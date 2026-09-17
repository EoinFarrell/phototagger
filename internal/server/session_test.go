package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"phototagger/internal/exiftool"
	"phototagger/internal/locations"
	"phototagger/internal/scan"
)

type fakeExif struct {
	dates    map[string]time.Time
	existing map[string]exiftool.Existing
	written  map[string]exiftool.Fields
	previews map[string][]byte
}

func newFakeExif() *fakeExif {
	return &fakeExif{
		dates:    map[string]time.Time{},
		existing: map[string]exiftool.Existing{},
		written:  map[string]exiftool.Fields{},
		previews: map[string][]byte{},
	}
}

func (f *fakeExif) ReadDateTimeOriginalBatch(paths []string) (map[string]time.Time, error) {
	out := make(map[string]time.Time, len(paths))
	for _, p := range paths {
		if dt, ok := f.dates[p]; ok {
			out[p] = dt
		}
	}
	return out, nil
}
func (f *fakeExif) ReadExisting(path string) (exiftool.Existing, error) {
	return f.existing[path], nil
}
func (f *fakeExif) WriteFields(path string, fields exiftool.Fields) error {
	f.written[path] = fields
	return nil
}
func (f *fakeExif) ExtractPreview(path string) ([]byte, error) {
	return f.previews[path], nil
}

type fakeTZ struct {
	offset, zone string
	ok           bool
}

func (f fakeTZ) Resolve(lat, lon float64, dt time.Time) (string, string, bool) {
	return f.offset, f.zone, f.ok
}

type fakeGeocoder struct {
	name string
	err  error
}

func (f fakeGeocoder) ReverseGeocode(lat, lon float64) (string, error) { return f.name, f.err }

type fakeElevation struct {
	alt float64
	err error
}

func (f fakeElevation) Lookup(lat, lon float64) (float64, error) { return f.alt, f.err }

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestSession(t *testing.T, flat bool) (*Session, string, string, *fakeExif) {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")
	tagged := filepath.Join(root, "source-tagged")

	touch(t, filepath.Join(source, "a.jpg"))
	touch(t, filepath.Join(source, "sub", "b.jpg"))

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}

	exif := newFakeExif()
	tz := fakeTZ{offset: "+01:00", zone: "Europe/Dublin", ok: true}
	geo := fakeGeocoder{name: "Dublin"}
	elev := fakeElevation{alt: 20}
	locs, err := locations.Load(filepath.Join(root, "locations.json"))
	if err != nil {
		t.Fatal(err)
	}

	sess, err := NewSession(source, backup, tagged, flat, result, exif, tz, geo, elev, locs)
	if err != nil {
		t.Fatal(err)
	}
	return sess, source, tagged, exif
}

func TestSession_CurrentAndDone(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)

	if got := sess.Total(); got != 2 {
		t.Fatalf("Total() = %d, want 2", got)
	}

	cur, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if cur.Done {
		t.Fatal("Current() reported Done with photos remaining")
	}

	sess.Skip()
	sess.Skip()

	cur, err = sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if !cur.Done {
		t.Fatal("Current() should report Done after skipping past every photo")
	}
}

func TestSession_SkipDoesNotTouchFilesystem(t *testing.T) {
	sess, source, _, _ := newTestSession(t, true)
	before, _ := sess.Current()

	sess.Skip()

	if _, err := os.Stat(filepath.Join(source, before.RelPath)); err != nil {
		t.Errorf("Skip must not move the file: %v", err)
	}
}

func TestSession_Prev_UndoesSkip(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)
	first, _ := sess.Current()

	sess.Skip()
	sess.Prev()

	back, _ := sess.Current()
	if back.RelPath != first.RelPath {
		t.Errorf("Prev() gave %q, want %q", back.RelPath, first.RelPath)
	}
}

func TestSession_Prev_NoopWhenNothingEarlier(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)
	first, _ := sess.Current()

	sess.Prev() // already at index 0

	back, _ := sess.Current()
	if back.RelPath != first.RelPath {
		t.Errorf("Prev() at index 0 should be a no-op, got %q", back.RelPath)
	}
}

func TestSession_Prev_SkipsOverAppliedPhotos(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:00"}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	// Now at index 1 (last photo), index 0 already Applied and moved.
	sess.Prev()

	cur, _ := sess.Current()
	if cur.Done {
		t.Fatal("expected the second photo still pending, not Done")
	}
	if cur.Index != 1 {
		t.Errorf("Prev() should have been a no-op past an Applied photo, got index %d", cur.Index)
	}
}

func TestSession_Apply_RequiresDateTime(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)
	if _, err := sess.Apply(ApplyRequest{}); err == nil {
		t.Fatal("expected error when dateTime is missing")
	}
}

func TestSession_Apply_RequiresOffsetWhenDateTimeTouched(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", DateTimeTouched: true}
	if _, err := sess.Apply(req); err == nil {
		t.Fatal("expected error when datetime touched but offset missing")
	}
}

func TestSession_Apply_WritesOnlyTouchedFields(t *testing.T) {
	sess, _, _, exif := newTestSession(t, true)
	first, _ := sess.Current()

	caption := "A caption"
	req := ApplyRequest{
		DateTime:       "2024-07-14T14:30:00",
		CaptionTouched: true,
		Caption:        caption,
	}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	var written exiftool.Fields
	for _, f := range exif.written {
		written = f
	}
	if written.DateTime != nil {
		t.Error("DateTime should not be written when not touched")
	}
	if written.Caption == nil || *written.Caption != caption {
		t.Errorf("Caption = %v, want %q", written.Caption, caption)
	}
	_ = first
}

func TestSession_Apply_MovesAndRenamesFlat(t *testing.T) {
	sess, _, tagged, _ := newTestSession(t, true)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(tagged, "20240714-143022.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected file at %s: %v", want, err)
	}
}

func TestSession_Apply_NestedLayoutPreservesSubfolder(t *testing.T) {
	sess, _, tagged, _ := newTestSession(t, false)

	// First photo (a.jpg, top-level) then second (sub/b.jpg).
	sess.Skip()
	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(tagged, "sub", "20240714-143022.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
}

func TestSession_Apply_SlugFromFavouriteName(t *testing.T) {
	sess, _, tagged, _ := newTestSession(t, true)

	lat, lon := 53.35, -6.26
	req := ApplyRequest{
		DateTime:        "2024-07-14T14:30:22",
		LocationTouched: true,
		Lat:             &lat,
		Lon:             &lon,
		FavouriteName:   "Home",
	}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(tagged, "20240714-143022_home.jpg")
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected %s to exist: %v", want, err)
	}
}

func TestSession_Apply_SlugFromGeocodeWhenNoFavourite(t *testing.T) {
	sess, _, tagged, _ := newTestSession(t, true)

	lat, lon := 53.35, -6.26
	req := ApplyRequest{
		DateTime:        "2024-07-14T14:30:22",
		LocationTouched: true,
		Lat:             &lat,
		Lon:             &lon,
	}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(tagged, "20240714-143022_dublin.jpg")
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected %s to exist: %v", want, err)
	}
}

func TestSession_Apply_NoSlugWhenNoLocation(t *testing.T) {
	sess, _, tagged, _ := newTestSession(t, true)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(tagged, "20240714-143022.jpg")
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected %s to exist: %v", want, err)
	}
}

func TestSession_Apply_CollisionAppendsSuffix(t *testing.T) {
	sess, _, tagged, _ := newTestSession(t, true)

	// Pre-create a file that will collide with the computed name.
	touch(t, filepath.Join(tagged, "20240714-143022.jpg"))

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(tagged, "20240714-143022-01.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
}

func TestSession_Apply_AdvancesQueueAndRemaining(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)

	if got := sess.Remaining(); got != 2 {
		t.Fatalf("Remaining() = %d, want 2", got)
	}
	if _, err := sess.Apply(ApplyRequest{DateTime: "2024-07-14T14:30:22"}); err != nil {
		t.Fatal(err)
	}
	if got := sess.Remaining(); got != 1 {
		t.Errorf("Remaining() = %d, want 1 after Apply", got)
	}
}

func TestSession_Apply_PreviousValuesCascadeAcrossSkip(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)

	lat, lon := 53.35, -6.26
	req := ApplyRequest{
		DateTime:        "2024-07-14T14:30:22",
		LocationTouched: true,
		Lat:             &lat,
		Lon:             &lon,
		FavouriteName:   "Home",
	}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	cur, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if cur.Previous.Location == nil {
		t.Fatal("expected Previous.Location to be set after an Apply that touched location")
	}
	if cur.Previous.Location.Lat != lat || cur.Previous.Location.FavouriteName != "Home" {
		t.Errorf("Previous.Location = %+v", cur.Previous.Location)
	}
}

func TestSession_ResolveTimezoneAndElevation(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)

	offset, zone, ok := sess.ResolveTimezone(53.35, -6.26, time.Now())
	if !ok || offset != "+01:00" || zone != "Europe/Dublin" {
		t.Errorf("ResolveTimezone = %q, %q, %v", offset, zone, ok)
	}

	alt, err := sess.LookupElevation(53.35, -6.26)
	if err != nil || alt != 20 {
		t.Errorf("LookupElevation = %v, %v", alt, err)
	}
}

func TestSession_FavouritesRoundtrip(t *testing.T) {
	sess, _, _, _ := newTestSession(t, true)

	if err := sess.AddFavourite(locations.Favourite{Name: "Home", Lat: 1, Lon: 2, Alt: 3}); err != nil {
		t.Fatal(err)
	}
	favs := sess.Favourites()
	if len(favs) != 1 || favs[0].Name != "Home" {
		t.Errorf("Favourites() = %+v", favs)
	}
}
