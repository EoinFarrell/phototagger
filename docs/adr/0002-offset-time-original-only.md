# Write OffsetTimeOriginal only, not OffsetTime/OffsetTimeDigitized

Photos are being corrected specifically so they import cleanly into Immich. Immich's
date/timezone resolution (via exiftool-vendored) has documented bugs where, if both
`OffsetTime` and `OffsetTimeOriginal` are present and differ, it can pick the wrong one
([immich#15639](https://github.com/immich-app/immich/issues/15639),
[immich#20839](https://github.com/immich-app/immich/issues/20839),
[exiftool-vendored.js#220](https://github.com/photostructure/exiftool-vendored.js/issues/220)).
`-AllDates` is used for `DateTimeOriginal`/`CreateDate`/`ModifyDate`, but the offset is
written explicitly as `-OffsetTimeOriginal` only — `OffsetTime` and
`OffsetTimeDigitized` are deliberately left unset, since a present-but-unwritten
`OffsetTime` is the documented failure mode. Caption is written to `-ImageDescription`
(Immich's top-priority read) with `-IPTC:Caption-Abstract` also set for compatibility
with other tools.
