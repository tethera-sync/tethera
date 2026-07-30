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

- Persistent local settings, activity and approved folder-mapping records
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

Actual file transfer, replacement and deletion remain deliberately disabled. Approved mappings enter `ready-for-initial-sync` state until the Rust reconciliation and transfer slice is implemented.

## Checks

```bash
bun run desktop:typecheck
bun run desktop:test
```

## Component workflow

Add additional Base UI-backed shadcn components from this directory:

```bash
bunx shadcn@latest add button dialog dropdown-menu
```

The existing component wrappers are local source files and can be customised without a package-level styling abstraction.
