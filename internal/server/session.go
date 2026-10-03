// Package server implements the HTTP API and page handlers for the tagging
// UI, plus the Session that holds the in-memory queue state described in
// CONTEXT.md and docs/plan.md.
package server

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"phototagger/internal/exiftool"
	"phototagger/internal/keywords"
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

// dateTimeLayoutNoSeconds matches dateTimeLayout, except for the seconds
// component. Per the HTML spec, <input type="datetime-local">.value omits
// seconds when they're zero, so a photo timestamped on an exact minute
// round-trips through the browser without them.
const dateTimeLayoutNoSeconds = "2006-01-02T15:04"

// parseDateTimeLocal parses a datetime-local value from the browser,
// accepting either dateTimeLayout or, when seconds are zero, the
// seconds-omitted form the browser actually sends in that case.
func parseDateTimeLocal(s string) (time.Time, error) {
	if dt, err := time.Parse(dateTimeLayout, s); err == nil {
		return dt, nil
	}
	return time.Parse(dateTimeLayoutNoSeconds, s)
}

// ExifClient is the subset of *exiftool.Client the session needs.
type ExifClient interface {
	ReadDateTimeOriginalBatch(paths []string) (map[string]time.Time, error)
	ReadExisting(path string) (exiftool.Existing, error)
	WriteFields(path string, f exiftool.Fields) error
	ExtractPreview(path string) ([]byte, error)
	RemoveKeywordBatch(paths []string, kw string) error
	RenameKeywordBatch(paths []string, oldKw, newKw string) error
	ReadKeywordsBatch(paths []string) (map[string][]string, error)
	ReadGPSPresenceBatch(paths []string) (map[string]bool, error)
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

	SourceDir string
	BackupDir string

	ScanResult scan.Result

	// allEntries is every scanned photo, chronologically Ordered and
	// classified Tagged/Non-Tagged, computed once at startup regardless of
	// Mode -- it's what Counts() reports against and what Start() filters
	// to build this run's fixed queue.
	allEntries []queue.Entry

	entries []queue.Entry
	applied []bool
	current int

	// busy is the authoritative Apply-in-progress lock: true while
	// WriteFields/rename is running, causing Apply() below to reject
	// overlapping requests. web/static/formstate.js's busy flag is this
	// lock's optimistic client-side mirror when it's guarding Apply --
	// kept only for UX (disabling the buttons instantly instead of
	// round-tripping to a rejected request); deleting the client copy
	// loses nothing but a disabled-button flash, deleting this one
	// reopens issue #1's race. That same client flag also guards Skip and
	// Prev below, which have no server-side lock at all -- both are
	// synchronous, mutex-only pointer moves with nothing worth rejecting a
	// second request over -- so there it's pure click-debounce, not a
	// mirror of anything here. See issue #11.
	busy bool

	exif      ExifClient
	tz        TZResolver
	geocoder  Geocoder
	elevation Elevation
	locations *locations.Store
	keywords  *keywords.Store

	last lastValues
}

// NewSession builds a Session from an already-completed scan, reading each
// photo's existing DateTimeOriginal to establish queue order (see
// internal/queue), classifying each as Tagged/Non-Tagged by filename, and
// seeding kws with every keyword already embedded in the directory's photos
// so the quick-pick pills aren't limited to keywords Applied via this tool.
// The run's actual queue isn't built yet -- that happens once the start
// screen's Mode choice reaches Start().
func NewSession(
	sourceDir, backupDir string,
	scanResult scan.Result,
	exif ExifClient,
	tz TZResolver,
	geocoder Geocoder,
	elevation Elevation,
	locs *locations.Store,
	kws *keywords.Store,
) (*Session, error) {
	dates, err := readDatesInBatches(exif, scanResult.Photos)
	if err != nil {
		return nil, err
	}

	existingKeywords, err := readKeywordsInBatches(exif, scanResult.Photos)
	if err != nil {
		return nil, err
	}
	if err := kws.Add(existingKeywords); err != nil {
		return nil, fmt.Errorf("seeding known keywords: %w", err)
	}

	hasGPS, err := readGPSPresenceInBatches(exif, scanResult.Photos)
	if err != nil {
		return nil, err
	}

	entries := make([]queue.Entry, 0, len(scanResult.Photos))
	for _, p := range scanResult.Photos {
		entry := queue.Entry{Photo: p, Tagged: rename.IsTagged(filepath.Base(p.RelPath)), HasGPS: hasGPS[p.Path]}
		if dt, ok := dates[p.Path]; ok {
			entry.DateTimeOriginal = &dt
		}
		entries = append(entries, entry)
	}

	return &Session{
		SourceDir:  sourceDir,
		BackupDir:  backupDir,
		ScanResult: scanResult,
		allEntries: queue.Order(entries),
		exif:       exif,
		tz:         tz,
		geocoder:   geocoder,
		elevation:  elevation,
		locations:  locs,
		keywords:   kws,
	}, nil
}

// Counts reports how many scanned photos match each Mode, for the start
// screen (see docs/plan.md's Start screen section).
func (s *Session) Counts() modeCounts {
	s.mu.Lock()
	defer s.mu.Unlock()
	counts := modeCounts{All: len(s.allEntries)}
	for _, e := range s.allEntries {
		if e.Tagged {
			counts.Tagged++
		}
	}
	counts.NonTagged = counts.All - counts.Tagged
	return counts
}

// GeoCounts reports how many scanned photos match each Geo filter, for the
// start screen. Independent of Mode -- counted over every scanned photo
// regardless of which Mode is currently selected, mirroring how Mode and
// Geo are chosen independently and ANDed together by Start.
func (s *Session) GeoCounts() geoCounts {
	s.mu.Lock()
	defer s.mu.Unlock()
	counts := geoCounts{All: len(s.allEntries)}
	for _, e := range s.allEntries {
		if !e.HasGPS {
			counts.MissingGPS++
		}
	}
	return counts
}

// Start builds this run's fixed queue: the subset of allEntries matching
// both mode and geo, in the same chronological order (see CONTEXT.md's
// Queue definition). Resets the current pointer and Applied tracking, so
// calling it again (e.g. before any Apply) rebuilds the queue from scratch.
func (s *Session) Start(mode queue.Mode, geo queue.GeoFilter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = queue.FilterGeo(queue.Filter(s.allEntries, mode), geo)
	s.applied = make([]bool, len(s.entries))
	s.current = 0
}

// metadataReadBatchSize caps how many paths go into a single exiftool
// invocation when bulk-reading metadata at startup. exiftool's command line
// can handle far more than this, but chunking keeps any one invocation's
// JSON response a reasonable size.
const metadataReadBatchSize = 200

// readDatesInBatches reads every photo's existing DateTimeOriginal via a
// small number of batched exiftool invocations rather than one per photo --
// exiftool is a Perl script, so per-invocation startup overhead dominates
// for hundreds of small reads.
func readDatesInBatches(exif ExifClient, photos []scan.Photo) (map[string]time.Time, error) {
	dates := make(map[string]time.Time, len(photos))
	for start := 0; start < len(photos); start += metadataReadBatchSize {
		end := start + metadataReadBatchSize
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

// readKeywordsInBatches reads every photo's existing Keywords via a small
// number of batched exiftool invocations, returning the deduplicated union
// in first-seen order for seeding the known-keywords store at startup.
func readKeywordsInBatches(exif ExifClient, photos []scan.Photo) ([]string, error) {
	seen := map[string]bool{}
	var all []string
	for start := 0; start < len(photos); start += metadataReadBatchSize {
		end := start + metadataReadBatchSize
		if end > len(photos) {
			end = len(photos)
		}
		paths := make([]string, end-start)
		for i, p := range photos[start:end] {
			paths[i] = p.Path
		}
		batch, err := exif.ReadKeywordsBatch(paths)
		if err != nil {
			return nil, fmt.Errorf("reading keywords for photos %d-%d: %w", start, end, err)
		}
		for _, kws := range batch {
			for _, k := range kws {
				if seen[k] {
					continue
				}
				seen[k] = true
				all = append(all, k)
			}
		}
	}
	return all, nil
}

// readGPSPresenceInBatches reads whether each photo already has GPS
// coordinates via a small number of batched exiftool invocations, for the
// Geo filter's "missing GPS" classification -- same batching rationale as
// readDatesInBatches.
func readGPSPresenceInBatches(exif ExifClient, photos []scan.Photo) (map[string]bool, error) {
	hasGPS := make(map[string]bool, len(photos))
	for start := 0; start < len(photos); start += metadataReadBatchSize {
		end := start + metadataReadBatchSize
		if end > len(photos) {
			end = len(photos)
		}
		paths := make([]string, end-start)
		for i, p := range photos[start:end] {
			paths[i] = p.Path
		}
		batch, err := exif.ReadGPSPresenceBatch(paths)
		if err != nil {
			return nil, fmt.Errorf("reading GPS presence for photos %d-%d: %w", start, end, err)
		}
		for path, has := range batch {
			hasGPS[path] = has
		}
	}
	return hasGPS, nil
}

// Total returns the number of photos in the current run's queue -- zero
// until Start has built it (see Counts for the pre-Start, per-Mode scan
// totals shown on the start screen).
func (s *Session) Total() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// Remaining returns how many photos in the current run's queue have not yet
// been Applied -- zero (not "nothing left to do") until Start has built the
// queue.
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

// Prev steps back to the previous photo in the queue. Since Apply renames a
// photo in place and never moves it out of the source directory, Prev can
// step back into any earlier entry, including ones already Applied this run
// (see ADR-0005) -- it's a no-op only at the start of the queue.
func (s *Session) Prev() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.current > 0 {
		s.current--
	}
}

// ApplyRequest is the fields submitted from the tagging form. Every value
// field carries the form's current effective value regardless of whether it
// was edited; the Touched flags say whether exiftool should actually write
// that group. DateTime/Offset/Lat/Lon are needed for renaming even when
// untouched -- a photo that was already correct still gets renamed in place
// (see docs/plan.md's Queue section).
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

// Apply writes the touched fields and renames the current photo in place,
// inside the source directory (see the Renaming section of docs/plan.md).
func (s *Session) Apply(req ApplyRequest) (ApplyResult, error) {
	s.mu.Lock()
	if s.busy {
		s.mu.Unlock()
		return ApplyResult{}, fmt.Errorf("another apply is already in progress")
	}
	if s.current >= len(s.entries) {
		s.mu.Unlock()
		return ApplyResult{}, fmt.Errorf("nothing left to apply")
	}
	photo := s.entries[s.current].Photo
	s.busy = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.busy = false
		s.mu.Unlock()
	}()

	if req.DateTime == "" {
		return ApplyResult{}, fmt.Errorf("dateTime is required")
	}
	dt, err := parseDateTimeLocal(req.DateTime)
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

	if req.KeywordsTouched {
		if err := s.keywords.Add(req.Keywords); err != nil {
			return ApplyResult{}, fmt.Errorf("saving known keywords: %w", err)
		}
	}

	slug := s.resolveSlug(req)
	destDir := filepath.Dir(photo.Path)
	currentName := filepath.Base(photo.Path)

	base := rename.Filename(dt, slug, photo.Ext)
	// The exists-check excludes the photo's own current name, so an
	// unchanged correction (re-Applying an already-Tagged photo with the
	// same datetime/location) doesn't spuriously collide with itself.
	name := rename.ResolveCollision(func(candidate string) bool {
		if candidate == currentName {
			return false
		}
		_, err := os.Stat(filepath.Join(destDir, candidate))
		return err == nil
	}, base)
	destPath := filepath.Join(destDir, name)

	if destPath != photo.Path {
		if err := os.Rename(photo.Path, destPath); err != nil {
			return ApplyResult{}, fmt.Errorf("renaming %s to %s: %w", photo.Path, destPath, err)
		}
	}

	s.mu.Lock()
	s.entries[s.current].Photo.Path = destPath
	s.entries[s.current].Photo.RelPath = filepath.Join(filepath.Dir(photo.RelPath), name)
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
		dt, err := parseDateTimeLocal(req.DateTime)
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

// Keywords returns every previously-Applied keyword and its optional saved
// Location, for the tagging UI's quick-pick pills and keyword-location
// management section (see web/static/app.js).
func (s *Session) Keywords() []keywords.Keyword {
	return s.keywords.All()
}

// SetKeywordLocation sets kw's saved Location, for the tagging UI's
// keyword-location management section -- picking that keyword later snaps
// the map to it (see web/static/app.js).
func (s *Session) SetKeywordLocation(kw string, loc keywords.Location) error {
	return s.keywords.SetLocation(kw, &loc)
}

// ClearKeywordLocation removes kw's saved Location, if any.
func (s *Session) ClearKeywordLocation(kw string) error {
	return s.keywords.SetLocation(kw, nil)
}

// DeleteKeyword removes kw from the known-keywords pill list and strips it
// from every photo currently in the source directory that carries it. It
// re-scans the directory rather than walking allEntries/entries: a photo
// Applied earlier this run has already been renamed on disk, so allEntries'
// copy of it holds a stale pre-rename path (Apply updates only entries,
// see its doc comment), and entries itself may exclude photos outside this
// run's Mode that could still carry kw.
func (s *Session) DeleteKeyword(kw string) error {
	result, err := scan.Scan(s.SourceDir)
	if err != nil {
		return fmt.Errorf("rescanning %s: %w", s.SourceDir, err)
	}
	paths := make([]string, len(result.Photos))
	for i, p := range result.Photos {
		paths[i] = p.Path
	}

	if err := s.exif.RemoveKeywordBatch(paths, kw); err != nil {
		return err
	}
	return s.keywords.Remove(kw)
}

// RenameKeyword changes oldKw's text to newKw everywhere: every photo
// currently in the source directory that carries oldKw (re-scanned for the
// same reason DeleteKeyword is, above -- an already-Applied photo's path in
// allEntries/entries may be stale), and the known-keywords list itself,
// preserving its position and any saved Location. The newKw-collision and
// blank-name checks happen before the directory-wide rewrite below, not
// just inside keywords.Store.Rename afterwards, so a rejected rename never
// touches a single file on disk.
func (s *Session) RenameKeyword(oldKw, newKw string) error {
	newKw = strings.TrimSpace(newKw)
	if newKw == oldKw {
		return nil
	}
	if newKw == "" {
		return fmt.Errorf("new keyword name is required")
	}
	if s.keywords.Exists(newKw) {
		return fmt.Errorf("keyword %q already exists", newKw)
	}

	result, err := scan.Scan(s.SourceDir)
	if err != nil {
		return fmt.Errorf("rescanning %s: %w", s.SourceDir, err)
	}
	paths := make([]string, len(result.Photos))
	for i, p := range result.Photos {
		paths[i] = p.Path
	}

	if err := s.exif.RenameKeywordBatch(paths, oldKw, newKw); err != nil {
		return err
	}
	return s.keywords.Rename(oldKw, newKw)
}
