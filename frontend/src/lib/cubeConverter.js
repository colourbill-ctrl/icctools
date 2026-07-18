// (c) 2026 William Li
/**
 * Lazy-loaded .cube → ICC DeviceLink converter (Group B "construct" module).
 *
 * Wraps iccconstruct.mjs/wasm (built from validator-wasm/construct-wrapper.cpp,
 * which lifts iccDEV's iccFromCube). Same fetch+blob+import pattern as
 * jsonConverter.js / xmlConverter.js — the module isn't fetched until fromCube()
 * is called, so users who never build a profile from a cube don't pay for it.
 */

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

// Mirror kMaxCubeBytes in construct-wrapper.cpp so an oversized paste/upload is
// rejected before we copy a multi-MB string into the wasm heap. Keep in sync.
export const MAX_CUBE_BYTES = 32 * 1024 * 1024   // 32 MB

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccconstruct.mjs')
      if (!res.ok) throw new Error(`Failed to load cube converter: HTTP ${res.status}`)
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

// Same embind exception unwrap as jsonConverter.js — getExceptionMessage()
// returns ["type_name", "what()"]; the what() carries the engine's specific
// reason ("LUT too large to process", "1DLUTs are not supported", …).
function toError(mod, e) {
  if (mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e)
      return new Error(Array.isArray(msg) ? (msg[1] || msg[0]) : String(msg))
    } catch {}
  }
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Convert Adobe/Resolve `.cube` 3D-LUT text → ICC DeviceLink profile bytes.
 * @param {string} cubeText   the .cube file contents
 * @param {string} [filename] original filename, used only in the generated
 *                            profile's default description/copyright text
 * @returns {Promise<Uint8Array>} the ICC profile bytes
 */
export async function fromCube(cubeText, filename = '') {
  // string.length is UTF-16 code units — always <= the UTF-8 byte count, so
  // this is a safe-loose upper bound; the C++ side does the authoritative
  // check on the byte size.
  if (cubeText.length > MAX_CUBE_BYTES) {
    throw new Error(
      `Cube file exceeds ${MAX_CUBE_BYTES / 1024 / 1024} MB limit ` +
      `(${(cubeText.length / 1024 / 1024).toFixed(1)} MB supplied)`
    )
  }
  const mod = await loadModule()
  try { return mod.fromCube(cubeText, filename) }
  catch (e) { throw toError(mod, e) }
}
