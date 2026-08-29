# AGENTS.md

This file defines how coding agents should work in this repository.

The goal is not to make code compile at any cost. The goal is to make changes that are correct, simple, easy to understand, and pleasant to work with later.

Leave the codebase better than you found it.

## Repository context

Tethera is a private, peer-to-peer desktop folder-sync application. It is not a conventional web app or a TypeScript-only project.

The stack is:

* a Bun workspace for JavaScript and TypeScript tooling;
* Electron and electron-vite for the desktop shell;
* React, strict TypeScript, Tailwind CSS, and shadcn-style components built on Base UI for the renderer;
* a Cargo workspace for the Rust sync engine, protocol, storage, crypto, platform, transport, and test support;
* SQLite for authoritative durable sync and mapping state; and
* authenticated local RPC and authenticated peer protocols at process and device boundaries.

Before changing behaviour, read the narrowest relevant source of truth:

* `README.md` for the supported stack and root commands;
* `CONTRIBUTING.md` for repository-wide safety and tooling rules;
* `docs/02-ARCHITECTURE.md` for the intended process and crate boundaries;
* `docs/03-SYNC-SEMANTICS.md` for convergence, conflict, deletion, and recovery rules;
* `docs/05-SECURITY.md` for the threat model;
* `docs/11-TESTING.md` for required validation;
* `docs/15-IMPLEMENTATION-STATUS.md` for what is implemented rather than merely planned; and
* the protocol documents in `docs/` when changing IPC, local RPC, pairing, or peer messages.

Some design documents describe future work. Do not implement against a planned topology as though it already exists. Confirm the live ownership in source and tests, and keep `docs/15-IMPLEMENTATION-STATUS.md` accurate when an implementation boundary moves.

## Non-negotiable architecture boundaries

Preserve the process boundaries unless the task explicitly changes the architecture:

* The React renderer is sandboxed. It must not import Node.js, Electron, filesystem, child-process, database, or private-key APIs.
* The preload exposes a narrow, capability-shaped `contextBridge` API. Never expose raw `ipcRenderer`, arbitrary channels, unrestricted paths, shell execution, or Node modules.
* Electron main owns desktop integration, window/tray lifecycle, validated IPC, Rust engine supervision, and the TypeScript-side orchestration that still lives there.
* The Rust engine and Rust crates own the authoritative mapping database, durable sync state, migrations, and the engine-side domain rules already assigned to them.
* The TypeScript-to-Rust boundary is authenticated newline-delimited JSON over child-process stdio. Changes to a request, response, method, error code, or protocol version must update both producers and consumers and add compatibility-focused tests.
* Authenticated peer messages are also untrusted input. Validate their size, shape, participant identity, revision, and path scope before they can affect local state.
* React state, browser storage, Electron preference state, and legacy JSON are not substitutes for authoritative Rust/SQLite state.

Keep types shared only within the boundary that owns them. TypeScript renderer/main contracts belong in `apps/desktop/src/shared`; Rust wire contracts belong in `sync-protocol`; persistence types and migrations belong in `sync-storage`. Do not create a third competing representation without a concrete boundary reason.

## Data integrity and filesystem safety

Tethera handles user files. A change that is merely convenient is not acceptable if it weakens recovery, path containment, authentication, or durable state.

* Treat local paths, remote paths, directory entries, file metadata, RPC payloads, peer messages, and persisted rows as untrusted at their boundary.
* Never perform a sync file operation outside the exact approved mapping root. The only permitted paths outside a mapping root are dedicated app-managed state, staging, archive, and recovery locations defined by the existing design; read or write them through their narrow owning modules, never through an arbitrary peer- or renderer-supplied path. Account for traversal, symlinks, junctions, reparse points, case differences, and time-of-check/time-of-use races.
* Preserve remote Windows drive paths, UNC paths, and Linux paths as opaque values until the machine that owns the path validates or resolves it. Do not run a remote path through host-platform path semantics.
* Preserve the existing staged-write, digest-verification, fsync, atomic no-replace, archive, and replacement-journal guarantees. Do not replace them with a simpler direct write or rename.
* Persist multi-step state transitions transactionally. Startup recovery must be idempotent, and a retry must not duplicate an operation or revive deleted state.
* An unavailable, locked, corrupt, migration-failed, or newer-schema database must fail closed. Never reinterpret it as an empty mapping set, silently recreate it, or fall back to stale legacy state.
* Do not enable deletion, rename propagation, conflict winner selection, or cleanup of recovery evidence unless the task includes the required recovery semantics and tests.
* Do not implement cryptographic primitives. Use the existing audited libraries and protocol construction, and preserve domain separation, replay protection, and authenticated identities.
* Tests must use temporary/synthetic roots. Never point automated tests or development migrations at real user folders.

Linux and Windows are first-class targets. Avoid Unix-only process, permission, separator, atomicity, executable-bit, case-sensitivity, or filename assumptions in shared behaviour. When platform behaviour differs, isolate it in `sync-platform` or the narrowest platform-specific desktop boundary and test both representations.

## Priorities

When making trade-offs, use this order:

1. Data integrity and recoverability
2. Security and privacy
3. Correctness
4. Cross-platform behaviour
5. Simplicity and clear architecture
6. User experience and accessibility
7. Type safety and maintainability
8. Developer experience
9. Performance
10. Delivery speed

Do not trade away the first nine just to finish faster.

## Before you write code

Inspect the repository first.

For any non-trivial task:

1. Find the code that currently owns the behaviour.
2. Read the nearby files.
3. Look for an existing implementation of something similar.
4. Check the types, tests, schemas, components, utilities, and package scripts that already exist.
5. Understand the local folder structure and dependency direction.
6. Work out the smallest complete change that solves the actual problem.
7. Then implement it.

Do not invent a second architecture because you prefer another pattern.

Do not create a new helper, component, hook, service, type, schema, or dependency before checking whether the repository already has one.

Existing code is evidence. Read it before guessing.

## Write good code

Code should be easy to follow without needing a long explanation beside it.

Prefer:

* clear names;
* small focused functions;
* early returns;
* explicit state;
* narrow interfaces;
* predictable control flow;
* strong domain types;
* composition;
* local reasoning;
* obvious ownership of data and side effects.

Avoid:

* clever code;
* unnecessary indirection;
* hidden side effects;
* giant functions;
* giant components;
* vague generic helpers;
* deeply nested control flow;
* stringly typed behaviour;
* mystery booleans;
* god objects;
* premature abstractions.

If a simpler implementation solves the same problem cleanly, use it.

## Do not write Python-shaped TypeScript

TypeScript should look and feel like TypeScript.

Do not write JavaScript or TypeScript as though Python code was translated line by line.

Avoid:

* large procedural scripts;
* giant mutable objects passed through every function;
* dictionaries standing in for proper types;
* long chains of state mutation;
* functions that operate on vaguely shaped bags of values;
* dynamic property access when the shape is known;
* excessive runtime type guessing;
* class-heavy designs for simple data and behaviour;
* recreating framework features manually;
* writing generic pseudocode instead of idiomatic application code.

Use the language and framework properly.

In TypeScript, make the type system do useful work.

## TypeScript and Electron

Keep TypeScript strict and follow the renderer/preload/main boundaries above. A compile-time type on one side of IPC, RPC, persistence, or a peer connection does not validate the runtime payload on the other side.

Do not make browser-preview success stand in for Electron runtime verification. Browser previews do not provide the real preload bridge. Likewise, a renderer build does not prove that the packaged Rust binary is present, spawnable, protocol-compatible, or able to recover its database.

## Rust

Use the repository's stable Rust toolchain, respect the workspace's Rust 1.85 minimum and Rust 2024 edition, and do not assume the floating `stable` channel is an exact version pin. `unsafe` is forbidden at workspace level. Keep `cargo fmt` clean and treat Clippy warnings as errors in completed work.

Use these broad crate boundaries, confirming current ownership against source and `docs/15-IMPLEMENTATION-STATUS.md` when the architecture document describes planned or older behaviour:

* `sync-core` contains pure domain and reconciliation rules and should not gain filesystem, network, or SQLite dependencies;
* `sync-protocol` owns versioned serialisable Rust wire types;
* `sync-crypto` owns identity and cryptographic integration while delegating primitives to audited crates;
* `sync-storage` owns SQLite schemas, migrations, journals, and durable state;
* `sync-platform` owns platform filesystem behaviour;
* `sync-transport` owns discovery, secure framing, connection, and transport concerns;
* `sync-engine` composes the implemented engine-side runtime; and
* `sync-testkit` owns reusable deterministic and fault-oriented test support.

Prefer explicit domain types and `Result`-based errors. Do not use `unwrap`, `expect`, `panic!`, or `unreachable!` on data, filesystem, database, network, peer, or RPC paths. In tests, or for a truly local invariant, an `expect` is acceptable when its message explains the invariant.

For serialised contracts, keep naming and unknown-field behaviour intentional. Rust's `serde` shape, TypeScript's runtime validator/parser, and both sides' tests must agree. Do not assume a successful TypeScript typecheck proves Rust/TypeScript wire compatibility.

## Never use `any`

Do not use `any`.

That includes:

```ts
const value: any = input;
```

```ts
function parse(value: any) {}
```

```ts
something as any;
```

```ts
Record<string, any>
```

Do not hide `any` behind a type alias.

When a value is genuinely unknown, use `unknown` and narrow it.

If a third-party library has poor types, isolate that problem at the boundary instead of spreading unsafe types through the application.

Do not use type assertions just to silence TypeScript.

A cast should represent something you actually know, not something you want the compiler to stop complaining about.

Avoid non-null assertions unless the invariant is clear and local.

## Make invalid states difficult to represent

Use types to model real application states.

Prefer:

```ts
type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: Result }
  | { status: "error"; error: Error };
```

instead of:

```ts
interface RequestState {
  loading: boolean;
  successful: boolean;
  data?: Result;
  error?: Error;
}
```

The second version allows nonsense states.

Do not make every caller defend against combinations that should never have existed.

Prefer discriminated unions, enums or literal unions, branded IDs where useful, and domain-specific types over loose primitives.

## Keep the solution proportional to the problem

Do not turn 100 lines of straightforward code into 1,000 lines of architecture.

Do not create:

* interfaces with one implementation for no reason;
* factories that construct one thing;
* repositories that only rename a database call;
* service layers that only forward arguments;
* adapters with nothing to adapt;
* generic engines for one use case;
* configuration systems for three constants;
* dependency injection containers for ordinary application code.

Every abstraction should earn its place.

An abstraction is useful when it does at least one of these:

* hides real complexity;
* protects an invariant;
* creates a meaningful boundary;
* removes repeated domain behaviour;
* provides a stable public interface.

"Maybe we will need it later" is not enough.

Build for the requirements that exist now.

Leave normal extension points where they naturally belong, but do not build imaginary future features.

## A little duplication is fine

Do not force two unrelated things together because they currently look similar.

Duplicate simple code is sometimes cheaper than the wrong abstraction.

Extract shared behaviour when the concepts are genuinely the same and are likely to change together.

Do not create a generic helper just to remove three lines.

## Keep files focused

A file should have a clear job.

Do not put an entire feature into one file containing:

* UI;
* business logic;
* API calls;
* validation;
* database access;
* formatting;
* types;
* state management;
* side effects.

Split code when responsibilities are genuinely different.

Do not split code purely because a file reached an arbitrary number of lines.

A cohesive 250-line module is better than ten tiny files that only make the call stack harder to follow.

Split by responsibility, not by line count.

## Do not put everything in one folder

Avoid turning the repository into this:

```text
src/
  components/
    hundreds-of-unrelated-files.tsx
  hooks/
    everything.ts
  services/
    everything-else.ts
  utils/
    random-stuff.ts
  types/
    every-type-in-the-app.ts
```

Keep feature-specific code with the feature that owns it.

A simplified map of this repository is:

```text
apps/desktop/src/
  main/       privileged Electron orchestration
  preload/    narrow context bridge
  renderer/   React UI
  shared/     renderer/main contracts
crates/
  sync-*/     Rust domains described in docs/02-ARCHITECTURE.md
```

Follow the architecture already used by the repository when it is sensible.

The important rule is locality.

Someone working on a feature should be able to find most of that feature without searching five unrelated global folders.

Shared folders are for code that is actually shared.

## Avoid dumping grounds

Be suspicious of vague files and folders named:

```text
utils
helpers
common
misc
types
constants
processor
```

Those names are not automatically wrong, but they often become places where architecture goes to die. Domain names such as `PeerSessionService`, `EngineSupervisor`, or the deliberate `shared` contract boundary are not dumping grounds merely because they use a general suffix.

Prefer names based on what the code does.

For example:

```text
path-safety.ts
folder-manifest.ts
version-archive.ts
mapping-authority.ts
```

is usually clearer than:

```text
utils.ts
helpers.ts
common.ts
```

## Keep dependencies moving in a sensible direction

Higher-level features may use lower-level shared infrastructure.

Shared infrastructure must not know about individual features.

UI primitives should not contain product business rules.

Database modules should not depend on React components.

Generic libraries should not import application routes.

Privileged Electron main/preload code, Node-only modules, and Rust integration details must not leak into the renderer bundle.

Avoid circular dependencies.

If two modules cannot exist without importing each other, the boundary is probably wrong.

## Keep module APIs small

Do not export everything.

A module should expose the parts other code is meant to use and keep implementation details private.

Avoid enormous barrel files that re-export half the repository.

Barrel files are useful when they define a deliberate module boundary.

They are not a substitute for one.

## Put types near the code that owns them

Do not create one global `types.ts` containing every type in the application.

Feature-specific types belong with that feature.

Shared domain types belong in the domain that owns them.

Use existing domain types instead of creating slightly different copies in several places.

Use `import type` for type-only imports where appropriate.

## Keep business rules out of UI markup

Components should mostly deal with presentation and interaction.

Do not bury important rules inside JSX.

Prefer:

```ts
const canRefund = canRefundOrder(order, policy);
```

to a long condition embedded directly inside a button.

Business rules should usually be testable without rendering the interface.

The UI may use the rule. It should not secretly become the only place where the rule exists.

## React

For React code:

* keep components focused;
* prefer composition over giant configurable components;
* avoid components with piles of boolean props;
* derive values during render when possible;
* avoid duplicated or mirrored state;
* do not use `useEffect` to calculate something that could have been calculated normally;
* do not create a custom hook just to rename another hook;
* keep browser-only code at the narrowest sensible boundary;
* avoid unnecessary context providers;
* use stable keys;
* keep expensive or stateful work out of render;
* do not move privileged main-process or engine work into the renderer because one component needs interaction.

Some components only need to exist for one screen.

That is fine.

Not everything needs to become a reusable design-system primitive.

## UI

Use the existing design system.

Before creating a button, dialog, dropdown, tooltip, input, card, tab, sheet, menu, or other primitive, check whether one already exists.

If the project uses shadcn, Base UI, Radix, or another established system, use it instead of creating another competing set of primitives.

Prefer composition over copying a shared component into a feature and modifying the copy.

Follow the existing:

* spacing;
* radii;
* typography;
* colours;
* tokens;
* icon system;
* interaction patterns.

Do not scatter arbitrary values everywhere when a project token already expresses the same thing.

If the project uses Tailwind, prefer Tailwind and existing design tokens over one-off CSS files.

Do not rebuild something in custom CSS because you forgot to check the existing component library.

## UX is part of whether the feature works

A feature is not complete just because the happy path technically functions.

For user-facing changes, consider the states that actually matter:

* loading;
* empty;
* error;
* success;
* disabled;
* unavailable;
* offline;
* stale;
* permission denied.

Do not add states that cannot happen just to satisfy a checklist.

Give the user useful feedback when an action takes time or fails.

Error messages should help them recover.

Do not expose implementation details when the user needs to know what happened and what they can do next.

Avoid unnecessary steps, choices, dialogs, and visual noise.

Use sensible defaults.

## Accessibility is not a cleanup task

Use semantic HTML first.

Use a button for an action.

Use a link for navigation.

Do not make clickable `div` elements.

Interactive elements must work with a keyboard.

Keep visible focus states.

Inputs need proper labels.

Icon-only controls need accessible names.

Do not communicate important state using colour alone.

Respect reduced motion when motion is not essential.

Do not remove native accessibility behaviour and replace it with a worse custom version.

## Validate data at boundaries

Treat external data as untrusted.

Validate values entering from:

* Electron IPC calls;
* local TypeScript-to-Rust RPC;
* authenticated peer messages;
* forms;
* environment variables;
* imported files;
* filesystem and watcher APIs;
* persisted JSON; and
* SQLite rows when their shape or schema version is not guaranteed.

Use the repository's existing validation system.

In TypeScript projects, use the established schema library rather than writing a second validation framework.

Once data has crossed a trusted validated boundary, do not repeatedly validate it at every internal function call.

Keep unsafe boundaries small and obvious.

## Error handling should preserve information

Do not do this:

```ts
try {
  return await loadData();
} catch {
  return null;
}
```

unless failure genuinely means "there is no result."

Do not swallow errors.

Do not log an error and then pretend the operation succeeded.

Do not replace useful errors with vague "something went wrong" exceptions deep inside the stack.

Expected user errors and unexpected system failures are different things. Treat them differently.

Preserve enough context to debug a failure without exposing secrets or sensitive data.

## Async work

Parallelize independent work when it meaningfully avoids a waterfall.

Do not parallelize operations that depend on each other just because `Promise.all` looks faster.

Do not fire and forget important promises.

Handle cleanup, cancellation, retries, and timeouts where the operation actually needs them.

Do not add arbitrary sleeps to fix races.

Find the race.

## Database code

The authoritative database belongs to Rust's `sync-storage` crate. Renderer and preload code must not access SQLite, and Electron main must go through the authenticated engine RPC for engine-owned state.

Avoid:

* N+1 queries;
* unbounded reads;
* database calls hidden inside loops;
* fetching large records when only two fields are needed;
* business rules scattered through query code;
* several round trips when one clear query can do the job.

Use transactions when a set of writes must succeed or fail together.

Do not keep transactions open while doing unrelated work.

Use database constraints for invariants the database genuinely owns.

Treat schema changes as real migrations, not casual edits.

Migrations must preserve existing installations, run transactionally, be restart-safe and idempotent, and refuse a newer unknown schema without modifying it. Update migration tests and `docs/06-DATA-MODEL.md` or `docs/15-IMPLEMENTATION-STATUS.md` when the persisted contract changes.

## Performance

Do not prematurely optimize normal code.

Also do not knowingly write obviously wasteful code.

Watch for:

* unnecessary renders;
* request waterfalls;
* duplicate fetching;
* repeated parsing;
* repeated expensive calculations;
* large client bundles;
* unnecessary client-side JavaScript;
* unbounded collections;
* accidental quadratic loops;
* oversized database queries;
* loading data that will never be used.

Optimize real bottlenecks or problems that are obvious from the execution path.

Do not make code difficult to read to save a theoretical microsecond.

## Developer experience matters

A good repository should be easy to start, understand, change, test, and debug.

A developer should not need tribal knowledge to run the project.

Prefer:

* one obvious setup path;
* predictable scripts;
* useful errors;
* validated environment configuration;
* sensible defaults;
* commands that work from the repository root;
* fast local feedback;
* documented unusual requirements.

Avoid:

* undocumented manual setup;
* duplicate commands that do the same thing;
* giant pre-commit checks;
* generation steps nobody understands;
* tooling that fails with meaningless errors;
* scripts that only work from a mystery directory.

Do not make local development slower without a good reason.

Expensive repository-wide checks can live in CI when they do not need to block every edit.

## Dependencies have a cost

Use Bun for the JavaScript/TypeScript workspace and Cargo for Rust.

Do not introduce another lockfile.

Do not upgrade unrelated packages during a focused task.

Before adding a dependency, check:

1. Does the language already solve this?
2. Does the framework already solve this?
3. Does the repository already contain something that solves this?
4. Is the package maintained?
5. Is the dependency worth the code and maintenance it adds?

Do not install a package for a tiny helper that can be safely written in a few clear lines.

Do not manually edit lockfiles.

## Names should explain the code

Prefer:

```ts
getActiveSubscription()
isEligibleForRefund()
customerId
formatReleaseDate()
```

over:

```ts
getData()
handle()
value
thing
process()
manager()
```

Avoid vague suffixes such as `Manager`, `Processor`, `Service`, `Helper`, and `Util` when they do not describe a real role.

A good name reduces the amount of explanation the implementation needs.

## Comments should explain why

Do not narrate obvious code.

Bad:

```ts
// Increase the count
count += 1;
```

Useful:

```ts
// The upstream API uses an inclusive page index, so advance
// only after the current page has been processed.
page += 1;
```

Delete stale comments when behaviour changes.

Do not leave commented-out implementations.

Git already stores the old code.

## Fix causes, not symptoms

When fixing a bug:

1. Reproduce it.
2. Trace the real execution path.
3. Find the cause.
4. Fix the cause.
5. Verify the original failure.
6. Check nearby behaviour for regressions.

Do not keep adding guards until the error disappears.

Do not add retries without understanding the failure.

Do not add timeouts or delays to cover broken state management.

Do not suppress warnings you have not understood.

## Keep changes focused

Do not rewrite unrelated areas while completing a small task.

Do not rename twenty files because you touched one of them.

Do not reformat files that are unrelated to the change.

Do not replace working architecture with your preferred architecture unless the task is actually an architecture change.

Small cleanup in the code you are already touching is fine when it clearly improves the result.

Large cleanup should be separate.

Focused diffs are easier to review, test, debug, and revert.

## Delete dead code

Do not leave:

* commented-out implementations;
* `_old` files;
* unused imports;
* unused functions;
* abandoned components;
* temporary debug logs;
* duplicate implementations;
* compatibility wrappers with no callers;
* TODOs that hide unfinished required work.

If code is no longer needed, remove it.

## Security

Never trust renderer state, IPC callers, RPC payloads, discovery packets, paired peers, or path strings merely because they came through an expected code path.

Sensitive operations must be checked at the trusted boundary that performs them: validated Electron main IPC, authenticated Rust RPC, or authenticated peer-session dispatch.

Check mapping/device participation and path scope, not just authentication.

Do not expose secrets, tokens, credentials, private identifiers, internal metadata, or sensitive user information where they do not belong.

Do not put secrets in:

* client bundles;
* URLs unless unavoidable;
* logs;
* error messages;
* test fixtures;
* committed configuration.

Treat user input and third-party responses as untrusted.

Fail safely when required security configuration is missing.

## Tests

Test behaviour that matters.

Good candidates include:

* business rules;
* IPC and RPC contracts;
* protocol compatibility;
* mapping revisions and migrations;
* destructive actions;
* state transitions;
* validation;
* parsing;
* path containment and cross-platform path representation;
* interrupted transfer, restart, retry, and recovery behaviour;
* tricky edge cases;
* previous regressions.

Do not write tests just to increase a coverage percentage.

Avoid tests that know so much about the implementation that a harmless refactor breaks them.

When fixing a bug, add a regression test when there is a sensible place for one.

Tests should make changing code safer.

## Verify the work

Do not call a task finished because the editor stopped showing errors.

Use the checks provided by the repository.

Use the narrowest relevant checks while iterating and when completing a task confined to one stack. For a pull request, release, cross-stack change, or high-risk sync/security/persistence change, the full local validation set is:

```bash
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
git diff --check
```

`bun run check` is a useful combined typecheck/test command, but it does not run the desktop build, Rust formatting, or Clippy. Do not present it as the complete pull-request gate by itself.

For renderer-only work, manually verify the affected states and interactions. For preload, IPC, engine-spawn, filesystem, updater, tray, packaging, or cross-process work, verify in Electron rather than only a browser. For peer sync or platform-sensitive work, unit tests on one Linux machine are not proof of a real Linux-to-Windows run; state that limitation unless the physical/platform matrix was exercised.

Changes limited to documentation do not require the full application suite unless they alter executable examples or build configuration. Still verify links, commands, formatting, and the final diff.

Do not claim a command passed unless you actually ran it.

If something could not be checked, say exactly what was not verified and why.

## When you are unsure

Do not guess immediately.

Look at:

* nearby code;
* types;
* tests;
* schemas;
* routes;
* existing UI;
* package scripts;
* repository history if useful;
* established naming;
* established architecture.

When several solutions are valid, prefer the simplest one that fits the current codebase.

## Definition of done

A task is done when:

* the requested behaviour works;
* the root problem was solved rather than hidden;
* the implementation fits the existing architecture;
* types remain strict;
* no `any` was introduced;
* code is idiomatic for the language;
* files and folders still have clear responsibilities;
* no unnecessary abstraction was added;
* important failure states are handled;
* accessibility and security were considered where relevant;
* relevant checks pass;
* there is no debug code or dead code left behind;
* the diff does not contain unrelated rewrites.

Before finishing, read the diff once more as if you were the next developer who has to maintain it.

If the code needs a long explanation to justify why it is shaped the way it is, see if the code can be made simpler first.

## Final response

Keep completion messages useful.

Say:

1. what changed;
2. anything important about the implementation;
3. what you verified;
4. any real limitation or unfinished requirement.

Do not pad the response with generic suggestions.

Do not claim work was tested when it was not.

Do not hide failed checks.

Do not write a victory speech.

Just report the result clearly.
