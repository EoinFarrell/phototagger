package server

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"phototagger/internal/exiftool"
	"phototagger/internal/keywords"
	"phototagger/internal/queue"
	"phototagger/internal/scan"
)

type fakeExif struct {
	dates    map[string]time.Time
	keywords map[string][]string
	hasGPS   map[string]bool
	existing map[string]exiftool.Existing
	written  map[string]exiftool.Fields
	previews map[string][]byte

	// onWrite, if set, runs at the start of WriteFields -- used to simulate a
	// second Apply call arriving while the first is still mid-flight (see
	// TestSession_Apply_RejectsOverlappingApply).
	onWrite func()

	// removedKeywordCalls records each RemoveKeywordBatch call, in order,
	// for TestSession_DeleteKeyword assertions.
	removedKeywordCalls []removeKeywordCall

	// renamedKeywordCalls records each RenameKeywordBatch call, in order,
	// for TestSession_RenameKeyword assertions.
	renamedKeywordCalls []renameKeywordCall

	// renameErr, if set, is returned by RenameKeywordBatch instead of nil --
	// used to prove a failed rewrite leaves the known-keywords list
	// unchanged (TestSession_RenameKeyword_LeavesStoreUnchangedOnExifError).
	renameErr error
}

type removeKeywordCall struct {
	paths []string
	kw    string
}

type renameKeywordCall struct {
	paths        []string
	oldKw, newKw string
}

func newFakeExif() *fakeExif {
	return &fakeExif{
		dates:    map[string]time.Time{},
		keywords: map[string][]string{},
		hasGPS:   map[string]bool{},
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

func (f *fakeExif) ReadKeywordsBatch(paths []string) (map[string][]string, error) {
	out := make(map[string][]string, len(paths))
	for _, p := range paths {
		if kws, ok := f.keywords[p]; ok {
			out[p] = kws
		}
	}
	return out, nil
}
func (f *fakeExif) ReadGPSPresenceBatch(paths []string) (map[string]bool, error) {
	out := make(map[string]bool, len(paths))
	for _, p := range paths {
		if has, ok := f.hasGPS[p]; ok {
			out[p] = has
		}
	}
	return out, nil
}
func (f *fakeExif) ReadExisting(path string) (exiftool.Existing, error) {
	return f.existing[path], nil
}
func (f *fakeExif) WriteFields(path string, fields exiftool.Fields) error {
	if f.onWrite != nil {
		f.onWrite()
	}
	f.written[path] = fields
	return nil
}
func (f *fakeExif) ExtractPreview(path string) ([]byte, error) {
	return f.previews[path], nil
}
func (f *fakeExif) RemoveKeywordBatch(paths []string, kw string) error {
	f.removedKeywordCalls = append(f.removedKeywordCalls, removeKeywordCall{paths: paths, kw: kw})
	return nil
}
func (f *fakeExif) RenameKeywordBatch(paths []string, oldKw, newKw string) error {
	f.renamedKeywordCalls = append(f.renamedKeywordCalls, renameKeywordCall{paths: paths, oldKw: oldKw, newKw: newKw})
	return f.renameErr
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

func newTestSession(t *testing.T) (*Session, string, *fakeExif) {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")

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
	kws, err := keywords.Load(filepath.Join(root, "keywords.json"))
	if err != nil {
		t.Fatal(err)
	}

	sess, err := NewSession(source, backup, result, exif, tz, geo, elev, kws)
	if err != nil {
		t.Fatal(err)
	}
	// Every fixture photo above is Non-Tagged, so starting in Non-Tagged mode
	// reproduces the pre-Mode-selector behavior these tests were written
	// against.
	sess.Start(queue.ModeNonTagged, queue.GeoAll)
	return sess, source, exif
}

// newTestSessionWithPhotos builds a Session (without calling Start) over a
// source directory containing exactly the given filenames, for tests that
// need control over which are Tagged vs Non-Tagged.
func newTestSessionWithPhotos(t *testing.T, filenames ...string) (*Session, string) {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")

	for _, name := range filenames {
		touch(t, filepath.Join(source, name))
	}

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	kws, err := keywords.Load(filepath.Join(root, "keywords.json"))
	if err != nil {
		t.Fatal(err)
	}
	sess, err := NewSession(source, backup, result, newFakeExif(), fakeTZ{}, fakeGeocoder{}, fakeElevation{}, kws)
	if err != nil {
		t.Fatal(err)
	}
	return sess, source
}

func TestSession_Counts_ReflectsTaggedAndNonTagged(t *testing.T) {
	sess, _ := newTestSessionWithPhotos(t,
		"IMG_0001.jpg",
		"20240101-080000_home.jpg",
		"20240102-090000.jpg",
	)

	got := sess.Counts()
	if got[queue.ModeAll][queue.GeoAll] != 3 || got[queue.ModeNonTagged][queue.GeoAll] != 1 || got[queue.ModeTagged][queue.GeoAll] != 2 {
		t.Errorf("Counts() = %+v, want All 3, Non-Tagged 1, Tagged 2 under Geo All", got)
	}
}

// TestSession_GeoCounts_And_Start_FiltersByGeo guards that the Geo axis is
// independent of Mode (see CONTEXT.md's Mode definition, which is strictly
// about Tagged/Non-Tagged) and still ANDs with whichever Mode is selected.
func TestSession_GeoCounts_And_Start_FiltersByGeo(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")

	// a.jpg: Tagged, has GPS. b.jpg: Non-Tagged, missing GPS. c.jpg:
	// Non-Tagged, missing GPS. So Mode and Geo cut across each other.
	touch(t, filepath.Join(source, "20240101-080000.jpg"))
	touch(t, filepath.Join(source, "b.jpg"))
	touch(t, filepath.Join(source, "c.jpg"))

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	kws, err := keywords.Load(filepath.Join(root, "keywords.json"))
	if err != nil {
		t.Fatal(err)
	}
	exif := newFakeExif()
	exif.hasGPS[filepath.Join(source, "20240101-080000.jpg")] = true

	sess, err := NewSession(source, backup, result, exif, fakeTZ{}, fakeGeocoder{}, fakeElevation{}, kws)
	if err != nil {
		t.Fatal(err)
	}

	// Each count is the intersection a run with that Mode and Geo would
	// queue, not a per-axis total.
	gotCounts := sess.Counts()
	wantCounts := queueCounts{
		queue.ModeAll:       {queue.GeoAll: 3, queue.GeoMissingGPS: 2},
		queue.ModeNonTagged: {queue.GeoAll: 2, queue.GeoMissingGPS: 2},
		queue.ModeTagged:    {queue.GeoAll: 1, queue.GeoMissingGPS: 0},
	}
	if !reflect.DeepEqual(gotCounts, wantCounts) {
		t.Errorf("Counts() = %+v, want %+v", gotCounts, wantCounts)
	}

	sess.Start(queue.ModeAll, queue.GeoMissingGPS)
	if got := sess.Total(); got != 2 {
		t.Errorf("Total() after Start(All, MissingGPS) = %d, want 2", got)
	}

	sess.Start(queue.ModeNonTagged, queue.GeoMissingGPS)
	if got := sess.Total(); got != 2 {
		t.Errorf("Total() after Start(NonTagged, MissingGPS) = %d, want 2 (both missing-GPS photos are also Non-Tagged)", got)
	}

	sess.Start(queue.ModeTagged, queue.GeoMissingGPS)
	if got := sess.Total(); got != 0 {
		t.Errorf("Total() after Start(Tagged, MissingGPS) = %d, want 0 (the only Tagged photo has GPS)", got)
	}
}

func TestSession_Start_FiltersByMode(t *testing.T) {
	sess, _ := newTestSessionWithPhotos(t,
		"IMG_0001.jpg",
		"20240101-080000_home.jpg",
		"20240102-090000.jpg",
	)

	cases := []struct {
		mode queue.Mode
		want int
	}{
		{queue.ModeTagged, 2},
		{queue.ModeNonTagged, 1},
		{queue.ModeAll, 3},
	}
	for _, c := range cases {
		sess.Start(c.mode, queue.GeoAll)
		if got := sess.Total(); got != c.want {
			t.Errorf("Total() after Start(%q) = %d, want %d", c.mode, got, c.want)
		}
	}
}

func TestSession_Start_EmptyModeGoesToDone(t *testing.T) {
	// Both fixture photos below are Non-Tagged, so Tagged mode matches none.
	sess, _ := newTestSessionWithPhotos(t, "a.jpg", "b.jpg")
	sess.Start(queue.ModeTagged, queue.GeoAll)

	cur, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if !cur.Done {
		t.Fatal("expected Done when the selected mode matches zero photos")
	}
}

// TestSession_Start_AllModeIsChronologicalInterleave guards that All mode
// orders Tagged and Non-Tagged photos together by DateTimeOriginal, not
// grouped by tagging status -- the filenames here are deliberately in the
// opposite order from their EXIF dates so a filename-based sort would fail
// this test.
func TestSession_Start_AllModeIsChronologicalInterleave(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")

	taggedPath := filepath.Join(source, "20240103-080000.jpg") // Tagged, filename sorts last
	nonTaggedPath := filepath.Join(source, "a_earlier.jpg")    // Non-Tagged, filename sorts first
	touch(t, taggedPath)
	touch(t, nonTaggedPath)

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	kws, err := keywords.Load(filepath.Join(root, "keywords.json"))
	if err != nil {
		t.Fatal(err)
	}
	exif := newFakeExif()
	exif.dates[taggedPath] = time.Date(2024, 1, 3, 8, 0, 0, 0, time.UTC)
	exif.dates[nonTaggedPath] = time.Date(2024, 1, 1, 8, 0, 0, 0, time.UTC) // earlier despite filename

	sess, err := NewSession(source, backup, result, exif, fakeTZ{}, fakeGeocoder{}, fakeElevation{}, kws)
	if err != nil {
		t.Fatal(err)
	}
	sess.Start(queue.ModeAll, queue.GeoAll)

	first, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if first.RelPath != "a_earlier.jpg" {
		t.Errorf("first entry = %q, want the chronologically earliest photo (a_earlier.jpg) despite filename order", first.RelPath)
	}
}

func TestSession_CurrentAndDone(t *testing.T) {
	sess, _, _ := newTestSession(t)

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
	sess, source, _ := newTestSession(t)
	before, _ := sess.Current()

	sess.Skip()

	if _, err := os.Stat(filepath.Join(source, before.RelPath)); err != nil {
		t.Errorf("Skip must not move the file: %v", err)
	}
}

func TestSession_Prev_UndoesSkip(t *testing.T) {
	sess, _, _ := newTestSession(t)
	first, _ := sess.Current()

	sess.Skip()
	sess.Prev()

	back, _ := sess.Current()
	if back.RelPath != first.RelPath {
		t.Errorf("Prev() gave %q, want %q", back.RelPath, first.RelPath)
	}
}

func TestSession_Prev_NoopWhenNothingEarlier(t *testing.T) {
	sess, _, _ := newTestSession(t)
	first, _ := sess.Current()

	sess.Prev() // already at index 0

	back, _ := sess.Current()
	if back.RelPath != first.RelPath {
		t.Errorf("Prev() at index 0 should be a no-op, got %q", back.RelPath)
	}
}

// TestSession_Prev_StepsBackIntoAppliedPhoto guards ADR-0005's change: since
// Apply renames a photo in place instead of moving it out of the source
// directory, there's nothing stopping Prev from stepping back into an
// already-Applied photo to revisit or correct it.
func TestSession_Prev_StepsBackIntoAppliedPhoto(t *testing.T) {
	sess, _, _ := newTestSession(t)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:00"}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	// Now at index 1 (last photo), index 0 already Applied but still in place.
	sess.Prev()

	cur, _ := sess.Current()
	if cur.Done {
		t.Fatal("expected the first (Applied) photo, not Done")
	}
	if cur.Index != 0 {
		t.Errorf("Prev() should step back into the Applied photo, got index %d", cur.Index)
	}
}

func TestSession_Apply_RequiresDateTime(t *testing.T) {
	sess, _, _ := newTestSession(t)
	if _, err := sess.Apply(ApplyRequest{}); err == nil {
		t.Fatal("expected error when dateTime is missing")
	}
}

func TestSession_Apply_RequiresOffsetWhenDateTimeTouched(t *testing.T) {
	sess, _, _ := newTestSession(t)
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", DateTimeTouched: true}
	if _, err := sess.Apply(req); err == nil {
		t.Fatal("expected error when datetime touched but offset missing")
	}
}

func TestSession_Apply_WritesOnlyTouchedFields(t *testing.T) {
	sess, _, exif := newTestSession(t)
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

func TestSession_Apply_RenamesInPlace(t *testing.T) {
	sess, source, _ := newTestSession(t)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(source, "20240714-143022.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected file at %s: %v", want, err)
	}
}

func TestSession_Apply_RenamesInPlaceWithinSubfolder(t *testing.T) {
	sess, source, _ := newTestSession(t)

	// First photo (a.jpg, top-level) then second (sub/b.jpg).
	sess.Skip()
	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}

	want := filepath.Join(source, "sub", "20240714-143022.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
}

func TestSession_Apply_SlugFromLocatedKeyword(t *testing.T) {
	sess, source, _ := newTestSession(t)

	lat, lon := 53.35, -6.26
	req := ApplyRequest{
		DateTime:        "2024-07-14T14:30:22",
		LocationTouched: true,
		Lat:             &lat,
		Lon:             &lon,
		LocatedKeyword:  "Home",
	}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(source, "20240714-143022_home.jpg")
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected %s to exist: %v", want, err)
	}
}

func TestSession_Apply_SlugFromGeocodeWhenNoLocatedKeyword(t *testing.T) {
	sess, source, _ := newTestSession(t)

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
	want := filepath.Join(source, "20240714-143022_dublin.jpg")
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected %s to exist: %v", want, err)
	}
}

func TestSession_Apply_NoSlugWhenNoLocation(t *testing.T) {
	sess, source, _ := newTestSession(t)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(source, "20240714-143022.jpg")
	if _, err := os.Stat(want); err != nil {
		t.Errorf("expected %s to exist: %v", want, err)
	}
}

func TestSession_Apply_CollisionAppendsSuffix(t *testing.T) {
	sess, source, _ := newTestSession(t)

	// Pre-create a third file (not part of the queue) that will collide
	// with the computed name.
	touch(t, filepath.Join(source, "20240714-143022.jpg"))

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(source, "20240714-143022-01.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
}

// TestSession_Apply_ReApplyDoesNotSelfCollide guards the exists-check
// exclusion described in ADR-0005: re-Applying an already-Tagged photo with
// an unchanged correction recomputes the same filename it already has, which
// must not be treated as a collision against itself.
func TestSession_Apply_ReApplyDoesNotSelfCollide(t *testing.T) {
	sess, source, _ := newTestSession(t)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:22"}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	sess.Prev()

	res, err := sess.Apply(req)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(source, "20240714-143022.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q (unchanged correction must not append a collision suffix)", res.NewPath, want)
	}
}

// TestSession_Apply_ReApplyRenamesWhenCorrectionChanges guards the other
// half of re-Apply: a correction that actually changes the computed
// filename renames the file again, and the old Tagged name no longer exists.
func TestSession_Apply_ReApplyRenamesWhenCorrectionChanges(t *testing.T) {
	sess, source, _ := newTestSession(t)

	if _, err := sess.Apply(ApplyRequest{DateTime: "2024-07-14T14:30:22"}); err != nil {
		t.Fatal(err)
	}
	sess.Prev()

	res, err := sess.Apply(ApplyRequest{DateTime: "2024-07-14T15:00:00"})
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(source, "20240714-150000.jpg")
	if res.NewPath != want {
		t.Errorf("NewPath = %q, want %q", res.NewPath, want)
	}
	if _, err := os.Stat(filepath.Join(source, "20240714-143022.jpg")); !os.IsNotExist(err) {
		t.Errorf("expected old Tagged filename to no longer exist, stat err = %v", err)
	}
}

// TestSession_Apply_RejectsOverlappingApply guards against the root cause of
// intermittently-missing GPS/altitude writes: Apply reads the current photo
// and releases the lock before the slow exiftool write, then only re-acquires
// it afterwards to advance the queue. Without a busy guard, a second Apply
// arriving in that window would read the *same* current photo, silently
// duplicating or clobbering its write instead of being rejected outright.
func TestSession_Apply_RejectsOverlappingApply(t *testing.T) {
	sess, _, exif := newTestSession(t)

	var overlapCalled bool
	var overlapErr error
	exif.onWrite = func() {
		overlapCalled = true
		lat, lon := 53.35, -6.26
		_, overlapErr = sess.Apply(ApplyRequest{
			DateTime:        "2024-07-14T14:30:22",
			LocationTouched: true,
			Lat:             &lat,
			Lon:             &lon,
		})
	}

	if _, err := sess.Apply(ApplyRequest{DateTime: "2024-07-14T14:30:00"}); err != nil {
		t.Fatal(err)
	}

	if !overlapCalled {
		t.Fatal("expected the overlapping Apply to be attempted while the first was mid-write")
	}
	if overlapErr == nil {
		t.Fatal("expected the overlapping Apply to be rejected while another Apply is in progress")
	}
	if got := sess.Remaining(); got != 1 {
		t.Errorf("Remaining() = %d, want 1 (the overlapping call must not have advanced the queue)", got)
	}
}

func TestSession_Apply_AdvancesQueueAndRemaining(t *testing.T) {
	sess, _, _ := newTestSession(t)

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

// A second run (the Done screen's "Back to start") must see the first run's
// renames: Mode counts, GPS presence and the queued paths all reflect the
// Applied photo, or the second run would try to open a file that's gone.
func TestSession_StartAgainAfterApply_SeesTheRenamedPhoto(t *testing.T) {
	sess, _, _ := newTestSession(t)
	lat, lon := 53.35, -6.26
	if _, err := sess.Apply(ApplyRequest{
		DateTime: "2024-07-14T14:30:22", DateTimeTouched: true, Offset: "+01:00",
		Lat: &lat, Lon: &lon, LocationTouched: true,
	}); err != nil {
		t.Fatal(err)
	}

	got := sess.Counts()
	if got[queue.ModeTagged][queue.GeoAll] != 1 || got[queue.ModeNonTagged][queue.GeoAll] != 1 {
		t.Errorf("Counts() = %+v, want 1 Tagged, 1 Non-Tagged", got)
	}
	if got[queue.ModeAll][queue.GeoMissingGPS] != 1 {
		t.Errorf("Counts()[all][missing-gps] = %d, want 1", got[queue.ModeAll][queue.GeoMissingGPS])
	}

	sess.Start(queue.ModeTagged, queue.GeoAll)
	cur, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if cur.Done || cur.RelPath != "20240714-143022_dublin.jpg" {
		t.Errorf("Current() = {Done:%v RelPath:%q}, want the renamed photo", cur.Done, cur.RelPath)
	}
	if _, _, err := sess.Preview(); err != nil {
		t.Errorf("Preview() of the renamed photo: %v", err)
	}
}

func TestSession_Apply_PreviousValuesCascadeAcrossSkip(t *testing.T) {
	sess, _, _ := newTestSession(t)

	lat, lon := 53.35, -6.26
	req := ApplyRequest{
		DateTime:        "2024-07-14T14:30:22",
		LocationTouched: true,
		Lat:             &lat,
		Lon:             &lon,
		LocatedKeyword:  "Home",
	}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	cur, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	if cur.Previous.Location == nil {
		t.Fatal("expected Previous.Location to be set after an Apply with a pin")
	}
	if cur.Previous.Location.Lat != lat || cur.Previous.Location.LocatedKeyword != "Home" {
		t.Errorf("Previous.Location = %+v", cur.Previous.Location)
	}
}

func TestSession_Apply_PreviousValuesRecordUntouchedGroups(t *testing.T) {
	sess, _, _ := newTestSession(t)

	// Nothing Touched: the photo already had all of this.
	lat, lon, alt := 53.35, -6.26, 12.0
	if _, err := sess.Apply(ApplyRequest{
		DateTime: "2024-07-14T14:30:22", Offset: "+01:00",
		Lat: &lat, Lon: &lon, Alt: &alt, LocatedKeyword: "Home",
		Keywords: []string{"beach", "family"},
		Caption:  "Sandcastles",
	}); err != nil {
		t.Fatal(err)
	}

	prev := mustCurrent(t, sess).Previous
	wantDT := time.Date(2024, 7, 14, 14, 30, 22, 0, time.UTC)
	if prev.DateTime == nil || !prev.DateTime.DateTime.Equal(wantDT) || prev.DateTime.Offset != "+01:00" {
		t.Errorf("Previous.DateTime = %+v, want %v +01:00", prev.DateTime, wantDT)
	}
	if prev.Location == nil || prev.Location.Lat != lat || prev.Location.Lon != lon ||
		prev.Location.Alt == nil || *prev.Location.Alt != alt || prev.Location.LocatedKeyword != "Home" {
		t.Errorf("Previous.Location = %+v", prev.Location)
	}
	if prev.Keywords == nil || !reflect.DeepEqual(*prev.Keywords, []string{"beach", "family"}) {
		t.Errorf("Previous.Keywords = %v", prev.Keywords)
	}
	if prev.Caption == nil || *prev.Caption != "Sandcastles" {
		t.Errorf("Previous.Caption = %v", prev.Caption)
	}
}

func TestSession_Apply_PreviousValuesAreNilForGroupsThePhotoLacked(t *testing.T) {
	sess, _, _ := newTestSession(t)

	lat, lon := 53.35, -6.26
	if _, err := sess.Apply(ApplyRequest{
		DateTime: "2024-07-14T14:30:22", Lat: &lat, Lon: &lon, LocationTouched: true,
		Keywords: []string{"beach"}, KeywordsTouched: true, Caption: "x", CaptionTouched: true,
	}); err != nil {
		t.Fatal(err)
	}
	// Re-Apply the same photo with no pin, keywords or caption: the next
	// photo copies what this one ended up with, not an older Apply's values.
	sess.Prev()
	if _, err := sess.Apply(ApplyRequest{DateTime: "2024-07-14T14:30:22"}); err != nil {
		t.Fatal(err)
	}

	prev := mustCurrent(t, sess).Previous
	if prev.Location != nil || prev.Keywords != nil || prev.Caption != nil {
		t.Errorf("Previous = {Location:%v Keywords:%v Caption:%v}, want all nil", prev.Location, prev.Keywords, prev.Caption)
	}
	if prev.DateTime == nil {
		t.Error("Previous.DateTime is nil, but every Apply has a date")
	}
}

func mustCurrent(t *testing.T, sess *Session) CurrentPhoto {
	t.Helper()
	cur, err := sess.Current()
	if err != nil {
		t.Fatal(err)
	}
	return cur
}

func TestSession_ResolveTimezoneAndElevation(t *testing.T) {
	sess, _, _ := newTestSession(t)

	offset, zone, ok := sess.ResolveTimezone(53.35, -6.26, time.Now())
	if !ok || offset != "+01:00" || zone != "Europe/Dublin" {
		t.Errorf("ResolveTimezone = %q, %q, %v", offset, zone, ok)
	}

	alt, err := sess.LookupElevation(53.35, -6.26)
	if err != nil || alt != 20 {
		t.Errorf("LookupElevation = %v, %v", alt, err)
	}
}

func TestSession_DeleteKeyword_RemovesFromKnownListAndUsesPostRenamePaths(t *testing.T) {
	sess, source, exif := newTestSession(t)

	// Applying a.jpg renames it on disk (fixture photos start as a.jpg/b.jpg,
	// see newTestSession) -- allEntries still holds a.jpg's pre-rename path
	// afterwards (see DeleteKeyword's doc comment on why it re-scans instead
	// of reading allEntries).
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"beach"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	if err := sess.DeleteKeyword("beach"); err != nil {
		t.Fatal(err)
	}

	if got := sess.Keywords(); len(got) != 0 {
		t.Errorf("expected \"beach\" removed from known-keywords list, got %+v", got)
	}

	if len(exif.removedKeywordCalls) != 1 {
		t.Fatalf("expected one RemoveKeywordBatch call, got %d", len(exif.removedKeywordCalls))
	}
	call := exif.removedKeywordCalls[0]
	if call.kw != "beach" {
		t.Errorf("got kw %q, want %q", call.kw, "beach")
	}
	for _, p := range call.paths {
		if filepath.Base(p) == "a.jpg" {
			t.Errorf("RemoveKeywordBatch called with a.jpg's stale pre-rename path %q", p)
		}
	}

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]string, len(result.Photos))
	for i, p := range result.Photos {
		want[i] = p.Path
	}
	if !reflect.DeepEqual(call.paths, want) {
		t.Errorf("RemoveKeywordBatch paths = %+v, want current on-disk scan %+v", call.paths, want)
	}
}

func TestSession_DeleteKeyword_UnknownKeywordIsNoop(t *testing.T) {
	sess, _, exif := newTestSession(t)

	if err := sess.DeleteKeyword("never-used"); err != nil {
		t.Fatal(err)
	}
	if len(exif.removedKeywordCalls) != 1 {
		t.Fatalf("expected RemoveKeywordBatch to still be called (it's safe against photos without the keyword), got %d calls", len(exif.removedKeywordCalls))
	}
}

func TestSession_RenameKeyword_UpdatesStoreAndUsesPostRenamePaths(t *testing.T) {
	sess, source, exif := newTestSession(t)

	// Same stale-path setup as TestSession_DeleteKeyword's post-rename case:
	// Applying a.jpg renames it on disk, so RenameKeyword must use a fresh
	// scan rather than allEntries' stale pre-rename path.
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"beach"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	giveEveryPhotoKeyword(t, exif, source, "beach")

	if err := sess.RenameKeyword("beach", "seaside"); err != nil {
		t.Fatal(err)
	}

	got := sess.Keywords()
	if len(got) != 1 || got[0].Name != "seaside" {
		t.Errorf("Keywords() = %+v, want [seaside]", got)
	}

	if len(exif.renamedKeywordCalls) != 1 {
		t.Fatalf("expected one RenameKeywordBatch call, got %d", len(exif.renamedKeywordCalls))
	}
	call := exif.renamedKeywordCalls[0]
	if call.oldKw != "beach" || call.newKw != "seaside" {
		t.Errorf("got oldKw=%q newKw=%q, want beach/seaside", call.oldKw, call.newKw)
	}
	for _, p := range call.paths {
		if filepath.Base(p) == "a.jpg" {
			t.Errorf("RenameKeywordBatch called with a.jpg's stale pre-rename path %q", p)
		}
	}

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	want := make([]string, len(result.Photos))
	for i, p := range result.Photos {
		want[i] = p.Path
	}
	if !reflect.DeepEqual(call.paths, want) {
		t.Errorf("RenameKeywordBatch paths = %+v, want current on-disk scan %+v", call.paths, want)
	}
}

// giveEveryPhotoKeyword makes the fake report kw on every photo currently
// in source, by its post-Apply path -- the fake's WriteFields doesn't track
// keywords, and Apply renames files after writing them.
func giveEveryPhotoKeyword(t *testing.T, exif *fakeExif, source, kw string) {
	t.Helper()
	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range result.Photos {
		exif.keywords[p.Path] = append(exif.keywords[p.Path], kw)
	}
}

// exiftool's "-Keywords-=old -Keywords+=new" adds new to every file it's
// given, carrying old or not (issue #19), so only photos that carry old may
// be passed to it.
func TestSession_RenameKeyword_OnlyRewritesPhotosCarryingTheOldKeyword(t *testing.T) {
	sess, source, exif := newTestSession(t)
	withBeach := filepath.Join(source, "a.jpg")
	exif.keywords[withBeach] = []string{"family", "beach"}
	exif.keywords[filepath.Join(source, "sub", "b.jpg")] = []string{"family"}
	if err := sess.keywords.Add([]string{"beach"}); err != nil {
		t.Fatal(err)
	}

	if err := sess.RenameKeyword("beach", "seaside"); err != nil {
		t.Fatal(err)
	}

	if len(exif.renamedKeywordCalls) != 1 {
		t.Fatalf("expected one RenameKeywordBatch call, got %d", len(exif.renamedKeywordCalls))
	}
	if got := exif.renamedKeywordCalls[0].paths; !reflect.DeepEqual(got, []string{withBeach}) {
		t.Errorf("RenameKeywordBatch paths = %v, want only %v", got, []string{withBeach})
	}
}

func TestSession_RenameKeyword_NoPhotoCarriesIt_RenamesOnlyTheKnownKeyword(t *testing.T) {
	sess, _, exif := newTestSession(t)
	if err := sess.keywords.Add([]string{"beach"}); err != nil {
		t.Fatal(err)
	}

	if err := sess.RenameKeyword("beach", "seaside"); err != nil {
		t.Fatal(err)
	}

	if len(exif.renamedKeywordCalls) != 0 {
		t.Errorf("RenameKeywordBatch called with %v, want no call", exif.renamedKeywordCalls[0].paths)
	}
	if got := sess.Keywords(); len(got) != 1 || got[0].Name != "seaside" {
		t.Errorf("Keywords() = %+v, want [seaside]", got)
	}
}

func TestSession_RenameKeyword_PreservesLocation(t *testing.T) {
	sess, _, _ := newTestSession(t)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"concert"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	loc := keywords.Location{Lat: 1, Lon: 2, Alt: 3}
	if err := sess.SetKeywordLocation("concert", loc); err != nil {
		t.Fatal(err)
	}

	if err := sess.RenameKeyword("concert", "gig"); err != nil {
		t.Fatal(err)
	}

	got := sess.Keywords()
	if len(got) != 1 || got[0].Name != "gig" || got[0].Location == nil || *got[0].Location != loc {
		t.Errorf("Keywords() = %+v, want \"gig\" carrying %+v", got, loc)
	}
}

func TestSession_RenameKeyword_NoopWhenNamesEqual(t *testing.T) {
	sess, _, exif := newTestSession(t)
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"beach"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	if err := sess.RenameKeyword("beach", "beach"); err != nil {
		t.Fatal(err)
	}
	if len(exif.renamedKeywordCalls) != 0 {
		t.Errorf("renaming to the same name must not touch any file, got %d RenameKeywordBatch calls", len(exif.renamedKeywordCalls))
	}
}

func TestSession_RenameKeyword_RejectsBlankNewName(t *testing.T) {
	sess, _, exif := newTestSession(t)
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"beach"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	if err := sess.RenameKeyword("beach", "   "); err == nil {
		t.Fatal("expected error renaming to a blank name")
	}
	if len(exif.renamedKeywordCalls) != 0 {
		t.Errorf("a rejected rename must not touch any file, got %d RenameKeywordBatch calls", len(exif.renamedKeywordCalls))
	}
}

// TestSession_RenameKeyword_RejectsCollisionBeforeTouchingFiles guards that
// the destination-name collision check happens before the directory-wide
// EXIF rewrite, not just inside keywords.Store.Rename afterwards -- a
// rejected rename must never touch a single file on disk.
func TestSession_RenameKeyword_RejectsCollisionBeforeTouchingFiles(t *testing.T) {
	sess, _, exif := newTestSession(t)
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"beach", "family"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	if err := sess.RenameKeyword("beach", "family"); err == nil {
		t.Fatal("expected error renaming onto an existing different keyword")
	}
	if len(exif.renamedKeywordCalls) != 0 {
		t.Errorf("a rejected rename must not touch any file, got %d RenameKeywordBatch calls", len(exif.renamedKeywordCalls))
	}
}

// TestSession_RenameKeyword_LeavesStoreUnchangedOnExifError guards the
// ordering established for DeleteKeyword: the directory-wide EXIF rewrite
// happens before the local keywords.json update, so a failed rewrite must
// not have already renamed the keyword in the known list.
func TestSession_RenameKeyword_LeavesStoreUnchangedOnExifError(t *testing.T) {
	sess, source, exif := newTestSession(t)
	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"beach"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}
	giveEveryPhotoKeyword(t, exif, source, "beach")
	exif.renameErr = fmt.Errorf("exiftool exploded")

	if err := sess.RenameKeyword("beach", "seaside"); err == nil {
		t.Fatal("expected the EXIF rewrite failure to propagate")
	}

	got := sess.Keywords()
	if len(got) != 1 || got[0].Name != "beach" {
		t.Errorf("Keywords() = %+v, want [beach] unchanged after a failed rewrite", got)
	}
}

func TestSession_SetAndClearKeywordLocation(t *testing.T) {
	sess, _, _ := newTestSession(t)

	req := ApplyRequest{DateTime: "2024-07-14T14:30:00", Keywords: []string{"concert"}, KeywordsTouched: true}
	if _, err := sess.Apply(req); err != nil {
		t.Fatal(err)
	}

	loc := keywords.Location{Lat: 40.7128, Lon: -74.006, Alt: 10}
	if err := sess.SetKeywordLocation("concert", loc); err != nil {
		t.Fatalf("SetKeywordLocation: %v", err)
	}
	got := sess.Keywords()
	if len(got) != 1 || got[0].Location == nil || *got[0].Location != loc {
		t.Fatalf("Keywords() = %+v, want concert carrying %+v", got, loc)
	}

	if err := sess.ClearKeywordLocation("concert"); err != nil {
		t.Fatalf("ClearKeywordLocation: %v", err)
	}
	got = sess.Keywords()
	if len(got) != 1 || got[0].Location != nil {
		t.Errorf("Keywords() = %+v, want Location cleared", got)
	}
}

func TestNewSession_SeedsKeywordsFromExistingPhotos(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	backup := filepath.Join(root, "source-backup")

	touch(t, filepath.Join(source, "a.jpg"))
	touch(t, filepath.Join(source, "b.jpg"))

	result, err := scan.Scan(source)
	if err != nil {
		t.Fatal(err)
	}

	exif := newFakeExif()
	exif.keywords[filepath.Join(source, "a.jpg")] = []string{"beach", "family"}
	exif.keywords[filepath.Join(source, "b.jpg")] = []string{"family", "sunset"}

	kws, err := keywords.Load(filepath.Join(root, "keywords.json"))
	if err != nil {
		t.Fatal(err)
	}

	sess, err := NewSession(source, backup, result, exif, fakeTZ{}, fakeGeocoder{}, fakeElevation{}, kws)
	if err != nil {
		t.Fatal(err)
	}

	got := make([]string, len(sess.Keywords()))
	for i, k := range sess.Keywords() {
		got[i] = k.Name
	}
	want := []string{"beach", "family", "sunset"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Keywords() names = %+v, want %+v", got, want)
	}
}
