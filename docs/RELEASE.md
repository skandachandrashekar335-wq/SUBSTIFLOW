# Release

How a release of SubstiFlow is produced and verified, the gates each release must pass, and the versioned release notes. Written for the project maintainer and for reviewers who want to know exactly what happened between versions.

## Current state (this release — prepared, not tagged)

- **Base commit**: `47912a3` (`docs: prepare SubstiFlow repository for release`), branch `main`.
- **Working tree**: the final-completion + production-readiness changeset is **deliberately left uncommitted** for review — 57 modified files (+4,686 / −1,042) and 22 untracked files. Nothing has been committed or pushed.
- **Version**: `package.json` carries `"version": "1.0.0"`; no git tag exists yet. The release is *prepared*, not published — see [Release notes](#release-notes-100-prepared-not-tagged).
- **Schema**: SQLite, WAL mode, foreign keys enforced, **schema version 8** (`TARGET_SCHEMA_VERSION`).
- **Test gate (verified on this host)**:
  - `npm test` → **208/208 passing across 15 files**
  - `npm run typecheck` (`tsc --noEmit`) → exit 0; `tsc -p tsconfig.electron.json --noEmit` → exit 0
  - `npm run build` → exit 0 (renderer + electron main); the built `dist/renderer/index.html` carries the strict production CSP
  - `npm run e2e` → **118/118 checks PASS** (nine journeys, isolated temp database, 0 external network requests)
  - `npm run dist` → exit 0 (NSIS installer produced in `dist-electron/` — see gates table for the exact run)
- **Dependencies**: `npm audit` → 31 advisories, **all dev/build tooling, none in the runtime dependency set**; assessed with upgrade paths in [SECURITY.md](SECURITY.md#dependency-advisory-posture-npm-audit). No secrets in repo.

## Test gates

| Gate | Command | Result |
|---|---|---|
| Unit / regression | `npm test` | 208/208 passing (15 files) |
| Type check renderer | `npm run typecheck` | exit 0 |
| Type check electron main | `npx tsc -p tsconfig.electron.json --noEmit` | exit 0 |
| Production build | `npm run build` | exit 0 |
| GUI end-to-end | `npm run e2e` | 118/118 checks PASS (nine journeys, offline assertion) |
| Windows packaging | `npm run dist` | exit 0 — `dist-electron/SubstiFlow-Setup.exe` (83,617,673 B NSIS; `app.asar` 1.6 MB — only `better-sqlite3` and its chain are packed, renderer libraries are bundled by Vite) + `.blockmap`, `electron-builder` 24.13.3, `electron` 31.7.7 |
| Native print path | code review (no automation) | verified in code |
| Installer smoke test | **not performed on Windows** | artifact builds; on-host execution BLOCKED per policy |

## Build & packaging

```bash
# production bundle
npm run build           # Vite + tsc → dist/, dist/main/

# Windows NSIS installer
npm run dist            # electron-builder --win --x64 → dist-electron/SubstiFlow-Setup.exe
```

Both are defined in `package.json`. `electron-builder` runs on this macOS host and produces a genuine Windows NSIS self-extracting archive (the packaged contents — main/preload/renderer/migrations/schema/Windows native module — are inspectable inside the asar). The installer has **not** been executed on Windows as part of this repository's verification; on-host verification remains BLOCKED per policy: the `.exe` and blockmap exist, but they could not be launched here. Evidence levels: [WINDOWS.md](WINDOWS.md).

## Database migration safety

- Forward-only migrations in `src/db/migrations.ts`, each wrapped in a transaction, tracked in `schema_version`.
- `TARGET_SCHEMA_VERSION` is **8**; migrations add columns/triggers but never remove. Migration 8 installs the complete set of 18 `updated_at` triggers and skips tables that do not exist, so a partial database can never brick startup.
- Migration 2 replays safely after a crash between commit and stamp (idempotency guard — no table rebuild). The database opens in WAL mode before first initialization, and a failed first-init shows a native error dialog and quits instead of white-screening.
- Recovery path is restore-from-backup (there are no down-migrations): take a backup (Settings → Backup & Restore, or rely on the automatic per-launch-day snapshot in `auto-backups/`) and restore it after installing the newer version. Every launch that finds an older schema first writes a `pre-upgrade-<timestamp>.db` snapshot (kept: 5) next to the daily auto-backups, so an interrupted upgrade always has a same-session copy of the data exactly as it was. The `npm run db:migrate` maintenance CLI exists for **development-tree** machines only — installed machines recover by restoring an auto-backup, not by running npm scripts. Fresh installs migrate automatically on first launch.

## Backup

- Manual export/import: Settings → Backup & Restore → export writes a validated SQLite snapshot; import verifies the file is a genuine, structurally compatible database, snapshots current data first, overwrites only after validation, and restores the snapshot if anything fails — always behind an explicit confirmation.
- Automatic per-launch-day snapshots: on each app start a snapshot goes into `auto-backups/` beside the database; old snapshots are pruned to the configured retention count. Failures are logged but never fatal.

## Release checklist (run before tagging)

1. `npm test` — **208/208** (15 files), all green.
2. `npm run typecheck` — exit 0.
3. `npx tsc -p tsconfig.electron.json --noEmit` — exit 0.
4. `npm run build` — exit 0.
5. `npm run e2e` — **118/118 checks**, 0 failed, 0 external requests.
6. `npm run dist` — exit 0 (installer in `dist-electron/`).
7. `npm audit` — confirm no *runtime* dependency advisories; any new tooling advisories get assessed in [SECURITY.md](SECURITY.md), not ignored.
8. Confirm `TARGET_SCHEMA_VERSION` and the `schema_version` seed match the intended release level (8).
9. `git status --short` — after committing *by explicit approval*, no untracked artifacts, no `.db` files, no logs, no secrets.
10. Note known limitations (Windows runtime unverified, print automation, no multi-user, Electron major upgrade pending) in the release tag body.

## Release notes — 1.0.0 (prepared, not tagged)

Scoped to the final-completion changeset on top of `47912a3`; earlier commit-level history is in [CHANGELOG.md](../CHANGELOG.md).

### Added — weekly allocation counter

- The "Allocations by Section & Subject" card header shows allocated sessions/week against the 36-session weekly capacity (e.g. **7 / 36 sessions/week · 29 remaining**), computed from the persisted allocation rows — each teacher's own row counts once and subject requirements are never added on top, so shared multi-teacher activities are not double-counted. It updates after every add/edit/delete, survives a full reload, and over capacity displays the uncapped true total with a clear "capacity exceeded (+N)" flag. Pure logic in `src/utils/weeklyCapacity.ts` (`weeklyCounter.test.ts`), UI in `TeachingAllocations.tsx`, verified end to end across journeys A/F/H.

### Fixed — critical user-facing defects

- **Teaching Allocations edit/delete now actually work.** The row edit and delete controls updated nothing; the grouped view also read snake_case database rows as camelCase, so faculty chips rendered as "Dr. Asha ()" and every edit failed with a misleading *"Please fill in all required fields."* (caught by the new E2E journey, pinned by `allocationEditing.test.ts`).
- **Master Timetable manual edits are atomic.** Conflict replacement and the entry write run in one transaction — a mid-operation failure can no longer leave a half-replaced slot.
- **Backup import is safe to run.** The import now validates schema/structure, snapshots the current database first, and rolls back on failure; the renderer reloads on success.

### Fixed — substitution workflow semantics (unified and documented)

- **Daily substitution limit** = assignments for that date where substitute = faculty and status ≠ REJECTED, capped by `min(faculty.maxDailySubstitutions, institution-wide setting)` — identical in generation, availability scoring, and the manual picker (a NaN bug in the solver loop had silently disabled one cap).
- **Coverage/uncovered statistics** come from one shared `computeCoverage()` (covered = has substitute and status ≠ REJECTED) — Planner, Dashboard, and Reports can no longer disagree.
- **Regeneration** prunes stale locked rows, resets approval inside the transaction, and walks days in a total order (Sunday included).
- **Approve with uncovered classes** is allowed (the coordinator may have arranged covers off-app) but never silent: the button is always visible, names the uncovered count, and requires an explicit confirmation.
- **Manual entry parity**: adding an entry by hand enforces the same faculty-status, working-day, working-hours, and break rules as the generator's draft validator; a lab without a room is an error in both paths.
- **Reports**: monthly "Substitution Days Run" counts distinct days actually served per faculty; rejected rows are excluded from substitute counts.

### Fixed — setup, settings, and UX defects

- First-run wizard: year defaults derive from today (no stale "2024-2025"), end ≥ start is enforced with a visible message, and the wizard sits behind the error boundary; a database setup failure shows a readable recovery screen instead of a blank window.
- Settings: the active term is editable (previously permanently "Outside term" after its end date with no way forward), and an empty institution name is refused instead of silently becoming "College".
- Attendance: "Mark All Present" asks for confirmation when it would overwrite existing marks (including absences).
- Dashboard/Reports: "Present Today" counts only explicitly-present faculty; recent activity is computed fresh per render; recent runs sort by date.
- Stable React list keys in Revised Timetable, Substitution Planner, and Reports (index keys caused stale-row rendering after data changes).
- Master Timetable shows an actionable empty state when no classes are configured; the Generation page's "add a class" link routes correctly.
- Teaching Allocations, Subject Requirements, Generation: the Actions-column icons rendered as near-invisible slivers (the caller-side `p-0` lost the cascade to `size="sm"` padding) — a shared `size="icon"` button (36×36px, 16px pencil/trash/eye/publish icons, accessible labels, hover/focus states, all on one row) replaces them, and faculty names render as plain single-line table text instead of a grey pill that wrapped names inside the bubble. Rows with a single teacher no longer show a second, identical trash button: the group "delete all" control only renders for multi-teacher activities where it does something the teacher's own delete does not. In the Add/Edit Subject Requirement dialog, the Class Type / Sessions per Week / Span controls now sit on exactly one line: the wrapped "Sessions per Week *" label used to push its input ~20px below its neighbours (equal-height bottom-aligned labels fix it at any wrap).

### Hardened — migrations, startup, dependencies

- Schema **v8**: full `updated_at` trigger parity between fresh installs and upgraded databases (tested per-table), crash-safe migration-2 replay, WAL before first init, native error dialog + clean quit if first-init fails.
- Dependencies (targeted, each verified): `npm audit fix` (non-force), official SheetJS `xlsx` build, `vite` 6.4.4, `react-router-dom` 7.18.4. The 31 remaining advisories are dev/build tooling with documented upgrade paths ([SECURITY.md](SECURITY.md#dependency-advisory-posture-npm-audit)); no runtime dependency carries an advisory.

### Hardened — production readiness (2026-10-12 pass)

Evidence-based audit of the main process, database layer, renderer, and packaging; every item below is a root-cause fix verified by the full gate suite.

- **One process per database.** A single-instance lock (scoped to `SUBSTIFLOW_DATA_DIR`, so QA/e2e runs with their own directory stay independent) replaces the previous two-process race: previously two launches each held a connection to the same file, and backup import — which closes the connection, deletes the WAL sidecars and replaces the file — could swap the database underneath the other instance mid-write. The maintenance CLI refuses to run against a database the app has open.
- **Backup import cannot destroy the live database.** Selecting the current database as the source used to truncate it to 0 bytes and report success; the import now refuses the live path up front and performs both the swap and the rollback atomically (stage next to the target, then `rename()`), after validation and a safety snapshot. Backup/export/snapshot probe connections close in `finally` so a failed backup can no longer leak a writer handle across the import's sidecar cleanup.
- **Upgrade and corruption safety.** Every launch that finds an older schema writes a `pre-upgrade-<timestamp>.db` snapshot (kept: 5) via the online backup API *before* migrations run; startup runs `PRAGMA quick_check` and reports corruption once, at launch, with restore instructions instead of a cryptic mid-session failure; a failed migration closes its connection instead of leaking it.
- **Boundary hardening.** Production navigation is restricted to the app's own `dist/renderer` bundle; the never-called `db:query`/`db:transaction` IPC channels (raw `BEGIN/COMMIT`, no nesting guard) were deleted from both sides of the bridge; the print window runs sandboxed; and the built renderer ships a strict CSP (`script-src 'self'`, `connect-src 'none'` — no inline scripts, no network), with the permissive HMR policy kept for development only.
- **Correct time display.** SQLite's zone-less `datetime('now')` stamps were parsed as *local* time (generation timestamps showed 5½ hours ahead for an Indian college): a shared `parseDbTimestamp()` treats them as UTC, and the Attendance day label and Monthly report interval no longer parse calendar dates as UTC midnight (both were off by one day/month west of UTC).
- **Write integrity.** Multi-write flows that committed 2–3 independent transactions now run as one each (via the shared SAVEPOINT-nesting `withTransaction`): faculty edit/create, substitution override + approval reopen + audit, run save (no more orphan empty `substitution_runs` rows), generation publish (drafts + diagnostics + COMPLETED status), "mark all present", allocation-group deletes, first-run wizard steps, working-hours/weights settings.
- **Seeder and CLI rebuilt for reality.** `db:seed` had been throwing mid-script since schema v2 (columns dropped by migration 2), stamped fresh databases `version = 1` after applying the current schema, and wrote into any database it found: it now applies the schema before any check, stamps the compiled target version, seeds through the v8 join tables in one transaction, attaches to the year that is already active, and **refuses a database that already contains data unless `--force`**. CLI task failures exit non-zero (they used to report success).
- **Native-module tooling cannot ship a broken binary.** `ensure-abi` verifies the native module's actual magic bytes (PE/Mach-O/ELF) on every stamp match and after every build — a stale stamp can no longer pack a host binary into the Windows installer — and quotes win32 commands so checkout paths with spaces work. `postinstall` fails the install when the native rebuild fails instead of warning.
- **Packaging.** Renderer libraries moved to `devDependencies` (Vite bundles them; only `better-sqlite3` is required at runtime) — `app.asar` shrank from 65 MB to 1.6 MB and the installer from 90,336,734 B to 83,617,673 B; main-process `.js.map` files are excluded; the data directory is created `0700` and the database file `0600`.
- **UI honesty.** The sidebar reports `app.getVersion()` (a hardcoded literal would drift at the next release — pinned by an E2E check); the backup picker no longer advertises `.sql`; Revised Timetable's inline error card is reachable instead of a whole-shell blank; long-standing settings/attendance/first-run multi-writes are transactional.

### Tests and documentation

- **208 unit/regression tests across 15 files** (up from 178/11), including new suites for unified substitution semantics, manual-entry parity, migration trigger parity, the allocation edit path, the icon-button markup contract, the weekly allocation counter, and timezone-correct timestamp parsing (`dateParsing.test.ts`).
- **118/118 E2E checks** (up from 77): allocation edit/delete through the real dialogs, the action-icon geometry (≥32px targets, ≥16px icons, single-row alignment) and plain-text faculty-cell assertions, the approve-with-uncovered confirmation, publish in journey H, schema v8 assertion, dialog-accept scoping and console-error echo in the harness, and the sidebar main-process-version assertion — all pages rendering under the new strict production CSP.
- README rewritten for beginners (install → first run → daily use → backup/restore → troubleshooting); docs/TESTING.md, docs/WINDOWS.md, docs/SECURITY.md, and these notes updated to match reality.

## Verification after push

```bash
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status --short
# Required for a published release:
#   HEAD == origin/main, working tree clean, tag present
```

If those checks pass and the gates above were run against the tagged commit, the release can be considered published. Until then it is *prepared* — which is the exact state of this changeset.
