# Architecture

This document describes how SubstiFlow is put together: process boundaries, layer responsibilities, and the decisions behind them. It reflects the code as it exists in this repository.

## Shape of the system

SubstiFlow is a single-process-at-a-time desktop application in the classic Electron sense: one main process that owns the operating-system integration and the database, and one renderer process that owns all UI.

```
                     ┌────────────────────────────────────┐
                     │           Electron main            │
                     │  electron/main.ts                  │
                     │  · BrowserWindow (hardened flags)  │
                     │  · IPC handlers (sender-verified)  │
                     │  · backup export/import + validate │
                     │  · auto-backups (daily, pruned)    │
                     │  · native print / print-to-PDF     │
                     │  · first-launch migrations         │
                     └───────────────┬────────────────────┘
                                     │ contextBridge (electron/preload.ts)
                                     │  window.electron = { db, backup, app, print }
                     ┌───────────────▼────────────────────┐
                     │           Renderer (React)         │
                     │  pages/  — routes, screen logic    │
                     │  components/ — layout + UI kit     │
                     │  stores/ — Zustand app state       │
                     └───────────────┬────────────────────┘
                                     │ service modules (no React imports)
                     ┌───────────────▼────────────────────┐
                     │        Application services        │
                     │  services/timetable                │
                     │    validation · conflicts · CRUD   │
                     │  services/substitution             │
                     │    engine · scoring · run lifecycle│
                     └───────────────┬────────────────────┘
                                     │ repository calls
                     ┌───────────────▼────────────────────┐
                     │         Repositories               │
                     │  one per aggregate, parameterised  │
                     │  SQL, ordered joins, transactions  │
                     └───────────────┬────────────────────┘
                                     │ src/db/database.ts
                     ┌───────────────▼────────────────────┐
                     │  SQLite access                     │
                     │  · in Electron renderer → IPC      │
                     │  · under Node (tests/CLI) → direct │
                     └───────────────┬────────────────────┘
                                     │ better-sqlite3
                              SQLite file (WAL, FK ON)
```

## Layer responsibilities

**Main process (`electron/`)** — the only code with real system power. It creates the window, exposes a deliberately small preload bridge, services IPC requests, and implements everything that must touch the OS: file dialogs for backup export/import, auto-backup snapshots, printing/PDF, and app info. Every database IPC handler first checks `isTrustedSender()` — the event must come from the main window's own `webContents`.

**Renderer (`src/pages`, `src/components`, `src/stores`)** — pure UI. It never touches the filesystem or Node APIs directly; it calls the typed `window.electron` bridge or the shared service modules. `stores/appStore.ts` (Zustand) holds session-level state such as setup completion.

**Application services (`src/services`)** — the behaviour that must be identical everywhere it is invoked:

- `services/timetable` — input validation, conflict detection (span-aware overlap, room double-booking, type-dependent faculty requirements), entry CRUD, and the grid's quick-entry logic. Conflicts raise `TimetableConflictError` carrying a human-readable list of the crossed activities; the UI renders it as a dialog.
- `services/substitution` — the substitution engine (candidate generation, hard constraints, P1–P5 ranking), the run lifecycle (`GENERATED → APPROVED → LOCKED`, reopening rules), and the lock/override rules. See [SUBSTITUTION_ENGINE.md](SUBSTITUTION_ENGINE.md).

Services do not import React. They are plain modules, which is what lets the same code run in Vitest, in the CLI scripts, and in the app.

**Repositories (`src/db/repositories`)** — one repository per aggregate (faculty, timetable entries, attendance, substitution runs, settings, audit, …). They own all SQL: parameterised statements, ordered join persistence (faculty teams, rooms), and transaction helpers in `base.ts`. Nothing above this layer writes SQL.

**SQLite access layer (`src/db/database.ts`)** — a single `getDatabase()` picks the implementation at runtime:

- inside the Electron renderer, `ipcDb.ts` routes queries over the preload bridge to the main process;
- under Node (tests, `scripts/cli.js`), `nodeDb.ts` opens the file directly.

Both run the same forward-only migrations on open, so every environment converges on the same schema.

## Key architectural decisions

**Offline-first, local file database.** The product's users are coordinators on college machines. A SQLite file keeps deployment to "run the installer", keeps data under the user's control, and removes servers, accounts, and sync from the problem entirely. Backup is therefore file-level, which is why backup/validation lives in the main process next to the database path it knows.

**Trust boundary at the renderer.** With `nodeIntegration: false` and `contextIsolation: true`, the renderer cannot reach the OS. All power flows through a minimal preload surface (`db`, `backup`, `app`, `print`), and the main process re-verifies the sender on every call. The renderer is treated as untrusted-ish UI code, not as an extension of the main process.

**Services are UI-free.** Conflict detection, substitution, and lifecycle rules live outside components so they can be unit-tested deterministically and reused by the CLI and tests without a browser.

**Span as a first-class concept.** A multi-period activity is one row with a `span`, not N rows. Conflict detection, availability checks, and the revised timetable all expand a span into the concrete periods it covers (via `coveredSlotsOf`), so a 2-hour lab is treated consistently as a single unit everywhere.

**Deterministic generation.** The engine sorts candidates by tier, then score, with a stable sort over a name-ordered input. The same database state always yields the same plan — a deliberate choice to make the system auditable and testable rather than "smart".

**Forward-only migrations.** Schema changes only move forward, each in a transaction, recorded in `schema_version`. Rollback is replaced by backup-and-restore, which users already have on disk (auto-backups). This removes the class of bugs where a down-migration half-undoes a live schema.

**Approval and lock as state, not ceremony.** A run's lifecycle status and each assignment's lock bit are stored rows, not UI-only affordances. That is what lets regeneration preserve locked assignments, lets the service layer refuse edits to locked rows, and lets restart persistence work without any in-memory session state.

## Concurrency and data integrity

- SQLite runs in WAL mode with foreign keys enforced; multi-statement operations are wrapped in transactions (`db:transaction` IPC, repository-level helpers) so a crash mid-operation cannot leave half a plan behind.
- The app is single-user by design: one main window, one writer. There is no cross-process contention to resolve.
- Regeneration is written as delete-non-locked + insert, preserving locked rows — atomic inside a transaction.

## Process flow of a typical morning

```
launch → migrations + auto-backup
      → Dashboard (term, counts, lifecycle)
      → Attendance marks                (attendance rows + audit)
      → Planner: Generate               (engine runs, run row + assignments + audit)
      → Review / manual override        (validated, audit override)
      → Approve                         (run.status = APPROVED, audit)
      → Lock assignments                (is_locked = 1, audit; survives regeneration)
      → Revised Timetable / CSV / print (derived views; master untouched)
```

Each step is exercised end to end by the live-workflow test suite and by the scripted UI acceptance pass described in [TESTING.md](TESTING.md).
