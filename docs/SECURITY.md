# Security

Verified security properties and accepted risks. SubstiFlow is an offline-first desktop application — there is no server, no telemetry, and no network calls at runtime. All data stays on the local machine.

## Electron security boundaries

- **Renderer isolation**: `nodeIntegration: false`, `contextIsolation: true`, default sandbox enabled.
- **Preload bridge**: `contextBridge.exposeInMainWorld` exposes exactly four namespaces — `db`, `backup`, `app`, `print` — each typed and scoped. The renderer cannot reach Node.js APIs directly.
- **IPC sender verification**: every database IPC handler first calls `isTrustedSender()`, which checks that the event's `sender` is the main window's own `webContents`. No other webContents (popups, print windows, devtools extensions) can reach the database bridge.
- **Navigation**: `will-navigate` handler permits in-app navigation only; all other URL schemes are examined by `openExternalSafely()` and only `http(s)`/`mailto` are forwarded to the OS; everything else is logged as a warning and blocked.
- **External links**: `shell.openExternal()` is only called with absolute URLs of scheme `http:`, `https:`, or `mailto:`; other protocols are rejected with a console warning.

## Validation and database handling

- All SQL goes through parameterised repository queries — the renderer never constructs SQL strings.
- Backup import validates that the supplied file is a genuine SQLite database before attempting to copy it; it requires explicit confirmation ("Importing a backup will overwrite current data. This cannot be undone.")
- Backup export validates integrity on write; failures are logged and never fatal — a missing backup must not stop the app from starting.
- No raw SQLite errors surface to the UI; the app catches them and renders friendly messages instead.

## Secrecy and data

- No secrets, credentials, or environment files are committed to this repository.
- The only local data lives in `application-data/substiflow.db` (user-controlled, backed up automatically per launch day).
- The app never uploads data, and there is no auto-sync or cloud component.

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
| Windows runtime verification | **not done** |
| Print automation | **not done** |
| Multi-user / authentication | **not applicable** |