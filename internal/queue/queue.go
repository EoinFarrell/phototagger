// Package queue orders the applicable photos found by scan.Scan into the
// tagging sequence. There's no separate progress store -- the queue is
// simply whatever photos remain in the source directory, so restarting the
// app naturally resumes at the first remaining one (see CONTEXT.md).
package queue

import (
	"sort"
	"time"

	"phototagger/internal/scan"
)

// Entry pairs a scanned photo with its existing DateTimeOriginal, if any,
// and whether its filename already matches the Tagged pattern (see
// CONTEXT.md).
type Entry struct {
	Photo            scan.Photo
	DateTimeOriginal *time.Time
	Tagged           bool
}

// Mode selects which subset of a chronologically Ordered set of entries a
// run's Queue includes -- see CONTEXT.md's Mode/Queue definitions.
type Mode string

const (
	ModeAll       Mode = "all"
	ModeNonTagged Mode = "non-tagged"
	ModeTagged    Mode = "tagged"
)

// ParseMode validates a wire-format mode string.
func ParseMode(s string) (Mode, bool) {
	switch Mode(s) {
	case ModeAll, ModeNonTagged, ModeTagged:
		return Mode(s), true
	default:
		return "", false
	}
}

// Filter returns the subset of entries matching mode, preserving relative
// order. ModeAll returns every entry unfiltered -- a single chronological
// interleave of Tagged and Non-Tagged together, per docs/plan.md.
func Filter(entries []Entry, mode Mode) []Entry {
	if mode == ModeAll {
		return entries
	}
	want := mode == ModeTagged
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if e.Tagged == want {
			out = append(out, e)
		}
	}
	return out
}

// Order sorts entries into tagging order: photos with a known
// DateTimeOriginal come first, chronologically; photos without one follow,
// sorted by filename (a filename can't be reliably compared against a
// timestamp, so rather than interleave the two kinds unpredictably, unknown
// dates are grouped after known ones). Ties within either group break on
// filename. The input slice is not mutated.
func Order(entries []Entry) []Entry {
	sorted := make([]Entry, len(entries))
	copy(sorted, entries)

	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		aHas, bHas := a.DateTimeOriginal != nil, b.DateTimeOriginal != nil
		if aHas != bHas {
			return aHas
		}
		if aHas && !a.DateTimeOriginal.Equal(*b.DateTimeOriginal) {
			return a.DateTimeOriginal.Before(*b.DateTimeOriginal)
		}
		return a.Photo.RelPath < b.Photo.RelPath
	})

	return sorted
}
