# Photo metadata tagging tool

## Context

You have 600-700 JPEG/HEIC photos with inconsistent metadata — some have datetime
but no GPS, some have GPS but wrong/no datetime, some had both stripped (likely by
an app export like WhatsApp), and some are already correct. There's no GPS track or
itinerary to auto-correlate against — corrections rely on your own memory of where/when
each photo was taken, and many locations repeat (home, work, Dublin city centre, etc.),
so a map-pin UI with saveable favourite locations is much less tedious than typing
coordinates. You want to go through photos one at a time (not batch-per-folder). The
eventual destination is Immich, which is why fields like timezone offset and captions
matter — but the Immich import itself is out of scope for this plan; this plan covers
only the tagging tool.

The tool is a genuinely new, standalone piece of software — not a homelab IaC change —
so it gets its own repo at `$CODE/personal/phototagger`, sibling to
`homelab.eoinfarrell.dev`.

See [`CONTEXT.md`](../CONTEXT.md) for the glossary of terms used below (Photo, Queue,
Apply, Favourite, Source/Backup/Tagged directory, etc.), and [`adr/`](adr/) for the
reasoning behind the decisions marked with an ADR reference.

## Approach

A small local Go web app, run with `go run . -dir ~/Pictures/to-fix`, opens a
one-photo-at-a-time tagging UI in your browser at `localhost:8080`. Go over
Python/Rust/Java here: single static binary, trivial `net/http` server, Go's `embed`
package bundles the HTML/JS into the binary so there's nothing to install beyond the Go
toolchain, and it shells out to `exiftool` for the actual metadata writes — no EXIF
library needed in any language, and no separate "CLI vs web form" tradeoff: the web
form *is* the front-end for exiftool.

### Directory layout

Given `-dir ~/Pictures/to-fix`, the app derives two sibling directories deterministically
from that path — never nested inside it, so a recursive scan never walks into the tool's
own output ([ADR-0004](adr/0004-tagged-and-backup-as-siblings.md)):

- `~/Pictures/to-fix-backup/` — an exact, untouched mirror of the source directory,
  made once before anything else happens ([ADR-0001](adr/0001-whole-directory-backup.md)).
- `~/Pictures/to-fix-tagged/` — where Applied photos land, laid out flat or mirroring
  source subfolders per a homescreen toggle (default: flat).

**Misdirection safety check:** on startup, if `-dir` points at something matching the
app's own `-backup`/`-tagged` naming convention, or whose files already match the
tagged-file rename pattern (`YYYYMMDD-HHMMSS_slug.ext`), the app hard-refuses to start
and names the directory it thinks you meant instead. This is a destructive-by-construction
tool pointed at irreplaceable personal photos, so a wrong `-dir` fails loudly rather than
quietly re-processing already-finished output.

### Start screen

Before the one-at-a-time UI opens, a start screen shows a recursive scan summary of the
source directory: total applicable-photo count broken down by extension, subfolder
count, and an expandable list (not just a count) of skipped/non-applicable files found
along the way, so a misplaced screenshot or `.DS_Store` is visible before you begin. It
also offers the flat-vs-nested toggle for `tagged/`'s layout.

Supported extensions: `.jpg`/`.jpeg`/`.heic`/`.heif`, case-insensitive. Anything else
found during the recursive scan is listed in the summary but otherwise ignored.

### The queue

The **queue** is simply whatever applicable photo files remain in the source directory
tree — there's no separate database of progress. Order is one flat sequence across the
whole recursive tree: sorted by existing `DateTimeOriginal` where present, falling back
to filename. Because photos leave the source tree (into `tagged/`) only when Applied,
restarting the app naturally resumes at the first remaining file in that order — no
progress file needed.

- **Skip** only advances the in-memory pointer to the next photo; it never touches the
  filesystem. A skipped photo is untouched and will reappear in its normal place in the
  order, whether later in the same session or on a future run.
- **Apply** always means "this photo is done, move on" — even if you touched zero
  fields (for photos that are already correct). It writes only the touched EXIF fields
  (skipping the exiftool call entirely if nothing was touched), renames the file (see
  below), and moves it into `tagged/`.

### UI per photo

- Large preview of the current photo, with Prev/Skip/Apply-and-Next controls.
- **HEIC preview gotcha:** browsers don't reliably render HEIC. Instead of adding an
  image-decoding dependency, extract the embedded preview/thumbnail exiftool already
  ships for HEIC files (`exiftool -b -PreviewImage` / `-ThumbnailImage`) and serve
  that — reuses the one dependency you already need instead of adding `libheif`/cgo.
- **Leaflet.js + OpenStreetMap tiles** (via CDN — this is a real locally-served page,
  not a sandboxed artifact, so CDN scripts are fine) for the map: click to drop a pin,
  drag to nudge.
- **Favourites dropdown**: select "Home" / "Work" / "Dublin City Centre" / etc. to
  snap the pin to a saved coordinate, then drag to fine-tune if needed. A "Save
  current pin as favourite" button appends `{name, lat, lon, alt}` to a flat
  `locations.json` next to the binary — no database, just a file you can eyeball/edit.
  This file is global across every invocation of the tool (not scoped to a batch), so
  it's untouched by quitting/restarting or by which `-dir` you point at.
- **Altitude:**
  - Freehand pin placement/drag triggers one HTTP GET to a free public elevation API
    (e.g. Open-Elevation or Open-Topo-Data — no key required) to fill the altitude
    field. Keep it editable; if the lookup fails or you're offline, leave it
    blank/as-last-entered rather than blocking the workflow.
  - Selecting a **favourite** uses its stored altitude directly — no API call. It's
    already known-good (you saved it deliberately), and skipping the lookup avoids a
    redundant round-trip.
- **Timezone — auto-computed, not manual.** Once a pin is placed and a datetime is
  entered, compute the IANA timezone from the coordinates and resolve the
  UTC offset *for that specific date* (so DST is handled correctly), rather than
  asking you to know/type an offset. This is offline, no API needed:
  - Coordinate → IANA zone name (e.g. `Europe/Dublin`) via a pure-Go offline library
    such as [`ringsaturn/tzf`](https://github.com/ringsaturn/tzf), which embeds
    timezone boundary data in the binary.
  - Zone name + entered date → UTC offset via the standard library:
    `time.LoadLocation(zoneName)` then format the offset of `time.Date(...).In(loc)`.
  - Show the computed offset next to the datetime field, editable for the rare
    override (e.g. a photo taken mid-flight).
  - **Failure mode differs from altitude:** if `tzf` can't resolve a zone for the pin
    (open ocean, an ambiguous border sliver), the offset field becomes required —
    Apply is blocked until you type it manually, rather than silently leaving it blank.
- **Per-field "same as previous" icons** — since consecutive photos are very often the
  same location/time, a small "↩ same as previous" icon next to each of four field
  groups (location+altitude, datetime+offset, keywords, caption) copies just that
  group from the previous photo's form. Grouped rather than one blanket button, so
  it's visible which fields are affected; grouped by what's computed/edited together
  rather than exposing all seven underlying fields individually.
- Datetime field (date+time picker), mapped to `DateTimeOriginal`/`CreateDate`/
  `ModifyDate` (exiftool's `-AllDates`) plus the auto-computed `OffsetTimeOriginal`
  only — deliberately not `OffsetTime`/`OffsetTimeDigitized`
  ([ADR-0002](adr/0002-offset-time-original-only.md)).
- Keywords and caption/description text fields, mapped to `-Keywords`/`-Subject` and
  `-ImageDescription` (primary; this is what Immich reads first) plus
  `-IPTC:Caption-Abstract` (compatibility with other tools/viewers).

### Renaming

Corrected datetime and location data only exists once a photo has actually been tagged
in the UI — so renaming happens per-photo, at Apply time, not as an upfront batch pass
([ADR-0003](adr/0003-rename-at-apply-time.md)). Apply therefore does three things in
one step: write EXIF, rename, move into `tagged/`.

New filename: `YYYYMMDD-HHMMSS_<location-slug>.<ext>`, e.g.
`20240714-143022_dublin.jpg`.

- **Location slug**: the favourite's name when the pin is snapped to one. For a
  freehand pin, reverse-geocode via [Nominatim](https://nominatim.org/release-docs/latest/api/Reverse/)
  (free, no key, ~1 req/sec usage policy — a non-issue at one human-paced request per
  pin-drop) at city/town granularity, falling back to county if city-level data isn't
  available for that coordinate. If the pin has no favourite and geocoding fails or is
  offline, omit the slug entirely (`20240714-143022.jpg`) rather than blocking Apply —
  same graceful-degradation pattern as altitude and (partially) timezone.
- **Collisions**: if two photos would otherwise get an identical name (e.g. burst
  shots), append `-01`, `-02`, etc. — only when actually needed, so the common case
  stays clean.
- The original filename is not preserved anywhere in the new name; `backup/` already
  preserves the original file and its original name permanently, so that's the
  traceability mechanism, not the new filename.

**People/faces:** don't bother tagging people via metadata. Immich's People feature is
its own ML face-detection pipeline that runs on pixel data at scan time — it doesn't
read pre-existing EXIF/XMP person tags to seed face clusters, so pre-tagging would just
be inert extra metadata. Name faces in Immich's own UI later, after import.

**Orientation:** not auto-corrected by the tool — worth a manual spot-check
(`exiftool -Orientation`) on any photos that look sideways in the preview, but not
common enough to build a dedicated control for.

### Repo scaffolding

`$CODE/personal/phototagger/`:
- `go.mod`, `main.go` (flag parsing, HTTP server, queue/progress logic)
- `templates/` or embedded HTML+JS (Leaflet map, form, embedded via `//go:embed`)
- `locations.json` — favourites store (starts empty or seeded with Home/Work)
- `README.md` — usage (`go run . -dir <path>`), and the exiftool install prerequisite
- `CONTEXT.md`, `docs/adr/` — glossary and decision records (see links above)

## Verification

1. Run the app against a small test directory (5-10 photos covering each broken case:
   no GPS, no datetime, both stripped, HEIC vs JPEG, at least one nested in a
   subfolder) and confirm: the start screen's scan summary is accurate, previews load
   (including HEIC), map pin + favourites + per-field "same as previous" icons all
   work, altitude auto-fills from a freehand pin placement but not from a favourite
   pick, and the computed timezone offset matches the known correct offset for a test
   coordinate/date (including at least one DST-affected date, to confirm it's not just
   using a static offset).
2. Confirm `backup/` is an exact untouched mirror of the original source directory
   before any edits happen, and is not re-copied on a second run.
3. Inspect the output in `tagged/` with
   `exiftool -G1 -a -s DateTimeOriginal OffsetTimeOriginal GPSLatitude GPSLongitude
   GPSAltitude Keywords ImageDescription Caption-Abstract` and confirm every field
   matches what was entered in the UI, `OffsetTime`/`OffsetTimeDigitized` were not
   written, and filenames follow the `YYYYMMDD-HHMMSS_slug` pattern with no collisions.
4. Confirm resumability: stop the app mid-batch, restart it, and check it picks up
   from the first untouched file rather than the beginning, and that `locations.json`
   favourites survived the restart.
5. Confirm the misdirection safety check: point `-dir` at the `tagged/` or `backup/`
   sibling from step 2-4 and confirm the app hard-refuses to start.
6. Once confirmed on the test batch, run the app across the full 600-700 photos.
