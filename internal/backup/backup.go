// Package backup mirrors the source directory to a sibling backup directory
// once, before any photo is edited (see ADR-0001).
package backup

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// Mirror copies source to dest as an exact recursive copy, unless dest
// already exists, in which case it does nothing. created reports whether a
// new backup was made.
//
// The copy is built at a temporary sibling path and renamed into place once
// complete, so a backup interrupted partway through (e.g. the process is
// killed) is never mistaken for a finished one on the next run.
func Mirror(source, dest string) (created bool, err error) {
	if _, err := os.Stat(dest); err == nil {
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, fmt.Errorf("checking %s: %w", dest, err)
	}

	tmp := dest + ".partial"
	if err := os.RemoveAll(tmp); err != nil {
		return false, fmt.Errorf("clearing stale partial backup %s: %w", tmp, err)
	}

	if err := copyTree(source, tmp); err != nil {
		os.RemoveAll(tmp)
		return false, fmt.Errorf("copying %s to %s: %w", source, tmp, err)
	}

	if err := os.Rename(tmp, dest); err != nil {
		return false, fmt.Errorf("finalizing backup %s: %w", dest, err)
	}

	return true, nil
}

func copyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)

		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
