# Changelog

All notable changes to SubstiFlow will be documented in this file.

The format is based on [keep a changelog](https://keepachangelog.com/),
and this project adheres to [semantic versioning](https://semver.org/),
starting from the initial commit in this repository.

## [Unreleased]

### Fixed

- **fix(substitution): refuse substitute changes on locked assignments at the service layer** (2026-10-03, commit 3baa6d1) — Added a narrow service guard in `updateSubstitutionAssignment` that throws `This substitution is locked. Unlock it before changing the substitute.` for substitute-changing updates on locked rows, before constraint validation; handleUpdateAssignment catches and surfaces the error via alert. Three source files changed (`src/services/substitution/index.ts`, `src/pages/SubstitutionPlanner.tsx`, `src/__tests__/regression.test.ts` §30). 141/141 unit/regression tests pass.
- **fix(settings): seed policy row id in v2 migration + self-repair NULL-id rows on set** (2026-10-03, commit f44cea3) — The v2 migration inserted `multi_faculty_absence_policy` without an `id`, making `SettingsRepository.set()` silently update 0 rows (WHERE id=NULL never matches). The migration now seeds a stable id; `set()` self-repairs NULL-id rows via `crypto.randomUUID()`; the fixture test asserts the id. Three files changed, no schema or version bump.

### Added

- **docs/ARCHITECTURE.md** — process boundaries, layer responsibilities, architectural decisions (2026-10-03).
- **docs/DATA_MODEL.md** — schema concepts and why they exist: academic year / terms / sections / subjects / faculty / rooms / time slots / timetable activity / attendance / substitution runs / assignments / audit (2026-10-03).
- **docs/SUBSTITUTION_ENGINE.md** — full pipeline: inputs → affected activities → candidate pool → hard constraints → priority tiers → weighted scoring → ranking → assignment → explainability → review → approve → lock (2026-10-03).
- **docs/DEVELOPMENT.md** — local setup, scripts, native ABI stamping, conventions, git workflow (2026-10-03).
- **docs/TESTING.md** — test strategy, 141 tests across 9 files, suite descriptions, live-workflow notes, what we do not claim (2026-10-03).
- **docs/SECURITY.md** — verified security properties (Electron isolation, IPC sender verification, no raw SQLite errors, no secrets in repo, auto-backup policy) and accepted risks (Windows runtime not verified, native print not automatable, no multi-user) (2026-10-03).
- **docs/RELEASE.md** — build, packaging, test gates, database migration safety, backup, release checklist (2026-10-03).
- **README.md** — rewritten into a professional open-source project README with overview, features, why, how substitution works, architecture, tech stack, project structure, getting started, testing, database/migrations, security, backup/reporting, limitations, roadmap, license, contributing (2026-10-03).
- **CONTRIBUTING.md** — fork/branch/install/test/build/pr expectations (2026-10-03).

### Changed

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