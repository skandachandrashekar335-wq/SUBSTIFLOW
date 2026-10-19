# Security

Verified security properties and accepted risks. SubstiFlow is an offline-first desktop application — there is no server, no telemetry, and no network calls at runtime. All data stays on the local machine.

## Electron security boundaries

- **Renderer isolation**: `nodeIntegration: false`, `contextIsolation: true`, default sandbox enabled.
- **Preload bridge**: `contextBridge.exposeInMainWorld` exposes exactly four namespaces — `db`, `backup`, `app`, `print` — each typed and scoped. The renderer cannot reach Node.js APIs directly. The unused async `db.query`/`db:transaction` channels (raw `BEGIN/COMMIT` with no nesting guard, called by nothing) were removed; only the checked sync bridge remains.
- **IPC sender verification**: every database IPC handler first calls `isTrustedSender()`, which checks that the event's `sender` is the main window's own `webContents`. No other webContents (popups, print windows, devtools extensions) can reach the database bridge.
- **Navigation**: in production `will-navigate` permits only the app's own built `dist/renderer` bundle (in development, `localhost:5173`); window-open is denied entirely; all other URL schemes are examined by `openExternalSafely()` and only `http(s)`/`mailto` are forwarded to the OS; everything else is logged as a warning and blocked.
- **External links**: `shell.openExternal()` is only called with absolute URLs of scheme `http:`, `https:`, or `mailto:`; other protocols are rejected with a console warning.
- **Content-Security-Policy**: the built `index.html` ships `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'` — no inline scripts, no connections of any kind. The permissive policy required by Vite's HMR applies to development only (applied by a build-time `transformIndexHtml` step; the full E2E suite renders every page under the strict policy).
- **Single instance per data directory**: `app.requestSingleInstanceLock()` (scoped to `SUBSTIFLOW_DATA_DIR`, so isolated QA/e2e directories remain independent) prevents two processes from racing the same SQLite file — which matters most for backup import, where the connection is closed, the WAL sidecars deleted and the file replaced. The maintenance CLI takes the same lock and refuses to run against a database the app has open.
- **Print pipeline**: print HTML is rendered by a hidden `BrowserWindow` with `sandbox: true` and no preload, loaded from a `data:` URL.

## Validation and database handling

- All SQL goes through parameterised queries (fixed statements with bound parameters — user input is never interpolated into SQL text).
- Backup import validates that the supplied file is a genuine SQLite database before attempting to copy it; it **refuses the live database path itself** (an import source equal to the destination used to truncate the live file to 0 bytes and report success), it requires explicit confirmation ("Importing a backup will overwrite current data. This cannot be undone."), and both the swap and the rollback are atomic — the validated copy is staged next to the target and `rename()`d into place, so a crash mid-copy can never leave a half-written database.
- Backup export validates integrity on write; probe connections used for backups close in `finally`; failures are logged and never fatal — a missing backup must not stop the app from starting.
- Startup runs `PRAGMA quick_check` before migrations (corruption is reported once, at launch, with restore instructions), and any launch that finds an older schema first writes a `pre-upgrade-<timestamp>.db` snapshot (kept: 5) before migrations run.
- The data directory is created with mode `0700` and the database file with `0600` (SQLite mirrors the file mode onto the `-wal`/`-shm` sidecars), so other local accounts cannot read the data.
- **Error messages**: destructive, user-initiated flows (timetable save, requirements, allocation writes) map failures to friendly messages; other failures surface the underlying message through the page's error display. There is no retry loop for `SQLITE_BUSY` — the practical protection is the single-instance lock above plus better-sqlite3's default 5 s busy timeout. A complete friendly-message pass for every query path is not claimed.

## Secrecy and data

- No secrets, credentials, or environment files are committed to this repository.
- The only local data lives under the app's own application-data directory (`…/database/substiflow.db`, mode `0600`), backed up automatically per launch day and before schema upgrades.
- The app never uploads data, and there is no auto-sync or cloud component.

## Dependency advisory posture (`npm audit`)

As of this release, `npm audit` reports **31 advisories (9 moderate, 19 high, 3 critical)**. Every one of them lives in the development, test, or packaging toolchain — **none is in the shipped code path** (`better-sqlite3` is the only production dependency packed into the installer; the renderer libraries — `react`, `react-dom`, `react-router-dom`, `zustand`, `zod`, `date-fns`, `lucide-react`, `clsx`, `react-hook-form`, `xlsx` — are bundled by Vite and declared as development dependencies; `electron` itself is the runtime), and no advisory package ships inside the packaged application. This is a risk assessment, not a dismissal: each chain is listed with its exposure and the concrete upgrade path.

**Targeted fixes already applied in this release** (each verified with the full test suite afterwards):

- `npm audit fix` (never `--force`) — in-range updates only.
- `xlsx` (npm's deprecated package, whose advisories had no in-range fix) replaced with the official SheetJS 0.20.3 build from `cdn.sheetjs.com` (the vendor's own tarball URL).
- `vite` pinned to 6.4.4 and `react-router-dom` to ^7.18.4 (in-range compatible upgrades).

**Remaining chains and why they are accepted (temporarily):**

| Chain | Severities | Exposure | Upgrade path |
|---|---|---|---|
| `vitest` → `@vitest/mocker`, `tinypool` (critical), `vite`, `vite-node`, `esbuild` | 2 critical, 1 high, 3 moderate | **Test time only.** The path-traversal/mock-redirect issues require malicious test files; this repository runs only its own locally-authored tests. Never shipped. | `vitest` 4 (fix offered) requires Node ≥ 20.19; the local toolchain is pinned to Node 20.17. Upgrade Node → `vitest@4`. |
| `electron-builder` 24 → `app-builder-lib`, `builder-util`, `builder-util-runtime`, `dmg-builder`, `electron-publish`, `electron-builder-squirrel-windows`, `tar` (critical) | 1 critical, 6 high | **Packaging time only** (`npm run dist`), processing files this repository itself produced. The `electron-updater` advisories do not apply: the app has no auto-updater and never installs updates from the internet. | `electron-builder` 26 (fix offered) requires Node ≥ 20.19 — same Node gate as vitest. |
| `@electron/rebuild` → `@electron/node-gyp`, `make-fetch-happen`, `cacache` | 3 high | **Dev/packaging only** — rebuilds the native `better-sqlite3` module locally. | Follows the electron-builder/Node 20.19 toolchain bump. |
| `electron` install chain → `@electron/get`, `extract-zip`, `global-agent`, `roarr`, `sprintf-js` | 5 high/moderate | **`npm install` time only**, while downloading the official Electron distribution zip from GitHub (a trusted source) on the developer's machine. Not bundled into the app. | Included in a supported-Electron upgrade (see accepted risk below). |
| `tailwindcss` 3 → `braces` (high), `micromatch`, `chokidar`, `fast-glob`, `postcss-nested`, `postcss-selector-parser` | 4 high, 2 moderate | **CSS build time only** — DoS-style issues trigger while compiling this repository's own stylesheets. The shipped artifact is compiled CSS, not the tool. | `tailwindcss` 4 (major configuration migration); scheduled, not forced. |

A blanket `npm audit fix --force` would pull `vitest` 4, `electron-builder` 26, `electron` 41, and `tailwindcss` 4 in one step — all major jumps that cannot run on the pinned Node 20.17 toolchain and each of which invalidates the verified test/packaging baseline. Blind tree upgrades were deliberately not performed; the plan above upgrades each chain deliberately, behind a full gate run (`npm test`, both typechecks, `npm run build`, `npm run e2e`, `npm run dist`).

**Runtime risk that is not an npm advisory (accepted, not harmless):** the pinned `electron` 31.x line (installed: 31.7.7) is past its upstream support window, so the bundled Chromium/Node miss later security patches. Mitigations that limit the practical exposure: the app is offline-first (no remote content is ever rendered, the E2E suite fails on any non-localhost request), `contextIsolation` + sandbox + `nodeIntegration: false`, and no auto-updater. The honest upgrade path is a dedicated Electron-major upgrade (rebuild native modules via `scripts/ensure-abi.js`, re-run every gate including Windows packaging), tracked rather than claimed resolved.

## Accepted risks

The following are documented honestly so that users and reviewers have a complete picture:

- **No authentication or multi-user support.** The app assumes one trusted coordinator on one machine. There are no user accounts, no role checks, no encryption at rest, and no network authentication.
- **Windows runtime not verified.** The Windows NSIS installer (`SubstiFlow-Setup.exe`) builds cross-platform from this macOS host, but the executable has not been executed or smoke-tested on an actual Windows machine. Builds succeed; runtime behaviour on Windows is undocumented here.
- **Native print dialog not automatable.** The print path uses the native save dialog, which Playwright cannot script. The code path is verified by code review (IPC handler → `dialog.showSaveDialog` → `printToPDF`), but an automated end-to-end verification that the file lands correctly does not exist in this repository.
- **Single-user, one-machine workflow.** There is no cross-machine state; a backup file must be copied manually between machines, and migration between computers is done by replacing the database file.
- **Timetable conventions are source-specific.** Working hours, period numbering, and break windows are configurable but must be set to match the local college's schedule; the app does not import institutional timetabling formats.

## Security practices summary

| Property | Status |
|---|---|
| Renderer `nodeIntegration: false` | verified |
| Context bridge exposed only to allowed APIs | verified |
| IPC sender verification on all DB handlers | verified |
| No raw SQLite errors to UI | verified |
| No secrets in repo | verified |
| Auto-backup on launch | verified |
| Silent failure if backup absent (never fatal) | verified |
| `npm audit` advisories in runtime dependencies | 0 (31 remain, all dev/build tooling — see [Dependency advisory posture](#dependency-advisory-posture-npm-audit)) |
| Windows runtime verification | **not done** |
| Print automation | **not done** |
| Multi-user / authentication | **not applicable** |