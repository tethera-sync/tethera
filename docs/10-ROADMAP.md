# Delivery roadmap

## M0 Foundations
Rust workspace, Electron/React shell, Base UI shadcn, Linux/Windows CI, lint/test/licence, ADR process, engine supervision, authenticated RPC and real empty snapshot.

## M1 Local index
Recursive scan, ignore engine, watcher plus reconciliation, SQLite migrations, stable reads and hashing.

Delivered local-index foundation:

- SQLite schema v3 is authoritative for folder mappings and verified file-sync state.
- Versioned active events, terminal tombstones, exact pending-delivery acknowledgements, and one-time `state.json` migration are implemented.
- Mapping-store health and fail-closed renderer states are implemented.
- SQLite schema v3 stores per-file verified baselines, retryable operations, and conflicts.
- Native recursive watchers plus a periodic safety scan drive continuous reconciliation.

Still outstanding in M1: scan generations/paging, incremental hashing at scale, and moving the live desktop scanner onto a single Rust implementation.

## M2 LAN technical MVP
Identity/pairing, LAN discovery, encrypted mutual session, folder mapping, previewed initial merge, whole-file transfer, atomic journalled commit, two-way sync, history/archive.

Pairing, authenticated Electron peer sessions, mapping approval, mapping-configuration reconciliation, a coordinated additive initial merge, and safe continuous file updates are implemented. Transfers are chunked and verified; replacements require the destination's last observed digest and use an atomic verified commit. Engine-owned networking, resumable chunks, deletion/rename propagation, and history/archive are not.

## M3 Correctness hardening
Logical revisions, concurrent conflicts, rename, open files, cross-platform incompatibilities, history restore, retention, one-way modes, removal workflow, property/fault tests.

## M4 Remote/performance
Tailscale route selection, resume, content-defined chunks, bandwidth/metered controls, paged inventories and profiling toward 1 TB collections.

## M5 Stable technical MVP
Installers, tray/startup, native alerts, diagnostics export, signed update notices, contributor/security docs and migration testing.

## M6 Polished public beta
Onboarding, full visual system, accessibility, recovery UX tests, opt-in auto updates, external security review, reproducible release and data-loss beta programme.

## Future
More devices, native NAT/relay, optional self-hosted rendezvous, other OSes, at-rest archive encryption, selective archive replication and snapshot integrations.

## Recommended next pull request

The next milestone should add an explicit archive-backed conflict-resolution flow, using the implemented replacement journal and restore primitive whenever a user chooses a winner. Deletion and rename propagation should remain disabled until that recovery flow is exposed and proven safe end to end.
