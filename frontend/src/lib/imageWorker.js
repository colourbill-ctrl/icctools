// (c) 2026 William Li
//
// Web Worker: STREAMING embedded-profile extraction. Reads byte-ranges from the source
// File SYNCHRONOUSLY (FileReaderSync — available in workers only) and installs them as
// globalThis.__imgRead / __imgSize, so the iccimage codecs (libtiff/libpng/libjpeg)
// read ONLY the header/IFD/markers + the profile blob — never the pixels. A huge image
// therefore never loads into memory just to grab its profile. Mirrors describeWorker.js.
//
// Protocol:
//   in : { reqId, file: File }
//   out: { reqId, profile: Uint8Array|null } | { reqId, error: string }

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccimage.mjs')
      if (!res.ok) throw new Error(`Failed to load image codecs: HTTP ${res.status}`)
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
  const { reqId, file } = e.data || {}
  try {
    const mod = await loadModule()
    const fr = new FileReaderSync()
    const size = file.size
    // Synchronous ranged reader over the File — the C read callbacks drive this and
    // pull only the ranges the codecs ask for (front-of-file for PNG/JPEG; a few seeks
    // for TIFF). Returns ≤ `want` bytes; empty past EOF.
    self.__imgSize = () => size
    self.__imgRead = (_id, offset, want) => {
      if (offset >= size) return new Uint8Array(0)
      const end = Math.min(size, offset + want)
      return new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, end)))
    }
    let profile = null
    try { profile = mod.findProfileStream(0) }
    finally { self.__imgRead = null; self.__imgSize = null }
    const out = profile ? new Uint8Array(profile) : null
    // Transfer the buffer so the profile bytes aren't copied back across the boundary.
    self.postMessage({ reqId, profile: out }, out ? [out.buffer] : [])
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) })
  }
}
