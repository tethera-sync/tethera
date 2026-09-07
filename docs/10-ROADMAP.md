# Delivery roadmap

## M0 Foundations
Rust workspace, Electron/React shell, Base UI shadcn, Linux/Windows CI, lint/test/licence, ADR process, engine supervision, authenticated RPC and real empty snapshot.

## M1 Local index
Recursive scan, ignore engine, watcher plus reconciliation, SQLite migrations, stable reads and hashing.

Delivered local-index foundation:

- SQLite schema v4 is authoritative for folder mappings, verified file-sync state, and the replacement/archive journal.
- Versioned active events, terminal tombstones, exact pending-delivery acknowledgements, and one-time `state.json` migration are implemented.
- Mapping-store health and fail-closed renderer states are implemented.
- SQLite schema v4 stores per-file verified baselines, retryable operations, conflicts, archive objects, and replacement recovery state.
- Native recursive watchers plus a periodic safety scan drive continuous reconciliation.

Still outstanding in M1: scan generations/paging, incremental hashing at scale, and moving the live desktop scanner onto a single Rust implementation.

## M2 LAN technical MVP
Identity/pairing, LAN discovery, encrypted mutual session, folder mapping, previewed initial merge, whole-file transfer, atomic journalled commit, two-way sync, history/archive.

Pairing, authenticated Electron peer sessions, mapping approval, mapping-configuration reconciliation, a coordinated additive initial merge, and safe continuous file updates are implemented. Transfers are chunked and verified; replacements require the destination's last observed digest and use an atomic verified commit. Replaced content has a local content-addressed archive and restart-safe journal, and exact two-copy conflicts can be resolved explicitly through that path. Archived versions can be browsed and restored per folder through a bounded read-only engine query. Engine-owned networking, resumable chunks, deletion/rename propagation, and archive retention are not implemented.

## M3 Correctness hardening
Logical revisions, missing-copy/deletion conflicts, rename, open files, cross-platform incompatibilities, retention, removal workflow, and property/fault tests. Two-copy conflict selection, one-way enforcement, the archive-backed restore primitive, and per-folder archive-history browsing are implemented foundations rather than complete lifecycle UX.

## M4 Remote/performance
Tailscale route selection, resume, content-defined chunks, bandwidth/metered controls, paged inventories and profiling toward 1 TB collections.

## M5 Stable technical MVP
Installers, tray/startup, native alerts, diagnostics export, signed update notices, contributor/security docs and migration testing.

## M6 Polished public beta
Onboarding, full visual system, accessibility, recovery UX tests, opt-in auto updates, external security review, reproducible release and data-loss beta programme.

## Future
More devices, native NAT/relay, optional self-hosted rendezvous, other OSes, at-rest archive encryption, selective archive replication and snapshot integrations.

## Recommended next pull request

Archive-history browsing now exists over the implemented replacement journal and restore primitive. The next milestone should add the retention policy: an explicit budget, a pruning pass that cannot remove an object still referenced by unfinished or recovery-required journal state, and interrupted-pruning tests. Deletion and rename propagation should remain disabled until archive recovery and interruption behavior are proven safe end to end.
