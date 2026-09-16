# Phototagger

A local, single-user tool for correcting EXIF metadata (datetime, GPS, timezone offset,
caption, keywords) on a batch of JPEG/HEIC photos, one photo at a time, ahead of import
into Immich.

## Language

**Photo**:
One JPEG or HEIC file being corrected. The unit the whole tool operates on — always
handled one at a time, never in bulk.

**Source directory**:
The directory passed via `-dir`, recursively scanned for Photos. Shrinks over the course
of a run as Photos are Applied and move out to the Tagged directory.
_Avoid_: input directory, working directory

**Queue**:
The set of applicable Photos still present in the Source directory, in processing order
(existing `DateTimeOriginal` where present, else filename). Not a separate list or
database — it's simply computed from what's still there, so quitting and resuming later
requires no extra state.

**Apply**:
The action that finishes work on the current Photo: write only the touched EXIF fields,
rename it, and move it into the Tagged directory. Always advances the Queue, even when
no fields were touched (e.g. a Photo that was already correct).
_Avoid_: save, submit, confirm

**Touched field**:
A field the user has explicitly set or edited in the UI for the current Photo, as
opposed to a value the form merely pre-populated from existing EXIF. Apply writes only
Touched fields to exiftool.

**Skip**:
Advances to the next Photo in the Queue without writing anything or moving the file. A
Skipped Photo is untouched and will reappear in its normal Queue position later.
_Avoid_: defer, ignore

**Backup directory**:
A sibling of the Source directory (`<source>-backup`), created once as an exact,
untouched mirror of the Source directory before any Photo is edited. Always mirrors
Source's folder structure exactly — no user-facing layout option, since it's a safety
copy rather than something browsed.

**Tagged directory**:
A sibling of the Source directory (`<source>-tagged`) that Applied Photos move into.
Its layout (flat, or mirroring Source's subfolders) is a user-chosen option on the start
screen, since — unlike Backup — this is the set of files you'll actually browse before
Immich import.

**Favourite**:
A named, saved location — `{name, lat, lon, alt}` — stored in `locations.json`, a single
file next to the binary shared across every run of the tool (not scoped to a Source
directory or session). Selecting a Favourite snaps the map pin to its coordinates and
altitude without an elevation lookup.
_Avoid_: saved location, bookmark, place

**Location slug**:
The place-name component of a renamed Photo's filename: the selected Favourite's name,
or a reverse-geocoded city/town name for a freehand pin, or omitted if neither is
available.
