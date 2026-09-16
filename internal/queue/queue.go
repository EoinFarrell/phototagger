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

// Entry pairs a scanned photo with its existing DateTimeOriginal, if any.
type Entry struct {
	Photo            scan.Photo
	DateTimeOriginal *time.Time
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
