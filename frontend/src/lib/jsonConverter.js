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

// Mirror the C++ cap in json-wrapper.cpp so the user gets a clean error
// before we pay for a multi-MB string copy into the wasm heap. Keep in
// sync with kMaxJsonBytes.
export const MAX_JSON_BYTES = 32 * 1024 * 1024   // 32 MB

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
  // string.length is UTF-16 code-units. UTF-8 byte count is always >=
  // code-unit count (most ASCII is 1:1; multi-byte chars = higher).
  // Rejecting on length is a safe-loose upper bound on bytes; the C++
  // side does the authoritative check on json.size().
  if (jsonString.length > MAX_JSON_BYTES) {
    throw new Error(
      `JSON exceeds ${MAX_JSON_BYTES / 1024 / 1024} MB limit ` +
      `(${(jsonString.length / 1024 / 1024).toFixed(1)} MB supplied)`
    )
  }
  const mod = await loadModule()
  try { return mod.jsonToIcc(jsonString) }
  catch (e) { throw toError(mod, e) }
}
