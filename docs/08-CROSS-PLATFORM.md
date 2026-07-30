# Cross-platform filesystem behaviour

## Names and case

Detect Windows reserved names, forbidden characters, trailing spaces/dots, length constraints, case-insensitive collisions and normalisation collisions. Block and ask for rename; never silently rewrite. Case-only rename may need an intermediate path.

## Symlinks and reparse points

Never follow during traversal. Preserve only when destination policy/platform safely supports; otherwise skip with warning. Never convert link target to ordinary content and reject root escapes. Treat junctions/reparse types conservatively.

## Metadata

Store Linux executable bit and restore it on Linux. Do not sync owners, groups, arbitrary ACLs or extended attributes by default. Surface unsupported metadata.

## Open files

Debounce, probe stability, respect Windows sharing violations, verify Linux reads did not change, and never equate successful open with finished write.

## Atomic replacement

Create temp data on destination filesystem, flush according to policy, archive old content, use platform replace APIs, retry bounded interference and never truncate the live destination in place.

## Rename IDs

Linux inode/device and Windows file IDs are hints, may be reused/change, and are combined with revision/digest evidence.

## Special cases

Sparse allocation may not remain sparse; hard links become independent files; sockets/devices/FIFOs are skipped; online-only placeholders are not hydrated without explicit policy.

## Visible default ignore presets

`.DS_Store`, `Thumbs.db`, `desktop.ini`, `$RECYCLE.BIN/`, `System Volume Information/`, `~$*`, `*.swp`, `*.tmp`. Presets are removable and never hidden hard-coded rules.
