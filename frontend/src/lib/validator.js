/**
 * Client-side ICC profile validator.
 *
 * Loads the Emscripten-built WASM module from /wasm/ on first use and caches
 * the instance. Exposes an API matching the old /api/validate response so
 * callers don't need to change.
 */

const WASM_DIR = '/wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      // Vite refuses to analyse imports from /public, so we fetch the glue
      // code ourselves and instantiate it from a blob URL.
      const res = await fetch(WASM_DIR + 'iccprofiledump.mjs')
      if (!res.ok) throw new Error(`Failed to load WASM loader: HTTP ${res.status}`)
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

/** Kick off WASM module download+instantiation in the background. */
export function preloadValidator() {
  loadModule().catch(() => { modulePromise = null })
}

/**
 * Validate an ICC profile File.
 * Returns the parsed JSON result, augmented with filename and exitCode for
 * parity with the old server response.
 */
export async function validateProfile(file) {
  const [mod, buffer] = await Promise.all([loadModule(), file.arrayBuffer()])
  const bytes = new Uint8Array(buffer)
  const json = mod.validateProfile(bytes)
  const data = JSON.parse(json)

  if (data.error) throw new Error(data.error)

  data.filename = file.name
  data.exitCode = (data.validation?.level === 'error') ? 1 : 0
  return data
}
