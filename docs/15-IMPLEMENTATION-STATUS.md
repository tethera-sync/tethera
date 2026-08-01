# Implementation Status

This document separates implemented behaviour from planned behaviour so the UI never implies that unfinished sync features are protecting data.

## Implemented desktop foundation

- Electron application shell with React, TypeScript, Tailwind CSS and shadcn-style components built on Base UI primitives.
- Overview, folder, activity, device, recovery and settings screens.
- Persistent local application state.
- Per-folder and global pause/resume plus non-destructive removal from configuration.
- Local activity log.
- System tray, close-to-tray, launch-at-login, start-minimised and theme settings.
- Narrow context-isolated preload API with renderer sandboxing and no renderer Node.js access.
- Rust engine child-process supervisor with authenticated stdio health and shutdown RPC.

## Implemented folder gate and custom browser

- A folder cannot be added until a trusted computer is paired.
- The custom in-app folder browser supports standard locations, drives/mounts, breadcrumbs, filtering, hidden folders, local folder creation and clear permission/error states.
- Remote browsing is read-only and returns directory metadata only through an encrypted trusted-peer request.

## Implemented LAN pairing and presence

- Persistent Ed25519 identity and stable fingerprint.
- Signed LAN discovery and reciprocal unicast presence beacons.
- Five-minute pairing visibility.
- Direct pairing with fresh nonces, matching six-digit comparison codes and approval on both computers.
- Persistent pinned peer identities and local trust revocation.
- Symmetric online/offline and LAN-direct state on Linux and Windows.

## Implemented in Slice 4

- Short-lived authenticated encrypted peer sessions on TCP 47656.
- Ephemeral X25519 key agreement for every request.
- Ed25519 authentication against the public key pinned during pairing.
- HKDF-SHA-256 session-key derivation and AES-256-GCM request/response encryption.
- Replay-resistant session IDs, fresh timestamps and bounded message size.
- Secure remote directory browsing through the existing custom picker.
- Recursive initial folder manifest generation with ignore-pattern evaluation.
- Development SHA-256 hashing for files up to 16 MiB.
- Initial comparison showing files on either side, identical files, different files and estimated transfer sizes.
- Windows-invalid filename and case-collision detection.
- A three-stage folder-mapping wizard.
- Explicit approval on the receiving computer, including the ability to change its local destination.
- Mandatory re-comparison when the receiver changes its destination, plus final stale-preview checks before a request or approval is accepted.
- Stable mapping IDs and matching persisted records on both computers.
- Approval delivery retries if the peer briefly disconnects.
- Honest `ready-for-initial-sync` state: no files are copied in this slice.

See [`17-SECURE-PEER-SESSION-AND-MAPPING.md`](17-SECURE-PEER-SESSION-AND-MAPPING.md).

## Implemented Rust/SQLite mapping index

- A `SQLite`-backed `MappingStore` in `sync-storage` durably records approved folder mappings: both device IDs and names, both paths, sync mode, ignore patterns, history limits, setup status, the last-verified comparison preview and timestamps.
- The Rust engine's stdio RPC now exposes `mapping.upsert`, `mapping.get`, `mapping.list`, `mapping.listPendingDelivery` and `mapping.delete` alongside `health`/`shutdown`, opening the database at `FOLDERSYNC_DATA_DIR/mappings.sqlite3`.
- The Electron main process write-throughs a mapping record to the engine the moment either side approves it, and deletes it from the index when a folder is removed. This is currently a best-effort dual write: the JSON snapshot in `state.json` remains the renderer-facing source of truth, and a write to the SQLite index is skipped (and logged) if the Rust engine isn't running yet.
- Full migration to the engine/SQLite index as the sole source of truth — including reading mappings back from it on startup — is still open; see "Next vertical slice" below.

One-way pull-only initial file copy already runs from `startInitialSync` in the Electron main process: it diffs manifests, pulls remote-only files up to 8 MiB over the encrypted peer session, verifies a SHA-256 digest, and writes atomically. Files that differ on both sides are skipped rather than reconciled, and there is no two-way sync, chunking, resume, revision history, BLAKE3 hashing or Rust-side involvement yet — see "Clearly not implemented yet" below for the honest boundary.

## Implemented CI and release packaging

- GitHub Actions CI running lint, typecheck and test/build jobs on pushes and pull requests.
- Tag-triggered and manually-dispatchable release workflow that validates the desktop, Cargo and lockfile versions agree with the release tag before building anything.
- Cross-platform electron-builder packaging: macOS dmg/zip, Windows NSIS installer and Linux AppImage/deb, built on their native runners and attached to a draft GitHub release.
- electron-updater wired into the desktop app and pointed at the GitHub releases feed, using the `latest*.yml` update metadata electron-builder publishes alongside each build.
- Release artifacts are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`, no code-signing certificates configured yet) — macOS Gatekeeper and Windows SmartScreen will warn until signing and notarization are added.

## Current security boundary

Pairing and Slice 4 peer RPC currently run in the trusted Electron main process. Identity keys, sockets, manifests and raw peer messages never enter the renderer. The production target remains moving all network protocol, indexing, hashing and key handling into the Rust engine before public beta.

## Clearly not implemented yet

- Two-way reconciliation and conflict resolution; today's initial sync only pulls remote-only files and skips anything that differs on both sides.
- Files over the 8 MiB initial-sync limit, and any file transfer initiated from the Rust engine rather than the Electron main process.
- Filesystem watchers and a durable SQLite file/revision index (the new mapping index only stores mapping metadata, not per-file state).
- Revision ancestry and vector/version counters.
- Content-defined chunking, BLAKE3, resume and bandwidth scheduling.
- Version-history and trash archive writes/restoration.
- Rename/move propagation.
- Tailscale and Headscale routing.
- QR-code pairing.
- Code-signed and notarized release builds; auto-update currently ships over unsigned artifacts.

## Next vertical slice

1. Make the Rust/SQLite mapping index the sole source of truth (read mappings back from it on startup, retire the JSON copy) instead of today's best-effort dual write.
2. Perform a durable initial scan with BLAKE3 hashes, run from the Rust engine rather than Node.js.
3. Build a no-write reconciliation plan and show the exact operations, including files currently skipped for differing on both sides.
4. Require final confirmation before the first transfer.
5. Implement whole-file encrypted transfer for files of any size, run from the Rust engine, with temporary writes, integrity verification, atomic replacement and resume.

## LAN ports

- UDP 47654: discovery and presence
- TCP 47655: pairing
- TCP 47656: encrypted trusted-peer RPC
