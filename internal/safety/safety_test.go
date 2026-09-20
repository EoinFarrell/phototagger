package safety

import "testing"

func TestCheckMisdirection_SuffixMatch(t *testing.T) {
	cases := []string{
		"/home/user/Pictures/to-fix-backup",
		"/home/user/Pictures/to-fix-backup/",
	}
	for _, dir := range cases {
		err := CheckMisdirection(dir)
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
	if err := CheckMisdirection("/home/user/Pictures/to-fix"); err != nil {
		t.Errorf("CheckMisdirection = %v, want nil", err)
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
