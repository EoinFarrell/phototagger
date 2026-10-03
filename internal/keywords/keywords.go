// Package keywords manages the flat keywords.json file: every keyword ever
// Applied to a photo, shared across every -dir invocation of the tool, so
// the tagging UI can offer them back as quick-pick pills (web/static/app.js)
// instead of making the user retype and remember them. A keyword may also
// carry its own saved Location (independent of internal/locations'
// favourites), letting the UI snap the map to that location when the
// keyword is picked -- not every keyword needs one.
package keywords

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Location is a keyword's own saved coordinate, set from the map's current
// pin when the user links it (see web/static/app.js's keyword-location
// management UI). Independent of internal/locations.Favourite -- a keyword
// isn't required to point at a saved favourite.
type Location struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
	Alt float64 `json:"alt"`
}

// Keyword is a single known keyword and its optional Location.
type Keyword struct {
	Name     string    `json:"name"`
	Location *Location `json:"location,omitempty"`
}

// Store is the in-memory, disk-backed set of previously-used keywords, kept
// in first-seen order so the pill list grows at the end rather than
// reshuffling as new keywords arrive.
type Store struct {
	mu       sync.Mutex
	path     string
	keywords []Keyword
	index    map[string]int // keyword name -> position in keywords
}

// Load reads keywords from path, or starts with an empty set if the file
// doesn't exist yet. Accepts both the current object-array format and the
// original plain-string-array format (every keyword predating the Location
// field), so an existing keywords.json keeps loading without migration.
func Load(path string) (*Store, error) {
	s := &Store{path: path, index: map[string]int{}}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	if err := json.Unmarshal(data, &s.keywords); err != nil {
		var names []string
		if err2 := json.Unmarshal(data, &names); err2 != nil {
			return nil, fmt.Errorf("parsing %s: %w", path, err)
		}
		s.keywords = make([]Keyword, len(names))
		for i, n := range names {
			s.keywords[i] = Keyword{Name: n}
		}
	}
	for i, k := range s.keywords {
		s.index[k.Name] = i
	}
	return s, nil
}

// All returns a copy of the current keywords, in first-seen order.
func (s *Store) All() []Keyword {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Keyword, len(s.keywords))
	copy(out, s.keywords)
	return out
}

// Add records any keyword in kws not already known, then persists the store
// to disk if that added at least one. Blank keywords are ignored. A
// keyword's Location, if any, is untouched by Add -- only SetLocation
// changes it.
func (s *Store) Add(kws []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	changed := false
	for _, k := range kws {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if _, ok := s.index[k]; ok {
			continue
		}
		s.index[k] = len(s.keywords)
		s.keywords = append(s.keywords, Keyword{Name: k})
		changed = true
	}
	if !changed {
		return nil
	}
	return s.saveLocked()
}

// Remove deletes kw from the known set, then persists the store to disk if
// it was present. A no-op if kw isn't known.
func (s *Store) Remove(kw string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	i, ok := s.index[kw]
	if !ok {
		return nil
	}
	s.keywords = append(s.keywords[:i], s.keywords[i+1:]...)
	delete(s.index, kw)
	for name, idx := range s.index {
		if idx > i {
			s.index[name] = idx - 1
		}
	}
	return s.saveLocked()
}

// SetLocation sets (loc non-nil) or clears (loc nil) kw's saved Location,
// then persists the store to disk. Returns an error if kw isn't known --
// the management UI only ever offers this for a keyword already in the
// known list.
func (s *Store) SetLocation(kw string, loc *Location) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	i, ok := s.index[kw]
	if !ok {
		return fmt.Errorf("unknown keyword %q", kw)
	}
	s.keywords[i].Location = loc
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	data, err := json.MarshalIndent(s.keywords, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o644)
}
