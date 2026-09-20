package dirs

import "testing"

func TestDerive(t *testing.T) {
	cases := []struct {
		source, wantBackup string
	}{
		{"/home/user/Pictures/to-fix", "/home/user/Pictures/to-fix-backup"},
		{"/home/user/Pictures/to-fix/", "/home/user/Pictures/to-fix-backup"},
	}
	for _, c := range cases {
		backup := Derive(c.source)
		if backup != c.wantBackup {
			t.Errorf("Derive(%q) = %q, want %q", c.source, backup, c.wantBackup)
		}
	}
}
