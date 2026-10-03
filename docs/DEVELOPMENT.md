# Development

How to work on SubstiFlow locally: setup, daily workflow, conventions.

## Prerequisites

- Node.js 20+ and npm (the project is developed and tested on Node 20 / macOS; nothing in the toolchain is platform-specific except noted packaging/signing steps)
- No database server, no Docker, no external services — the app is self-contained

## Setup

```bash
git clone https://github.com/skandachandrashekar335-wq/SUBSTIFLOW.git
cd SUBSTIFLOW
npm install
```

`npm install` runs `scripts/postinstall.js`, which:

1. makes sure the Electron runtime is fully downloaded,
2. on macOS applies an ad-hoc code signature (some macOS versions refuse to run unsigned app bundles),
3. rebuilds `better-sqlite3` against Electron's headers so the native ABI matches — guarded by a stamp so it only runs when needed.

It is safe to re-run at any time: `npm run postinstall`.

## Daily workflow

```bash
npm run dev        # Vite dev server + Electron, hot reload for renderer changes
npm test           # full suite before you push
npm run typecheck  # tsc --noEmit
npm run build      # production bundle (renderer + electron main)
```

Other useful scripts:

| Command | Purpose |
|---|---|
| `npm run dev:vite` / `npm run dev:electron` | the two halves of `dev`, separately |
| `npm run test:watch` | Vitest watch mode |
| `npm run db:migrate` | apply pending migrations from the CLI |
| `npm run db:seed` | load the optional sample BCA dataset |
| `npm run preview` | serve the production renderer build |
| `npm run dist` | build + package the Windows x64 NSIS installer |
| `npm run icon` | regenerate application icons |

### Native ABI (the one recurring papercut)

`better-sqlite3` must match the runtime that loads it: **Electron** when the app runs, **Node** when Vitest or the CLI runs. The `predev` / `pretest` / `predist` hooks stamp the right ABI automatically via `scripts/ensure-abi.js`. If you ever see an ABI mismatch error, re-run the matching stamp:

```bash
node scripts/ensure-abi.js electron   # for the app
node scripts/ensure-abi.js node       # for tests / CLI
```

Switching between `npm test` and `npm run dev` is safe — the hooks handle it.

## Database in development

- The app creates and migrates its database on launch, at the OS application-data path (`<app data>/database/substiflow.db`).
- `SUBSTIFLOW_DATA_DIR=<dir>` relocates the data directory (database is created at `<dir>/database/substiflow.db`) — useful for isolated experiments.
- `npm run db:seed` loads a sample BCA dataset (sample college, faculty, sections, timetable) if you want content to click through.
- Tests never write to the real database: the live-workflow suite snapshots it and deletes the snapshot (see [TESTING.md](TESTING.md)).

## Conventions

**TypeScript strict, two compilation targets.** `tsconfig.json` covers the renderer/app code; `tsconfig.electron.json` compiles `electron/` to `dist/main`. Run `npm run typecheck` plus `npm run build` — both must be clean.

**Layering rules (enforced by review):**

- Components/pages never contain SQL — go through services or repositories.
- Services never import React — they must stay runnable under Vitest and the CLI.
- All SQL lives in `src/db/repositories` (parameterised), except the schema itself and migrations.
- The main process is the only code allowed to touch the filesystem.

**Domain vocabulary.** Use the product's terms in code and messages: *activity/entry*, *section*, *faculty*, *substitute*, *uncovered*, *run*, *assignment*, *lock*. User-facing errors must be specific and actionable — the acceptance pass rejects raw SQLite errors and generic messages.

**Validation** happens in services (`validateTimetableEntryInput`, substitution constraint checks), shared by every caller — UI, tests, CLI.

**Audit.** If an action changes what the coordinator will see later (attendance, generation, override, lock, approval, timetable edits), it writes an audit record through the service that performs it.

## Migrations

- Schema changes are added as forward-only steps in `src/db/migrations.ts`, each in a transaction, recorded in `schema_version`.
- Bump `TARGET_SCHEMA_VERSION` together with the migration, and extend `src/__tests__/migration.test.ts` (the fixture test asserts schema shape at the target version).
- Never edit `schema.sql` alone as "the change" — it is the base schema; existing databases only see new structure via migrations.

## Git workflow

See [CONTRIBUTING.md](../CONTRIBUTING.md). In short: branch off `main`, keep commits scoped (`feat:`, `fix:`, `test:`, `docs:`, `chore:` — matching existing history), and never push with `--force` to `main`.
