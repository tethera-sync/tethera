# Implementation Status

This document separates implemented behaviour from planned behaviour so the UI never implies that unfinished sync features are protecting data.

## Implemented in the first vertical slice

- Electron application shell with React, TypeScript, Tailwind CSS and shadcn-style components built on Base UI primitives.
- Overview, folder, activity, device, recovery and settings screens.
- Native folder picker for local paths.
- Persistent folder mappings stored in Electron's per-user application data directory.
- Per-folder pause/resume and non-destructive removal from configuration.
- Global pause/resume.
- Local activity log for configuration events.
- System tray behaviour with close-to-tray enabled by default.
- Launch-at-login, start-minimised, metered-network and theme settings.
- Narrow context-isolated preload API; no Node.js access in the renderer.
- Rust engine child-process supervisor with a random per-launch session token.
- Line-delimited JSON health and shutdown RPC methods.
- Deterministic concurrent-revision tie-breaking in `sync-core`, with tests.

## Clearly scaffolded but not yet implemented

- Pairing by code, QR code or LAN approval.
- Device identity key generation and secure key storage.
- Tailscale detection and peer routing.
- Recursive file watching and initial scans.
- SQLite index and migration system.
- Ignore-pattern evaluation.
- Chunking, hashing, encrypted transfer and resume.
- Version history, trash archive and restoration.
- Conflict detection based on revision ancestry.
- Cross-platform filename and metadata safeguards.
- Packaging and signed updates.

## Next vertical slice

1. Add the SQLite-backed engine database and migrations.
2. Add a real `folder.add` RPC method so the Rust engine owns folder configuration.
3. Implement initial recursive scans with ignore rules and progress events.
4. Stream engine events to Electron over the authenticated stdio RPC channel.
5. Replace Electron's temporary JSON state store once the Rust path is stable.
