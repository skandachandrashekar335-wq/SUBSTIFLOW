import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: [],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    // better-sqlite3 v12 + Node.js v22+ / v24: the native addon's Database
    // destructor asserts `(env) != nullptr` when V8's GC fires it after the
    // Node.js environment has already been torn down inside vitest's worker
    // threads (tinypool workers share the process GC heap with the host env).
    // Using the 'forks' pool runs each test file in its own child process so
    // the native addon's destructor always runs inside a live environment.
    pool: 'forks',
  },
})