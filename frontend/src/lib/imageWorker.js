// (c) 2026 William Li
//
// Web Worker: STREAMING embedded-profile extraction. Reads byte-ranges from the source
// File SYNCHRONOUSLY (FileReaderSync — available in workers only) and installs them as
// globalThis.__imgRead / __imgSize, so the iccimage codecs (libtiff/libpng/libjpeg)
// read ONLY the header/IFD/markers + the profile blob — never the pixels. A huge image
// therefore never loads into memory just to grab its profile. Mirrors describeWorker.js.
//
// Protocol:
//   in : { reqId, file: File, op?: 'profile' | 'probe' }   (default 'profile')
//   out: { reqId, profile: Uint8Array|null }               (op 'profile')
//      | { reqId, probe: {ok,width,height,channels,bitDepth,photometric} }  (op 'probe')
//      | { reqId, error: string }

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
  const { reqId, file, op } = e.data || {}
  try {
    const mod = await loadModule()
    const fr = new FileReaderSync()
    const size = file.size
    // Synchronous ranged reader over the File — the C read callbacks drive this and
    // pull only the ranges the codecs ask for (front-of-file for PNG/JPEG; a few seeks
    // for TIFF). Returns ≤ `want` bytes; empty past EOF. Used by BOTH the profile-
    // extract and the header-probe paths — neither reads the pixel data.
    self.__imgSize = () => size
    self.__imgRead = (_id, offset, want) => {
      if (offset >= size) return new Uint8Array(0)
      const end = Math.min(size, offset + want)
      return new Uint8Array(fr.readAsArrayBuffer(file.slice(offset, end)))
    }
    try {
      if (op === 'probe') {
        const info = mod.probeImage(0)   // plain {ok,width,height,channels,bitDepth,photometric}
        self.postMessage({ reqId, probe: info })
      } else {
        const profile = mod.findProfileStream(0)
        const out = profile ? new Uint8Array(profile) : null
        // Transfer the buffer so the profile bytes aren't copied back across the boundary.
        self.postMessage({ reqId, profile: out }, out ? [out.buffer] : [])
      }
    } finally { self.__imgRead = null; self.__imgSize = null }
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) })
  }
}
