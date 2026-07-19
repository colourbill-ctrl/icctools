// (c) 2026 William Li
//
// Pipeline engine boundary (DL-PIPELINE1). The JS seam between the Pipeline builder UI
// and the WASM ports of the deferred iccDEV apply/link tools (validator-wasm/
// construct-wrapper.cpp, iccconstruct module). All memory-only — no MEMFS/filesystem —
// with kMaxIccBytes-style caps enforced C++-side.
//
//   chainInfo(chainBytes)          → authoritative connectivity + spaces (AddXform×N +
//                                    Begin, no LUT). Gates the UI.
//   buildLink(chainBytes)          → DeviceLink from the chain (iccApplyToLink core:
//                                    grid-sampled AToB0 CLUT). Returns .icc bytes → pool.
//   applyToImage(chainBytes, file) → iccApplyProfiles path: decode via the iccimage
//                                    codecs (lib/imageCodec — libtiff/libpng/libjpeg),
//                                    run pixels through the CMM in WASM, re-encode.
//                                    Returns {bytes, filename} → download.
//   assembleSpecSep(files)         → iccSpecSepToTiff: gather N single-channel rasters
//                                    (decoded via iccimage) into one multichannel TIFF
//                                    (encoded via libtiff). → download.
//
// Follow-ups (logged): >8-bit / float (HDR) handling (decode already returns 16-bit;
// apply + encode still quantize to 8-bit) and per-stage intent/BPC/PCC controls.

// ── iccconstruct module loader (shared with the .cube / V4-display producers) ──
// Same lazy blob-URL import pattern as v5tov4Engine.js — the construct wasm isn't
// fetched until a producer runs. buildLink() rides the SAME module as fromCube /
// v5DspObsToV4 (validator-wasm/construct-wrapper.cpp).
const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

async function loadConstruct() {
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

// Unwrap an embind exception to the engine's specific rejection ("Cannot link
// profile 2: …", "The chain does not connect: …").
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
 * Bake an ordered profile chain into a DeviceLink profile.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers (first → last)
 * @param {{intent?: number, grid?: number}} [opts] intent 0-3 (default 1=relative), grid 0=auto
 * @returns {Promise<Uint8Array>} the DeviceLink .icc bytes
 */
export async function buildLink(chainBytes, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.buildLink !== 'function') {
    throw new Error('The DeviceLink engine is not built into this WASM module yet.')
  }
  const intent = Number.isInteger(opts.intent) ? opts.intent : 1   // relative colorimetric
  const grid = Number.isInteger(opts.grid) ? opts.grid : 0         // 0 = auto by channel count
  let out
  try { out = mod.buildLink(chainBytes, intent, grid) }
  catch (e) { throw toError(mod, e) }
  if (!out || !out.length) throw new Error('The DeviceLink engine returned no profile.')
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}

/**
 * Authoritative chain validation for the UI (cheap: CMM AddXform×N + Begin, no LUT).
 * Never throws — a bad chain is a normal result the builder shows as an explanatory
 * warning.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers
 * @param {number} [intent] rendering intent 0-3 (default 1=relative)
 * @returns {Promise<{ok:boolean, error?:string, failedStage?:number, empty?:boolean,
 *   sourceSpace?:string, destSpace?:string, sourceSamples?:number, destSamples?:number}>}
 */
export async function chainInfo(chainBytes, intent = 1) {
  const mod = await loadConstruct()
  if (typeof mod.chainInfo !== 'function') {
    // Older WASM without the export — don't block the UI, just skip validation.
    return { ok: true, unavailable: true }
  }
  try {
    const r = mod.chainInfo(chainBytes, Number.isInteger(intent) ? intent : 1)
    return r || { ok: false, error: 'No result from chain analysis.' }
  } catch (e) {
    return { ok: false, error: toError(mod, e).message }
  }
}

/**
 * Run one raster image through the chain. Decode happens in the browser (PNG/JPEG →
 * RGB); the CMM runs in WASM; the result is re-encoded (PNG for RGB/Gray, TIFF for
 * CMYK/multichannel). Images are never stored — the caller downloads the result.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers
 * @param {File} file the input image
 * @param {{intent?: number}} [opts]
 * @returns {Promise<{bytes: Uint8Array, filename: string}>}
 */
export async function applyToImage(chainBytes, file, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.applyImage !== 'function') {
    throw new Error('The image engine is not built into this WASM module yet.')
  }
  const { decodeImage, encodeImage } = await import('./imageCodec.js')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let img
  try { img = await decodeImage(bytes) }                       // TIFF/PNG/JPEG, any space
  catch (e) { throw new Error(`Could not decode “${file.name}”: ${e.message}`) }

  // Raw samples (native-endian 8/16-bit) → Float32 [0,1] in the source device channels.
  const nSrc = img.channels
  const nPixels = img.width * img.height
  const src = new Float32Array(nPixels * nSrc)
  const s = img.samples
  if (img.bitDepth === 16) {
    for (let i = 0; i < src.length; i++) src[i] = (s[i * 2] | (s[i * 2 + 1] << 8)) / 65535
  } else {
    for (let i = 0; i < src.length; i++) src[i] = s[i] / 255
  }

  const intent = Number.isInteger(opts.intent) ? opts.intent : 1
  let res
  try { res = mod.applyImage(chainBytes, new Uint8Array(src.buffer), nSrc, intent) }
  catch (e) { throw toError(mod, e) }
  if (!res || !res.ok) throw new Error(res?.error || 'Image processing failed.')
  const nDst = res.destSamples
  const dstF = res.pixels

  const out8 = new Uint8Array(nPixels * nDst)
  for (let i = 0; i < out8.length; i++) {
    const v = dstF[i]
    out8[i] = (v <= 0 || Number.isNaN(v)) ? 0 : v >= 1 ? 255 : Math.round(v * 255)
  }

  // Container by destination channel count: 1/3 → PNG (lossless); 4 → separated TIFF
  // (CMYK); other → minisblack+extra TIFF.
  let format, photometric
  if (nDst === 1) { format = 'png'; photometric = 1 }
  else if (nDst === 3) { format = 'png'; photometric = 2 }
  else if (nDst === 4) { format = 'tiff'; photometric = 5 }
  else { format = 'tiff'; photometric = 1 }
  const outBytes = await encodeImage({
    format, width: img.width, height: img.height, channels: nDst, bitDepth: 8, photometric, samples: out8,
  })
  const ext = format === 'tiff' ? 'tif' : format
  const stem = (file.name || 'image').replace(/\.[^.]+$/, '')
  return { bytes: outBytes, filename: `${stem}-converted.${ext}` }
}

/**
 * Assemble N single-channel spectral images (channel order = file order) into one
 * multi-channel baseline TIFF. Pure browser-side (decode grayscale + TIFF write) — no
 * WASM needed; it is an image GATHER, not a colour transform.
 * @param {File[]} files ordered channel images
 * @returns {Promise<{bytes: Uint8Array, filename: string}>}
 */
export async function assembleSpecSep(files) {
  if (!files || files.length < 2) throw new Error('Add at least two channel images to assemble.')
  const { decodeImage, encodeImage } = await import('./imageCodec.js')
  let W = 0, H = 0
  const planes = []
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer())    // eslint-disable-line no-await-in-loop
    let img
    try { img = await decodeImage(bytes) }                 // eslint-disable-line no-await-in-loop
    catch (e) { throw new Error(`Could not decode “${f.name}”: ${e.message}`) }
    if (!W) { W = img.width; H = img.height }
    else if (img.width !== W || img.height !== H) {
      throw new Error('All spectral channels must have the same width and height.')
    }
    // One channel per image = channel 0 (grayscale sources have equal channels). 16-bit
    // sources contribute their high byte.
    const n = W * H, ch = img.channels, s = img.samples
    const plane = new Uint8Array(n)
    if (img.bitDepth === 16) for (let i = 0; i < n; i++) plane[i] = s[(i * ch) * 2 + 1]
    else for (let i = 0; i < n; i++) plane[i] = s[i * ch]
    planes.push(plane)
  }
  const spp = planes.length
  const n = W * H
  const samples = new Uint8Array(n * spp)
  for (let i = 0; i < n; i++) for (let c = 0; c < spp; c++) samples[i * spp + c] = planes[c][i]
  // libtiff writes minisblack + (spp-1) unspecified extra samples for the multichannel stack.
  const bytes = await encodeImage({ format: 'tiff', width: W, height: H, channels: spp, bitDepth: 8, photometric: 1, samples })
  return { bytes, filename: 'spectral.tif' }
}
