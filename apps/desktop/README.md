# Desktop shell

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

## Implemented

- Persistent folder mappings and ignore patterns
- Native local folder selection
- Global and per-folder pause/resume
- Local activity log
- Close-to-tray lifecycle
- Basic launch and appearance settings
- Authenticated Rust child-process health handshake

## Component workflow

Add additional Base UI-backed shadcn components from this directory:

```bash
bunx shadcn@latest add button dialog dropdown-menu
```

The existing `button`, `dialog` and `switch` wrappers are local source files and can be customised without a package-level styling abstraction.
