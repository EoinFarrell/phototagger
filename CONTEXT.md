# Phototagger

A local, single-user tool for correcting EXIF metadata (datetime, GPS, timezone offset,
caption, keywords) on a batch of JPEG/HEIC photos, one photo at a time, ahead of import
into Immich.

## Language

**Photo**:
One JPEG or HEIC file being corrected. The unit the whole tool operates on — always
handled one at a time, never in bulk.

**Source directory**:
The directory passed via `-dir`, recursively scanned for Photos. Holds every Photo for
the entire run, Tagged and Non-Tagged side by side — Applying a Photo renames it in
place but never moves it out. Doesn't shrink over the course of a run.
_Avoid_: input directory, working directory

**Tagged**:
A Photo whose filename already matches the pattern Apply produces
(`YYYYMMDD-HHMMSS[_slug].ext`). This filename is the only record of tagging status —
there's no separate metadata field or progress database.
_Avoid_: applied, done, processed

**Non-Tagged**:
A Photo whose filename doesn't match the Tagged pattern yet — it hasn't been through
Apply, or was Skipped.
_Avoid_: untagged, pending, remaining

**Mode**:
One of All, Non-Tagged, or Tagged, chosen once on the start screen before the Queue is
built. Determines which Photos the Queue includes for that run.
_Avoid_: filter, view

**Queue**:
The ordered list of Photos included by the current Mode, in processing order (existing/
corrected `DateTimeOriginal` where present, else filename). Computed once when a run
starts and fixed for that run's lifetime — it doesn't shrink, grow, or reorder as Photos
are Applied, which is what lets Prev step back into a Photo Applied earlier in the same
run.

**Apply**:
The action that finishes work on the current Photo: write only the touched EXIF fields,
then rename it in place using the corrected datetime/location — giving it its Tagged
filename for the first time, or updating an already-Tagged Photo's filename if the
correction changes it. Always advances the Queue, even when no fields were touched (e.g.
a Photo that was already correct).
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
