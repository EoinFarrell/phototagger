// Package keywords manages the flat keywords.json file: every keyword ever
// Applied to a photo, shared across every -dir invocation of the tool, so
// the tagging UI can offer them back as quick-pick pills (web/static/app.js)
// instead of making the user retype and remember them. A keyword may also
// carry its own saved Location -- a located keyword -- letting the UI snap
// the map to that location when the keyword is picked; not every keyword
// needs one.
package keywords

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// Location is a located keyword's saved coordinate, set from a map pin in
// the tagging form or the manage-keywords view (see web/static/app.js).
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

	if _, ok := s.index[kw]; !ok {
		return nil
	}
	s.removeLocked(kw)
	return s.saveLocked()
}

// removeLocked drops known keyword kw and reindexes; s.mu must be held.
func (s *Store) removeLocked(kw string) {
	i := s.index[kw]
	s.keywords = append(s.keywords[:i], s.keywords[i+1:]...)
	delete(s.index, kw)
	for name, idx := range s.index {
		if idx > i {
			s.index[name] = idx - 1
		}
	}
}

// Exists reports whether name is already a known keyword.
func (s *Store) Exists(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.index[name]
	return ok
}

// Rename changes oldName's text to newName, preserving its position and
// Location, then persists the store to disk. If newName is already a known
// keyword, the two merge instead: oldName's entry goes, and newName keeps
// its own position and Location, taking oldName's Location only if it had
// none. A no-op if newName equals oldName (after trimming). Returns an
// error if oldName isn't known or newName is blank.
func (s *Store) Rename(oldName, newName string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	newName = strings.TrimSpace(newName)
	if newName == oldName {
		return nil
	}
	if newName == "" {
		return fmt.Errorf("new keyword name is required")
	}
	i, ok := s.index[oldName]
	if !ok {
		return fmt.Errorf("unknown keyword %q", oldName)
	}
	if j, exists := s.index[newName]; exists {
		if s.keywords[j].Location == nil {
			s.keywords[j].Location = s.keywords[i].Location
		}
		s.removeLocked(oldName)
		return s.saveLocked()
	}
	s.keywords[i].Name = newName
	delete(s.index, oldName)
	s.index[newName] = i
	return s.saveLocked()
}

// SetLocation sets (loc non-nil) or clears (loc nil) kw's saved Location,
// then persists the store to disk. Setting a Location on an unknown kw
// creates it as a located keyword (the tagging form's "Save pin as located
// keyword" may name a new one); clearing an unknown kw is an error. kw is
// trimmed, and a blank kw is an error.
func (s *Store) SetLocation(kw string, loc *Location) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	kw = strings.TrimSpace(kw)
	if kw == "" {
		return fmt.Errorf("keyword name is required")
	}
	i, ok := s.index[kw]
	if !ok {
		if loc == nil {
			return fmt.Errorf("unknown keyword %q", kw)
		}
		i = len(s.keywords)
		s.index[kw] = i
		s.keywords = append(s.keywords, Keyword{Name: kw})
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
