package locations

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad_MissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locations.json")
	store, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(store.All()) != 0 {
		t.Errorf("expected empty store, got %+v", store.All())
	}
}

func TestAddAndSave_Roundtrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locations.json")
	store, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	fav := Favourite{Name: "Home", Lat: 53.35, Lon: -6.26, Alt: 20}
	if err := store.Add(fav); err != nil {
		t.Fatalf("Add: %v", err)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	all := reloaded.All()
	if len(all) != 1 {
		t.Fatalf("got %d favourites, want 1", len(all))
	}
	if all[0] != fav {
		t.Errorf("got %+v, want %+v", all[0], fav)
	}
}

func TestAdd_ReplacesSameName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locations.json")
	store, _ := Load(path)

	if err := store.Add(Favourite{Name: "Home", Lat: 1, Lon: 2, Alt: 3}); err != nil {
		t.Fatal(err)
	}
	if err := store.Add(Favourite{Name: "Home", Lat: 9, Lon: 9, Alt: 9}); err != nil {
		t.Fatal(err)
	}

	all := store.All()
	if len(all) != 1 {
		t.Fatalf("got %d favourites, want 1 (update in place)", len(all))
	}
	if all[0].Lat != 9 {
		t.Errorf("favourite not updated: %+v", all[0])
	}
}

func TestLoad_MalformedJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "locations.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error loading malformed JSON")
	}
}

func TestLoad_PreservesFileAcrossReloads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "locations.json")

	store, _ := Load(path)
	store.Add(Favourite{Name: "Work", Lat: 1, Lon: 1, Alt: 1})

	// Simulate a restart: load again from the same path.
	store2, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(store2.All()) != 1 {
		t.Fatalf("favourites did not survive reload: %+v", store2.All())
	}
}
