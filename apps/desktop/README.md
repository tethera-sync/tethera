# Desktop application

The desktop application uses Electron, electron-vite, React, TypeScript, Tailwind CSS and shadcn-style components backed by Base UI primitives.

From the repository root:

```bash
bun install
bun run desktop:setup
bun run desktop:dev
```

To build and connect the Rust health RPC before launching:

```bash
bun run desktop:dev:full
```

`desktop:dev:full` also runs the explicit Electron installer, which helps on fresh Bun workspace installs on Linux and Windows.

## Implemented

- Persistent local settings and activity, with approved folder mappings owned authoritatively by Rust/SQLite
- Custom local and encrypted remote folder browser
- Global and per-folder pause/resume
- Close-to-tray lifecycle and launch/appearance settings
- Authenticated Rust child-process health handshake
- Persistent Ed25519 device identity
- Signed LAN discovery and symmetric online/offline presence
- Two-sided pairing with a six-digit comparison code
- Trusted-device persistence and revocation
- Forward-secret authenticated peer RPC using X25519, HKDF and AES-256-GCM
- Recursive initial folder comparison with ignore rules
- Three-stage mapping wizard and mandatory approval on the receiving computer
- Recomparison when the receiving computer changes its destination folder
- Transactional one-time migration of legacy `state.json` mappings into SQLite
- Durable mapping tombstones and authenticated, exact-acknowledged configuration delivery
- Mapping-store loading, degraded, unsupported-schema and migration-failure UI
- One-click, direction-aware initial merge coordinated across both computers
- Bounded encrypted file chunks with full SHA-256 verification and atomic no-replace commits
- Automatic watcher-backed reconciliation with peer change notifications and a five-minute safety scan
- Durable Rust/SQLite file baselines, retry operations, and non-destructive conflicts

`state.json` continues to hold unrelated desktop preferences and temporary proposal UI state, but it is not a mapping read source or a second writable mapping store. The engine prefers `TETHERA_DATA_DIR`; the deprecated `FOLDERSYNC_DATA_DIR` is accepted only as a logged compatibility fallback. Electron continues to pass its established `userData` location so existing databases remain discoverable.

The explicitly initiated initial merge copies files that are missing on the receiving side, coordinates the inverse pass when the mapping direction allows it, and supports files larger than one peer-session frame. Once active, both computers watch their approved local root; the non-coordinator sends an authenticated change notification and a deterministic coordinator scans both roots. A five-minute full verification is the missed-event safety net. A change transfers only when the other copy still matches the last verified common digest, and the displaced version is hard-linked into a reserved recovery area before replacement. Simultaneous edits, one-sided deletions, and unbased legacy state are persisted and surfaced without choosing a winner. Deletion/rename propagation, recovery browsing/retention, production engine-owned networking, conflict resolution, content-defined chunks, and mid-file resume remain unimplemented.

## Checks

```bash
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
```

## Component workflow

Add additional Base UI-backed shadcn components from this directory:

```bash
bunx shadcn@latest add button dialog dropdown-menu
```

The existing component wrappers are local source files and can be customised without a package-level styling abstraction.
