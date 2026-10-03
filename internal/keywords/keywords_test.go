package keywords

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func names(ks []Keyword) []string {
	out := make([]string, len(ks))
	for i, k := range ks {
		out[i] = k.Name
	}
	return out
}

func TestLoad_MissingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(store.All()) != 0 {
		t.Errorf("expected empty store, got %+v", store.All())
	}
}

func TestAdd_PersistsNewKeywords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if err := store.Add([]string{"beach", "family"}); err != nil {
		t.Fatalf("Add: %v", err)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	all := names(reloaded.All())
	if len(all) != 2 || all[0] != "beach" || all[1] != "family" {
		t.Errorf("got %+v, want [beach family]", all)
	}
}

func TestAdd_SkipsDuplicatesAndBlanks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)

	if err := store.Add([]string{"beach", " ", ""}); err != nil {
		t.Fatal(err)
	}
	if err := store.Add([]string{"beach", "family"}); err != nil {
		t.Fatal(err)
	}

	all := names(store.All())
	if len(all) != 2 || all[0] != "beach" || all[1] != "family" {
		t.Errorf("got %+v, want [beach family] (no duplicate, no blanks)", all)
	}
}

func TestRemove_DeletesAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach", "family", "sunset"})

	if err := store.Remove("family"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	all := names(store.All())
	if len(all) != 2 || all[0] != "beach" || all[1] != "sunset" {
		t.Errorf("got %+v, want [beach sunset]", all)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := names(reloaded.All()); len(got) != 2 || got[0] != "beach" || got[1] != "sunset" {
		t.Errorf("removal did not persist, got %+v", got)
	}
}

func TestRemove_UnknownKeywordIsNoop(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach"})

	if err := store.Remove("never-added"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if all := names(store.All()); len(all) != 1 || all[0] != "beach" {
		t.Errorf("got %+v, want [beach] unchanged", all)
	}
}

// TestRemove_ReindexesSurvivingKeywords guards the index-shift bookkeeping
// in Remove: removing an earlier keyword must not corrupt a later one's
// position, which a subsequent SetLocation/Remove call relies on.
func TestRemove_ReindexesSurvivingKeywords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach", "family", "sunset"})

	if err := store.Remove("beach"); err != nil {
		t.Fatal(err)
	}
	loc := &Location{Lat: 1, Lon: 2, Alt: 3}
	if err := store.SetLocation("sunset", loc); err != nil {
		t.Fatalf("SetLocation after Remove: %v", err)
	}

	all := store.All()
	if len(all) != 2 || all[1].Name != "sunset" || all[1].Location == nil || *all[1].Location != *loc {
		t.Errorf("got %+v, want sunset at index 1 carrying %+v", all, loc)
	}
}

func TestRename_ChangesTextPreservingPositionAndLocation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach", "family", "sunset"})
	loc := &Location{Lat: 1, Lon: 2, Alt: 3}
	store.SetLocation("family", loc)

	if err := store.Rename("family", "relatives"); err != nil {
		t.Fatalf("Rename: %v", err)
	}

	all := store.All()
	if len(all) != 3 || all[1].Name != "relatives" || all[1].Location == nil || *all[1].Location != *loc {
		t.Errorf("got %+v, want \"relatives\" at index 1 carrying %+v", all, loc)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := names(reloaded.All()); len(got) != 3 || got[1] != "relatives" {
		t.Errorf("rename did not persist, got %+v", got)
	}
}

func TestRename_NoopWhenNamesEqual(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach"})

	if err := store.Rename("beach", "beach"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if all := names(store.All()); len(all) != 1 || all[0] != "beach" {
		t.Errorf("got %+v, want [beach] unchanged", all)
	}
}

func TestRename_UnknownOldNameErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)

	if err := store.Rename("never-added", "anything"); err == nil {
		t.Fatal("expected error renaming an unknown keyword")
	}
}

func TestRename_BlankNewNameErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach"})

	if err := store.Rename("beach", "   "); err == nil {
		t.Fatal("expected error renaming to a blank name")
	}
	if all := names(store.All()); len(all) != 1 || all[0] != "beach" {
		t.Errorf("a rejected rename must not change the keyword, got %+v", all)
	}
}

func TestRename_CollisionWithAnotherKeywordErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach", "family"})

	if err := store.Rename("beach", "family"); err == nil {
		t.Fatal("expected error renaming onto an existing different keyword")
	}
	if all := names(store.All()); len(all) != 2 || all[0] != "beach" || all[1] != "family" {
		t.Errorf("a rejected rename must not change either keyword, got %+v", all)
	}
}

func TestExists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach"})

	if !store.Exists("beach") {
		t.Error("Exists(\"beach\") = false, want true")
	}
	if store.Exists("never-added") {
		t.Error("Exists(\"never-added\") = true, want false")
	}
}

func TestSetLocation_SetsAndClears(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"concert"})

	loc := &Location{Lat: 40.7128, Lon: -74.006, Alt: 10}
	if err := store.SetLocation("concert", loc); err != nil {
		t.Fatalf("SetLocation: %v", err)
	}
	all := store.All()
	if all[0].Location == nil || *all[0].Location != *loc {
		t.Errorf("got %+v, want Location %+v", all[0], loc)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	got := reloaded.All()
	if got[0].Location == nil || *got[0].Location != *loc {
		t.Errorf("Location did not persist, got %+v", got[0])
	}

	if err := store.SetLocation("concert", nil); err != nil {
		t.Fatalf("SetLocation clear: %v", err)
	}
	if all = store.All(); all[0].Location != nil {
		t.Errorf("expected Location cleared, got %+v", all[0])
	}
}

func TestSetLocation_UnknownKeywordErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)

	if err := store.SetLocation("never-added", &Location{}); err == nil {
		t.Fatal("expected error setting location on an unknown keyword")
	}
}

// TestLoad_MigratesPlainStringArrayFormat guards that a keywords.json
// written before Location existed (a flat ["gaming", "concert"] array)
// keeps loading rather than erroring or silently discarding its contents.
func TestLoad_MigratesPlainStringArrayFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	if err := os.WriteFile(path, []byte(`["gaming", "concert"]`), 0o644); err != nil {
		t.Fatal(err)
	}

	store, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	all := store.All()
	if len(all) != 2 || all[0].Name != "gaming" || all[0].Location != nil ||
		all[1].Name != "concert" || all[1].Location != nil {
		t.Errorf("got %+v, want [gaming concert] with no locations", all)
	}
}

func TestLoad_MalformedJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected error loading malformed JSON")
	}
}

func TestLoad_PreservesFileAcrossReloads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keywords.json")

	store, _ := Load(path)
	store.Add([]string{"vacation2024"})

	// Simulate a restart: load again from the same path.
	store2, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(store2.All()) != 1 {
		t.Fatalf("keywords did not survive reload: %+v", store2.All())
	}
}

// TestAdd_WritesObjectFormat guards that the on-disk format is the new
// object array (not the old plain-string array) once anything is saved, so
// a Location set later has somewhere to live.
func TestAdd_WritesObjectFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "keywords.json")
	store, _ := Load(path)
	store.Add([]string{"beach"})

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var raw []map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("expected object-array format on disk, got %s: %v", data, err)
	}
	if raw[0]["name"] != "beach" {
		t.Errorf("got %+v, want name=beach", raw[0])
	}
}
