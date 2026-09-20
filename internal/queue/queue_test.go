package queue

import (
	"testing"
	"time"

	"phototagger/internal/scan"
)

func dt(s string) *time.Time {
	t, err := time.Parse("2006-01-02 15:04:05", s)
	if err != nil {
		panic(err)
	}
	return &t
}

func TestOrder_ByDateTimeOriginal(t *testing.T) {
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "c.jpg"}, DateTimeOriginal: dt("2024-07-14 12:00:00")},
		{Photo: scan.Photo{RelPath: "a.jpg"}, DateTimeOriginal: dt("2024-01-01 08:00:00")},
		{Photo: scan.Photo{RelPath: "b.jpg"}, DateTimeOriginal: dt("2024-05-01 08:00:00")},
	}
	got := Order(entries)
	want := []string{"a.jpg", "b.jpg", "c.jpg"}
	for i, w := range want {
		if got[i].Photo.RelPath != w {
			t.Errorf("position %d = %q, want %q", i, got[i].Photo.RelPath, w)
		}
	}
}

func TestOrder_UnknownDatesSortAfterKnown_ByFilename(t *testing.T) {
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "zebra.jpg"}, DateTimeOriginal: nil},
		{Photo: scan.Photo{RelPath: "known.jpg"}, DateTimeOriginal: dt("2024-07-14 12:00:00")},
		{Photo: scan.Photo{RelPath: "apple.jpg"}, DateTimeOriginal: nil},
	}
	got := Order(entries)
	want := []string{"known.jpg", "apple.jpg", "zebra.jpg"}
	for i, w := range want {
		if got[i].Photo.RelPath != w {
			t.Errorf("position %d = %q, want %q", i, got[i].Photo.RelPath, w)
		}
	}
}

func TestOrder_StableAndDoesNotMutateInput(t *testing.T) {
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "b.jpg"}, DateTimeOriginal: nil},
		{Photo: scan.Photo{RelPath: "a.jpg"}, DateTimeOriginal: nil},
	}
	orig := append([]Entry{}, entries...)

	_ = Order(entries)

	for i := range entries {
		if entries[i].Photo.RelPath != orig[i].Photo.RelPath {
			t.Errorf("Order mutated its input slice")
		}
	}
}

func TestParseMode(t *testing.T) {
	valid := []Mode{ModeAll, ModeNonTagged, ModeTagged}
	for _, m := range valid {
		got, ok := ParseMode(string(m))
		if !ok || got != m {
			t.Errorf("ParseMode(%q) = %v, %v, want %v, true", m, got, ok, m)
		}
	}
	if _, ok := ParseMode("bogus"); ok {
		t.Error("ParseMode(\"bogus\") = true, want false")
	}
}

func TestFilter_All_ReturnsEveryEntryUnfiltered(t *testing.T) {
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "a.jpg"}, Tagged: true},
		{Photo: scan.Photo{RelPath: "b.jpg"}, Tagged: false},
	}
	got := Filter(entries, ModeAll)
	if len(got) != 2 {
		t.Fatalf("Filter(ModeAll) len = %d, want 2", len(got))
	}
}

func TestFilter_NonTagged_ExcludesTagged(t *testing.T) {
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "a.jpg"}, Tagged: true},
		{Photo: scan.Photo{RelPath: "b.jpg"}, Tagged: false},
		{Photo: scan.Photo{RelPath: "c.jpg"}, Tagged: false},
	}
	got := Filter(entries, ModeNonTagged)
	want := []string{"b.jpg", "c.jpg"}
	if len(got) != len(want) {
		t.Fatalf("Filter(ModeNonTagged) len = %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Photo.RelPath != w {
			t.Errorf("position %d = %q, want %q", i, got[i].Photo.RelPath, w)
		}
	}
}

func TestFilter_Tagged_ExcludesNonTagged(t *testing.T) {
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "a.jpg"}, Tagged: true},
		{Photo: scan.Photo{RelPath: "b.jpg"}, Tagged: false},
		{Photo: scan.Photo{RelPath: "c.jpg"}, Tagged: true},
	}
	got := Filter(entries, ModeTagged)
	want := []string{"a.jpg", "c.jpg"}
	if len(got) != len(want) {
		t.Fatalf("Filter(ModeTagged) len = %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Photo.RelPath != w {
			t.Errorf("position %d = %q, want %q", i, got[i].Photo.RelPath, w)
		}
	}
}

func TestOrder_TieBreakSameTimestamp(t *testing.T) {
	same := dt("2024-07-14 12:00:00")
	entries := []Entry{
		{Photo: scan.Photo{RelPath: "z.jpg"}, DateTimeOriginal: same},
		{Photo: scan.Photo{RelPath: "a.jpg"}, DateTimeOriginal: same},
	}
	got := Order(entries)
	if got[0].Photo.RelPath != "a.jpg" || got[1].Photo.RelPath != "z.jpg" {
		t.Errorf("expected filename tie-break, got %q, %q", got[0].Photo.RelPath, got[1].Photo.RelPath)
	}
}
