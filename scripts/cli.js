/**
 * Runs a maintenance task inside Electron so the native `better-sqlite3`
 * binding matches the Electron ABI and the storage location is exactly the
 * one the app uses.
 *
 *   electron scripts/cli.js migrate
 *   electron scripts/cli.js seed
 */
const path = require('path')
const { app } = require('electron')

// Must match the name used by electron/main.ts so `app.getPath('userData')`
// points at the same folder for both the app and these maintenance tasks.
app.setName('SubstiFlow')

const task = process.argv[2]
const tasks = {
  migrate: () => require('./tasks/migrate')(),
  seed: () => require('./tasks/seed')(),
}

app.whenReady().then(() => {
  try {
    // Point the scripts at the exact database folder the app itself uses.
    if (!process.env.SUBSTIFLOW_DATA_DIR) {
      process.env.SUBSTIFLOW_DATA_DIR = app.getPath('userData')
    }

    const run = tasks[task]
    if (!run) {
      throw new Error(
        `Unknown task "${task}". Available: ${Object.keys(tasks).join(', ')}`
      )
    }
    run()
    console.log(`Task "${task}" completed.`)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
