package scan

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScan(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.jpg"))
	writeFile(t, filepath.Join(root, "b.JPEG"))
	writeFile(t, filepath.Join(root, "sub", "c.heic"))
	writeFile(t, filepath.Join(root, "sub", "d.HEIF"))
	writeFile(t, filepath.Join(root, "sub", "deeper", "e.jpg"))
	writeFile(t, filepath.Join(root, "notes.txt"))
	writeFile(t, filepath.Join(root, "sub", ".DS_Store"))

	result, err := Scan(root)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}

	if len(result.Photos) != 5 {
		t.Fatalf("got %d photos, want 5: %+v", len(result.Photos), result.Photos)
	}
	var rels []string
	for _, p := range result.Photos {
		rels = append(rels, p.RelPath)
		if p.Ext == "" {
			t.Errorf("photo %q has empty ext", p.RelPath)
		}
	}
	sort.Strings(rels)
	want := []string{"a.jpg", "b.JPEG", filepath.Join("sub", "c.heic"), filepath.Join("sub", "d.HEIF"), filepath.Join("sub", "deeper", "e.jpg")}
	sort.Strings(want)
	for i := range want {
		if rels[i] != want[i] {
			t.Errorf("rels[%d] = %q, want %q", i, rels[i], want[i])
		}
	}

	if len(result.Skipped) != 2 {
		t.Fatalf("got %d skipped, want 2: %+v", len(result.Skipped), result.Skipped)
	}

	// sub and sub/deeper are both subfolders.
	if result.SubfolderCount != 2 {
		t.Errorf("SubfolderCount = %d, want 2", result.SubfolderCount)
	}
}

func TestScanEmptyDir(t *testing.T) {
	root := t.TempDir()
	result, err := Scan(root)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(result.Photos) != 0 || len(result.Skipped) != 0 || result.SubfolderCount != 0 {
		t.Errorf("expected empty result, got %+v", result)
	}
}

func TestScanNonexistentDir(t *testing.T) {
	if _, err := Scan(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected error for nonexistent dir")
	}
}

func TestIsApplicableExt(t *testing.T) {
	cases := map[string]bool{
		".jpg": true, ".JPG": true, ".jpeg": true, ".heic": true, ".HEIF": true,
		".png": false, ".txt": false, "": false,
	}
	for ext, want := range cases {
		if got := IsApplicableExt(ext); got != want {
			t.Errorf("IsApplicableExt(%q) = %v, want %v", ext, got, want)
		}
	}
}
