// Command phototagger is a local, single-user web app for correcting EXIF
// metadata on a batch of JPEG/HEIC photos, one photo at a time, ahead of
// import into Immich. See docs/plan.md for the full design.
package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/ringsaturn/tzf"

	"phototagger/internal/backup"
	"phototagger/internal/dirs"
	"phototagger/internal/elevation"
	"phototagger/internal/exiftool"
	"phototagger/internal/geocode"
	"phototagger/internal/locations"
	"phototagger/internal/safety"
	"phototagger/internal/scan"
	"phototagger/internal/server"
	"phototagger/internal/tzoffset"

	// Embed the IANA timezone database so tzoffset.Resolve works from the
	// single static binary regardless of what's installed on the host.
	_ "time/tzdata"
)

//go:embed web/static
var webAssets embed.FS

func main() {
	dir := flag.String("dir", "", "source directory of photos to tag (required)")
	addr := flag.String("addr", "localhost:8080", "address to serve the tagging UI on")
	open := flag.Bool("open", true, "open the tagging UI in your default browser on startup")
	locationsPath := flag.String("locations", "locations.json",
		"path to the favourites file, shared across every -dir invocation (relative paths resolve against the current directory, so run phototagger from the same place each time, or pass an absolute path)")
	flag.Parse()

	if *dir == "" {
		fmt.Fprintln(os.Stderr, "usage: phototagger -dir <path>")
		os.Exit(2)
	}

	if err := run(*dir, *addr, *open, *locationsPath); err != nil {
		log.Fatal(err)
	}
}

func run(sourceDir, addr string, openBrowser bool, locationsPath string) error {
	if err := exiftool.CheckAvailable(); err != nil {
		return err
	}

	absSource, err := filepath.Abs(sourceDir)
	if err != nil {
		return err
	}
	backupDir := dirs.Derive(absSource)

	if err := safety.CheckMisdirection(absSource); err != nil {
		return err
	}

	log.Printf("scanning %s...", absSource)
	scanResult, err := scan.Scan(absSource)
	if err != nil {
		return fmt.Errorf("scanning %s: %w", absSource, err)
	}

	log.Printf("found %d applicable photo(s), %d subfolder(s), %d skipped file(s)",
		len(scanResult.Photos), scanResult.SubfolderCount, len(scanResult.Skipped))

	log.Printf("backing up %s to %s...", absSource, backupDir)
	created, err := backup.Mirror(absSource, backupDir)
	if err != nil {
		return fmt.Errorf("backing up %s: %w", absSource, err)
	}
	if created {
		log.Printf("backup complete")
	} else {
		log.Printf("backup already exists, skipping")
	}

	log.Printf("loading timezone boundary data...")
	tzFinder, err := tzf.NewDefaultFinder()
	if err != nil {
		return fmt.Errorf("loading timezone data: %w", err)
	}

	locs, err := locations.Load(locationsPath)
	if err != nil {
		return fmt.Errorf("loading %s: %w", locationsPath, err)
	}

	log.Printf("reading existing dates for %d photo(s) to establish tagging order...", len(scanResult.Photos))
	sess, err := server.NewSession(
		absSource, backupDir,
		scanResult,
		exiftool.New(),
		tzoffset.New(tzFinder),
		geocode.New(),
		elevation.New(),
		locs,
	)
	if err != nil {
		return fmt.Errorf("building session: %w", err)
	}

	if err := server.SetWebFS(webAssets, "web/static"); err != nil {
		return err
	}

	url := "http://" + addr + "/"
	log.Printf("serving tagging UI at %s", url)
	if openBrowser {
		go openInBrowser(url)
	}

	return http.ListenAndServe(addr, server.NewMux(sess))
}

func openInBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
