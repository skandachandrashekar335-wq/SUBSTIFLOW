# Testing

How SubstiFlow is tested, what the suites actually cover, and how to run them.

## Commands

```bash
npm test              # full suite (Vitest), stamps the native ABI for Node first
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit (renderer/app)
npm run build         # also compiles the Electron main (tsconfig.electron.json)
```

**Current state: 141 tests in 9 files, all passing.** This number is taken from a fresh `npm test` run, not a cached claim — re-run it to confirm.

## The suites

| File | Tests | What it proves |
|---|---:|---|
| `src/__tests__/regression.test.ts` | 49 | Regression blocks for fixed QA findings: service error paths, referential integrity, approval lifecycle, lock/unlock rules (including that a locked assignment refuses substitute changes while lock state itself stays mutable), database integrity helpers |
| `src/__tests__/product-model.test.ts` | 31 | Domain behaviour of the data model: spans, ordered faculty/room joins, relationships, cascade/protect rules |
| `src/services/substitution/__tests__/engine.test.ts` | 15 | Engine scenarios end to end: correct selection, multi-faculty behaviour, coverage, determinism of output |
| `src/services/substitution/__tests__/hard-constraints.test.ts` | 11 | Each hard constraint rejects when it should (absent, busy incl. span, daily limit, break, working hours) |
| `src/__tests__/quick-entry.test.ts` | 10 | Grid quick-entry input resolution (cell → correct defaults/actions) |
| `src/services/substitution/__tests__/priority.test.ts` | 7 | P1–P5 tier derivation from relationship flags, including P5 filtering |
| `src/__tests__/migration.test.ts` | 6 | Migrations run against fixtures; schema at `TARGET_SCHEMA_VERSION` has the expected structure (columns, ids, seed rows) |
| `src/__tests__/live-workflow.test.ts` | 6 | A full coordinator workflow executed through the real service layer: dynamic periods, timetable CRUD, attendance, generation, overrides, locks, approval, simulated restart |
| `src/__tests__/backupValidation.test.ts` | 6 | Backup file validation accepts real backups and rejects non-databases/corrupt files |

## Live-workflow suite

`live-workflow.test.ts` is the closest thing in-repo to an end-to-end test:

- it **snapshots** the local app database (the real file), runs the workflow against the snapshot, and deletes the snapshot afterwards — the production database is never written to;
- it exercises services exactly as the UI calls them, including an app-restart simulation (reopen the connection and assert persistence);
- it **skips automatically when no local database exists** (fresh clone/CI), so the suite stays green without app data.

## End-to-end / UI acceptance

There is **no Playwright or browser-test dependency in this repository** — `npm test` is pure Vitest. Separate scripted UI acceptance passes were run during development using an external harness (outside this repo) against the packaged app: real clicks through the morning workflow, negative/conflict attacks, restart persistence, and export verification, with results recorded in a local QA ledger. Those records are intentionally not committed here.

No CI pipeline is configured yet; the suites run locally. Test coverage has not been measured, so no coverage percentage is claimed.

## What we do not claim

- No coverage figure (not measured).
- No "tests on every OS" — the suite runs on the development host (macOS).
- No Windows runtime verification from tests: packaging is verified by building; execution on Windows has not been performed (see [RELEASE.md](RELEASE.md)).

## Adding tests

- **Behaviour in services** → unit test next to the code (`src/services/*/__tests__/`) or in `src/__tests__/` for repository/domain-level behaviour.
- **Fixed bugs** → add a regression case to `regression.test.ts` describing the original failure, so it can never silently return.
- **Schema changes** → extend `migration.test.ts`.
- **Fixtures** → keep them small and version-controlled; the migration suite uses committed fixtures rather than live data.

Aim for tests that fail for the right reason: assert the user-visible message or the persisted state, not internal call counts.
