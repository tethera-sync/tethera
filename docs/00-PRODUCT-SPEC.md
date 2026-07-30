# Product specification

## 1. Vision

Tethera is a private, local-first desktop application that keeps user-selected folders synchronised between a Linux Mint computer and a Windows 11 computer. It should feel as approachable as a consumer cloud-drive application while retaining the transparency, control and self-host-friendly values expected from open-source software.

The application does not provide cloud storage, does not require an account, does not upload telemetry and does not retain a project-operated copy of user files. Both paired computers must be online for synchronisation to occur.

## 2. Target users

### Primary

People with two personal computers who want selected folders available on both systems without copying their entire home directory or trusting a cloud-storage provider.

### Initial public audience

Technical users comfortable installing Tailscale and interpreting actionable diagnostics. The product then progresses to a polished public beta for ordinary users.

## 3. Jobs to be done

- Keep selected work, media, game, document or development folders aligned across two computers.
- Use different destination paths on each operating system.
- Work automatically while the app is open, without constant manual intervention.
- Recover an overwritten or deleted file.
- Understand what is syncing, what is ignored and why something failed.
- Sync remotely without opening a public port.

## 4. Product principles

1. **Never trade data safety for apparent speed.**
2. **Normal files stay normal.** The app does not force managed vault folders.
3. **Simple by default, inspectable underneath.**
4. **No silent destructive behaviour.**
5. **No mandatory account or project-operated storage.**
6. **The Rust engine is the source of truth.** The Electron UI is a client.
7. **Cross-platform differences are surfaced rather than hidden.**
8. **Every automatic decision is recoverable or auditable.**

## 5. Scope for version 1

### Included

- Two paired devices.
- Linux Mint and Windows 11.
- Multiple independently configured sync-folder pairs.
- Recursive subfolder syncing.
- Two-way sync by default.
- Per-folder one-way modes and pause/disable controls.
- Immediate sync by default, configurable to interval or manual.
- LAN direct transport.
- Tailscale transport for remote networks, including Headscale-compatible networks where practical.
- Initial non-destructive folder merge with preview.
- Ignore rules and glob patterns.
- Searchable ignored-item inspection.
- Version history for overwritten files.
- Recoverable archive for deleted files.
- Time and size retention limits per folder.
- Rename/move detection.
- Whole-file and changed-chunk transfer strategies.
- Transfer resumption.
- Global and per-folder bandwidth controls.
- Metered-network policies.
- Tray operation after the window closes.
- Configurable launch-at-sign-in; disabled by default.
- Important-only desktop notifications by default.
- Local diagnostic logs and manually exported redacted support bundles.
- Signed update notifications with optional automatic installation.

### Explicitly deferred

- Project-hosted accounts.
- Project-hosted discovery or relay service.
- Sync while one device is offline.
- Mobile clients.
- Native internet NAT traversal without Tailscale.
- More than two active devices in a folder mesh.
- Collaborative document merging.
- Full ACL, owner or extended-attribute replication.
- Remote browsing of arbitrary files outside configured roots.
- Archive mirroring between devices.

## 6. Success criteria

### Safety

- A power loss or process crash during transfer never leaves a partial file at the final destination path.
- Every destination replacement creates a recoverable local prior version unless explicitly excluded by policy.
- Deletions are archived before removal.
- The engine never follows a symlink outside a configured root.
- Initial pairing cannot complete without visible confirmation on both devices.

### Usability

- A first-time user can pair two machines and configure one folder pair without reading documentation.
- Every folder card communicates status in one glance.
- Every skipped item has a human-readable reason.
- Recovery of a previous version takes no more than a few clear steps.

### Performance targets for the polished beta

- Comfortable operation for aggregate configured data up to roughly 1 TB.
- Indexes hundreds of thousands of ordinary files without loading all entries into the Electron renderer.
- Streams large files with bounded memory.
- UI remains responsive during scans and transfers.
- Interrupted transfers resume from verified chunks when possible.

## 7. Default policies

| Area | Default |
|---|---|
| Direction | Two-way |
| Trigger | Immediate |
| Remote transport | Tailscale |
| Startup | Manual app launch |
| Window close | Continue in tray |
| Conflict | Choose deterministic winner, preserve loser in history |
| Deletion | Archive before deleting |
| Overwrite | Preserve prior version |
| History retention | 30 days or 10 GB per folder, oldest first |
| Hidden items | Sensible presets; user-created dotfiles are not universally ignored |
| Notifications | Important problems only |
| Telemetry | None |
| Archive location | Central app-managed location, configurable per folder |
| Archive replication | Local only |
| Bandwidth | Unlimited, configurable |

The 30-day/10-GB values are starting defaults, not protocol constants.

## 8. Public-release posture

The project is open source under GPL-3.0-only. Reproducible builds, signed releases, contribution guidance, security reporting and data-loss-focused test coverage are release requirements rather than post-launch polish.
