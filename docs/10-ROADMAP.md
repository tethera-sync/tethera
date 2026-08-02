# Delivery roadmap

## M0 Foundations
Rust workspace, Electron/React shell, Base UI shadcn, Linux/Windows CI, lint/test/licence, ADR process, engine supervision, authenticated RPC and real empty snapshot.

## M1 Local index
Recursive scan, ignore engine, watcher plus reconciliation, SQLite migrations, stable reads and hashing.

Delivered mapping-configuration foundation:

- SQLite schema v2 is authoritative for folder mappings.
- Versioned active events, terminal tombstones, exact pending-delivery acknowledgements, and one-time `state.json` migration are implemented.
- Mapping-store health and fail-closed renderer states are implemented.

Still outstanding in M1: a durable per-file index, scan generations, production stable reads at scale, watcher/reconciliation scheduling, and moving the live desktop preview path onto the Rust scanner.

## M2 LAN technical MVP
Identity/pairing, LAN discovery, encrypted mutual session, folder mapping, previewed initial merge, whole-file transfer, atomic journalled commit, two-way sync, history/archive.

Pairing, authenticated Electron peer sessions, mapping approval, and mapping-configuration reconciliation are implemented. Engine-owned transfer, journalled file commits, continuous two-way sync, and history/archive are not.

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

PR #6 should move read-only manifest generation and initial comparison behind the existing authenticated engine boundary, with a durable-scan design that removes the preliminary scanner’s in-memory/size ceilings. It should remain a read-only slice: no transfers, watcher, file reconciliation, deletion propagation, or user-file mutation until the per-file index and operation journal have explicit migrations and crash tests.
