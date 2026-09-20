// Package rename builds the YYYYMMDD-HHMMSS_slug.ext filename applied photos
// are given, and resolves collisions between photos that would otherwise
// share a name (e.g. burst shots).
package rename

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// Filename builds the new filename for a photo taken at dt, with the given
// location slug (may be empty) and file extension (without leading dot).
func Filename(dt time.Time, slug string, ext string) string {
	base := dt.Format("20060102-150405")
	if slug != "" {
		base += "_" + slug
	}
	return base + "." + ext
}

var (
	nonAlnumRun    = regexp.MustCompile(`[^a-z0-9]+`)
	dropChars      = regexp.MustCompile(`['’]`)
	stripDiacritic = transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)

	// taggedPattern matches filenames Filename produces: YYYYMMDD-HHMMSS
	// optionally followed by _slug, then an extension. A photo whose
	// filename matches is Tagged, per CONTEXT.md.
	taggedPattern = regexp.MustCompile(`^\d{8}-\d{6}(_[^.]+)?\.[A-Za-z0-9]+$`)
)

// IsTagged reports whether name -- a base filename, not a full path --
// matches the pattern Filename produces, i.e. whether the photo it names is
// Tagged.
func IsTagged(name string) bool {
	return taggedPattern.MatchString(name)
}

// Slugify turns a favourite name or reverse-geocoded place name into a
// filename-safe, lowercase, hyphenated slug. Diacritics are stripped
// (café -> cafe) and apostrophes are dropped rather than turned into hyphens
// (O'Brien's -> obriens) so common place names stay readable.
func Slugify(name string) string {
	ascii, _, err := transform.String(stripDiacritic, name)
	if err != nil {
		ascii = name
	}
	lower := strings.ToLower(strings.TrimSpace(ascii))
	noApostrophes := dropChars.ReplaceAllString(lower, "")
	replaced := nonAlnumRun.ReplaceAllString(noApostrophes, "-")
	return strings.Trim(replaced, "-")
}

// ResolveCollision returns name unchanged if exists reports it isn't taken,
// otherwise appends -01, -02, ... before the extension until it finds a free
// name.
func ResolveCollision(exists func(name string) bool, name string) string {
	if !exists(name) {
		return name
	}

	ext := ""
	stem := name
	if idx := strings.LastIndex(name, "."); idx != -1 {
		ext = name[idx:]
		stem = name[:idx]
	}

	for i := 1; ; i++ {
		candidate := fmt.Sprintf("%s-%02d%s", stem, i, ext)
		if !exists(candidate) {
			return candidate
		}
	}
}
