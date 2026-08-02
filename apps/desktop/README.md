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

`state.json` continues to hold unrelated desktop preferences and temporary proposal UI state, but it is not a mapping read source or a second writable mapping store. The engine prefers `TETHERA_DATA_DIR`; the deprecated `FOLDERSYNC_DATA_DIR` is accepted only as a logged compatibility fallback. Electron continues to pass its established `userData` location so existing databases remain discoverable.

The existing explicitly initiated development initial pull can copy bounded remote-only files and skips differing files. This PR does not expand that path. Continuous two-way reconciliation, filesystem watchers, deletion propagation, production transfer and history remain unimplemented.

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
