/**
 * Runs a maintenance task inside Electron so the native `better-sqlite3`
 * binding matches the Electron ABI and the storage location is exactly the
 * one the app uses.
 *
 *   electron scripts/cli.js migrate
 *   electron scripts/cli.js seed
 */
const { app } = require('electron')

// Must match the name used by electron/main.ts so `app.getPath('userData')`
// points at the same folder for both the app and these maintenance tasks.
app.setName('SubstiFlow')

// Point the scripts at the exact database folder the app itself uses — and
// scope the Electron profile (hence the single-instance lock) to it, exactly
// like the app does. A maintenance task must never race an OPEN app on the
// same database file (two processes replaying migrations), while runs with
// their own SUBSTIFLOW_DATA_DIR (e2e/QA) stay independent.
if (!process.env.SUBSTIFLOW_DATA_DIR) {
  process.env.SUBSTIFLOW_DATA_DIR = app.getPath('userData')
}
app.setPath('userData', process.env.SUBSTIFLOW_DATA_DIR)

if (!app.requestSingleInstanceLock()) {
  console.error(
    'Refusing to run: another SubstiFlow instance is using this database.\n' +
      'Close the app first (or point SUBSTIFLOW_DATA_DIR at a different data directory).'
  )
  app.exit(1)
} else {
  const task = process.argv[2]
  const tasks = {
    migrate: () => require('./tasks/migrate')(),
    seed: () => require('./tasks/seed')(),
  }

  app.whenReady().then(() => {
    try {
      const run = tasks[task]
      if (!run) {
        throw new Error(
          `Unknown task "${task}". Available: ${Object.keys(tasks).join(', ')}`
        )
      }
      run()
      console.log(`Task "${task}" completed.`)
      app.quit()
    } catch (error) {
      // `app.quit()` reports exit code 0 even when the task failed — npm
      // scripts and CI must see the failure. `app.exit()` takes effect
      // immediately, so wait for stderr to flush first (it is asynchronous
      // when piped) or the message would be truncated.
      process.exitCode = 1
      process.stderr.write(
        `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
        () => app.exit(1)
      )
    }
  })
}
