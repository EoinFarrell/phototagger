// Package scan recursively walks a source directory, classifying files as
// applicable photos or skipped/non-applicable files.
package scan

import (
	"io/fs"
	"path/filepath"
	"strings"
)

// Photo is a single applicable photo file found during a scan.
type Photo struct {
	// Path is the absolute filesystem path.
	Path string
	// RelPath is the path relative to the scanned root.
	RelPath string
	// Ext is the lowercase extension without the leading dot.
	Ext string
}

// IsHEIC reports whether the photo needs the HEIC preview-extraction path
// (see the HEIC preview gotcha in docs/plan.md) rather than being served
// directly by the browser.
func (p Photo) IsHEIC() bool {
	return p.Ext == "heic" || p.Ext == "heif"
}

// SkippedFile is a non-applicable file found during a scan.
type SkippedFile struct {
	RelPath string
}

// Result is the outcome of scanning a source directory.
type Result struct {
	Photos         []Photo
	Skipped        []SkippedFile
	SubfolderCount int
}

var applicableExts = map[string]bool{
	"jpg":  true,
	"jpeg": true,
	"heic": true,
	"heif": true,
}

// IsApplicableExt reports whether ext (with or without a leading dot, any
// case) is one of the tool's supported photo extensions.
func IsApplicableExt(ext string) bool {
	ext = strings.ToLower(strings.TrimPrefix(ext, "."))
	return applicableExts[ext]
}

// Scan recursively walks root and classifies every file it finds.
func Scan(root string) (Result, error) {
	var result Result
	subfolders := make(map[string]bool)

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != root {
				rel, relErr := filepath.Rel(root, path)
				if relErr != nil {
					return relErr
				}
				subfolders[rel] = true
			}
			return nil
		}

		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
		if IsApplicableExt(ext) {
			result.Photos = append(result.Photos, Photo{Path: path, RelPath: rel, Ext: ext})
		} else {
			result.Skipped = append(result.Skipped, SkippedFile{RelPath: rel})
		}
		return nil
	})
	if err != nil {
		return Result{}, err
	}

	result.SubfolderCount = len(subfolders)
	return result, nil
}
