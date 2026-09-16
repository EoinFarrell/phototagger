# phototagger

A local, single-user tool for correcting EXIF metadata (datetime, GPS, timezone
offset, caption, keywords) on a batch of JPEG/HEIC photos, one photo at a time,
ahead of import into Immich.

See [`docs/plan.md`](docs/plan.md) for the full design, [`CONTEXT.md`](CONTEXT.md)
for the glossary of terms (Photo, Queue, Apply, Favourite, ...), and
[`docs/adr/`](docs/adr/) for the reasoning behind specific decisions.

## Prerequisites

- Go (see `go.mod` for the minimum version)
- [`exiftool`](https://exiftool.org/) on your `PATH` -- the tool shells out to it
  for every metadata read and write. Install it with your package manager, e.g.
  `apt install libimage-exiftool-perl` or `brew install exiftool`.

## Usage

```sh
go run . -dir ~/Pictures/to-fix
```

This opens `http://localhost:8080` in your browser (disable with `-open=false`).
On startup it:

1. Refuses to run if `-dir` looks like the tool's own `-backup`/`-tagged` output
   (see [ADR-0004](docs/adr/0004-tagged-and-backup-as-siblings.md)).
2. Recursively scans `-dir` for `.jpg`/`.jpeg`/`.heic`/`.heif` files.
3. Backs up the whole directory to `<dir>-backup` once, if it doesn't already
   exist ([ADR-0001](docs/adr/0001-whole-directory-backup.md)).
4. Serves a start screen with a scan summary, then the one-photo-at-a-time
   tagging UI.

Applied photos are written in place with `exiftool`, renamed, and moved into
`<dir>-tagged`. Quitting and re-running the same command later resumes where
you left off -- the queue is just whatever's still in the source directory.

`locations.json` (favourite locations) is shared across every `-dir` you point
the tool at, and by default lives in whatever directory you run the command
from -- so run it from the same place each time (e.g. always `cd` into this
repo first), or pass `-locations /absolute/path/to/locations.json` to pin it
somewhere stable regardless of your current directory.

### Flags

- `-dir` (required): source directory to scan and tag.
- `-addr` (default `localhost:8080`): address to serve the UI on.
- `-open` (default `true`): open the UI in your default browser on startup.
- `-locations` (default `locations.json`): path to the favourites file.

## Verifying a batch

After tagging, spot-check the output with:

```sh
exiftool -G1 -a -s DateTimeOriginal OffsetTimeOriginal GPSLatitude GPSLongitude \
  GPSAltitude Keywords ImageDescription Caption-Abstract ~/Pictures/to-fix-tagged/*
```

See the Verification section of [`docs/plan.md`](docs/plan.md) for the full
checklist (HEIC previews, DST-aware offsets, resumability, the misdirection
safety check, and so on).

## Development

```sh
go build ./...
go vet ./...
go test ./...
```

Every package under `internal/` has unit tests; `internal/server` covers the
Apply/Skip/Prev queue logic and the HTTP API against fakes for exiftool, the
timezone resolver, and the geocoding/elevation clients, so `go test ./...`
doesn't require `exiftool` or network access to pass.
