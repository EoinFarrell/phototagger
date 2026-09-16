package safety

import (
	"path/filepath"
	"testing"

	"phototagger/internal/scan"
)

func TestCheckMisdirection_SuffixMatch(t *testing.T) {
	cases := []string{
		"/home/user/Pictures/to-fix-backup",
		"/home/user/Pictures/to-fix-tagged",
		"/home/user/Pictures/to-fix-backup/",
	}
	for _, dir := range cases {
		err := CheckMisdirection(dir, nil)
		if err == nil {
			t.Errorf("CheckMisdirection(%q) = nil, want error", dir)
			continue
		}
		if !contains(err.Error(), "to-fix") {
			t.Errorf("CheckMisdirection(%q) error = %q, want it to name %q", dir, err.Error(), "to-fix")
		}
	}
}

func TestCheckMisdirection_OKDir(t *testing.T) {
	photos := []scan.Photo{
		{RelPath: "IMG_1234.jpg"},
		{RelPath: filepath.Join("sub", "IMG_5678.heic")},
	}
	if err := CheckMisdirection("/home/user/Pictures/to-fix", photos); err != nil {
		t.Errorf("CheckMisdirection = %v, want nil", err)
	}
}

func TestCheckMisdirection_AlreadyTaggedFiles(t *testing.T) {
	photos := []scan.Photo{
		{RelPath: "20240714-143022_dublin.jpg"},
		{RelPath: "20240715-090000.heic"},
	}
	err := CheckMisdirection("/home/user/Pictures/to-fix", photos)
	if err == nil {
		t.Fatal("expected error for directory full of already-tagged filenames")
	}
}

func TestCheckMisdirection_MixedFilesAlsoTrips(t *testing.T) {
	// Even one already-tagged filename is enough to refuse: the pattern is
	// specific enough that it won't collide with real camera/messaging-app
	// names by chance, and this is a destructive tool over irreplaceable
	// photos, so it should fail loudly on a partially-reprocessed directory
	// too, not just one that's entirely already-tagged output.
	photos := []scan.Photo{
		{RelPath: "20240714-143022_dublin.jpg"},
		{RelPath: "IMG_5678.heic"},
	}
	err := CheckMisdirection("/home/user/Pictures/to-fix", photos)
	if err == nil {
		t.Fatal("expected error when any photo already matches the tagged pattern")
	}
	if !contains(err.Error(), "20240714-143022_dublin.jpg") {
		t.Errorf("error = %q, want it to name the offending file", err.Error())
	}
}

func TestCheckMisdirection_EmptyPhotosOK(t *testing.T) {
	if err := CheckMisdirection("/home/user/Pictures/to-fix", nil); err != nil {
		t.Errorf("CheckMisdirection = %v, want nil for empty dir", err)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (func() bool {
		for i := 0; i+len(substr) <= len(s); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	})()
}
