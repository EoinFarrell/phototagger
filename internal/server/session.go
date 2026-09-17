// Package server implements the HTTP API and page handlers for the tagging
// UI, plus the Session that holds the in-memory queue state described in
// CONTEXT.md and docs/plan.md.
package server

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"phototagger/internal/exiftool"
	"phototagger/internal/locations"
	"phototagger/internal/queue"
	"phototagger/internal/rename"
	"phototagger/internal/scan"
)

// dateTimeLayout is the wall-clock layout used on the wire between the
// browser's <input type="datetime-local"> and the server. It carries no
// timezone: the location's UTC offset is tracked separately as
// OffsetTimeOriginal, exactly like the underlying EXIF tags.
const dateTimeLayout = "2006-01-02T15:04:05"

// ExifClient is the subset of *exiftool.Client the session needs.
type ExifClient interface {
	ReadDateTimeOriginalBatch(paths []string) (map[string]time.Time, error)
	ReadExisting(path string) (exiftool.Existing, error)
	WriteFields(path string, f exiftool.Fields) error
	ExtractPreview(path string) ([]byte, error)
}

// TZResolver is the subset of *tzoffset.Resolver the session needs.
type TZResolver interface {
	Resolve(lat, lon float64, dt time.Time) (offset, zone string, ok bool)
}

// Geocoder is the subset of *geocode.Client the session needs.
type Geocoder interface {
	ReverseGeocode(lat, lon float64) (string, error)
}

// Elevation is the subset of *elevation.Client the session needs.
type Elevation interface {
	Lookup(lat, lon float64) (float64, error)
}

// lastValues tracks, per field group, the most recently Applied values --
// what the "same as previous" icons copy from. Skipped photos don't change
// these, so the value keeps cascading across skips until the next Apply
// that actually touches that group.
type lastValues struct {
	location *LocationFields
	dateTime *DateTimeFields
	keywords *[]string
	caption  *string
}

// Session holds the queue state for one -dir invocation: the ordered list
// of photos, which have been Applied, and the pointer to the current one.
type Session struct {
	mu sync.Mutex

	SourceDir  string
	BackupDir  string
	TaggedDir  string
	FlatLayout bool

	ScanResult scan.Result

	entries []queue.Entry
	applied []bool
	current int

	exif      ExifClient
	tz        TZResolver
	geocoder  Geocoder
	elevation Elevation
	locations *locations.Store

	last lastValues
}

// NewSession builds a Session from an already-completed scan, reading each
// photo's existing DateTimeOriginal to establish queue order (see
// internal/queue).
func NewSession(
	sourceDir, backupDir, taggedDir string,
	flatLayout bool,
	scanResult scan.Result,
	exif ExifClient,
	tz TZResolver,
	geocoder Geocoder,
	elevation Elevation,
	locs *locations.Store,
) (*Session, error) {
	dates, err := readDatesInBatches(exif, scanResult.Photos)
	if err != nil {
		return nil, err
	}

	entries := make([]queue.Entry, 0, len(scanResult.Photos))
	for _, p := range scanResult.Photos {
		entry := queue.Entry{Photo: p}
		if dt, ok := dates[p.Path]; ok {
			entry.DateTimeOriginal = &dt
		}
		entries = append(entries, entry)
	}

	return &Session{
		SourceDir:  sourceDir,
		BackupDir:  backupDir,
		TaggedDir:  taggedDir,
		FlatLayout: flatLayout,
		ScanResult: scanResult,
		entries:    queue.Order(entries),
		applied:    make([]bool, len(entries)),
		exif:       exif,
		tz:         tz,
		geocoder:   geocoder,
		elevation:  elevation,
		locations:  locs,
	}, nil
}

// dateReadBatchSize caps how many paths go into a single exiftool
// invocation when establishing queue order. exiftool's command line can
// handle far more than this, but chunking keeps any one invocation's JSON
// response a reasonable size.
const dateReadBatchSize = 200

// readDatesInBatches reads every photo's existing DateTimeOriginal via a
// small number of batched exiftool invocations rather than one per photo --
// exiftool is a Perl script, so per-invocation startup overhead dominates
// for hundreds of small reads.
func readDatesInBatches(exif ExifClient, photos []scan.Photo) (map[string]time.Time, error) {
	dates := make(map[string]time.Time, len(photos))
	for start := 0; start < len(photos); start += dateReadBatchSize {
		end := start + dateReadBatchSize
		if end > len(photos) {
			end = len(photos)
		}
		paths := make([]string, end-start)
		for i, p := range photos[start:end] {
			paths[i] = p.Path
		}
		batch, err := exif.ReadDateTimeOriginalBatch(paths)
		if err != nil {
			return nil, fmt.Errorf("reading dates for photos %d-%d: %w", start, end, err)
		}
		for path, dt := range batch {
			dates[path] = dt
		}
	}
	return dates, nil
}

// Total returns the number of photos found by the initial scan.
func (s *Session) Total() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// Remaining returns how many photos have not yet been Applied.
func (s *Session) Remaining() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, a := range s.applied {
		if !a {
			n++
		}
	}
	return n
}

// CurrentPhoto describes the photo currently shown in the UI, or reports
// Done if every photo has been Applied.
type CurrentPhoto struct {
	Done     bool
	Index    int
	Total    int
	RelPath  string
	Ext      string
	IsHeic   bool
	Existing exiftool.Existing
	Previous PreviousValues
}

// PreviousValues is the previously-Applied value for each field group, used
// by the "same as previous" icons. A nil pointer means no prior Apply has
// touched that group yet this session.
type PreviousValues struct {
	Location *LocationFields
	DateTime *DateTimeFields
	Keywords *[]string
	Caption  *string
}

// LocationFields is the location+altitude field group.
type LocationFields struct {
	Lat           float64
	Lon           float64
	Alt           *float64
	FavouriteName string
}

// DateTimeFields is the datetime+offset field group.
type DateTimeFields struct {
	DateTime time.Time
	Offset   string
}

// Current returns the photo currently at the front of the queue.
func (s *Session) Current() (CurrentPhoto, error) {
	s.mu.Lock()
	current, total := s.current, len(s.entries)
	if current >= total {
		s.mu.Unlock()
		return CurrentPhoto{Done: true, Total: total}, nil
	}
	photo := s.entries[current].Photo
	previous := PreviousValues{Location: s.last.location, DateTime: s.last.dateTime, Keywords: s.last.keywords, Caption: s.last.caption}
	s.mu.Unlock()

	existing, err := s.exif.ReadExisting(photo.Path)
	if err != nil {
		return CurrentPhoto{}, err
	}

	return CurrentPhoto{
		Index:    current,
		Total:    total,
		RelPath:  photo.RelPath,
		Ext:      photo.Ext,
		IsHeic:   photo.IsHEIC(),
		Existing: existing,
		Previous: previous,
	}, nil
}

// Preview returns image bytes and a content type suitable for browser
// display of the current photo.
func (s *Session) Preview() (data []byte, contentType string, err error) {
	s.mu.Lock()
	if s.current >= len(s.entries) {
		s.mu.Unlock()
		return nil, "", fmt.Errorf("no current photo")
	}
	photo := s.entries[s.current].Photo
	s.mu.Unlock()

	if photo.IsHEIC() {
		data, err := s.exif.ExtractPreview(photo.Path)
		return data, "image/jpeg", err
	}

	data, err = os.ReadFile(photo.Path)
	if err != nil {
		return nil, "", err
	}
	return data, "image/jpeg", nil
}

// Skip advances to the next photo without changing anything on disk.
func (s *Session) Skip() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current < len(s.entries) {
		s.current++
	}
}

// Prev steps back to the nearest earlier photo that hasn't been Applied
// yet (an Applied photo has already left the source directory, so there's
// nothing to go back to). It's a no-op if every earlier photo is Applied.
func (s *Session) Prev() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := s.current - 1; i >= 0; i-- {
		if !s.applied[i] {
			s.current = i
			return
		}
	}
}

// ApplyRequest is the fields submitted from the tagging form. Every value
// field carries the form's current effective value regardless of whether it
// was edited; the Touched flags say whether exiftool should actually write
// that group. DateTime/Offset/Lat/Lon are needed for renaming even when
// untouched -- a photo that was already correct still gets renamed and
// moved into tagged/ (see docs/plan.md's Queue section).
type ApplyRequest struct {
	DateTime        string `json:"dateTime"`
	DateTimeTouched bool   `json:"dateTimeTouched"`
	Offset          string `json:"offset"`

	Lat             *float64 `json:"lat"`
	Lon             *float64 `json:"lon"`
	Alt             *float64 `json:"alt"`
	LocationTouched bool     `json:"locationTouched"`
	FavouriteName   string   `json:"favouriteName"`

	Keywords        []string `json:"keywords"`
	KeywordsTouched bool     `json:"keywordsTouched"`

	Caption        string `json:"caption"`
	CaptionTouched bool   `json:"captionTouched"`
}

// ApplyResult is what Apply did to the file, for logging/tests.
type ApplyResult struct {
	NewPath string
}

// Apply writes the touched fields, renames the current photo, and moves it
// into the tagged directory (see the Renaming section of docs/plan.md).
func (s *Session) Apply(req ApplyRequest) (ApplyResult, error) {
	s.mu.Lock()
	if s.current >= len(s.entries) {
		s.mu.Unlock()
		return ApplyResult{}, fmt.Errorf("nothing left to apply")
	}
	photo := s.entries[s.current].Photo
	flat := s.FlatLayout
	taggedDir := s.TaggedDir
	s.mu.Unlock()

	if req.DateTime == "" {
		return ApplyResult{}, fmt.Errorf("dateTime is required")
	}
	dt, err := time.Parse(dateTimeLayout, req.DateTime)
	if err != nil {
		return ApplyResult{}, fmt.Errorf("invalid dateTime %q: %w", req.DateTime, err)
	}
	if req.DateTimeTouched && req.Offset == "" {
		return ApplyResult{}, fmt.Errorf("offset is required when datetime is touched")
	}

	fields := exiftool.Fields{}
	if req.DateTimeTouched {
		fields.DateTime = &dt
		fields.OffsetTimeOriginal = &req.Offset
	}
	if req.LocationTouched {
		fields.Latitude = req.Lat
		fields.Longitude = req.Lon
		fields.Altitude = req.Alt
	}
	if req.KeywordsTouched {
		kw := req.Keywords
		fields.Keywords = &kw
	}
	if req.CaptionTouched {
		fields.Caption = &req.Caption
	}

	if err := s.exif.WriteFields(photo.Path, fields); err != nil {
		return ApplyResult{}, err
	}

	slug := s.resolveSlug(req)
	destDir := taggedDir
	if !flat {
		destDir = filepath.Join(taggedDir, filepath.Dir(photo.RelPath))
	}

	base := rename.Filename(dt, slug, photo.Ext)
	name := rename.ResolveCollision(func(candidate string) bool {
		_, err := os.Stat(filepath.Join(destDir, candidate))
		return err == nil
	}, base)
	destPath := filepath.Join(destDir, name)

	if err := moveFile(photo.Path, destPath); err != nil {
		return ApplyResult{}, err
	}

	s.mu.Lock()
	s.applied[s.current] = true
	s.updateLastValues(req)
	s.current++
	s.mu.Unlock()

	return ApplyResult{NewPath: destPath}, nil
}

// resolveSlug determines the location slug for the new filename: the
// favourite name if the pin is snapped to one, otherwise a best-effort
// reverse geocode of the coordinates, or "" if neither is available (see
// the Renaming section of docs/plan.md).
func (s *Session) resolveSlug(req ApplyRequest) string {
	if req.FavouriteName != "" {
		return rename.Slugify(req.FavouriteName)
	}
	if req.Lat == nil || req.Lon == nil {
		return ""
	}
	name, err := s.geocoder.ReverseGeocode(*req.Lat, *req.Lon)
	if err != nil || name == "" {
		return ""
	}
	return rename.Slugify(name)
}

// updateLastValues records the values from a group that was actually
// touched, for the next photo's "same as previous" icons. Groups that
// weren't touched keep whatever was recorded from an earlier Apply.
func (s *Session) updateLastValues(req ApplyRequest) {
	if req.LocationTouched && req.Lat != nil && req.Lon != nil {
		s.last.location = &LocationFields{Lat: *req.Lat, Lon: *req.Lon, Alt: req.Alt, FavouriteName: req.FavouriteName}
	}
	if req.DateTimeTouched {
		dt, err := time.Parse(dateTimeLayout, req.DateTime)
		if err == nil {
			s.last.dateTime = &DateTimeFields{DateTime: dt, Offset: req.Offset}
		}
	}
	if req.KeywordsTouched {
		kw := append([]string{}, req.Keywords...)
		s.last.keywords = &kw
	}
	if req.CaptionTouched {
		caption := req.Caption
		s.last.caption = &caption
	}
}

// ResolveTimezone computes the UTC offset for a coordinate and date.
func (s *Session) ResolveTimezone(lat, lon float64, dt time.Time) (offset, zone string, ok bool) {
	return s.tz.Resolve(lat, lon, dt)
}

// LookupElevation looks up ground elevation for a freehand pin.
func (s *Session) LookupElevation(lat, lon float64) (float64, error) {
	return s.elevation.Lookup(lat, lon)
}

// Favourites returns the saved favourite locations.
func (s *Session) Favourites() []locations.Favourite {
	return s.locations.All()
}

// AddFavourite saves a new favourite (or updates one with the same name).
func (s *Session) AddFavourite(fav locations.Favourite) error {
	return s.locations.Add(fav)
}
