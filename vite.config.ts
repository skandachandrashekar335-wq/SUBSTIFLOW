import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

/**
 * The CSP lives in index.html for dev (it must allow Vite's inline HMR
 * preamble and the ws: live-reload channel). Production is offline-first and
 * loads only its own bundled assets over file://, so the build swaps in a
 * strict policy: no inline scripts, no network of any kind. `style-src` keeps
 * 'unsafe-inline' for React's inline style attributes — styles are the
 * lower-risk vector and Tailwind ships as an external stylesheet anyway.
 */
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'"

function productionCsp(): Plugin {
  return {
    name: 'substiflow-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(/content="default-src[^"]*"/, `content="${PROD_CSP}"`)
    },
  }
}

export default defineConfig({
  plugins: [react(), productionCsp()],
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