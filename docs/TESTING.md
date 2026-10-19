# Testing

How SubstiFlow is tested, what the suites actually cover, and how to run them.

## Commands

```bash
npm test              # full suite (Vitest), stamps the native ABI for Node first
npm run test:watch    # watch mode
npm run typecheck     # tsc --noEmit (renderer/app)
npm run build         # also compiles the Electron main (tsconfig.electron.json)
npm run e2e           # Playwright-driven journeys against the packaged app (see below)
node scripts/e2e/console-check.js   # dev-mode React console warnings (see below)
```

**Current state: 250 tests in 18 files, all passing.** This number is taken from a fresh `npm test` run, not a cached claim — re-run it to confirm.

## The suites

| File | Tests | What it proves |
|---|---:|---|
| `src/__tests__/regression.test.ts` | 55 | Regression blocks for fixed QA findings: service error paths, referential integrity, approval lifecycle, lock/unlock rules (including that a locked assignment refuses substitute changes while lock state itself stays mutable), database integrity helpers, the unified substitution semantics (a PENDING row reserves a daily slot, the manual picker honours min(personal, institution-wide) limits, stale locked rows are pruned on regeneration, coverage/uncovered math), manual-entry parity with the draft validator (active/TEACHING faculty, configured working days and hours, break-crossing refused), and periods-outside-working-hours as a hard constraint |
| `src/__tests__/product-model.test.ts` | 31 | Domain behaviour of the data model: spans, ordered faculty/room joins, relationships, cascade/protect rules |
| `src/__tests__/generator.test.ts` | 27 | The timetable generator end to end against isolated temp databases: exact weekly counts, span/break/working-period hard constraints, determinism (two runs produce identical assignments), TEAM labs, a genuine backtracking fixture (attempts exceed placements), impossible-timetable diagnostics with reason/suggested action, section/faculty overload, missing-qualification diagnostics, attempt-limit and timeout bounds, draft tamper → validation failure, publish success + audit + draft history, publish rollback on conflict and mid-transaction failure, substitution remap/supersede on publish, summary-helper queries binding every SQL parameter (subject-scoped regression), re-publish guard (a second publish of the same run throws before any transaction and leaves timetable/substitution/audit rows byte-identical), stale-RUNNING crash recovery (abandoned run → FAILED with diagnostics/drafts preserved, terminal runs untouched, an in-flight run never failed), and the manual-testing fixes: a non-teaching allocation refuses generation with a named `INPUT_INVALID` diagnostic, an explicit TEAM with fewer than two teachers is refused with both remedies in the suggested action, explicit TEAM puts every allocated teacher on every session while explicit ALTERNATE uses exactly one (spread across the team), crafted drafts with a missing team member / a double-staffed alternate session / a reclassified non-teaching teacher each fail validation, and `effectiveTeachingArrangement` (explicit always wins; AUTO = multi-teacher LAB → TEAM, otherwise ALTERNATE) |
| `src/services/substitution/__tests__/engine.test.ts` | 15 | Engine scenarios end to end: correct selection, multi-faculty behaviour, coverage, determinism of output |
| `src/services/substitution/__tests__/hard-constraints.test.ts` | 14 | Each hard constraint rejects when it should (absent, busy incl. span, daily limit, break, working hours), plus the staff-type rules: non-teaching staff never appear in the candidate pool (and are reconsidered the moment they are reclassified), never in the assign-substitute picker, and a manual override to a non-teaching person is refused with a reason naming the staff type |
| `src/__tests__/quick-entry.test.ts` | 10 | Grid quick-entry input resolution (cell → correct defaults/actions) |
| `src/services/substitution/__tests__/priority.test.ts` | 7 | P1–P5 tier derivation from relationship flags, including P5 filtering |
| `src/__tests__/migration.test.ts` | 9 | Migrations run against fixtures; schema at `TARGET_SCHEMA_VERSION` (8) has the expected structure (columns, ids, seed rows); migration 7 adds `faculty.staff_type` / `subject_requirements.teaching_arrangement` with CHECK constraints and safe defaults, and backfills legacy NULL `audit_log` ids on a simulated pre-v7 upgrade without losing or duplicating rows; migration 2 replays safely after a crash (idempotency guard, no rebuild); migration 8 installs the full set of `updated_at` triggers and an upgraded database is proven to carry the same per-table trigger set as a fresh install |
| `src/__tests__/live-workflow.test.ts` | 6 | A full coordinator workflow executed through the real service layer: dynamic periods, timetable CRUD, attendance, generation, overrides, locks, approval, simulated restart |
| `src/__tests__/backupValidation.test.ts` | 8 | Backup file validation accepts real backups and rejects non-databases/corrupt files, plus the import-time snapshot/rollback guards |
| `src/__tests__/serviceGuards.test.ts` | 6 | Service-level guards from the manual-testing fixes: teaching allocations refuse non-teaching staff (with a readable message) on create and update, vanished faculty references are named rather than surfacing a SQL error, and the teaching arrangement persists exactly what was chosen while unknown values are rejected on both create and update |
| `src/__tests__/allocationEditing.test.ts` | 2 | The teaching-allocation edit path (regression: the grouped view read snake_case rows as camelCase, so chips rendered empty and every edit failed with "Please fill in all required fields"): grouped rows carry `classType`/`requiredSessionsPerWeek`, and the exact dialog payload updates the row and the grouped view |
| `src/__tests__/demoFixture.test.ts` | 24 | Isolated demo path guards, exact fixture counts/determinism, 124-session/140-occupied-period generation, balanced and intentionally conflicting fixtures, span-aware validation, publish, and both substitution scenarios |
| `src/__tests__/iconButton.test.ts` | 4 | Shared icon-button markup contract: dimensions, icon size, labels, and focus ring |
| `src/__tests__/weeklyCounter.test.ts` | 8 | Weekly allocation-counter arithmetic, shared-requirement deduplication, and over-capacity display values |
| `src/__tests__/dateParsing.test.ts` | 6 | Timezone-correct parsing: zone-less SQLite stamps are UTC and date-only values are local midnight |
| `src/__tests__/draftGridRender.test.ts` | 9 | Draft timetable grid rendering for spans, rooms, faculty teams, breaks, and time labels |
| `src/__tests__/timetableQuality.test.ts` | 9 | Demo timetable quality, capacity/distribution, determinism, and publish checks |

## Live-workflow suite

`live-workflow.test.ts` is the closest thing in-repo to an end-to-end test:

- it **snapshots** the local app database (the real file), runs the workflow against the snapshot, and deletes the snapshot afterwards — the production database is never written to;
- it exercises services exactly as the UI calls them, including an app-restart simulation (reopen the connection and assert persistence);
- it **skips automatically when no local database exists** (fresh clone/CI), so the suite stays green without app data.

## End-to-end / UI acceptance

`npm run e2e` runs `scripts/e2e/journeys.js`: Playwright-driven journeys against the **real packaged app** (production renderer build, real SQLite database, no dev server, no mock data). The runner:

- points the app at an **isolated QA database** via `SUBSTIFLOW_DATA_DIR` under the OS temp directory — the production database is never opened;
- switches the native module ABI for Electron (`scripts/ensure-abi.js`) and restores the Node ABI afterwards;
- drives the real UI with clicks and form input, and asserts persisted state through the app's own IPC bridge (`window.electron.db`), i.e. the exact data path the app uses.

Journeys covered:

- **A — the Phase 1 workflow end to end**: first-run setup wizard → add a second faculty member → create a Subject Requirement and a Teaching Allocation through their dialogs → generate (real solver) → review the draft grid (subject/faculty/room/type/duration) → independent validation → publish → master timetable entries + audit entry + draft history marked PUBLISHED.
- **F — the manual-testing fixes**: Add Subject with an untouched department select must *display* an empty state that matches the stored state (the reported bug: it showed the first department while Create insisted "Department is required"), the refusal alert matches what the dropdown shows, and the subject persists with its department in the database; a non-teaching person is created through the Faculty page (`staff_type` persisted, "Non-teaching" badge shown) and is never offered in the Teaching Allocations dialog nor chosen as a substitute (journey C asserts the latter); a teaching arrangement of TEAM is configured on the requirement through its dialog and persisted, a second teacher is allocated, and the real solver puts **both** teachers on **every** session, which then passes independent validation; finally the allocation itself is **edited** (sessions/week changed and persisted, then restored) and **deleted** through the real UI with its native confirmation accepted — then re-created so later journeys keep their baseline. Along the way journey F also asserts the row's user-visible geometry in the running app: the action buttons measure ≥32×32px with ≥16px icons, each teacher in the Faculty cell renders as **plain single-line table text** (transparent background, `border-radius: 0`, name and session count unabbreviated), and every edit/delete icon sits on a **single row** in the Actions column. The requirement dialog's Class Type / Sessions per Week / Span controls are measured to sit on **one line** (a wrapping label used to push the middle input ~20px out of line). The weekly allocation counter in the card header is asserted at **0** (journey A, fresh database), **2** after the first allocation, **3** (two teacher rows summed once each), **5** and back to **3** through edit/restore, **3 after a full page reload**, **2 after delete**, **3 after re-create**, **23 → 43** while several max-size rows push it over capacity (showing the uncapped total plus the "capacity exceeded" flag), back to **3** after cleanup, and **7 / 36 with 29 remaining** in journey H. Delete-button counts are pinned too: journey A asserts a single-teacher row renders **exactly one** delete button (the group "delete all" button is hidden when it would only repeat the teacher's own delete), and journey F asserts a multi-teacher row keeps both teacher deletes plus the group delete.
- **B — honest failure**: an impossible requirement (40 periods into 36 available) → FAILED run, `SECTION_OVERLOADED` + `FACULTY_OVERLOADED` diagnostics with reason/suggested action on screen and in the database, and the published timetable proven untouched.
- **C — substitutions**: mark the published teacher absent through Attendance → generate a plan in the Substitution Planner → approve → run status APPROVED in the database → the non-teaching staff member holds no assignment. Then the approve-with-uncovered path: the institution-wide cap is temporarily set to 0 (regenerating an approved plan asks for confirmation, which the harness accepts), the plan regenerates with every class uncovered, the approve button stays reachable and names the uncovered count, and approving requires a native confirmation that mentions them — after which the run is APPROVED again and the cap is restored exactly.
- **H — TEAM lab + ALTERNATE arrangement** (Windows smoke checklist): create a Software Engineering LAB requirement (TEAM, 1×/week, span 2) and an ALTERNATE LECTURE requirement (2×/week) on the same subject, allocate two teachers to both, generate with the real solver, and assert the lab session spans 2 periods with **both** teachers on it while each lecture session carries **exactly one** teacher with both teachers used across the week — then pass independent validation and **publish**: the master timetable carries the span-2 TEAM lab with both teachers, the two lectures with one teacher each, and every draft row of the published generation is marked PUBLISHED (older superseded drafts remain as history). Runs after journey B (which needs exactly one requirement while it edits it).
- **D — backups**: relaunch the app and assert the automatic daily backup snapshot exists on disk; the Backup page renders. Native save/open dialogs cannot be driven by Playwright and are covered by `backupValidation.test.ts` instead.
- **E — regression**: every sidebar page renders without hitting the error boundary.
- **G1 — legacy audit rows**: inject three `audit_log` rows without an id (exactly what an old build wrote) and prove the Dashboard's Recent Activity still renders all three, then rewind the schema stamp to 6 to simulate a pre-v7 database.
- **G2 — the backfill after a real upgrade**: relaunch → migration 7 backfilled every NULL audit id to a unique one, no row was lost or duplicated, the schema is stamped at the current version (8), and the Dashboard still renders the same rows.

The runner also watches every request the app makes and **fails if any http(s) request is aimed outside localhost** — the offline-first promise is asserted, not assumed (last run: 0 external requests). The harness is Windows-portable: stale-process cleanup uses `pkill` on macOS/Linux and a PowerShell process query scoped to this checkout on Windows (see [docs/WINDOWS.md](WINDOWS.md)).

The `playwright` package is a declared **development dependency** — after a clean `npm ci`, `npm run e2e` works with no extra setup (`npm test` still never touches Playwright). Journeys A–H were last verified green (**118/118 checks**) against an isolated temporary database — including every page rendering under the strict production CSP shipped in `dist/renderer/index.html`, and the sidebar showing the main-process version. The harness answers native `alert()`/`confirm()` dialogs by dismissing them (so a stray confirmation can never silently pass) and only accepts inside an explicit `withAcceptedDialogs(...)` scope used by steps that must confirm an intentional override; renderer `console.error` output is echoed next to journey results so failures show the underlying cause.

## Dev-console check (React warnings)

React strips development-only warnings from production bundles, so key-related warnings can never be observed by `npm run e2e`. `node scripts/e2e/console-check.js` reproduces the exact `npm run dev` environment instead — Vite dev server on `localhost:5173` + Electron with `NODE_ENV=development`, against its own isolated database — runs the first-run wizard, injects legacy NULL-id audit rows, visits the Dashboard and captures the console. Exit 0 means no key warnings; exit 1 prints the captured warnings (with their component stacks) as evidence. This is how the "duplicate React keys in Recent Activity" report was reproduced (`Encountered two children with the same key … null`, pointing at `Dashboard.tsx`) and verified fixed. It needs port 5173 free — stop any running dev server first.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request on `macos-latest` (the platform this repository is developed and verified on): `npm ci` → `npm test` → `npx tsc --noEmit` → `npx tsc -p tsconfig.electron.json --noEmit` → `npm run build`. The GUI E2E suite is **not** run in CI: it launches a real Electron window, which hosted runners have not been validated for — run it locally. Test coverage has not been measured, so no coverage percentage is claimed.

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
