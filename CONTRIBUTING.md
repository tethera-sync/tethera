# Contributing

Priorities: data integrity, security/privacy, cross-platform clarity, performance, visual polish. Speed never justifies weakened recovery.

Before coding, read `docs/03-SYNC-SEMANTICS.md`, record architecture changes, explain failure/recovery behaviour and add regression tests for correctness bugs.

Rust formatting/linting and strict TypeScript must pass. Renderer code never imports privileged Node/Electron APIs. New IPC is validated in Electron and Rust. Protocol changes define compatibility. Dependencies need justification and licence review.


## Tooling

Use Bun for all JavaScript and TypeScript dependency management and scripts. Do not add pnpm, npm, or Yarn lockfiles. Run `bun install` at the repository root and commit `bun.lock`. Use Cargo directly, or the root Bun wrappers such as `bun run rust:test`, for the Rust workspace.
