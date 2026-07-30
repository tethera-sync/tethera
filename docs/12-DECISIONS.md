# Architecture decision index

| ID | Decision | Rationale |
|---|---|---|
| ADR-001 | Electron for v1 | Consistent Chromium renderer; user had poor Linux Tauri experience. |
| ADR-002 | React + TypeScript + Vite | Productive typed UI stack. |
| ADR-003 | shadcn/ui with Base UI | Owned accessible component source. |
| ADR-004 | Separate Rust engine | Heavy/correctness-critical work isolated from UI. |
| ADR-005 | Two devices first | Lower distributed complexity, extensible IDs later. |
| ADR-006 | No account | Direct device trust, no mandatory central service. |
| ADR-007 | Both online | No cloud intermediary. |
| ADR-008 | LAN + Tailscale | Local speed and remote reach without public ports. |
| ADR-009 | App encryption every route | Tailscale is defence in depth, not sole auth. |
| ADR-010 | Plain local files | Encrypt transfer, decrypt on receive. |
| ADR-011 | Two-way immediate default | Expected simple behaviour, configurable. |
| ADR-012 | Previewed initial merge | Prevent surprising overwrite/delete. |
| ADR-013 | Causal revisions | Clocks are not sufficient. |
| ADR-014 | Auto winner + history | One live path with recovery, configurable. |
| ADR-015 | Local archives only | Avoid recursive history and traffic. |
| ADR-016 | Central archive default | Keep metadata outside user roots. |
| ADR-017 | Time + size retention | Bounded disk with recovery window. |
| ADR-018 | Recursive + inspectable ignores | User-controlled subfolder exclusions. |
| ADR-019 | Whole/delta hybrid | Simplicity for small, efficiency for large. |
| ADR-020 | No telemetry | Explicit local diagnostics only. |
| ADR-021 | GPL-3.0-only | Distributed modifications remain open. |
