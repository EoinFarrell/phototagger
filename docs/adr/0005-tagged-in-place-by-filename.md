# Tag photos by filename in place, not by moving them into a tagged/ directory

_Supersedes [ADR-0004](0004-tagged-and-backup-as-siblings.md)._

Originally, Applying a photo moved it out of the source directory into a
`<source>-tagged/` sibling, and "tagged" simply meant "no longer in source." That made
it impossible to revisit or edit an already-tagged photo without first moving it back
(see the "Prev button" judgment call, and the issue it left open), and it required a
homescreen flat/nested layout choice for how `tagged/` mirrored source's subfolders.

Instead, Apply renames a photo in place, inside the source directory, using the same
`YYYYMMDD-HHMMSS[_slug].ext` pattern it always produced. That filename pattern is now
the sole signal of tagging status — a photo matching it is Tagged, one that doesn't is
Non-Tagged — so there's no separate metadata field or progress database. The source
directory holds every photo for the whole run; the homescreen instead offers a Mode
(All / Non-Tagged / Tagged) that filters which photos the queue for that run includes.

## Considered options

- **Explicit EXIF/XMP tag** written alongside the renamed fields, independent of
  filename. Rejected: it costs an extra exiftool round-trip per photo, risks the marker
  leaking into a field Immich actually reads (e.g. Keywords), and buys nothing the
  filename pattern doesn't already provide — the pattern is already specific enough to
  be a reliable signal (`internal/safety` already relies on it).
- **Keep `tagged/`, but allow copying a photo back into source for editing.** Rejected
  as strictly more moving parts (two directories to keep in sync, a copy-back-and-forth
  step) for the same end result as just never moving the file.

## Consequences

- The flat/nested tagged-layout start-screen toggle is removed entirely — there's
  nothing to lay out, since photos never move.
- The startup misdirection check (`internal/safety`) drops its "a photo already matches
  the tagged pattern" refusal, since that's now the normal, expected state of a resumed
  batch. It keeps the `-backup`-suffix directory-name refusal; it drops the
  `-tagged`-suffix one, since no such directory is produced anymore.
- Editing an already-Tagged photo (via Prev, or via Tagged/All Mode) is a full re-Apply:
  touched fields are re-written, and the filename is recomputed and re-renamed in place
  if the correction changes it.
