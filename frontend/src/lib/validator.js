// (c) 2026 William Li
/**
 * Client-side ICC profile validator.
 *
 * Loads the Emscripten-built WASM module from /wasm/ on first use and caches
 * the instance. Exposes an API matching the old /api/validate response so
 * callers don't need to change.
 */

// BASE_URL is '/' in dev and '/profiletool/' in production builds — see vite.config.js.
const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
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
  const buffer = await file.arrayBuffer()
  return validateBytes(new Uint8Array(buffer), file.name)
}

/** Validate already-loaded bytes (used by XML→ICC round-trip). */
export async function validateBytes(bytes, filename) {
  const mod = await loadModule()
  const json = mod.validateProfile(bytes)
  const data = JSON.parse(json)

  if (data.error) throw new Error(data.error)

  data.filename = filename
  data.exitCode = (data.validation?.level === 'error') ? 1 : 0
  return data
}

/**
 * Full-verbosity Describe() for a single tag, computed on demand.
 *
 * The bulk validateProfile() pass uses verbosity 75 (no CLUT cell dumps) so
 * the WASM heap stays bounded even on huge nCLR profiles. The tag detail
 * modal calls this when opened to get the wxProfileDump-equivalent dump for
 * one tag — which fits even at full verbosity once isolated.
 *
 * `tagSig` is the 4-character ICC signature (e.g. "A2B0", "desc").
 */
export async function describeTag(bytes, tagSig) {
  const mod = await loadModule()
  const json = mod.describeTag(bytes, tagSig)
  const data = JSON.parse(json)
  if (data.error) throw new Error(data.error)
  return data.description
}
