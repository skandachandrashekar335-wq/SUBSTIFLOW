# Release

This document captures the facts about how a release of SubstiFlow is produced and verified. It is written for the project maintainer and for reviewers who want to know what happened between versions.

## Current state

- **Commit** that defines the latest release state: `3baa6d1361860682af24a0f06efdd1c67e91502d` (`HEAD == origin/main`)
- **Two fix commits** on top of phase-38 HEAD `fba3608`:
  - `f44cea3` — fix settings NULL-id row in v2 migration + self-repair on `set()` (3 files)
  - `3baa6d1` — fix substitution locked-assignment guard + UI alert (3 files + regression test)
- **Test gate**: `npm test` → 141/141 passing across 9 files; `npm run typecheck` → exit 0; `npm run build` → exit 0 (renderer + electron main); `npm run dist` → exit 0 (Windows NSIS installer produced in `dist-electron/`)
- **Production database**: SQLite, WAL mode, FK enforced, schema version 3. No secrets in repo.
- **Build artifact**: `dist-electron/SubstiFlow-Setup.exe` (90.3 MB, PE32 NSIS) + `.blockmap`, `latest.yml`, `win-unpacked/` — produced by `npm run dist` on this macOS host.

## Test gates

| Gate | Command | Result |
|---|---|---|
| Unit / regression | `npm test` | 141/141 passing (9 files) |
| Type check renderer | `npm run typecheck` | exit 0 |
| Electron main compile | `npm run build` | exit 0 |
| Windows packaging | `npm run dist` | exit 0 (installer produced) |
| Native print path | code review (no automation) | verified in code |
| Installer smoke test | **not performed on Windows** | artifact builds, on-host verification BLOCKED |

## Build & packaging

```bash
# production bundle
npm run build           # Vite + tsc → dist/, dist/main/

# Windows NSIS installer
npm run dist            # electron-builder --win --x64 → dist-electron/SubstiFlow-Setup.exe
```

Both are defined in `package.json`. `electron-builder` 24.13.3 runs on this macOS host and produces a genuine Windows NSIS self-extracting archive; the installer was not executed on Windows as part of this repository's CI (none exists), so on-host verification is BLOCKED per policy — the .exe and blockmap exist, but they could not be launched here.

## Database migration safety

- Forward-only migrations in `src/db/migrations.ts`, each wrapped in a transaction.
- `TARGET_SCHEMA_VERSION` stays 3 for the current release; migrations add columns/indices but never remove.
- Before a production release, the usual path is: take a backup (Settings → Backup & Restore or `auto-backups/`), verify the backup file with the built-in validation, then run `npm run db:migrate` to bring any pending migrations forward on the target machine.
- A fresh install on a new machine runs migrations automatically on first launch; no manual step is required if the database has not been customised.

## Backup

- Manual export/import: Settings → Backup & Restore → export writes a validated SQLite snapshot; import verifies first and asks for confirmation.
- Automatic per-launch-day snapshots: on each app start a snapshot goes into `auto-backups/` beside the database; old snapshots are pruned to the configured retention count. Failures are logged but never fatal.

## Release checklist (run before tagging)

1. `npm test` — 141/141
2. `npm run typecheck` — exit 0
3. `npm run build` — exit 0
4. `npm run dist` — exit 0 (installer produced in `dist-electron/`)
5. `git status --short` — clean (no untracked artifacts, no .db files, no logs)
6. `git fetch origin` — confirm `HEAD == origin/main`
7. Confirm `TARGET_SCHEMA_VERSION` and schema version table are at the intended level
8. Note any known limitations (Windows runtime, print automation, no multi-user) in the release tag body

## Version / changelog

See [CHANGELOG.md](CHANGELOG.md) for the project's actual commit-level history. No fabricated version numbers are introduced — the current git HEAD defines what's been released. The existing package metadata has `"version": "1.0.0"`; if a formal tag is added later, it should be based on the git history, not invented here.

## Verification after push

```bash
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status --short
# Required:
HEAD == origin/main
working tree clean
```

If all three checks pass, the repository is in the expected state and the release can be considered pending based on the above gates.