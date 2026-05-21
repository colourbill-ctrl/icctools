import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Resolve a build-time version label, in priority order:
//   1. git tag (`git describe --tags --abbrev=0`) — matches chardata's
//      deploy.yml convention; will return the latest semver tag once any
//      are pushed.
//   2. package.json `version` — until a tag exists, this is the
//      source of truth and is what the footer renders.
// Both are exposed as the build-time constant __APP_VERSION__.
function resolveAppVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
    if (tag) return tag.replace(/^v/i, '')
  } catch (_) { /* no tags yet — fall through */ }
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))
    if (pkg.version) return pkg.version
  } catch (_) {}
  return 'dev'
}

// Production builds emit /profiletool/-rooted asset URLs because profiletool is
// served at chardata.colourbill.com/profiletool/. Dev keeps base='/' so
// http://localhost:5173/ continues to work as before.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/profiletool/' : '/',
  server: { port: 5173 },
  define: {
    __APP_VERSION__: JSON.stringify(resolveAppVersion()),
  },
}))
