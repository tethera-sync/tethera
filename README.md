# FolderSync

FolderSync is a GPLv3 peer-to-peer folder synchronisation application for Linux and Windows. Users choose individual folders, pair trusted computers and transfer files directly over LAN or Tailscale. Files are encrypted in transit and stored normally on the receiving filesystem.

The repository is an implementation starter, not yet a production-safe sync tool. See [`docs/15-IMPLEMENTATION-STATUS.md`](docs/15-IMPLEMENTATION-STATUS.md) for the exact boundary between working features and planned features.

## Stack

- Bun workspaces
- Electron + electron-vite
- React + TypeScript
- shadcn-style components using Base UI primitives
- Tailwind CSS
- Rust workspace for the sync engine

## Prerequisites

- Bun 1.3.14 or newer stable release
- Rust stable with Cargo
- Linux Mint or Windows 11 for the initial target platforms

## Install

```bash
bun install
cd apps/desktop
bun run electron:install
cd ../..
```

The explicit Electron install command is useful with Bun's isolated workspace layout and lifecycle-script security.

## Run the UI only

The app launches and saves folder configuration even when the Rust binary has not been built:

```bash
bun run desktop:dev
```

## Run with the Rust engine

```bash
bun run desktop:dev:full
```

This builds `sync-engine` first. The Electron main process discovers `target/debug/sync-engine`, launches it with an authenticated stdio RPC session and displays its health status in the sidebar.

## Checks

```bash
bun run desktop:typecheck
cargo test --workspace
```

## Documentation

Start with:

- [`docs/00-PRODUCT-SPEC.md`](docs/00-PRODUCT-SPEC.md)
- [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md)
- [`docs/03-SYNC-SEMANTICS.md`](docs/03-SYNC-SEMANTICS.md)
- [`docs/05-SECURITY.md`](docs/05-SECURITY.md)
- [`docs/07-UX-SPEC.md`](docs/07-UX-SPEC.md)
- [`docs/15-IMPLEMENTATION-STATUS.md`](docs/15-IMPLEMENTATION-STATUS.md)
