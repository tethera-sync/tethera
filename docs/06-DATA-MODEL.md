# Data model

SQLite is local to each device. Conceptual tables:

- `devices`: identity, fingerprint, trust/revocation, last seen.
- `folder_pairs`: roots, peer, direction, trigger, status and generation.
- `folder_policies`: conflict, retention, archive root, bandwidth, metered, symlink and notifications.
- `ignore_rules`: ordered pattern, source and enabled state.
- `entries`: encoded/display relative path, type, platform file ID hint, current revision, observed metadata and ignore reason.
- `revisions`: creator device/sequence, parent set, kind, digest, size and display timestamp.
- `revision_parents`: revision graph edges.
- `operations`: expected old/target revision, operation kind, phase, retries and error.
- `transfers`: temp path, expected digest/size, strategy, bytes and state.
- `transfer_chunks`: ordinal, offset/length, digest, received/verified.
- `history_items`: original path, revision, archive path, reason, size, expiry and pin.
- `events`: monotonic sequence, severity/category, related IDs, stable message code and structured parameters.
- `settings`: engine-owned schema-versioned app settings.

## Notes

- Separate normalised path identity from display strings.
- Never use wall-clock timestamps as revision ordering keys.
- Index `(folder_id, relative_path)` and scan generations.
- Share transactions between operation/revision state where correctness requires.
- Track archive bytes transactionally.
- Store structured message codes, localise in renderer.

## Migrations

Forwards-only, backup before destructive migration, run before sync, pause on failure and test upgrades from every supported public schema.
