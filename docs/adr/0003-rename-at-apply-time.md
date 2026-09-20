# Rename each photo at Apply time, not in an upfront batch pass

The new filename scheme (`YYYYMMDD-HHMMSS_slug.ext`) depends on corrected datetime and
location data — but for the photos this tool exists to fix, that data doesn't exist
until each photo has individually been tagged in the UI. Renaming as an upfront pass
before tagging would mean renaming from the same wrong/missing data the tool is meant
to correct. Instead, renaming happens as part of Apply, per photo, at the moment its
corrected fields are known — the same step that writes EXIF. (Renaming happens in place
within the source directory; see [ADR-0005](0005-tagged-in-place-by-filename.md) — this
ADR is only about the *timing* of the rename, which is unaffected.)
