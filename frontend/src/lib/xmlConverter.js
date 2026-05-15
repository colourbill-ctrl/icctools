/**
 * Lazy-loaded ICC ↔ XML converter.
 *
 * Wraps iccxml.mjs/wasm (built from validator-wasm/xml-wrapper.cpp). Nothing
 * is fetched until iccToXml() or xmlToIcc() is actually called — the module
 * pulls in IccLibXML + libxml2, which adds ~1.5 MB on top of the baseline
 * validator.
 *
 * Same fetch+blob trick as validator.js, for the same reason: Vite refuses
 * to analyse imports out of /public.
 */

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

// Mirror the C++ cap in xml-wrapper.cpp so the user gets a clean error
// before we pay for a multi-MB string copy into the wasm heap. Keep in
// sync with kMaxXmlBytes.
export const MAX_XML_BYTES = 32 * 1024 * 1024   // 32 MB

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccxml.mjs')
      if (!res.ok) throw new Error(`Failed to load XML converter: HTTP ${res.status}`)
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

// Embind surfaces C++ throws as opaque `CppException` values; getExceptionMessage
// (exported via EXPORTED_RUNTIME_METHODS in CMakeLists.txt) unwraps what() to a
// usable string. Wrap both entry points so the React side gets an Error with a
// real message.
function toError(mod, e) {
  if (mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e)
      // getExceptionMessage returns ["type_name", "what()"] — we want the latter.
      return new Error(Array.isArray(msg) ? (msg[1] || msg[0]) : String(msg))
    } catch {}
  }
  return e instanceof Error ? e : new Error(String(e))
}

/** Convert ICC profile bytes → XML string. Throws Error with reason on failure. */
export async function iccToXml(bytes) {
  const mod = await loadModule()
  try { return mod.iccToXml(bytes) }
  catch (e) { throw toError(mod, e) }
}

/** Convert XML string → ICC profile bytes (Uint8Array). Throws Error with reason on failure. */
export async function xmlToIcc(xml) {
  // string.length is UTF-16 code-units. UTF-8 byte count is always >=
  // code-unit count, so rejecting on length is a safe-loose upper bound
  // on bytes; the C++ side does the authoritative check on xml.size().
  if (xml.length > MAX_XML_BYTES) {
    throw new Error(
      `XML exceeds ${MAX_XML_BYTES / 1024 / 1024} MB limit ` +
      `(${(xml.length / 1024 / 1024).toFixed(1)} MB supplied)`
    )
  }
  const mod = await loadModule()
  try { return mod.xmlToIcc(xml) }
  catch (e) { throw toError(mod, e) }
}
