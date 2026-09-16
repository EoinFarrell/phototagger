// Package tzoffset computes the UTC offset for a coordinate on a specific
// date, resolving DST correctly, entirely offline: coordinate -> IANA zone
// name via tzf, then zone name + date -> offset via the standard library.
package tzoffset

import (
	"time"
)

// Finder resolves an IANA timezone name for a coordinate. Satisfied by
// tzf.F; kept as a narrow interface here so tests don't need to load tzf's
// embedded boundary data.
type Finder interface {
	GetTimezoneName(lng, lat float64) string
}

// Resolver computes UTC offsets for coordinates and dates.
type Resolver struct {
	finder Finder
}

// New wraps a Finder (typically produced by tzf.NewDefaultFinder) in a
// Resolver.
func New(finder Finder) *Resolver {
	return &Resolver{finder: finder}
}

// Resolve returns the "+HH:MM"/"-HH:MM" UTC offset in effect at (lat, lon) on
// the date dt (DST-aware), along with the resolved IANA zone name. ok is
// false if the coordinate's zone can't be resolved, e.g. open ocean or an
// ambiguous border sliver -- callers should fall back to requiring a manual
// offset in that case.
func (r *Resolver) Resolve(lat, lon float64, dt time.Time) (offset, zone string, ok bool) {
	zone = r.finder.GetTimezoneName(lon, lat)
	if zone == "" {
		return "", "", false
	}

	loc, err := time.LoadLocation(zone)
	if err != nil {
		return "", "", false
	}

	inZone := time.Date(dt.Year(), dt.Month(), dt.Day(), dt.Hour(), dt.Minute(), dt.Second(), 0, loc)
	return inZone.Format("-07:00"), zone, true
}
