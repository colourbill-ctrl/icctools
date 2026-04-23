/**
 * Lazy-loaded ICC ↔ JSON converter.
 *
 * Wraps iccjson.mjs/wasm (built from validator-wasm/json-wrapper.cpp). Same
 * fetch+blob+import pattern as validator.js and xmlConverter.js — the module
 * isn't touched until iccToJson() or jsonToIcc() is called, so users who
 * never open the JSON tab don't pay for the ~1 MB download.
 */

const WASM_DIR = '/wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccjson.mjs')
      if (!res.ok) throw new Error(`Failed to load JSON converter: HTTP ${res.status}`)
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

// Same embind exception unwrap as xmlConverter.js — getExceptionMessage()
// returns ["type_name", "what()"]; we want the latter.
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
 * Convert ICC profile bytes → JSON string.
 * @param {Uint8Array} bytes
 * @param {{ indent?: number, sort?: boolean }} [opts]
 */
export async function iccToJson(bytes, opts = {}) {
  const mod = await loadModule()
  const indent = opts.indent ?? 2
  const sort = opts.sort ?? false
  try { return mod.iccToJson(bytes, indent, sort) }
  catch (e) { throw toError(mod, e) }
}

/** Convert JSON string → ICC profile bytes (Uint8Array). */
export async function jsonToIcc(jsonString) {
  const mod = await loadModule()
  try { return mod.jsonToIcc(jsonString) }
  catch (e) { throw toError(mod, e) }
}
