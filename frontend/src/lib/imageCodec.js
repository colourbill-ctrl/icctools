// (c) 2026 William Li
//
// JS boundary for the iccimage WASM module (libtiff + libpng + libjpeg). Replaces the
// hand-rolled JS image reader/writers (the old lib/imageIO.js) and the hand-rolled
// embedded-profile parsers (the old lib/embeddedProfile.js) with the canonical
// libraries compiled to WASM. Lazy blob-URL import (same pattern as v5tov4Engine.js);
// the codec wasm isn't fetched until an image is actually decoded/encoded/probed.

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

function toError(mod, e) {
  if (mod && mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e)
      return new Error(Array.isArray(msg) ? (msg[1] || msg[0]) : String(msg))
    } catch { /* fall through */ }
  }
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Extract the embedded ICC profile from a TIFF/PNG/JPEG byte buffer already in memory
 * (e.g. #url= / postMessage, where the bytes are fully in hand).
 * @param {Uint8Array} bytes whole image file bytes
 * @returns {Promise<Uint8Array|null>} the profile, or null if none / not an image
 */
export async function findEmbeddedProfile(bytes) {
  const mod = await loadModule()
  let r
  try { r = mod.findProfile(bytes) } catch (e) { throw toError(mod, e) }
  if (!r) return null
  return r instanceof Uint8Array ? r : new Uint8Array(r)
}

// ── streaming extraction (worker + FileReaderSync) ──────────────────────────
// For the common "load an image FILE" case we must NOT read the whole image — only
// its metadata. The codecs run in a worker that reads byte-ranges from the File
// synchronously (FileReaderSync), so libtiff/libpng/libjpeg touch only the header/
// IFD/markers + the profile blob. Falls back to a whole-file read on the main thread
// only if the worker can't be created (old/blocked environment).
let profWorker = null
let profWorkerBroken = false
let reqSeq = 0
const pending = new Map()

function getProfWorker() {
  if (profWorker || profWorkerBroken) return profWorker
  try {
    profWorker = new Worker(new URL('./imageWorker.js', import.meta.url), { type: 'module' })
    profWorker.onmessage = (e) => {
      const { reqId, profile, probe, error } = e.data || {}
      const p = pending.get(reqId)
      if (!p) return
      pending.delete(reqId)
      if (error) return p.reject(new Error(error))
      if (probe !== undefined) return p.resolve(probe)   // header probe → info object
      p.resolve(profile ? (profile instanceof Uint8Array ? profile : new Uint8Array(profile)) : null)
    }
    profWorker.onerror = () => {
      profWorkerBroken = true
      for (const [, p] of pending) p.reject(new Error('image worker error'))
      pending.clear()
      try { profWorker.terminate() } catch { /* ignore */ }
      profWorker = null
    }
  } catch {
    profWorkerBroken = true
    profWorker = null
  }
  return profWorker
}

/**
 * Extract the embedded ICC profile from an image File reading ONLY its metadata (never
 * the pixels). Use this for inspection / add-from-image; use decodeImage only when the
 * pixels are actually needed.
 * @param {File|Blob} file
 * @returns {Promise<Uint8Array|null>}
 */
export function findEmbeddedProfileFromFile(file) {
  const w = getProfWorker()
  if (!w) return findEmbeddedProfileWhole(file)
  const reqId = ++reqSeq
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try { w.postMessage({ reqId, file }) }
    catch (err) { pending.delete(reqId); reject(err) }
  }).catch((err) => {
    if (profWorkerBroken) return findEmbeddedProfileWhole(file)   // worker died → main-thread fallback
    throw err
  })
}
async function findEmbeddedProfileWhole(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return findEmbeddedProfile(bytes)
}

/**
 * Probe an image File for geometry + colour space reading ONLY the header (never the
 * pixels) — for validating a dropped image before deciding to transform it.
 * @param {File|Blob} file
 * @returns {Promise<{ok:boolean, error?:string, width?:number, height?:number,
 *   channels?:number, bitDepth?:number, photometric?:number}>}
 */
export function probeImageFromFile(file) {
  const w = getProfWorker()
  if (!w) return probeImageWhole(file)
  const reqId = ++reqSeq
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try { w.postMessage({ reqId, file, op: 'probe' }) }
    catch (err) { pending.delete(reqId); reject(err) }
  }).catch((err) => {
    if (profWorkerBroken) return probeImageWhole(file)   // worker died → main-thread fallback
    throw err
  })
}
// Fallback only (no worker): decode the whole image on the main thread to read its
// geometry. Reads the pixels — used solely when a worker can't be created.
async function probeImageWhole(file) {
  try {
    const mod = await loadModule()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const r = mod.decodeImage(bytes)
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not read the image.' }
    return { ok: true, width: r.width, height: r.height, channels: r.channels, bitDepth: r.bitDepth, photometric: r.photometric }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

/**
 * Decode a TIFF/PNG/JPEG to raw samples.
 * @param {Uint8Array} bytes whole image file bytes
 * @returns {Promise<{width:number, height:number, channels:number, bitDepth:number,
 *   photometric:number, samples:Uint8Array, profile?:Uint8Array}>}
 */
export async function decodeImage(bytes) {
  const mod = await loadModule()
  let r
  try { r = mod.decodeImage(bytes) } catch (e) { throw toError(mod, e) }
  if (!r || !r.ok) throw new Error((r && r.error) || 'Could not decode the image.')
  return r
}

// TIFF-only encode knobs (ignored for PNG/JPEG). `sampleFormat`: 'uint' (8/16-bit
// integer) or 'float' (32-bit IEEE, bitDepth must be 32). `compression`: 'none' |
// 'lzw' | 'zip'. `planar`: 'contig' | 'separate'. Defaults preserve the historical
// behaviour of the spec-sep / convert callers (LZW, contiguous, unsigned integer).
const SAMPLE_FMT = { uint: 0, float: 1 }
const COMPRESSION = { none: 0, lzw: 1, zip: 2 }
const PLANAR = { contig: 0, separate: 1 }

/**
 * Encode raw samples to a TIFF/PNG/JPEG.
 * @param {{format:'tiff'|'png'|'jpeg', width:number, height:number, channels:number,
 *   bitDepth?:number, photometric?:number, samples:Uint8Array, profile?:Uint8Array,
 *   quality?:number, sampleFormat?:'uint'|'float', compression?:'none'|'lzw'|'zip',
 *   planar?:'contig'|'separate'}} o
 * @returns {Promise<Uint8Array>}
 */
export async function encodeImage(o) {
  const mod = await loadModule()
  const { format, width, height, channels } = o
  const bitDepth = o.bitDepth || 8
  const photometric = o.photometric || 0
  const quality = o.quality || 92
  const profile = o.profile || new Uint8Array(0)
  const sampleFmt = SAMPLE_FMT[o.sampleFormat] ?? 0
  // Undefined compression = LZW (historical default); the UI passes an explicit choice.
  const compression = o.compression == null ? COMPRESSION.lzw : (COMPRESSION[o.compression] ?? 0)
  const planar = PLANAR[o.planar] ?? 0
  let out
  try { out = mod.encodeImage(format, width, height, channels, bitDepth, photometric, o.samples, profile, quality, sampleFmt, compression, planar) }
  catch (e) { throw toError(mod, e) }
  if (!out || !out.length) throw new Error('The image encoder returned nothing.')
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}
