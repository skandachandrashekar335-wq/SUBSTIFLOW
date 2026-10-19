# Changelog

All notable changes to SubstiFlow will be documented in this file.

The format is based on [keep a changelog](https://keepachangelog.com/),
and this project adheres to [semantic versioning](https://semver.org/),
starting from the initial commit in this repository.

## [Unreleased]

Final-completion changeset on top of `47912a3` (all dated 2026-10-10, **uncommitted** — left for review; full narrative in [docs/RELEASE.md](docs/RELEASE.md#release-notes-100-prepared-not-tagged)):

### Fixed (this changeset)

- **Teaching Allocations edit/delete** — the row controls updated nothing, and the grouped view read snake_case rows as camelCase: chips rendered "Dr. Asha ()" and every edit failed with a misleading *"Please fill in all required fields."* (found by the new E2E journey F checks, pinned by `src/__tests__/allocationEditing.test.ts`).
- **Table action icons + faculty display** — the Actions-column icon buttons rendered as near-invisible slivers (a caller-side `p-0` lost the CSS cascade to `size="sm"`'s `px-3 py-1.5`); a shared `Button size="icon"` (36×36px, ≥16px pencil/trash icons, `aria-label`s, focus rings, single row) now serves Teaching Allocations, Subject Requirements, and Generation, and the Faculty cell renders each teacher as plain single-line table text instead of a grey `rounded-full` pill that wrapped names inside the bubble (pinned by `iconButton.test.ts` and journey F's computed-style/geometry checks). A redundant second trash button — the group "delete all" doing the exact same job as a single teacher's own delete on one-teacher rows — now renders only for multi-teacher activities (pinned by journey A/F delete-count checks).
- **Requirement dialog row alignment** — in the Add/Edit Subject Requirement dialog the Class Type / Sessions per Week / Span controls sat at different heights: "Sessions per Week *" wrapped to two lines in its ~120px column (the dialog is capped at `max-w-md`), pushing its number input ~20px below its neighbours. The three labels now share an equal two-line box with bottom-aligned text, so all three controls sit on exactly one line whatever the label wrap (pinned by a journey F bounding-box check).
- **Master Timetable atomic replace** — conflict replacement and the entry write now run in one `withTransaction`.
- **Backup import hardening** — schema/structure validation, safety snapshot before overwrite, rollback on failure, renderer reload on success (`electron/backupValidation.ts`, `electron/main.ts`).
- **Substitution semantics unified** — daily limit = non-REJECTED assignments capped by `min(personal, institution-wide)` everywhere (generation, scoring, manual picker; NaN cap bug in the solver loop fixed); coverage math from one `computeCoverage()` shared by Planner/Dashboard/Reports; stale locked rows pruned on regeneration; approval reset inside the transaction; total-order day comparator (Sunday included); approve-with-uncovered allowed only via an explicit confirmation naming the count; manual entry enforces the same faculty-status/working-day/hours/break rules as the draft validator; reports exclude REJECTED rows and count distinct served days per faculty.
- **Setup/settings/UX** — first-run wizard derives year defaults from today and enforces end ≥ start (visible message); active term editable in Settings; empty institution name refused; "Mark All Present" confirms before overwriting; honest Present/Absent/Dashboard metrics; fresh recent activity; recent runs sorted by date; stable React list keys (Revised Timetable, Planner, Reports); Master Timetable no-sections empty state; setup-failure recovery screen + wizard error boundary.
- **Migration safety (schema v8)** — complete `updated_at` trigger parity fresh-vs-upgraded (per-table test, missing tables skipped), crash-safe migration-2 replay guard, WAL before first init, native error dialog + clean quit when first-init fails.

### Changed (this changeset)

- **Dependencies (targeted, each verified)** — `npm audit fix` (non-force), `xlsx` → official SheetJS 0.20.3 tarball, `vite` 6.4.4, `react-router-dom` 7.18.4 (obsolete `HashRouter` `future` prop dropped). Remaining 31 advisories are dev/build tooling only with documented upgrade paths and a Node-20.19 gate (`vitest` 4 / `electron-builder` 26 blocked by the pinned Node 20.17) — assessed in [docs/SECURITY.md](docs/SECURITY.md#dependency-advisory-posture-npm-audit).
- **E2E harness** — dialog answers default to *dismiss* with scoped `withAcceptedDialogs()` for intentional confirmations; renderer `console.error` echoed next to journey results; journey F covers allocation edit/delete plus the action-icon geometry and plain-text faculty-cell checks plus the weekly allocation counter at every state (0/2/3/5/7, edit, reload, over capacity), journey C the approve-with-uncovered confirmation, journey H the publish and the 7/36 counter total, G2 asserts schema v8, and the delete-button counts are pinned (one on single-teacher rows, both teacher deletes plus the group delete on multi-teacher rows), and journey F also asserts the Class Type / Sessions / Span controls of the requirement dialog sit on ONE line (**117/117 checks**).

### Added (this changeset)

- **Weekly allocation counter** — the "Allocations by Section & Subject" card header shows allocated sessions/week against the 36-session weekly capacity (`7 / 36 sessions/week · 29 remaining`), computed from the persisted allocation rows (each teacher's own row counts once — shared requirements are never double-counted), following every add/edit/delete and surviving a full reload; over capacity the true total is displayed uncapped and flagged (`43 / 36 — capacity exceeded`). Pure logic in `src/utils/weeklyCapacity.ts`, pinned by `weeklyCounter.test.ts` and 16 E2E assertions across journeys A/F/H.
- **Tests** — 202 across 14 files (from 178/11): new `allocationEditing.test.ts`, `iconButton.test.ts`, and `weeklyCounter.test.ts`, plus regression suites for unified substitution semantics, manual-entry parity, and v8 trigger parity.
- **Docs** — README rebuilt for beginners (install → first run → daily use → backup/restore → troubleshooting); docs/TESTING.md, docs/WINDOWS.md, docs/SECURITY.md (dependency advisory posture), docs/RELEASE.md (release checklist + versioned 1.0.0 release notes) updated to the verified numbers.

Production-readiness hardening pass on top of the above (dated 2026-10-12, **uncommitted** — evidence-based audit of the main process, database layer, renderer, and packaging; each finding fixed at its root cause):

### Fixed (production-readiness pass)

- **One process per database** — the app had no single-instance lock: two launches each held their own connection to the same file, and the backup-import flow (which closes the connection, deletes the WAL sidecars and replaces the file) could swap the database underneath the second instance mid-write. `electron/main.ts` now takes `app.requestSingleInstanceLock()` scoped to the data directory (`SUBSTIFLOW_DATA_DIR` moves the profile with it, so e2e/QA runs stay independent), focuses the existing window on a second launch, and the maintenance CLI (`scripts/cli.js`) refuses to run against a database that is already open — closing the "db:migrate while the app is open" migration race.
- **Backup import could destroy the live database** — selecting the current database as the import source made `copyFileSync(src, dest)` truncate the destination to 0 bytes and then report *"Backup imported successfully"* on an empty database. The import now refuses the live path up front, and both the swap and the rollback stage the copy next to the target and `rename()` it into place (crash-safe: the rename either happened or it did not).
- **Backup/export connections no longer leak on failure** — the auto-backup, export, and pre-import snapshot paths closed their probe connection only on success; all three now close in `finally`, so a failed backup can no longer leave a writer handle keeping the WAL alive across the import's sidecar cleanup.
- **Navigation restricted to the app's own bundle** — `will-navigate` allowed any `file://` URL in production; it now allows only the built `dist/renderer` directory (dev: localhost:5173), so the preload bridge can never be handed to an arbitrary local page.
- **Dead IPC surface removed** — `db:query`/`db:transaction` (async `invoke` channels with raw `BEGIN/COMMIT` and no nesting guard, callable by nothing in the renderer) were deleted from both `electron/main.ts` and `electron/preload.ts` and from the global types; `ARCHITECTURE.md` corrected.
- **Seeded timestamps display the right instant** — SQLite's `datetime('now')` writes UTC without a zone marker, which `new Date()` parses as *local*: every generation Created/Completed stamp displayed 5½ hours ahead of real time (any offset from UTC, either direction). New `parseDbTimestamp()` in `src/utils/date.ts` completes zone-less values with `Z` (and passes already-zoned values through), used by Generation and Dashboard; the Attendance day label parsed `yyyy-MM-dd` as UTC midnight (previous day west of UTC, `Attendance.tsx`); the Monthly report started its interval at UTC midnight of the month start (previous month west of UTC, `Reports.tsx`).
- **Seeder rebuilt for schema v8** — `scripts/seed.js` inserted `faculty_id`/`room_id` into `timetable_entries` (columns dropped by migration 2 — it had been throwing mid-script since v2), stamped a fresh database `version = 1` although it applied the current v8 schema, ran every insert outside a transaction, and wrote into any database it found. Now: schema applied before any table check, stamped with the compiled `TARGET_SCHEMA_VERSION`, faculty/rooms attached through the `timetable_entry_faculty`/`timetable_entry_rooms` join tables, sections attached to the year that is already active, all inserts in one transaction (failure = rollback, nothing partial), and an occupancy guard that refuses to mix demo rows into a database that already contains data unless `--force` is passed.
- **Maintenance CLI exits non-zero on failure** — task failures set `process.exitCode` and then `app.quit()`, which reported exit 0: `npm run db:seed` "succeeded" even when the task threw. Failures now flush stderr and `app.exit(1)`; seed refusals throw through the same path.
- **`ensure-abi` no longer trusts a content-blind stamp** — the stamp recorded what was *requested*, not what was on disk: a stale stamp (e.g. after `npm rebuild`) would short-circuit into the Windows installer and ship a host binary that crashes on first launch. The script now reads the native module's magic bytes (PE/Mach-O/ELF) on every stamp match *and* after a successful build before writing the stamp, and win32 commands are quoted so checkout paths with spaces work.
- **`postinstall` fails loudly where it must** — every failure was a warning, so `npm ci` could "succeed" with an unbuilt native module and the crash surfaced later at first launch. A failed native rebuild (and a failed Electron runtime download — its own installer self-guards when already present) now fails the install; the runtime-exists check is platform-correct instead of macOS-only; a codesign failure still warns with the exact manual command.
- **Faculty edit, weights, working hours, first-run wizard steps, attendance batch, allocation deletes, generation publish, substitution override/delete and run save are now single transactions** — previously 2–3 independent commits each (a mid-sequence failure left a faculty row with stale section mappings, a saved entry reported as failed because its *audit row* threw, an APPROVED badge outliving the change that invalidated it, a RUNNING generation with committed drafts, an orphan empty `substitution_runs` row). All wrap the existing `withTransaction`, which nests via SAVEPOINT, so inner repository transactions keep working.
- **Revised Timetable's inline error card is reachable** — `error` state existed but nothing ever set it, so any repository failure escaped to the app-wide boundary and blanked the whole shell; the data load is now a guarded memo that renders the designed error card instead.
- **Honest inputs and labels** — the backup picker no longer offers `.sql` (import only accepts SQLite backups); the sidebar shows `app.getVersion()` instead of a hardcoded `v1.0.0` that would drift at the first release after 1.0.0.

### Changed (production-readiness pass)

- **Strict production CSP** — the shipped `index.html` allowed `'unsafe-inline'` scripts and any localhost/WS connection. The build now swaps in `script-src 'self'; connect-src 'none'; …` (Vite `transformIndexHtml`), while dev keeps the permissive policy HMR needs; verified in `dist/renderer/index.html` and exercised by the full E2E suite (every page renders under the strict policy).
- **Installer slimmed** — every renderer library (react, react-router, lucide-react, xlsx, zod, zustand, …) was packed into `app.asar` although Vite bundles them into `dist/renderer`; only `better-sqlite3` is required at runtime, so the renderer libraries moved to `devDependencies`. Main-process `.js.map` files are excluded from the `files` list.
- **Print window sandboxed** — the hidden window that renders print HTML from a `data:` URL runs with `sandbox: true` (no preload, no node, no network).
- **Database file hardening** — the data directory is created `0700` and the database file `0600` (SQLite mirrors the file mode onto `-wal`/`-shm`), so other local accounts cannot read the school's data; `app:info` is wrapped so a path-resolution failure returns an error instead of rejecting silently.

### Added (production-readiness pass)

- **Startup integrity check + pre-upgrade snapshots** — `createDatabase()` runs `PRAGMA quick_check` before migrations (corruption is reported once, at startup, with restore instructions — not as a cryptic `SQLITE_NOTADB` mid-session) and closes the connection if migrations fail instead of leaking it. Every launch that finds an older schema first writes a `pre-upgrade-<timestamp>.db` snapshot (kept: 5) next to the daily auto-backups via the online backup API, so an interrupted upgrade always has a same-session copy of the data as it was.
- **Tests** — 208 across 15 files (new `dateParsing.test.ts` pinning the UTC/local parsing contract), all green; **E2E** 118/118 checks (new journey E assertion: the sidebar version must equal `package.json`'s version as reported by the main process).

Disposable BCA demo environment on top of the above (dated 2026-10-13, **uncommitted** — a self-contained evaluation/demo mode built entirely on the real engine; full walkthrough in [docs/DEMO-GUIDE.md](docs/DEMO-GUIDE.md)):

### Added (demo environment)

- **Demo audit consistency** — corrected the demo documentation and fixture narrative to the current 27-subject/54-requirement/66-allocation/124-session fixture, removed the stale single-instance limitation claim, and clarified that a timetable session is an activity row while an occupied period is one hourly grid cell. The read-only audit now expands spans over non-break slots, reports capacity in occupied periods, and prints a per-section/subject requirement table with eligible faculty and effective arrangement.
- **Isolated demo database** — `npm run demo:setup` creates and seeds `<repo>/.substiflow-demo/` (git-ignored) with a fixture derived from the uploaded Dayananda Sagar BCA exam timetable (21–24 Sep 2026, I/III/V Sem): 6 sections, 27 subjects (unique course codes), 12 fictional teaching + 2 non-teaching faculty, 4 classrooms + 3 labs, 54 weekly requirements and 66 allocations. The fixture covers TEAM (IL/GE labs, ML & NN), ALTERNATE (AI/tutorials), 2-period lab spans and per-faculty substitution caps; it generates 124 sessions occupying 140 periods. Setup is repeatable (full wipe + re-seed, never duplicates) and every write is preceded by `assertSafeDemoPaths()` — the tooling refuses non-canonical paths and anything resolving inside the production data directory.
- **Demo commands** — `demo:setup`, `demo:reset`, `demo:status` (resolved path + seeded counts), `demo:remove` (marker-checked, deletes only `.substiflow-demo/`, refuses while the demo app holds the per-directory lock), `demo:launch` (real app with `SUBSTIFLOW_DATA_DIR` pinned to the demo dir — no silent production fallback) and `demo:verify` (Playwright walkthrough: generate → validate → publish → absence → covered substitution plan with independently verified substitutes → approve → revised timetable → whole-staff-absent scenario reporting 18 uncovered classes behind an explicit confirmation). Shared logic lives in `src/db/demoPaths.ts` / `src/db/demoFixture.ts`, used identically by the CLI and the tests.
- **DEMO DATA banner** — `app:info` now reports `isDemo` (set only by `SUBSTIFLOW_DEMO=1` from `demo:launch`); a non-dismissible banner showing the exact demo database path sits on every page, with a DEMO DATA badge in the sidebar footer. Production and E2E runs are unaffected (flag never set), and there is intentionally no in-app reset button.
- **Tests** — 250 across 18 files at the current verification point: `demoFixture.test.ts` (24 tests) pins path isolation and production-path refusal, cleanup-guard semantics (marker/symlink/unmarked refusal), fixture counts and determinism, reseed rollback, balanced and conflict-fixture generation correctness (exact demand, span-aware conflict freedom/failure diagnostics, TEAM/ALTERNATE/lab-span/break rules, non-teaching exclusion, publish) and both substitution scenarios (eligible substitutes within workload limits; whole-staff absence fully uncovered, nobody ineligible assigned). Verified in this work: `npm test` 250/250, `demo:verify` 29/29, and the production database SHA-256 + mtime remained unchanged across demo operations.


### Previously in [Unreleased] (2026-10-03, committed)

### Fixed (earlier)

- **fix(substitution): refuse substitute changes on locked assignments at the service layer** (2026-10-03, commit 3baa6d1) — Added a narrow service guard in `updateSubstitutionAssignment` that throws `This substitution is locked. Unlock it before changing the substitute.` for substitute-changing updates on locked rows, before constraint validation; handleUpdateAssignment catches and surfaces the error via alert. Three source files changed (`src/services/substitution/index.ts`, `src/pages/SubstitutionPlanner.tsx`, `src/__tests__/regression.test.ts` §30). 141/141 unit/regression tests pass.
- **fix(settings): seed policy row id in v2 migration + self-repair NULL-id rows on set** (2026-10-03, commit f44cea3) — The v2 migration inserted `multi_faculty_absence_policy` without an `id`, making `SettingsRepository.set()` silently update 0 rows (WHERE id=NULL never matches). The migration now seeds a stable id; `set()` self-repairs NULL-id rows via `crypto.randomUUID()`; the fixture test asserts the id. Three files changed, no schema or version bump.

### Added (earlier)
- **docs/ARCHITECTURE.md** — process boundaries, layer responsibilities, architectural decisions (2026-10-03).
- **docs/DATA_MODEL.md** — schema concepts and why they exist: academic year / terms / sections / subjects / faculty / rooms / time slots / timetable activity / attendance / substitution runs / assignments / audit (2026-10-03).
- **docs/SUBSTITUTION_ENGINE.md** — full pipeline: inputs → affected activities → candidate pool → hard constraints → priority tiers → weighted scoring → ranking → assignment → explainability → review → approve → lock (2026-10-03).
- **docs/DEVELOPMENT.md** — local setup, scripts, native ABI stamping, conventions, git workflow (2026-10-03).
- **docs/TESTING.md** — test strategy, 141 tests across 9 files, suite descriptions, live-workflow notes, what we do not claim (2026-10-03).
- **docs/SECURITY.md** — verified security properties (Electron isolation, IPC sender verification, no raw SQLite errors, no secrets in repo, auto-backup policy) and accepted risks (Windows runtime not verified, native print not automatable, no multi-user) (2026-10-03).
- **docs/RELEASE.md** — build, packaging, test gates, database migration safety, backup, release checklist (2026-10-03).
- **README.md** — rewritten into a professional open-source project README with overview, features, why, how substitution works, architecture, tech stack, project structure, getting started, testing, database/migrations, security, backup/reporting, limitations, roadmap, license, contributing (2026-10-03).
- **CONTRIBUTING.md** — fork/branch/install/test/build/pr expectations (2026-10-03).

### Changed (earlier)
- **README.md** — replaced the prior hand-crafted version with the professional rewrite above (2026-10-03).
- **docs/** — added ARCHITECTURE, DATA_MODEL, SUBSTITUTION_ENGINE, DEVELOPMENT, TESTING, SECURITY, RELEASE documents (2026-10-03).
- **src/services/substitution/index.ts** + **src/pages/SubstitutionPlanner.tsx** — narrow lock guard and alert surface for locked assignment edits (2026-10-03, 3baa6d1).
- **src/db/migrations.ts** + **src/db/repositories/settings.ts** + **src/__tests__/migration.test.ts** — migration now seeds id on the policy row; set() self-repairs NULL-id rows; fixture updated (2026-10-03, f44cea3).
- **src/services/substitution/types.ts** — P1–P5 priority tier labels formalized; `priorityTierFor()` is the single source of truth shared by scoring and the manual validator (already present, formalized here).

### Deprecated

- (none — this is a v1.0 project with no prior releases to deprecate)

## 2026-10-03

Release of the phase-39R acceptance test outcomes, documentation rewrite, and two genuine defect fixes:

- Substitution locked-assignment bypass (previously observed via P10.3b BUG, now PASS with explicit locked error)
- Policy row NULL-id persistence (previously observed via P6.2a BUG, now PASS with migration fix + self-repair)
- All other gates green: 141/141 tests, both `tsc` checks, build, dist (installer produced)
- HEAD `3baa6d1` on `main == origin/main`, clean tree, 2 fix commits pushed fast-forward

## 2026-10-02

Phase-38 baseline; all pre-existing feature commits and fixes (see `git log` for full list).

## [Initial commit]

4b8e1af — initial commit, containing the core timetable and substitution scaffolding, Electron setup, SQLite schema v1, and README.
