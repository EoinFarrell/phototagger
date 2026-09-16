# Back up the whole source directory once, before touching anything

The tool rewrites EXIF in place and renames/moves every photo it processes, across
600-700 irreplaceable personal photos, with no undo. Rather than relying on exiftool's
default per-file `foo.jpg_original` backups, the tool copies the entire source
directory to a sibling `<source>-backup/` once, before any edit happens (skipped on
later runs if it already exists). Because that whole-directory backup now covers
recovery, exiftool is run with `-overwrite_original` so `tagged/` isn't cluttered with
redundant per-file backup copies.
