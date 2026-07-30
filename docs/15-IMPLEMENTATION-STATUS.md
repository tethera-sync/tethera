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

## Current security boundary

Pairing and Slice 4 peer RPC currently run in the trusted Electron main process. Identity keys, sockets, manifests and raw peer messages never enter the renderer. The production target remains moving all network protocol, indexing, hashing and key handling into the Rust engine before public beta.

## Clearly not implemented yet

- Actual file copying or two-way reconciliation.
- Filesystem watchers and durable SQLite index.
- Revision ancestry and vector/version counters.
- Content-defined chunking, BLAKE3, resume and bandwidth scheduling.
- Version-history and trash archive writes/restoration.
- Rename/move propagation.
- Tailscale and Headscale routing.
- QR-code pairing.
- Packaging, signed updates and release hardening.

## Next vertical slice

1. Move approved mapping state into the Rust/SQLite index.
2. Perform a durable initial scan with BLAKE3 hashes.
3. Build a no-write reconciliation plan and show the exact operations.
4. Require final confirmation before the first transfer.
5. Implement whole-file encrypted transfer for small files with temporary writes, integrity verification and atomic replacement.

## LAN ports

- UDP 47654: discovery and presence
- TCP 47655: pairing
- TCP 47656: encrypted trusted-peer RPC
