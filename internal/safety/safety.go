// Package safety implements the startup misdirection check described in
// ADR-0004: refuse to run against a directory that looks like the tool's own
// backup/tagged output.
package safety

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"phototagger/internal/scan"
)

// taggedFilePattern matches filenames this tool itself produces:
// YYYYMMDD-HHMMSS optionally followed by _slug, then an extension.
var taggedFilePattern = regexp.MustCompile(`^\d{8}-\d{6}(_[^.]+)?\.[A-Za-z0-9]+$`)

// CheckMisdirection returns an error if dir looks like it's the tool's own
// backup or tagged output directory rather than a genuine source directory.
// photos is the set of applicable photos already found by scan.Scan(dir).
func CheckMisdirection(dir string, photos []scan.Photo) error {
	clean := filepath.Clean(dir)
	base := filepath.Base(clean)

	if suggestion, ok := strippedSuffix(base); ok {
		return fmt.Errorf(
			"refusing to start: %q looks like a directory this tool generates, not a source directory; did you mean %q?",
			clean, filepath.Join(filepath.Dir(clean), suggestion),
		)
	}

	if tagged, ok := firstAlreadyTagged(photos); ok {
		return fmt.Errorf(
			"refusing to start: %q in %q already matches the tagged-file naming pattern (YYYYMMDD-HHMMSS_slug.ext) — this looks like the -tagged output of a previous run",
			tagged, clean,
		)
	}

	return nil
}

func strippedSuffix(base string) (suggestion string, matched bool) {
	for _, suffix := range []string{"-backup", "-tagged"} {
		if strings.HasSuffix(base, suffix) && len(base) > len(suffix) {
			return strings.TrimSuffix(base, suffix), true
		}
	}
	return "", false
}

// firstAlreadyTagged reports the first photo (if any) whose filename already
// matches the tool's own rename pattern. A single match is enough to refuse
// startup: the pattern is specific enough that it won't collide with camera
// or messaging-app filenames by chance, and this is a destructive-by-
// construction tool pointed at irreplaceable personal photos, so it should
// fail loudly on partial matches too, not just a directory that's entirely
// already-tagged output.
func firstAlreadyTagged(photos []scan.Photo) (relPath string, found bool) {
	for _, p := range photos {
		if taggedFilePattern.MatchString(filepath.Base(p.RelPath)) {
			return p.RelPath, true
		}
	}
	return "", false
}
