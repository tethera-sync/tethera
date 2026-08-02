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
- The database lives at `FOLDERSYNC_DATA_DIR/mappings.sqlite3`, and the desktop shell passes Electron's `app.getPath("userData")` as that directory. Nothing is ever written inside the source tree.
- The schema is versioned with `PRAGMA user_version` (currently `1`). Each migration step runs inside one transaction that also bumps the version, so a migration either lands completely or not at all — it can never leave a half-migrated database claiming to be current. A database stamped with a *newer* version than the running build understands is refused with a structured error rather than opened and written to. Databases written before versioning existed are adopted as version 1.
- Connections run in WAL mode with foreign keys on and a 5-second busy timeout. The journal mode is read back rather than assumed, and reported through `health`, so a database that silently refused WAL is visible instead of presumed fine.
- Mapping writes are validated before they reach SQL: blank or overlong ids, unknown sync modes, negative or absurd history limits, and oversized ignore-pattern lists are rejected with a structured error. Every value is bound as a parameter; no RPC method accepts SQL.
- Malformed JSON in a stored `ignore_patterns` or `preview` column surfaces as a structured `CorruptRecord` error naming the mapping and the column, rather than panicking the engine.
- Paths are stored verbatim in both directions. A Windows `C:\Users\…` path (including UNC) and a Linux `/home/…` path each round-trip byte-for-byte; nothing normalises separators, because each path only has to stay valid on the machine that produced it. These are local paths in a private per-machine index — no path is ever used as a network identity or a cryptographic identifier.
- The Rust engine's stdio RPC exposes `mapping.upsert`, `mapping.get`, `mapping.list`, `mapping.listPendingDelivery` and `mapping.delete` alongside `health`/`shutdown`. Every one of them requires the local engine session token, checked before the request is even inspected.
- The Electron main process writes a mapping record through to the engine the moment either side approves it, and deletes the row when a folder is removed. Removal only ever drops the index record — no file inside a mapped folder is read, moved or deleted on either computer.
- Those writes are best-effort by design: a database that will not open must not be able to block pairing or approval. They are never silent, though. A failed write is logged *and* raised into the activity feed, and `health` reports whether the index is `ready`, `not-configured` or `unavailable` (with the reason), so the app never presents a mapping as durably persisted when it isn't.
- `pendingDelivery` means the same thing on both computers: the responder marks its record pending when it approves, and clears it once the approval has actually reached the initiator. The initiator only ever learns of an approval that has already arrived, so it records `false`. `mapping.listPendingDelivery` therefore returns exactly the approvals still owed to a peer.
- On every engine start, once the engine reports ready, the main process reconciles the index *one way*: folders `state.json` has but the index doesn't (approved while the engine wasn't running) are written through. It deliberately does not copy the other way — `state.json` is still authoritative, and an index record with no matching folder is ambiguous between "the snapshot was lost" and "the user removed this folder while the engine was down". Recreating a folder from it would silently resurrect a removed mapping, so those records are reported as orphans and left untouched. See `reconcileMappingIndex` and `apps/desktop/src/main/mapping-index.ts`.
- The JSON snapshot in `state.json` remains the authoritative, renderer-facing copy. The SQLite index is a durability backstop that is written but not yet read on the UI's path. Making it authoritative — and reading folders back out of it — is the next slice; see "Next vertical slice" below.

One-way pull-only initial file copy already runs from `startInitialSync` in the Electron main process: it diffs manifests, pulls remote-only files up to 8 MiB over the encrypted peer session, verifies a SHA-256 digest, and writes atomically. Files that differ on both sides are skipped rather than reconciled, and there is no two-way sync, chunking, resume or revision history yet — see "Clearly not implemented yet" below for the honest boundary.

## Implemented Rust-side manifest scan, comparison and sync planning

- `sync-core::manifest` reimplements `apps/desktop/src/main/folder-manifest.ts`'s comparison logic in Rust: the gitignore-flavoured `IgnoreMatcher` (`*`, `?`, `**`, directory-only and basename-only rules), `compare_manifests` (identical/different/one-sided counts, byte estimates per direction, Windows-invalid-name and case-collision detection), and `compute_sync_plan`, a no-write plan of exactly which remote-only files an initial sync would pull and which differing files it would skip and why.
- `sync-platform::scan_folder` recursively scans a directory into the same manifest shape, streaming each eligible file through `BLAKE3` rather than reading it into memory, and skipping anything ignored.
- **The scanner is preliminary, not production-ready.** It builds one whole manifest in memory in a single pass, and both of its ceilings are temporary guards against unbounded memory use, not product limits:
  - **10,000 files** — the scan stops there and marks the manifest `truncated`, so the caller gets a partial picture.
  - **16 MiB per file** — larger files are listed with size and mtime but no digest, and comparison falls back to the size/mtime heuristic for them.

  It is explicitly **not** ready for the terabyte-scale mappings Tethera targets. Lifting these ceilings needs the streaming, resumable, database-backed scan of the durable-index slice.
- Scanner safety properties, all covered by tests: it is strictly read-only (it never creates, writes, moves or deletes anything); it never follows symlinks, so it cannot be lured outside the folder it was given or into a cycle; traversal is depth-bounded so a pathological tree cannot exhaust the stack; every emitted path is relative to the scan root and cannot escape it; and an unreadable directory, entry or file is counted in `unreadable` and skipped rather than aborting the whole scan.
- Ignore patterns are gitignore-flavoured and matched case-insensitively against each entry's `/`-separated path relative to the root: `*` (within one segment), `?` (one character), `**` (crosses segments), a trailing `/` for directory-only rules, and basename-only matching when a pattern contains no `/`. A matched directory is skipped whole and counts as one `ignored`, not one per contained file. Negation (`!`) is not supported.
- The Rust engine's stdio RPC now also exposes `manifest.scan`, `manifest.compare` and `plan.build`, wrapping the above. All three require the session token. `manifest.scan` additionally requires a non-empty, length-bounded, absolute path, so it never resolves against whatever working directory the engine inherited.
- None of this is wired into the live desktop sync path yet — folder previews and `startInitialSync` still run entirely in Node.js against SHA-256 digests. This is additive infrastructure the next slice switches the desktop app over to; see "Next vertical slice" below.

## Implemented CI and release packaging

- GitHub Actions CI running lint, typecheck and test/build jobs on pushes and pull requests.
- Tag-triggered and manually-dispatchable release workflow that validates the desktop, Cargo and lockfile versions agree with the release tag before building anything.
- Cross-platform electron-builder packaging: macOS dmg/zip, Windows NSIS installer and Linux AppImage/deb, built on their native runners and attached to a draft GitHub release.
- electron-updater wired into the desktop app and pointed at the GitHub releases feed, using the `latest*.yml` update metadata electron-builder publishes alongside each build.
- Release artifacts are unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`, no code-signing certificates configured yet) — macOS Gatekeeper and Windows SmartScreen will warn until signing and notarization are added.

## Current security boundary

Pairing and Slice 4 peer RPC currently run in the trusted Electron main process. Identity keys, sockets, manifests and raw peer messages never enter the renderer. The production target remains moving all network protocol, indexing, hashing and key handling into the Rust engine before public beta.

## Clearly not implemented yet

- The Rust mapping index as the *sole authoritative* source of mapping state. It is written but never read on the UI's path; `state.json` is still the authority, and no folder is ever reconstructed from the index.
- Full two-device end-to-end consumption of persisted mappings: nothing in the sync pipeline yet reads a mapping back out of SQLite and acts on it.
- A durable per-file index. The mapping index stores mapping metadata only — no per-file rows, no scan generations, no revision history.
- Two-way reconciliation, reconciliation plans applied to real files, and conflict resolution; today's initial sync only pulls remote-only files and skips anything that differs on both sides.
- Deletion propagation. Removing a folder drops its index row on this computer only; it never deletes a file, and never tells the other computer to.
- Continuous filesystem watching. Everything is on-demand; nothing observes a folder for changes.
- Production file transfers: files over the 8 MiB initial-sync limit, and any transfer initiated from the Rust engine rather than the Electron main process — the engine can scan, compare and plan (see above) but cannot yet move a single byte.
- Revision ancestry and vector/version counters.
- Content-defined chunking, resume and bandwidth scheduling.
- Version-history and trash archive writes/restoration.
- Rename/move propagation.
- Tailscale and Headscale routing.
- QR-code pairing.
- Code-signed and notarized release builds; auto-update currently ships over unsigned artifacts.

## Next vertical slice

1. Make the Rust/SQLite mapping index the sole source of truth — have the UI's read path query it directly and retire the JSON copy of mapping/folder state — instead of today's write-only backstop. This is what makes recovering folders *from* the index safe: it needs a durable tombstone for a removed mapping so a restored record can't resurrect a folder the user deleted while the engine was down.
2. Switch the desktop app's folder previews and initial sync over to the Rust engine's `manifest.scan`/`manifest.compare`/`plan.build` RPC methods (BLAKE3-hashed, durable-scan-ready) instead of the current Node.js/SHA-256 implementation, including scanning the *encrypted peer's* folder through the engine rather than over the existing peer-session RPC.
3. Show the `plan.build` output to the user as the exact operations an initial sync will perform, including the files currently skipped for differing on both sides, before anything is written.
4. Require final confirmation before the first transfer.
5. Implement whole-file encrypted transfer for files of any size, run from the Rust engine, with temporary writes, integrity verification, atomic replacement and resume.

## LAN ports

- UDP 47654: discovery and presence
- TCP 47655: pairing
- TCP 47656: encrypted trusted-peer RPC
