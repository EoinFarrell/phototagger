package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMirror_CopiesExactly(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	dest := filepath.Join(root, "source-backup")

	writeFile(t, filepath.Join(source, "a.jpg"), "aaa")
	writeFile(t, filepath.Join(source, "sub", "b.heic"), "bbb")

	created, err := Mirror(source, dest)
	if err != nil {
		t.Fatalf("Mirror: %v", err)
	}
	if !created {
		t.Error("expected created=true on first run")
	}

	for _, rel := range []string{"a.jpg", filepath.Join("sub", "b.heic")} {
		want, _ := os.ReadFile(filepath.Join(source, rel))
		got, err := os.ReadFile(filepath.Join(dest, rel))
		if err != nil {
			t.Fatalf("reading backup copy of %s: %v", rel, err)
		}
		if string(got) != string(want) {
			t.Errorf("%s: backup content = %q, want %q", rel, got, want)
		}
	}
}

func TestMirror_SkipsIfAlreadyExists(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	dest := filepath.Join(root, "source-backup")

	writeFile(t, filepath.Join(source, "a.jpg"), "original")

	if _, err := Mirror(source, dest); err != nil {
		t.Fatalf("first Mirror: %v", err)
	}

	// Mutate the source after the first backup -- a second Mirror call
	// must not touch the existing backup.
	writeFile(t, filepath.Join(source, "a.jpg"), "mutated")

	created, err := Mirror(source, dest)
	if err != nil {
		t.Fatalf("second Mirror: %v", err)
	}
	if created {
		t.Error("expected created=false on second run")
	}

	got, err := os.ReadFile(filepath.Join(dest, "a.jpg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Errorf("backup was overwritten: got %q, want %q", got, "original")
	}
}
