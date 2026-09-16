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

func TestReadDateTimeOriginal_Present(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("2024:07:14 14:30:22\n")}}
	c := NewWithRunner(r)

	dt, ok, err := c.ReadDateTimeOriginal("photo.jpg")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !ok {
		t.Fatal("ok = false, want true")
	}
	want := time.Date(2024, 7, 14, 14, 30, 22, 0, time.UTC)
	if !dt.Equal(want) {
		t.Errorf("dt = %v, want %v", dt, want)
	}
}

func TestReadDateTimeOriginal_Absent(t *testing.T) {
	r := &fakeRunner{outputs: [][]byte{[]byte("-\n")}}
	c := NewWithRunner(r)

	_, ok, err := c.ReadDateTimeOriginal("photo.jpg")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if ok {
		t.Error("ok = true, want false for missing tag")
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
