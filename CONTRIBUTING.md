# Contributing to fetchling

Thanks for helping. fetchling is an early-stage MCP router; expect things to move.

## Setup

Requirements: **Node 22 or newer** (CI runs 22 and 24) and **pnpm** — the version is pinned in
`package.json` (`packageManager`), so `corepack enable` or `pnpm/action-setup` picks it up.

```bash
pnpm install
pnpm build
pnpm test
```

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm build` | Builds every package with tsdown into `packages/*/dist` |
| `pnpm typecheck` | Builds, then type-checks the whole workspace (`tsc --build`) |
| `pnpm lint` | Biome lint + format check (what CI runs) |
| `pnpm format` | Biome: apply formatting and safe fixes |
| `pnpm test` | Builds, then runs every package's tests (vitest) |
| `pnpm test:watch` | Tests in watch mode (run `pnpm build` first if you change a package others import) |
| `pnpm changeset` | Describe a user-facing change for the next release |

Workspace packages import each other's **built** output (`dist/`), which is why `typecheck` and
`test` build first.

## Repository layout

```
packages/
  protocol/   @fetchling/protocol  vendored MCP 2026-07-28 schema types (never edit schema.ts by hand)
  core/       @fetchling/core      routing logic — pure TypeScript, no Node APIs, no SDK types
  upstream/   @fetchling/upstream  client side: connections to upstream MCP servers
  server/     @fetchling/server    server side: stdio and Streamable HTTP facades
  config/     @fetchling/config    configuration schema and loading
  cli/        fetchling            the `npx fetchling` entry point
  testkit/    @fetchling/testkit   fake MCP servers, raw client, recorder, spec checker
```

## Conventions

- **TypeScript is strict** (`tsconfig.base.json`): `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no `enum`, no
  parameter properties, no `namespace`). Relative imports use the `.js` extension.
- **Never write to stdout** in library or server code: on stdio, stdout *is* the protocol
  channel. Biome's `noConsole` rule allows only `console.error`/`console.warn`.
- **`@fetchling/core` has no Node APIs** — its tsconfig has `"types": []`, so `process` or
  `Buffer` there fails to compile. Keep it that way.
- **Declare what you import**: Biome's `noUndeclaredDependencies` requires every package to list
  its own dependencies.
- **Every spec rule has a name and a test.** When you implement a MUST from the MCP spec, add or
  reference a testkit checker rule and a test.
- **Errors say what, which upstream, why, and what to do.**

## Changes and releases

- Branch from `main`; open a pull request; CI (`.github/workflows/ci.yml`) must pass.
- For anything a user of a published package would notice, run `pnpm changeset` and commit the
  generated file with your change. Packages version independently; `fetchling` (the CLI) is the
  headline version.
- Releases are cut by maintainers (`pnpm version-packages`, review, `pnpm release`).

## Reporting security issues

Please do not open a public issue for security problems. Contact the maintainer privately
(see the repository's GitHub profile) until a `SECURITY.md` exists.
