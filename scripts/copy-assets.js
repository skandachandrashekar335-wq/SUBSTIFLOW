/**
 * Copies non-TypeScript assets that the compiled Electron main process needs.
 * Runs after `tsc -p tsconfig.electron.json`.
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')

const copies = [
  {
    from: path.join(root, 'src', 'db', 'schema.sql'),
    to: path.join(root, 'dist', 'main', 'src', 'db', 'schema.sql'),
  },
]

for (const { from, to } of copies) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`)
}
