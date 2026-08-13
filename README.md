<div align="center">
  <img src="assets/tethera-logo.png" alt="Tethera" width="120" />

  # Tethera

  **Private, peer-to-peer folder sync for Linux and Windows — no cloud, no account, no middleman.**

  [![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
  [![Status: early development](https://img.shields.io/badge/status-early%20development-orange)](docs/15-IMPLEMENTATION-STATUS.md)
  [![Bun](https://img.shields.io/badge/runtime-Bun-f472b6)](https://bun.sh)
  [![Rust](https://img.shields.io/badge/engine-Rust-dea584)](https://www.rust-lang.org)

</div>

---

Tethera keeps folders you choose in sync between two computers you trust — a Linux box and a Windows box, over LAN or [Tailscale](https://tailscale.com) — without uploading anything to a third party. There's no account to create, no server holding a copy of your files, and no telemetry. You pair two machines directly, pick the folders that matter, and Tethera keeps them aligned while both machines are online.

It's built for people who want Dropbox-style convenience for a couple of personal machines without trusting a cloud provider with the entire contents of a folder tree.

> **This repository is under active early development.** Pairing, authenticated peer sessions, approved folder mappings, a safe initial merge, and automatic post-merge file synchronization work today. Changes are detected continuously, transferred in verified chunks, and retried from durable Rust/SQLite state. Replaced files now have a durable local version archive and restart-safe restore journal. Deletion/rename propagation, archive browsing, conflict resolution, resumable chunks, and engine-owned network transfer are not implemented. See [`docs/15-IMPLEMENTATION-STATUS.md`](docs/15-IMPLEMENTATION-STATUS.md) for the exact boundary.

## Why Tethera

- **No cloud in the middle.** Files move directly between your paired devices over LAN or your Tailscale tailnet. Tethera never stores a copy of your data.
- **Normal files stay normal.** Synced folders remain ordinary directories on disk — no proprietary vault format, no forced app-only access.
- **Nothing happens silently.** Deletions are archived first, overwrites keep prior versions, and every automatic decision is meant to be recoverable or auditable.
- **Cross-platform by design.** Linux Mint and Windows 11 are first-class, including differing destination paths, filename rules, and case-sensitivity behavior.
- **The mapping index is the source of truth.** The Rust engine owns folder-mapping configuration, revisions, tombstones, and pending peer delivery in SQLite. The sandboxed renderer can reach it only through preload, Electron main, and authenticated local RPC.

## How it works

1. **Pair two computers.** Devices discover each other over LAN (or find each other over Tailscale) using a signed presence protocol, then confirm pairing with a comparison code approved on both sides.
2. **Choose folders to sync.** Point Tethera at a folder on each machine — the source and destination paths don't need to match.
3. **Tethera keeps them aligned.** Changes propagate directly between paired devices over an encrypted peer session. No relay server ever sees your files.

See [`docs/16-PAIRING-PROTOCOL.md`](docs/16-PAIRING-PROTOCOL.md) and [`docs/17-SECURE-PEER-SESSION-AND-MAPPING.md`](docs/17-SECURE-PEER-SESSION-AND-MAPPING.md) for the protocol details.

## Tech stack

| Layer | Technology |
|---|---|
| Sync engine | Rust workspace (`crates/`) — identity, transport, protocol, storage, crypto |
| Desktop shell | Electron + electron-vite |
| UI | React, TypeScript, Tailwind CSS, shadcn-style components on Base UI |
| Package management | Bun workspaces |

The Electron main process supervises the Rust `sync-engine` binary as a child process and talks to it over an authenticated stdio RPC session; the renderer never touches Node.js or Electron APIs directly.

Mapping data lives at `TETHERA_DATA_DIR/mappings.sqlite3`; the desktop passes its existing Electron `userData` directory so upgrades do not strand the PR #4 database. `FOLDERSYNC_DATA_DIR` remains a deprecated fallback for compatibility, and is ignored when `TETHERA_DATA_DIR` is present.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) 1.3.14 or newer
- Rust (stable) with Cargo
- Linux Mint or Windows 11 (the initial target platforms)

### Install

```bash
bun install
cd apps/desktop
bun run electron:install
cd ../..
```

The explicit `electron:install` step matters because of how Bun's isolated workspace layout and lifecycle-script security interact with Electron's postinstall.

### Run

UI only — the app launches without a built Rust binary, but mapping reads and mutations remain explicitly unavailable because SQLite cannot be reached:

```bash
bun run desktop:dev
```

With the Rust sync engine (builds `sync-engine` first, then launches the app):

```bash
bun run desktop:dev:full
```

### Test

```bash
bun run desktop:typecheck
bun run desktop:test
cargo test --workspace
```

Or everything at once:

```bash
bun run check
```

## Networking

Tethera needs the following local ports reachable on trusted/private networks only — it never opens or modifies firewall rules automatically:

| Port | Purpose |
|---|---|
| UDP 47654 | Signed LAN discovery and presence beacons |
| TCP 47655 | Direct pairing handshake |
| TCP 47656 | Authenticated, encrypted peer sessions |

## Documentation

| Doc | Covers |
|---|---|
| [`docs/00-PRODUCT-SPEC.md`](docs/00-PRODUCT-SPEC.md) | Vision, scope, and default policies |
| [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md) | System architecture |
| [`docs/03-SYNC-SEMANTICS.md`](docs/03-SYNC-SEMANTICS.md) | Sync, conflict, and recovery semantics |
| [`docs/05-SECURITY.md`](docs/05-SECURITY.md) | Threat model and security design |
| [`docs/07-UX-SPEC.md`](docs/07-UX-SPEC.md) | UX specification |
| [`docs/10-ROADMAP.md`](docs/10-ROADMAP.md) | Roadmap |
| [`docs/15-IMPLEMENTATION-STATUS.md`](docs/15-IMPLEMENTATION-STATUS.md) | What's implemented vs. planned, right now |
| [`docs/16-PAIRING-PROTOCOL.md`](docs/16-PAIRING-PROTOCOL.md) | Device pairing protocol |
| [`docs/17-SECURE-PEER-SESSION-AND-MAPPING.md`](docs/17-SECURE-PEER-SESSION-AND-MAPPING.md) | Encrypted peer sessions and folder mapping |

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for coding standards and priorities (data integrity and security come before speed or polish).

## Security

Found a vulnerability? Please see [`SECURITY.md`](SECURITY.md) before opening a public issue — some classes of report (pairing/auth bypass, path escape, RCE, data loss from crafted input) should be reported privately.

## License

Tethera is licensed under the [GNU GPLv3](LICENSE).
