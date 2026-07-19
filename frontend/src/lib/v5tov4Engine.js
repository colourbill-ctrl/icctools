// (c) 2026 William Li
/**
 * V5 display + V5 observer → V4 display profile (phase-1 item 5, iccV5DspObsToV4Dsp).
 *
 * This is a Group B "construct" producer, so it rides the SAME wasm module as the
 * .cube converter (iccconstruct.mjs/wasm, built from validator-wasm/construct-
 * wrapper.cpp): one embind export `v5DspObsToV4(displayBytes, observerBytes)` that
 * replicates the tool's construction via CIccMemIO. Lazy-loaded — not fetched
 * until the maker's produce button is used.
 */

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccconstruct.mjs')
      if (!res.ok) throw new Error(`Failed to load construct engine: HTTP ${res.status}`)
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

// Same embind exception unwrap as cubeConverter.js — getExceptionMessage() returns
// ["type_name", "what()"]; the what() carries the engine's specific rejection
// ("… is not an RGB display profile", "… doesn't have a spectral emission AToB1Tag").
function toError(mod, e) {
  if (mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e)
      return new Error(Array.isArray(msg) ? (msg[1] || msg[0]) : String(msg))
    } catch { /* fall through */ }
  }
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * @param {Uint8Array} displayBytes  V5 RGB display profile
 * @param {Uint8Array} observerBytes V5 observer (ColorSpace-class PCC) profile
 * @returns {Promise<Uint8Array>} the V4 display profile bytes
 */
export async function v5DspObsToV4(displayBytes, observerBytes) {
  const mod = await loadModule()
  if (typeof mod.v5DspObsToV4 !== 'function') {
    // The construct wasm hasn't been rebuilt with this export yet.
    throw new Error('The V4 display engine is not built into this WASM module yet.')
  }
  let out
  try { out = mod.v5DspObsToV4(displayBytes, observerBytes) }
  catch (e) { throw toError(mod, e) }
  if (!out || !out.length) throw new Error('The V4 display engine returned no profile.')
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}
