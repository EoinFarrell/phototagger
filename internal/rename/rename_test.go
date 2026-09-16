package rename

import (
	"testing"
	"time"
)

func TestFilename(t *testing.T) {
	dt := time.Date(2024, 7, 14, 14, 30, 22, 0, time.UTC)
	cases := []struct {
		slug, ext, want string
	}{
		{"dublin", "jpg", "20240714-143022_dublin.jpg"},
		{"", "jpg", "20240714-143022.jpg"},
		{"dublin", "JPG", "20240714-143022_dublin.JPG"},
	}
	for _, c := range cases {
		got := Filename(dt, c.slug, c.ext)
		if got != c.want {
			t.Errorf("Filename(%v, %q, %q) = %q, want %q", dt, c.slug, c.ext, got, c.want)
		}
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Dublin City Centre": "dublin-city-centre",
		"Home":               "home",
		"O'Brien's Café":     "obriens-cafe",
		"  spaced  out  ":    "spaced-out",
		"":                   "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveCollision_NoCollision(t *testing.T) {
	exists := func(name string) bool { return false }
	got := ResolveCollision(exists, "20240714-143022_dublin.jpg")
	if got != "20240714-143022_dublin.jpg" {
		t.Errorf("got %q, want unchanged name", got)
	}
}

func TestResolveCollision_Collisions(t *testing.T) {
	taken := map[string]bool{
		"20240714-143022_dublin.jpg":    true,
		"20240714-143022_dublin-01.jpg": true,
		"20240714-143022_dublin-02.jpg": true,
	}
	exists := func(name string) bool { return taken[name] }
	got := ResolveCollision(exists, "20240714-143022_dublin.jpg")
	want := "20240714-143022_dublin-03.jpg"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestResolveCollision_NoSlug(t *testing.T) {
	taken := map[string]bool{"20240714-143022.jpg": true}
	exists := func(name string) bool { return taken[name] }
	got := ResolveCollision(exists, "20240714-143022.jpg")
	want := "20240714-143022-01.jpg"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
