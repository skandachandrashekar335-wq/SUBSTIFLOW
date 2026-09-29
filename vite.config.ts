import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the packaged app loads index.html over file://,
  // where absolute paths (/assets/…) would resolve outside the app folder.
  base: './',
  resolve: {
    alias: [
      // The renderer must never bundle native/node-only modules.
      {
        find: '@/db/nodeDb',
        replacement: path.resolve(__dirname, './src/db/nodeDb.browser.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})