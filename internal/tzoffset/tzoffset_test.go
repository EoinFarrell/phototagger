package tzoffset

import (
	"testing"
	"time"
)

// fakeFinder lets tests control the zone name without loading the real
// (large, embedded) tzf boundary data.
type fakeFinder struct {
	zone string
}

func (f fakeFinder) GetTimezoneName(lng, lat float64) string { return f.zone }

func TestResolve_DST(t *testing.T) {
	r := New(fakeFinder{zone: "Europe/Dublin"})

	summer := time.Date(2024, 7, 14, 14, 30, 0, 0, time.UTC)
	offset, zone, ok := r.Resolve(53.3498, -6.2603, summer)
	if !ok {
		t.Fatal("Resolve returned ok=false")
	}
	if zone != "Europe/Dublin" {
		t.Errorf("zone = %q, want Europe/Dublin", zone)
	}
	if offset != "+01:00" {
		t.Errorf("summer offset = %q, want +01:00", offset)
	}

	winter := time.Date(2024, 1, 14, 14, 30, 0, 0, time.UTC)
	offset, _, ok = r.Resolve(53.3498, -6.2603, winter)
	if !ok {
		t.Fatal("Resolve returned ok=false")
	}
	if offset != "+00:00" {
		t.Errorf("winter offset = %q, want +00:00", offset)
	}
}

func TestResolve_NegativeOffset(t *testing.T) {
	r := New(fakeFinder{zone: "America/New_York"})
	dt := time.Date(2024, 1, 14, 12, 0, 0, 0, time.UTC)
	offset, _, ok := r.Resolve(40.7128, -74.0060, dt)
	if !ok {
		t.Fatal("Resolve returned ok=false")
	}
	if offset != "-05:00" {
		t.Errorf("offset = %q, want -05:00", offset)
	}
}

func TestResolve_UnresolvableZone(t *testing.T) {
	r := New(fakeFinder{zone: ""})
	_, _, ok := r.Resolve(0, 0, time.Now())
	if ok {
		t.Error("expected ok=false when finder can't resolve a zone")
	}
}

func TestResolve_InvalidZoneName(t *testing.T) {
	r := New(fakeFinder{zone: "Not/AZone"})
	_, _, ok := r.Resolve(0, 0, time.Now())
	if ok {
		t.Error("expected ok=false when zone name doesn't load")
	}
}
