package server

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// moveFile moves src to dst, creating dst's parent directory as needed. It
// tries a plain rename first (the common case, since tagged/ is a sibling
// of the source directory and normally on the same filesystem) and falls
// back to copy-then-remove for a cross-device move.
func moveFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return fmt.Errorf("creating %s: %w", filepath.Dir(dst), err)
	}

	if err := os.Rename(src, dst); err == nil {
		return nil
	}

	if err := copyFile(src, dst); err != nil {
		return fmt.Errorf("moving %s to %s: %w", src, dst, err)
	}
	if err := os.Remove(src); err != nil {
		return fmt.Errorf("removing %s after copy to %s: %w", src, dst, err)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}
