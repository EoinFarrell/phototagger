package exiftool

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

type fakeRunner struct {
	calls   [][]string
	outputs [][]byte
	errs    []error
	i       int
}

func (f *fakeRunner) Output(args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	idx := f.i
	f.i++
	var out []byte
	var err error
	if idx < len(f.outputs) {
		out = f.outputs[idx]
	}
	if idx < len(f.errs) {
		err = f.errs[idx]
	}
	return out, err
}

func TestReadDateTimeOriginalBatch(t *testing.T) {
	json := `[
		{"SourceFile":"a.jpg","DateTimeOriginal":"2024:07:14 14:30:22"},
		{"SourceFile":"b.jpg"},
		{"SourceFile":"c.jpg","DateTimeOriginal":"2024:01:01 08:00:00"}
	]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	dates, err := c.ReadDateTimeOriginalBatch([]string{"a.jpg", "b.jpg", "c.jpg"})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(dates) != 2 {
		t.Fatalf("got %d dates, want 2 (b.jpg has none): %v", len(dates), dates)
	}
	if !dates["a.jpg"].Equal(time.Date(2024, 7, 14, 14, 30, 22, 0, time.UTC)) {
		t.Errorf("a.jpg = %v", dates["a.jpg"])
	}
	if !dates["c.jpg"].Equal(time.Date(2024, 1, 1, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("c.jpg = %v", dates["c.jpg"])
	}
	if _, ok := dates["b.jpg"]; ok {
		t.Errorf("b.jpg should be absent from the map, got %v", dates["b.jpg"])
	}

	// One exiftool invocation for the whole batch, not one per file.
	if len(r.calls) != 1 {
		t.Fatalf("expected 1 exiftool invocation, got %d: %v", len(r.calls), r.calls)
	}
	args := r.calls[0]
	for _, want := range []string{"-j", "-DateTimeOriginal", "a.jpg", "b.jpg", "c.jpg"} {
		found := false
		for _, a := range args {
			if a == want {
				found = true
			}
		}
		if !found {
			t.Errorf("args %v missing %q", args, want)
		}
	}
}

func TestReadDateTimeOriginalBatch_Empty(t *testing.T) {
	r := &fakeRunner{}
	c := NewWithRunner(r)

	dates, err := c.ReadDateTimeOriginalBatch(nil)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(dates) != 0 {
		t.Errorf("got %v, want empty", dates)
	}
	if len(r.calls) != 0 {
		t.Errorf("expected no exiftool invocation for an empty batch, got %v", r.calls)
	}
}

func TestReadKeywordsBatch(t *testing.T) {
	json := `[
		{"SourceFile":"a.jpg","Keywords":["beach","family"]},
		{"SourceFile":"b.jpg"},
		{"SourceFile":"c.jpg","Keywords":"solo"}
	]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	kws, err := c.ReadKeywordsBatch([]string{"a.jpg", "b.jpg", "c.jpg"})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !reflect.DeepEqual(kws["a.jpg"], []string{"beach", "family"}) {
		t.Errorf("a.jpg = %v", kws["a.jpg"])
	}
	if !reflect.DeepEqual(kws["c.jpg"], []string{"solo"}) {
		t.Errorf("c.jpg = %v", kws["c.jpg"])
	}
	if _, ok := kws["b.jpg"]; ok {
		t.Errorf("b.jpg should be absent from the map, got %v", kws["b.jpg"])
	}

	if len(r.calls) != 1 {
		t.Fatalf("expected 1 exiftool invocation, got %d: %v", len(r.calls), r.calls)
	}
	args := r.calls[0]
	for _, want := range []string{"-j", "-Keywords", "a.jpg", "b.jpg", "c.jpg"} {
		found := false
		for _, a := range args {
			if a == want {
				found = true
			}
		}
		if !found {
			t.Errorf("args %v missing %q", args, want)
		}
	}
}

func TestReadKeywordsBatch_Empty(t *testing.T) {
	r := &fakeRunner{}
	c := NewWithRunner(r)

	kws, err := c.ReadKeywordsBatch(nil)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(kws) != 0 {
		t.Errorf("got %v, want empty", kws)
	}
	if len(r.calls) != 0 {
		t.Errorf("expected no exiftool invocation for an empty batch, got %v", r.calls)
	}
}

func TestReadGPSPresenceBatch(t *testing.T) {
	json := `[
		{"SourceFile":"a.jpg","GPSLatitude":53.3498,"GPSLongitude":-6.2603},
		{"SourceFile":"b.jpg"},
		{"SourceFile":"c.jpg","GPSLatitude":40.7128}
	]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	has, err := c.ReadGPSPresenceBatch([]string{"a.jpg", "b.jpg", "c.jpg"})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !has["a.jpg"] {
		t.Error("a.jpg has both lat and lon, want has[a.jpg] = true")
	}
	if has["b.jpg"] {
		t.Error("b.jpg has neither, want has[b.jpg] = false")
	}
	if has["c.jpg"] {
		t.Error("c.jpg has only latitude, want has[c.jpg] = false")
	}

	if len(r.calls) != 1 {
		t.Fatalf("expected 1 exiftool invocation, got %d: %v", len(r.calls), r.calls)
	}
	args := r.calls[0]
	for _, want := range []string{"-n", "-j", "-GPSLatitude", "-GPSLongitude", "a.jpg", "b.jpg", "c.jpg"} {
		found := false
		for _, a := range args {
			if a == want {
				found = true
			}
		}
		if !found {
			t.Errorf("args %v missing %q", args, want)
		}
	}
}

// TestReadGPSPresenceBatch_ToleratesNonNumericValue guards against a crash
// seen against a real photo library: despite -n, exiftool can still emit a
// GPS tag as a non-numeric JSON value (e.g. a string) for a photo with
// malformed GPS EXIF data. Presence detection only needs to know the tag
// was there, not parse it, so this must still report it as present instead
// of erroring out the whole batch.
func TestReadGPSPresenceBatch_ToleratesNonNumericValue(t *testing.T) {
	json := `[
		{"SourceFile":"a.jpg","GPSLatitude":"malformed","GPSLongitude":"malformed"},
		{"SourceFile":"b.jpg"}
	]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	has, err := c.ReadGPSPresenceBatch([]string{"a.jpg", "b.jpg"})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !has["a.jpg"] {
		t.Error("a.jpg has a (malformed but present) GPS tag, want has[a.jpg] = true")
	}
	if has["b.jpg"] {
		t.Error("b.jpg has no GPS tag at all, want has[b.jpg] = false")
	}
}

func TestReadGPSPresenceBatch_Empty(t *testing.T) {
	r := &fakeRunner{}
	c := NewWithRunner(r)

	has, err := c.ReadGPSPresenceBatch(nil)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(has) != 0 {
		t.Errorf("got %v, want empty", has)
	}
	if len(r.calls) != 0 {
		t.Errorf("expected no exiftool invocation for an empty batch, got %v", r.calls)
	}
}

func TestExtractPreview_PrefersPreviewImage(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("preview-bytes")}}
	c := NewWithRunner(r)

	data, err := c.ExtractPreview("photo.heic")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if string(data) != "preview-bytes" {
		t.Errorf("data = %q", data)
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected 1 call when PreviewImage succeeds, got %d", len(r.calls))
	}
}

func TestExtractPreview_FallsBackToThumbnail(t *testing.T) {
	r := &fakeRunner{
		outputs: [][]byte{{}, []byte("thumb-bytes")},
		errs:    []error{errors.New("no PreviewImage"), nil},
	}
	c := NewWithRunner(r)

	data, err := c.ExtractPreview("photo.heic")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if string(data) != "thumb-bytes" {
		t.Errorf("data = %q", data)
	}
	if len(r.calls) != 2 {
		t.Fatalf("expected 2 calls, got %d", len(r.calls))
	}
}

func TestExtractPreview_BothFail(t *testing.T) {
	r := &fakeRunner{
		errs: []error{errors.New("no preview"), errors.New("no thumb")},
	}
	c := NewWithRunner(r)

	if _, err := c.ExtractPreview("photo.heic"); err == nil {
		t.Fatal("expected error when neither preview nor thumbnail is available")
	}
}

func TestReadExisting_FullRecord(t *testing.T) {
	json := `[{"SourceFile":"photo.jpg","DateTimeOriginal":"2024:07:14 14:30:22","OffsetTimeOriginal":"+01:00","GPSLatitude":53.3498,"GPSLongitude":-6.2603,"GPSAltitude":12.5,"Keywords":["dublin","family"],"ImageDescription":"A caption"}]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	e, err := c.ReadExisting("photo.jpg")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if e.DateTime == nil || !e.DateTime.Equal(time.Date(2024, 7, 14, 14, 30, 22, 0, time.UTC)) {
		t.Errorf("DateTime = %v", e.DateTime)
	}
	if e.OffsetTimeOriginal == nil || *e.OffsetTimeOriginal != "+01:00" {
		t.Errorf("OffsetTimeOriginal = %v", e.OffsetTimeOriginal)
	}
	if e.Latitude == nil || *e.Latitude != 53.3498 {
		t.Errorf("Latitude = %v", e.Latitude)
	}
	if e.Longitude == nil || *e.Longitude != -6.2603 {
		t.Errorf("Longitude = %v", e.Longitude)
	}
	if e.Altitude == nil || *e.Altitude != 12.5 {
		t.Errorf("Altitude = %v", e.Altitude)
	}
	if len(e.Keywords) != 2 || e.Keywords[0] != "dublin" || e.Keywords[1] != "family" {
		t.Errorf("Keywords = %v", e.Keywords)
	}
	if e.Caption == nil || *e.Caption != "A caption" {
		t.Errorf("Caption = %v", e.Caption)
	}
}

func TestReadExisting_SingleKeywordAsString(t *testing.T) {
	json := `[{"SourceFile":"photo.jpg","Keywords":"solo"}]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	e, err := c.ReadExisting("photo.jpg")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(e.Keywords) != 1 || e.Keywords[0] != "solo" {
		t.Errorf("Keywords = %v", e.Keywords)
	}
}

func TestReadExisting_EmptyRecord(t *testing.T) {
	json := `[{"SourceFile":"photo.jpg"}]`
	r := &fakeRunner{outputs: [][]byte{[]byte(json)}}
	c := NewWithRunner(r)

	e, err := c.ReadExisting("photo.jpg")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if e.DateTime != nil || e.Latitude != nil || e.Longitude != nil || e.Altitude != nil || e.Caption != nil || len(e.Keywords) != 0 {
		t.Errorf("expected all-empty Existing, got %+v", e)
	}
}

func TestFieldsTouched(t *testing.T) {
	if (Fields{}).Touched() {
		t.Error("empty Fields should not be Touched")
	}
	dt := time.Now()
	if !(Fields{DateTime: &dt}).Touched() {
		t.Error("Fields with DateTime set should be Touched")
	}
}

func TestWriteFields_NoopWhenUntouched(t *testing.T) {
	r := &fakeRunner{}
	c := NewWithRunner(r)

	if err := c.WriteFields("photo.jpg", Fields{}); err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 0 {
		t.Errorf("expected no exiftool invocation for untouched fields, got %v", r.calls)
	}
}

func TestWriteFields_BuildsExpectedArgs(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("1 image files updated")}}
	c := NewWithRunner(r)

	dt := time.Date(2024, 7, 14, 14, 30, 22, 0, time.UTC)
	lat, lon, alt := 53.3498, -6.2603, 12.5
	offset := "+01:00"
	caption := "A caption"
	keywords := []string{"dublin", "family"}

	err := c.WriteFields("photo.jpg", Fields{
		DateTime:           &dt,
		OffsetTimeOriginal: &offset,
		Latitude:           &lat,
		Longitude:          &lon,
		Altitude:           &alt,
		Keywords:           &keywords,
		Caption:            &caption,
	})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected 1 exiftool invocation, got %d: %v", len(r.calls), r.calls)
	}
	args := r.calls[0]

	mustContain := []string{
		"-overwrite_original",
		"-AllDates=2024:07:14 14:30:22",
		"-OffsetTimeOriginal=+01:00",
		"-GPSLatitude=53.3498",
		"-GPSLatitudeRef=N",
		"-GPSLongitude=6.2603",
		"-GPSLongitudeRef=W",
		"-GPSAltitude=12.5",
		"-GPSAltitudeRef=0",
		"-ImageDescription=A caption",
		"-IPTC:Caption-Abstract=A caption",
		"-Keywords=",
		"-Keywords+=dublin",
		"-Keywords+=family",
		"photo.jpg",
	}
	for _, want := range mustContain {
		found := false
		for _, a := range args {
			if a == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("args %v missing %q", args, want)
		}
	}
	// path must be last.
	if args[len(args)-1] != "photo.jpg" {
		t.Errorf("expected path last, got args = %v", args)
	}
	// OffsetTime/OffsetTimeDigitized must never be written (ADR-0002).
	for _, a := range args {
		if a == "-OffsetTime=" || a == "-OffsetTimeDigitized=" || reflect.DeepEqual(a, "-OffsetTime") {
			t.Errorf("must not write OffsetTime/OffsetTimeDigitized, got arg %q", a)
		}
	}
}

func TestWriteFields_NegativeLatLon(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("ok")}}
	c := NewWithRunner(r)

	lat, lon := -33.8688, 151.2093 // Sydney: S, E
	err := c.WriteFields("photo.jpg", Fields{Latitude: &lat, Longitude: &lon})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	args := r.calls[0]
	mustContain := []string{"-GPSLatitude=33.8688", "-GPSLatitudeRef=S", "-GPSLongitude=151.2093", "-GPSLongitudeRef=E"}
	for _, want := range mustContain {
		found := false
		for _, a := range args {
			if a == want {
				found = true
			}
		}
		if !found {
			t.Errorf("args %v missing %q", args, want)
		}
	}
}

func TestWriteFields_NegativeAltitude(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("ok")}}
	c := NewWithRunner(r)

	alt := -10.0
	err := c.WriteFields("photo.jpg", Fields{Altitude: &alt})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	args := r.calls[0]
	mustContain := []string{"-GPSAltitude=10", "-GPSAltitudeRef=1"}
	for _, want := range mustContain {
		found := false
		for _, a := range args {
			if a == want {
				found = true
			}
		}
		if !found {
			t.Errorf("args %v missing %q", args, want)
		}
	}
}

func TestWriteFields_KeywordsClearedWhenEmptySlice(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("ok")}}
	c := NewWithRunner(r)

	empty := []string{}
	err := c.WriteFields("photo.jpg", Fields{Keywords: &empty})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	args := r.calls[0]
	if len(args) < 2 {
		t.Fatalf("unexpected args: %v", args)
	}
	found := false
	for _, a := range args {
		if a == "-Keywords=" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected -Keywords= to clear, got %v", args)
	}
}

func TestRemoveKeywordBatch_BuildsExpectedArgs(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("1 image files updated")}}
	c := NewWithRunner(r)

	if err := c.RemoveKeywordBatch([]string{"a.jpg", "b.jpg"}, "beach"); err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected 1 invocation, got %d", len(r.calls))
	}
	want := []string{"-overwrite_original", "-Keywords-=beach", "a.jpg", "b.jpg"}
	if !reflect.DeepEqual(r.calls[0], want) {
		t.Errorf("args = %v, want %v", r.calls[0], want)
	}
}

func TestRemoveKeywordBatch_ChunksLargePathLists(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("ok"), []byte("ok"), []byte("ok")}}
	c := NewWithRunner(r)

	paths := make([]string, removeKeywordBatchSize*2+5)
	for i := range paths {
		paths[i] = "p.jpg"
	}

	if err := c.RemoveKeywordBatch(paths, "beach"); err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 3 {
		t.Fatalf("expected 3 batched invocations, got %d", len(r.calls))
	}
	// Each call's path count is its args minus the two flags.
	if got := len(r.calls[0]) - 2; got != removeKeywordBatchSize {
		t.Errorf("first batch had %d paths, want %d", got, removeKeywordBatchSize)
	}
	if got := len(r.calls[2]) - 2; got != 5 {
		t.Errorf("last batch had %d paths, want 5", got)
	}
}

func TestRenameKeywordBatch_BuildsExpectedArgs(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("1 image files updated")}}
	c := NewWithRunner(r)

	if err := c.RenameKeywordBatch([]string{"a.jpg", "b.jpg"}, "beach", "seaside"); err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected 1 invocation, got %d", len(r.calls))
	}
	want := []string{"-overwrite_original", "-Keywords-=beach", "-Keywords+=seaside", "a.jpg", "b.jpg"}
	if !reflect.DeepEqual(r.calls[0], want) {
		t.Errorf("args = %v, want %v", r.calls[0], want)
	}
}

func TestRenameKeywordBatch_ChunksLargePathLists(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("ok"), []byte("ok"), []byte("ok")}}
	c := NewWithRunner(r)

	paths := make([]string, removeKeywordBatchSize*2+5)
	for i := range paths {
		paths[i] = "p.jpg"
	}

	if err := c.RenameKeywordBatch(paths, "beach", "seaside"); err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 3 {
		t.Fatalf("expected 3 batched invocations, got %d", len(r.calls))
	}
}

func TestRemoveKeywordBatch_EmptyPathsIsNoop(t *testing.T) {
	r := &fakeRunner{}
	c := NewWithRunner(r)

	if err := c.RemoveKeywordBatch(nil, "beach"); err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 0 {
		t.Errorf("expected no exiftool invocation for an empty path list, got %d", len(r.calls))
	}
}
