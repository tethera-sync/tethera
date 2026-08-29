# AGENTS.md

This file defines how coding agents should work in this repository.

The goal is not to make code compile at any cost. The goal is to make changes that are correct, simple, easy to understand, and pleasant to work with later.

Leave the codebase better than you found it.

## Priorities

When making trade-offs, use this order:

1. Correctness
2. Simplicity
3. User experience
4. Clear architecture
5. Type safety
6. Developer experience
7. Maintainability
8. Accessibility and security
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

A typical structure might look like:

```text
src/
  features/
    auth/
      components/
      server/
      schemas.ts
      types.ts

    billing/
      components/
      server/
      billing.ts
      types.ts

  components/
    ui/
    layout/

  lib/
    database/
    auth/
    logging/

  app/
```

This is an example, not a mandatory template.

Follow the architecture already used by the repository when it is sensible.

The important rule is locality.

Someone working on a feature should be able to find most of that feature without searching five unrelated global folders.

Shared folders are for code that is actually shared.

## Avoid dumping grounds

Be suspicious of files and folders named:

```text
utils
helpers
common
shared
misc
services
types
constants
manager
processor
```

Those names are not automatically wrong, but they often become places where architecture goes to die.

Prefer names based on what the code does.

For example:

```text
format-release-date.ts
refund-policy.ts
subscription-permissions.ts
parse-game-slug.ts
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

Server-only code must not leak into client bundles.

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
* do not make everything client-side because one child needs interaction.

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

* API requests;
* forms;
* URL parameters;
* environment variables;
* third-party APIs;
* webhooks;
* imported files;
* local storage;
* browser persistence;
* database data when its shape is not guaranteed.

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

Use the package manager already chosen by the repository.

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

Never trust client-side authorization.

Sensitive operations must be checked at the trusted server boundary.

Check ownership, not just authentication.

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
* permissions;
* money;
* destructive actions;
* state transitions;
* validation;
* parsing;
* tricky edge cases;
* previous regressions.

Do not write tests just to increase a coverage percentage.

Avoid tests that know so much about the implementation that a harmless refactor breaks them.

When fixing a bug, add a regression test when there is a sensible place for one.

Tests should make changing code safer.

## Verify the work

Do not call a task finished because the editor stopped showing errors.

Use the checks provided by the repository.

That will usually include some combination of:

```text
format
lint
typecheck
test
build
```

Use the narrowest useful checks while iterating.

Run the broader relevant checks before finishing a substantial change.

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

