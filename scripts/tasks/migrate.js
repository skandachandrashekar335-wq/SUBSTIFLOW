/**
 * Creates (if needed) and upgrades the local SQLite database.
 * Invoked through `scripts/cli.js` so it runs inside Electron.
 */
const path = require('path')

const compiled = path.join(__dirname, '..', '..', 'dist', 'main', 'src', 'db', 'nodeDb.js')

module.exports = function migrate() {
  const { openNodeDatabase, runMigrations, resolveDatabasePath } = require(compiled)

  const dbPath = resolveDatabasePath()
  console.log('Database:', dbPath)

  const db = openNodeDatabase(dbPath)
  runMigrations(db)
  db.close()

  console.log('Migrations applied.')
}
