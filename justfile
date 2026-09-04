default:
    @just --list

check:
    bun run verify

fmt:
    cargo fmt --all

run-engine:
    cargo run -p sync-engine
