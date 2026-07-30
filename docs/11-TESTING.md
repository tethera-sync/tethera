# Testing and quality strategy

## Pure and property tests

Test revision ancestry/concurrency, deterministic winner, direction, ignores, retention, merge plans and preconditions. Properties: idempotent replay, partial transfer never changes live path, replacement preserves old content, paths never escape root, both peers pick same winner, and eventual delivery converges.

## Integration/E2E

SQLite migration/recovery, watcher reconciliation, temp-verify-archive-replace, local RPC auth and protocol negotiation. Matrix covers Linux/Linux, Windows/Windows, Linux/Windows, LAN, remote/Tailscale simulation, disconnect at every phase, low space, permissions, sharing interference and name/case collisions.

## Fault injection

Crash after planning, during receive, after verify/archive/live rename, around DB commit and before ack. Restart must produce one safe tracked state.

## Fuzzing

Peer frames, paths, ignore parser, chunk maps, migrations where practical and pairing URI.

## Model simulation

Random create/edit/delete/rename, concurrent edits, policy changes, partitions, duplicate/reordered messages and restarts. After stability, verify convergence and that displaced content is live or accounted for in history/archive.

## UI/performance

React/Playwright Electron flows, keyboard/accessibility, virtualised large lists and renderer restart. Bench 10k/100k/1m scan, memory per entry, event bursts, hashing/chunking, delta break-even, SQLite queries, renderer memory and direct/relay throughput.

## Release gates

No known data-loss bug, crash-phase tests pass, cross-platform E2E passes, signed clean-VM artefacts verify, migrations recover, security checklist complete.
