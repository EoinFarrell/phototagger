// Package dirs derives the backup and tagged sibling directories from a
// source directory path (see ADR-0004).
package dirs

import "path/filepath"

// Derive returns the backup and tagged sibling directory paths for the given
// source directory.
func Derive(source string) (backup, tagged string) {
	clean := filepath.Clean(source)
	return clean + "-backup", clean + "-tagged"
}
