// Package locations manages the flat locations.json favourites file: named
// coordinates the user can snap the map pin to, shared across every -dir
// invocation of the tool.
package locations

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

// Favourite is a named, saved map location.
type Favourite struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	Alt  float64 `json:"alt"`
}

// Store is the in-memory, disk-backed set of favourites.
type Store struct {
	mu         sync.Mutex
	path       string
	favourites []Favourite
}

// Load reads favourites from path, or starts with an empty set if the file
// doesn't exist yet.
func Load(path string) (*Store, error) {
	s := &Store{path: path}

	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}

	if err := json.Unmarshal(data, &s.favourites); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	return s, nil
}

// All returns a copy of the current favourites.
func (s *Store) All() []Favourite {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Favourite, len(s.favourites))
	copy(out, s.favourites)
	return out
}

// Add appends fav, or replaces the existing favourite with the same name,
// then persists the store to disk.
func (s *Store) Add(fav Favourite) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	replaced := false
	for i, existing := range s.favourites {
		if existing.Name == fav.Name {
			s.favourites[i] = fav
			replaced = true
			break
		}
	}
	if !replaced {
		s.favourites = append(s.favourites, fav)
	}

	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	data, err := json.MarshalIndent(s.favourites, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o644)
}
