/**
 * Lazy-loaded ICC PAWG assessment report.
 *
 * Wraps iccpawg.mjs/wasm (built from validator-wasm/pawg-wrapper.cpp, which
 * drives the iccPawgReport tool's --json output). Same fetch+blob+import
 * pattern as the other lazy WASM modules — only downloaded when the user opens
 * the PAWG tab.
 */

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccpawg.mjs')
      if (!res.ok) throw new Error(`Failed to load PAWG module: HTTP ${res.status}`)
      const source = await res.text()
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      try {
        const factory = (await import(/* @vite-ignore */ blobUrl)).default
        return await factory({ locateFile: (path) => WASM_DIR + path })
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
    })()
    modulePromise.catch(() => { modulePromise = null })
  }
  return modulePromise
}

/**
 * Run the PAWG assessment checklist on a profile.
 * @param {Uint8Array} bytes
 * @returns {Promise<object>} parsed report { tool, summary, items[], ... }
 */
export async function pawgReport(bytes) {
  const mod = await loadModule()
  const report = JSON.parse(mod.pawgReport(bytes))
  if (report.error) throw new Error(report.error)
  return report
}
