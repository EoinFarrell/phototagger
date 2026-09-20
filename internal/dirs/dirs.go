// Package dirs derives the backup sibling directory from a source directory
// path (see ADR-0004, ADR-0005).
package dirs

import "path/filepath"

// Derive returns the backup sibling directory path for the given source
// directory.
func Derive(source string) (backup string) {
	return filepath.Clean(source) + "-backup"
}
