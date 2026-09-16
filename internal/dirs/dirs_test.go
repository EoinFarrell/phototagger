package dirs

import "testing"

func TestDerive(t *testing.T) {
	cases := []struct {
		source, wantBackup, wantTagged string
	}{
		{"/home/user/Pictures/to-fix", "/home/user/Pictures/to-fix-backup", "/home/user/Pictures/to-fix-tagged"},
		{"/home/user/Pictures/to-fix/", "/home/user/Pictures/to-fix-backup", "/home/user/Pictures/to-fix-tagged"},
	}
	for _, c := range cases {
		backup, tagged := Derive(c.source)
		if backup != c.wantBackup {
			t.Errorf("Derive(%q) backup = %q, want %q", c.source, backup, c.wantBackup)
		}
		if tagged != c.wantTagged {
			t.Errorf("Derive(%q) tagged = %q, want %q", c.source, tagged, c.wantTagged)
		}
	}
}
