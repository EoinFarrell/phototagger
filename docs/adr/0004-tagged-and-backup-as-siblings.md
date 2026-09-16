# Backup and Tagged directories are siblings of Source, not nested inside it

The original design nested `tagged/` inside the source directory being processed. Once
the source scan became recursive, that would make the app walk into its own output on
a second run and treat already-tagged photos as fresh input. Both `<source>-backup/`
and `<source>-tagged/` are instead created as siblings of the source directory, named
deterministically from it, so a recursive scan of the source tree never encounters
them. This also enables a startup safety check: a `-dir` argument matching that naming
convention (or containing already-renamed files) is refused, since it's likely a
misdirected re-run.
