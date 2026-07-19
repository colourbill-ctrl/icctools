// (c) 2026 William Li
//
// Web Worker: runs describeTag() (the verbosity-100 per-tag dump) OFF the main
// thread so a large CLUT tag's dump never blocks the UI. It loads its own
// iccprofiledump WASM instance — the module is built with
// `-sENVIRONMENT=web,worker,node`, so the Emscripten glue runs here — using the
// same fetch+blob+import pattern as the main-thread loader (Vite won't analyse
// imports from /public).
//
// Protocol:
//   in : { reqId, bytes: Uint8Array, tagSig: string }
//   out: { reqId, text: string } | { reqId, error: string }

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
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

self.onmessage = async (e) => {
  const { reqId, bytes, tagSig } = e.data || {}
  try {
    const mod = await loadModule()
    const data = JSON.parse(mod.describeTag(bytes, tagSig))
    if (data.error) throw new Error(data.error)
    self.postMessage({ reqId, text: data.description })
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) })
  }
}
