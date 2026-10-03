// Package exiftool wraps the exiftool CLI: reading DateTimeOriginal for
// queue ordering, extracting HEIC preview/thumbnail images for the browser
// UI, and writing only the touched fields for a photo's Apply step.
package exiftool

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// dateLayout is the exiftool text format used for both reading and writing
// DateTimeOriginal-family tags.
const dateLayout = "2006:01:02 15:04:05"

// Runner executes exiftool and returns its stdout. Satisfied by the real CLI
// via execRunner, and by a fake in tests.
type Runner interface {
	Output(args ...string) ([]byte, error)
}

type execRunner struct{}

func (execRunner) Output(args ...string) ([]byte, error) {
	return exec.Command("exiftool", args...).Output()
}

// CheckAvailable reports an error if exiftool isn't on PATH. The tool
// shells out to it for every metadata read/write, so this should be
// checked once at startup.
func CheckAvailable() error {
	if _, err := exec.LookPath("exiftool"); err != nil {
		return fmt.Errorf("exiftool not found on PATH (install it, e.g. `apt install libimage-exiftool-perl` or `brew install exiftool`): %w", err)
	}
	return nil
}

// Client shells out to exiftool for metadata reads and writes.
type Client struct {
	runner Runner
}

// New returns a Client that invokes the real exiftool binary.
func New() *Client {
	return &Client{runner: execRunner{}}
}

// NewWithRunner returns a Client using a custom Runner, for tests.
func NewWithRunner(r Runner) *Client {
	return &Client{runner: r}
}

// ReadDateTimeOriginalBatch reads the existing DateTimeOriginal tag for many
// photos in a single exiftool invocation, used to establish queue order at
// startup. exiftool is a Perl script, so process-launch overhead dominates
// for many small reads -- one invocation covering every path is dramatically
// faster than one invocation per photo. The returned map contains an entry
// only for paths that have the tag; a missing entry means it wasn't present.
func (c *Client) ReadDateTimeOriginalBatch(paths []string) (map[string]time.Time, error) {
	dates := make(map[string]time.Time, len(paths))
	if len(paths) == 0 {
		return dates, nil
	}

	args := append([]string{"-j", "-DateTimeOriginal"}, paths...)
	out, err := c.runner.Output(args...)
	if err != nil {
		return nil, fmt.Errorf("reading DateTimeOriginal for %d photo(s): %w", len(paths), err)
	}

	var records []struct {
		SourceFile       string `json:"SourceFile"`
		DateTimeOriginal string `json:"DateTimeOriginal"`
	}
	if err := json.Unmarshal(out, &records); err != nil {
		return nil, fmt.Errorf("parsing DateTimeOriginal batch response: %w", err)
	}

	for _, r := range records {
		if r.DateTimeOriginal == "" {
			continue
		}
		dt, err := time.Parse(dateLayout, r.DateTimeOriginal)
		if err != nil {
			return nil, fmt.Errorf("parsing DateTimeOriginal %q from %s: %w", r.DateTimeOriginal, r.SourceFile, err)
		}
		dates[r.SourceFile] = dt
	}
	return dates, nil
}

// ReadKeywordsBatch reads the existing Keywords tag for many photos in a
// single exiftool invocation, used at startup to seed the known-keywords
// store with whatever's already embedded in the source directory's photos
// (see internal/keywords). The returned map contains an entry only for
// paths that have the tag; a missing entry means it wasn't present.
func (c *Client) ReadKeywordsBatch(paths []string) (map[string][]string, error) {
	keywords := make(map[string][]string, len(paths))
	if len(paths) == 0 {
		return keywords, nil
	}

	args := append([]string{"-j", "-Keywords"}, paths...)
	out, err := c.runner.Output(args...)
	if err != nil {
		return nil, fmt.Errorf("reading Keywords for %d photo(s): %w", len(paths), err)
	}

	var records []struct {
		SourceFile string          `json:"SourceFile"`
		Keywords   json.RawMessage `json:"Keywords"`
	}
	if err := json.Unmarshal(out, &records); err != nil {
		return nil, fmt.Errorf("parsing Keywords batch response: %w", err)
	}

	for _, r := range records {
		if len(r.Keywords) == 0 {
			continue
		}
		kws, err := parseKeywords(r.Keywords)
		if err != nil {
			return nil, fmt.Errorf("parsing Keywords %q from %s: %w", r.Keywords, r.SourceFile, err)
		}
		keywords[r.SourceFile] = kws
	}
	return keywords, nil
}

// ReadGPSPresenceBatch reads whether each photo has both GPSLatitude and
// GPSLongitude set, in a single exiftool invocation, used at startup to
// classify entries for the "missing GPS" Geo filter (see internal/queue).
// A path absent from the returned map is treated the same as false by
// callers -- exiftool's -j omits a tag entirely rather than emitting null
// for a file with no EXIF data at all.
func (c *Client) ReadGPSPresenceBatch(paths []string) (map[string]bool, error) {
	has := make(map[string]bool, len(paths))
	if len(paths) == 0 {
		return has, nil
	}

	args := append([]string{"-n", "-j", "-GPSLatitude", "-GPSLongitude"}, paths...)
	out, err := c.runner.Output(args...)
	if err != nil {
		return nil, fmt.Errorf("reading GPS presence for %d photo(s): %w", len(paths), err)
	}

	// GPSLatitude/GPSLongitude are read as raw JSON rather than *float64:
	// -n normally forces decimal output, but some real-world photos carry
	// GPS tags in a form exiftool can't convert cleanly (seen in practice
	// as a string value even with -n), which would otherwise abort the
	// whole batch over a single photo. Presence-detection only needs to
	// know the tag was there, not parse its value, so any non-null JSON
	// value -- numeric or not -- counts as present.
	var records []struct {
		SourceFile   string          `json:"SourceFile"`
		GPSLatitude  json.RawMessage `json:"GPSLatitude"`
		GPSLongitude json.RawMessage `json:"GPSLongitude"`
	}
	if err := json.Unmarshal(out, &records); err != nil {
		return nil, fmt.Errorf("parsing GPS presence batch response: %w", err)
	}

	for _, r := range records {
		has[r.SourceFile] = jsonPresent(r.GPSLatitude) && jsonPresent(r.GPSLongitude)
	}
	return has, nil
}

// jsonPresent reports whether raw holds an actual JSON value rather than
// being absent (empty) or explicitly null.
func jsonPresent(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

// ExtractPreview returns image bytes suitable for browser display, for
// formats (HEIC/HEIF) browsers can't reliably render natively. It tries the
// embedded PreviewImage first, falling back to ThumbnailImage.
func (c *Client) ExtractPreview(path string) ([]byte, error) {
	if data, err := c.runner.Output("-b", "-PreviewImage", path); err == nil && len(data) > 0 {
		return data, nil
	}
	if data, err := c.runner.Output("-b", "-ThumbnailImage", path); err == nil && len(data) > 0 {
		return data, nil
	}
	return nil, fmt.Errorf("no embedded PreviewImage or ThumbnailImage found in %s", path)
}

// Existing holds a photo's current metadata, used to prefill the tagging
// form. Nil/empty fields mean the tag wasn't present.
type Existing struct {
	DateTime           *time.Time
	OffsetTimeOriginal *string
	Latitude           *float64
	Longitude          *float64
	Altitude           *float64
	Keywords           []string
	Caption            *string
}

// rawExisting mirrors exiftool's -j output. Keywords may come back as a
// single string or an array depending on how many values are present, and
// -n gives signed decimal GPS coordinates/altitude directly (no separate
// Ref tag to combine).
type rawExisting struct {
	DateTimeOriginal   string          `json:"DateTimeOriginal"`
	OffsetTimeOriginal string          `json:"OffsetTimeOriginal"`
	GPSLatitude        *float64        `json:"GPSLatitude"`
	GPSLongitude       *float64        `json:"GPSLongitude"`
	GPSAltitude        *float64        `json:"GPSAltitude"`
	Keywords           json.RawMessage `json:"Keywords"`
	ImageDescription   string          `json:"ImageDescription"`
}

// ReadExisting reads a photo's current metadata, to prefill the tagging
// form.
func (c *Client) ReadExisting(path string) (Existing, error) {
	out, err := c.runner.Output(
		"-n", "-j",
		"-DateTimeOriginal", "-OffsetTimeOriginal",
		"-GPSLatitude", "-GPSLongitude", "-GPSAltitude",
		"-Keywords", "-ImageDescription",
		path,
	)
	if err != nil {
		return Existing{}, fmt.Errorf("reading metadata from %s: %w", path, err)
	}

	var records []rawExisting
	if err := json.Unmarshal(out, &records); err != nil {
		return Existing{}, fmt.Errorf("parsing metadata for %s: %w", path, err)
	}
	if len(records) == 0 {
		return Existing{}, fmt.Errorf("no metadata returned for %s", path)
	}
	raw := records[0]

	var e Existing
	if raw.DateTimeOriginal != "" {
		dt, err := time.Parse(dateLayout, raw.DateTimeOriginal)
		if err != nil {
			return Existing{}, fmt.Errorf("parsing DateTimeOriginal %q from %s: %w", raw.DateTimeOriginal, path, err)
		}
		e.DateTime = &dt
	}
	if raw.OffsetTimeOriginal != "" {
		e.OffsetTimeOriginal = &raw.OffsetTimeOriginal
	}
	e.Latitude = raw.GPSLatitude
	e.Longitude = raw.GPSLongitude
	e.Altitude = raw.GPSAltitude
	if raw.ImageDescription != "" {
		e.Caption = &raw.ImageDescription
	}
	if len(raw.Keywords) > 0 {
		e.Keywords, err = parseKeywords(raw.Keywords)
		if err != nil {
			return Existing{}, fmt.Errorf("parsing Keywords for %s: %w", path, err)
		}
	}

	return e, nil
}

func parseKeywords(raw json.RawMessage) ([]string, error) {
	var asSlice []string
	if err := json.Unmarshal(raw, &asSlice); err == nil {
		return asSlice, nil
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return splitKeywordString(asString), nil
	}
	return nil, fmt.Errorf("unexpected Keywords shape: %s", raw)
}

// splitKeywordString splits a single Keywords value on commas, trimming
// whitespace and dropping empties. Seen in practice: a third-party tool
// (a race-photography vendor's watermarking software) wrote an entire
// keyword list as one comma-joined string into what's normally a
// multi-value tag, so exiftool reads it back as a single JSON string
// rather than an array -- "2019, Sussex Sport Photography, revolve24,
// brands hatch, bike, ..." as one literal keyword, instead of eleven.
// Splitting it here matches the comma-separated convention this app's own
// keywords field already uses everywhere else (see web/static/app.js's
// own parseKeywords), rather than surfacing the whole blob as one tag. A
// single-word value with no comma splits into itself unchanged.
func splitKeywordString(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// Fields holds the metadata to write for a single photo's Apply step. Every
// field is a pointer so nil unambiguously means "not touched" -- Apply
// writes only touched fields.
type Fields struct {
	// DateTime sets DateTimeOriginal/CreateDate/ModifyDate (-AllDates).
	DateTime *time.Time
	// OffsetTimeOriginal is written alone; OffsetTime/OffsetTimeDigitized
	// are deliberately never written (ADR-0002).
	OffsetTimeOriginal *string
	Latitude           *float64
	Longitude          *float64
	Altitude           *float64
	// Keywords, if non-nil, replaces the full keyword list (an empty slice
	// clears it).
	Keywords *[]string
	// Caption is written to both ImageDescription (Immich's primary read)
	// and IPTC:Caption-Abstract (compatibility).
	Caption *string
}

// Touched reports whether any field was set.
func (f Fields) Touched() bool {
	return f.DateTime != nil || f.OffsetTimeOriginal != nil || f.Latitude != nil ||
		f.Longitude != nil || f.Altitude != nil || f.Keywords != nil || f.Caption != nil
}

// WriteFields writes only the touched fields in f to path via exiftool,
// with -overwrite_original (the whole-directory backup in ADR-0001 is the
// recovery mechanism, so per-file _original copies would just be clutter).
// It's a no-op if nothing was touched.
func (c *Client) WriteFields(path string, f Fields) error {
	if !f.Touched() {
		return nil
	}

	args := f.args()
	args = append(args, "-overwrite_original", path)

	if _, err := c.runner.Output(args...); err != nil {
		return fmt.Errorf("writing metadata to %s: %w", path, err)
	}
	return nil
}

func (f Fields) args() []string {
	var args []string

	if f.DateTime != nil {
		args = append(args, "-AllDates="+f.DateTime.Format(dateLayout))
	}
	if f.OffsetTimeOriginal != nil {
		args = append(args, "-OffsetTimeOriginal="+*f.OffsetTimeOriginal)
	}
	if f.Latitude != nil && f.Longitude != nil {
		args = append(args, gpsArgs(*f.Latitude, *f.Longitude)...)
	}
	if f.Altitude != nil {
		ref := "0"
		alt := *f.Altitude
		if alt < 0 {
			ref = "1"
			alt = -alt
		}
		args = append(args, "-GPSAltitude="+formatFloat(alt), "-GPSAltitudeRef="+ref)
	}
	if f.Keywords != nil {
		args = append(args, "-Keywords=") // clear existing list first
		for _, kw := range *f.Keywords {
			args = append(args, "-Keywords+="+kw)
		}
	}
	if f.Caption != nil {
		args = append(args, "-ImageDescription="+*f.Caption, "-IPTC:Caption-Abstract="+*f.Caption)
	}

	return args
}

// removeKeywordBatchSize caps how many paths go into a single exiftool
// invocation when bulk-removing a keyword, for the same command-line-length
// reason as ReadDateTimeOriginalBatch's chunking in session.go.
const removeKeywordBatchSize = 200

// RemoveKeywordBatch strips kw from every photo in paths that currently has
// it. exiftool's -Keywords-=VALUE leaves a photo without that value
// untouched and doesn't error, so paths can safely be every photo in a
// directory rather than just the ones known to carry kw.
func (c *Client) RemoveKeywordBatch(paths []string, kw string) error {
	for start := 0; start < len(paths); start += removeKeywordBatchSize {
		end := start + removeKeywordBatchSize
		if end > len(paths) {
			end = len(paths)
		}
		args := append([]string{"-overwrite_original", "-Keywords-=" + kw}, paths[start:end]...)
		if _, err := c.runner.Output(args...); err != nil {
			return fmt.Errorf("removing keyword %q from photos %d-%d: %w", kw, start, end, err)
		}
	}
	return nil
}

// RenameKeywordBatch replaces oldKw with newKw across every photo in paths,
// in a single pass per batch: a photo without oldKw is left untouched by
// the removal half and gains newKw from the addition half, same as applying
// -Keywords-=X to a photo that never had X -- both no-op safely, so paths
// can be every photo in a directory. If a photo already independently
// carries newKw, it ends up with a duplicate entry (ExifTool's += doesn't
// dedupe) -- accepted as a rare, self-correcting edge case rather than
// adding dedup logic for it.
func (c *Client) RenameKeywordBatch(paths []string, oldKw, newKw string) error {
	for start := 0; start < len(paths); start += removeKeywordBatchSize {
		end := start + removeKeywordBatchSize
		if end > len(paths) {
			end = len(paths)
		}
		args := append([]string{"-overwrite_original", "-Keywords-=" + oldKw, "-Keywords+=" + newKw}, paths[start:end]...)
		if _, err := c.runner.Output(args...); err != nil {
			return fmt.Errorf("renaming keyword %q to %q for photos %d-%d: %w", oldKw, newKw, start, end, err)
		}
	}
	return nil
}

func gpsArgs(lat, lon float64) []string {
	latRef, lon2Ref := "N", "E"
	if lat < 0 {
		latRef = "S"
		lat = -lat
	}
	if lon < 0 {
		lon2Ref = "W"
		lon = -lon
	}
	return []string{
		"-GPSLatitude=" + formatFloat(lat),
		"-GPSLatitudeRef=" + latRef,
		"-GPSLongitude=" + formatFloat(lon),
		"-GPSLongitudeRef=" + lon2Ref,
	}
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
