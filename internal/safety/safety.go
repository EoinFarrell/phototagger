// Package safety implements the startup misdirection check described in
// ADR-0004: refuse to run against a directory that looks like the tool's own
// backup output.
package safety

import (
	"fmt"
	"path/filepath"
	"strings"
)

// backupSuffix is the suffix the tool appends to derive its backup sibling
// directory (see internal/dirs).
const backupSuffix = "-backup"

// CheckMisdirection returns an error if dir looks like it's the tool's own
// backup directory rather than a genuine source directory. A source
// directory containing a mix of Tagged and Non-Tagged photos is the normal,
// expected state of a resumed batch (ADR-0005), so that's not checked here.
func CheckMisdirection(dir string) error {
	clean := filepath.Clean(dir)
	base := filepath.Base(clean)

	if strings.HasSuffix(base, backupSuffix) && len(base) > len(backupSuffix) {
		suggestion := strings.TrimSuffix(base, backupSuffix)
		return fmt.Errorf(
			"refusing to start: %q looks like a directory this tool generates, not a source directory; did you mean %q?",
			clean, filepath.Join(filepath.Dir(clean), suggestion),
		)
	}

	return nil
}
