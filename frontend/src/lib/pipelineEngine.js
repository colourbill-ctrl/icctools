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

// CMM interpolation selector (iccApplyProfiles' global `interpolation` arg, G5). The
// C++ side maps 0→linear, anything-else→tetrahedral (profiletool's historical default).
export const INTERP = { linear: 0, tetrahedral: 1 }
const interpNum = (v) => (v === INTERP.linear || v === 'linear') ? 0 : 1

/**
 * Bake an ordered profile chain into a DeviceLink profile.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers (first → last)
 * @param {{intent?: number, grid?: number, interp?: number|string}} [opts] intent 0-3
 *   (default 1=relative), grid 0=auto, interp linear|tetrahedral (default tetrahedral)
 * @returns {Promise<Uint8Array>} the DeviceLink .icc bytes
 */
export async function buildLink(chainBytes, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.buildLink !== 'function') {
    throw new Error('The DeviceLink engine is not built into this WASM module yet.')
  }
  const intents = opts.intents ?? 1        // array (per-profile) or scalar; default relative
  const firstInput = opts.firstInput ?? true   // head-transform direction (true = device→PCS)
  const grid = Number.isInteger(opts.grid) ? opts.grid : 0         // 0 = auto by channel count
  const interp = interpNum(opts.interp)
  let out
  try { out = mod.buildLink(chainBytes, intents, firstInput, grid, interp) }
  catch (e) { throw toError(mod, e) }
  if (!out || !out.length) throw new Error('The DeviceLink engine returned no profile.')
  return out instanceof Uint8Array ? out : new Uint8Array(out)
}

/**
 * Per-profile extended-intent availability for the apply intent menus (G6). Reports the
 * tag/version facts the UI gates on: base intents 0-3 are always offered; 10-13 (no
 * D2Bx/B2Dx) need `hasD2Bx`; 40-42 (BPC) need `hasLut`.
 * @param {Uint8Array} bytes one profile
 * @returns {Promise<{ok:boolean, versionMajor?:number, v5?:boolean, hasD2Bx?:boolean,
 *   hasLut?:boolean, isLink?:boolean, deviceClass?:string, error?:string}>}
 */
export async function profileApplyCaps(bytes) {
  const mod = await loadConstruct()
  if (typeof mod.profileApplyCaps !== 'function') return { ok: false, unavailable: true }
  try {
    const r = mod.profileApplyCaps(bytes)
    return r || { ok: false }
  } catch (e) { return { ok: false, error: toError(mod, e).message } }
}

// icRenderingIntent enum (ICC) — the value picked per transform (and the global
// default). 0 perceptual · 1 relative colorimetric · 2 saturation · 3 absolute.
export const RENDERING_INTENTS = [
  { id: 0, label: 'Perceptual', short: 'Perc' },
  { id: 1, label: 'Relative Colorimetric', short: 'Rel' },
  { id: 2, label: 'Saturation', short: 'Sat' },
  { id: 3, label: 'Absolute Colorimetric', short: 'Abs' },
]

// icFloatColorEncoding enum (IccCmm.h) — the C++ applyValues clamps out-of-range,
// but the JS side names them so the data methods can pass the auto-detected encoding.
export const ENCODING = {
  value: 0,
  percent: 1,
  unitFloat: 2,
  float: 3,
  '8Bit': 4,
  '16Bit': 5,
  '16BitV2': 6,
}

/**
 * Run a LIST of colours (a dropped dataset) through the chain — profiletool's
 * iccApplyNamedCmm equivalent (Transform Data). Unlike applyToImage, source values
 * carry a real encoding (percent / 8-bit / PCS Lab-XYZ value units), so the WASM
 * routes each sample through ToInternalEncoding / FromInternalEncoding.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers
 * @param {Float32Array|number[]} samples row-major nSamples × nSrc source values
 * @param {number} nSrc source channels per sample
 * @param {{intent?:number, srcEncoding?:string|number, dstEncoding?:string|number}} [opts]
 * @returns {Promise<{destSamples:number, srcSpace:string, dstSpace:string, values:Float32Array}>}
 */
export async function transformData(chainBytes, samples, nSrc, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.applyValues !== 'function') {
    throw new Error('The data-transform engine is not built into this WASM module yet.')
  }
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples)
  if (nSrc < 1) throw new Error('The data has no colour channels.')
  if (src.length % nSrc !== 0) throw new Error('Data value count is not a multiple of the channel count.')
  const intents = opts.intents ?? 1
  const firstInput = opts.firstInput ?? true
  const interp = interpNum(opts.interp)
  const encNum = (e, dflt) =>
    Number.isInteger(e) ? e : e in ENCODING ? ENCODING[e] : dflt
  const srcEnc = encNum(opts.srcEncoding, ENCODING.unitFloat)
  const dstEnc = encNum(opts.dstEncoding, ENCODING.value)
  let res
  try { res = mod.applyValues(chainBytes, new Uint8Array(src.buffer), nSrc, intents, firstInput, srcEnc, dstEnc, interp) }
  catch (e) { throw toError(mod, e) }
  if (!res || !res.ok) throw new Error(res?.error || 'Data transform failed.')
  const values = res.values instanceof Float32Array ? res.values : new Float32Array(res.values)
  return { destSamples: res.destSamples, srcSpace: res.srcSpace, dstSpace: res.dstSpace, values }
}

/**
 * Cheap gate for the Invert Transform (iccApplySearch): assemble the SEARCH CMM
 * (2–3 profiles, last one inverted) and report the source space the dropped dataset
 * MUST match plus the device space the inversion produces. Never throws — a chain that
 * can't be inverted (wrong length / won't connect) is a normal, explained result.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers (last = inverted)
 * @param {{intents?:number|number[], initIntent?:number}} [opts]
 * @returns {Promise<{ok:boolean, count:number, tooMany?:boolean, message?:string,
 *   srcSpace?:string, dstSpace?:string, srcSamples?:number, dstSamples?:number}>}
 */
export async function searchInfo(chainBytes, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.searchInfo !== 'function') {
    return { ok: false, count: chainBytes.length, unavailable: true,
      message: 'The inversion engine is not built into this WASM module yet.' }
  }
  const intents = opts.intents ?? 1
  const initIntent = Number.isInteger(opts.initIntent) ? opts.initIntent : 1
  try {
    const r = mod.searchInfo(chainBytes, intents, initIntent)
    return r || { ok: false, count: chainBytes.length, message: 'No result from inversion analysis.' }
  } catch (e) {
    return { ok: false, count: chainBytes.length, message: toError(mod, e).message }
  }
}

/**
 * Invert a LIST of colours through a 2–3 profile chain — profiletool's iccApplySearch
 * equivalent (Invert Transform). The forward profiles carry the dropped data → PCS; the
 * LAST profile is inverted via a Nelder-Mead search to recover its DEVICE values. The
 * dataset must be in the search SOURCE space (see searchInfo). Optionally returns a
 * per-row search residual (`cost`) — an index of how cleanly each target inverts.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers (last = inverted)
 * @param {Float32Array|number[]} samples row-major nSamples × nSrc source values
 * @param {number} nSrc source channels per sample
 * @param {{intents?:number|number[], initIntent?:number, srcEncoding?:string|number,
 *   dstEncoding?:string|number, wantCost?:boolean}} [opts]
 * @returns {Promise<{destSamples:number, srcSpace:string, dstSpace:string,
 *   values:Float32Array, cost?:Float32Array}>}
 */
export async function invertData(chainBytes, samples, nSrc, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.invertValues !== 'function') {
    throw new Error('The inversion engine is not built into this WASM module yet.')
  }
  const src = samples instanceof Float32Array ? samples : Float32Array.from(samples)
  if (nSrc < 1) throw new Error('The data has no colour channels.')
  if (src.length % nSrc !== 0) throw new Error('Data value count is not a multiple of the channel count.')
  const intents = opts.intents ?? 1
  const initIntent = Number.isInteger(opts.initIntent) ? opts.initIntent : 1
  const encNum = (e, dflt) =>
    Number.isInteger(e) ? e : e in ENCODING ? ENCODING[e] : dflt
  const srcEnc = encNum(opts.srcEncoding, ENCODING.value)
  const dstEnc = encNum(opts.dstEncoding, ENCODING.value)
  const wantCost = opts.wantCost !== false     // default on — the residual is cheap-ish and useful
  let res
  try {
    res = mod.invertValues(chainBytes, new Uint8Array(src.buffer), nSrc,
      intents, initIntent, srcEnc, dstEnc, wantCost)
  } catch (e) { throw toError(mod, e) }
  if (!res || !res.ok) throw new Error(res?.error || 'Invert Transform failed.')
  const values = res.values instanceof Float32Array ? res.values : new Float32Array(res.values)
  const out = { destSamples: res.destSamples, srcSpace: res.srcSpace, dstSpace: res.dstSpace, values }
  if (res.cost) out.cost = res.cost instanceof Float32Array ? res.cost : new Float32Array(res.cost)
  return out
}

// Observer / illuminant / M-condition option values, shared with the UI controls.
// Illuminant ints are icIlluminant enum values (only D50/D65/D93/A have built-in
// SPDs in iccDEV — the only ones exposed). Observer 1 = CIE 1931 2°, 2 = 1964 10°.
export const OBSERVERS = [
  { id: 1, label: '2° (1931)' },
  { id: 2, label: '10° (1964)' },
]
export const ILLUMINANTS = [
  { id: 1, label: 'D50' },
  { id: 2, label: 'D65' },
  { id: 3, label: 'D93' },
  { id: 6, label: 'A' },
]
export const M_CONDITIONS = [
  { id: 0, label: 'M0' },
  { id: 1, label: 'M1' },
  { id: 2, label: 'M2' },
  { id: 3, label: 'M3' },
]

/**
 * Convert spectral reflectance rows → CIE XYZ (relative colorimetry, Y=1) using
 * iccDEV's canonical CIccColorimetricCalculator (the ~/code/spectral reference
 * class). Reflectance must be in [0,1] FACTORS — scale percent→unit before calling.
 * @param {number[][]} reflRows  each row is nBands reflectance factors
 * @param {{startNm:number, endNm:number, observer?:number, illuminant?:number, mCond?:number}} opts
 * @returns {Promise<{ xyz: number[][], white: number[] }>} XYZ rows + adopted white
 */
export async function spectralToXYZ(reflRows, opts) {
  const mod = await loadConstruct()
  if (typeof mod.spectralToXYZ !== 'function') {
    throw new Error('The spectral engine is not built into this WASM module yet.')
  }
  const n = reflRows.length
  if (!n) return { xyz: [], white: [0, 0, 0] }
  const nBands = reflRows[0].length
  const flat = new Float32Array(n * nBands)
  for (let r = 0; r < n; r++) {
    const row = reflRows[r]
    for (let b = 0; b < nBands; b++) flat[r * nBands + b] = Number(row[b]) || 0
  }
  let res
  try {
    res = mod.spectralToXYZ(new Uint8Array(flat.buffer), n, nBands,
      opts.startNm, opts.endNm,
      Number.isInteger(opts.observer) ? opts.observer : 1,
      Number.isInteger(opts.illuminant) ? opts.illuminant : 1,
      Number.isInteger(opts.mCond) ? opts.mCond : 0)
  } catch (e) { throw toError(mod, e) }
  if (!res || !res.ok) throw new Error(res?.error || 'Spectral conversion failed.')
  const vals = res.values instanceof Float32Array ? res.values : new Float32Array(res.values)
  const xyz = []
  for (let r = 0; r < n; r++) xyz.push([vals[r * 3], vals[r * 3 + 1], vals[r * 3 + 2]])
  const w = res.white instanceof Float32Array ? res.white : new Float32Array(res.white)
  return { xyz, white: [w[0], w[1], w[2]] }
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
export async function chainInfo(chainBytes, intents = 1, firstInput = true, interp = INTERP.tetrahedral) {
  const mod = await loadConstruct()
  if (typeof mod.chainInfo !== 'function') {
    // Older WASM without the export — don't block the UI, just skip validation.
    return { ok: true, unavailable: true }
  }
  try {
    const r = mod.chainInfo(chainBytes, intents, firstInput, interpNum(interp))
    return r || { ok: false, error: 'No result from chain analysis.' }
  } catch (e) {
    return { ok: false, error: toError(mod, e).message }
  }
}

/**
 * Run one raster image through the chain. Decode happens via the iccimage codecs
 * (libtiff/libpng/libjpeg); the CMM runs in WASM; the result is re-encoded. The output
 * options mirror iccApplyProfiles' destination knobs (G1-G5): sample encoding, TIFF
 * compression, planar layout, ICC embedding, and CMM interpolation. Images are never
 * stored — the caller downloads the result.
 * @param {Uint8Array[]} chainBytes ordered profile byte buffers
 * @param {File} file the input image
 * @param {{intents?:number|number[], firstInput?:boolean, interp?:number|string,
 *   outEncoding?:'same'|'8'|'16'|'float', compression?:'none'|'lzw'|'zip',
 *   planar?:'contig'|'separate', embedIcc?:boolean}} [opts]
 * @returns {Promise<{bytes: Uint8Array, filename: string}>}
 */
// Pixels processed per chunk. Bounds WASM memory: a chunk is nSrc/nDst × this × 4
// bytes each way (~16 MB at 4 channels), so an arbitrarily large image never needs
// its whole float raster resident (which std::bad_alloc'd on big CMYK TIFFs).
const IMG_CHUNK_PIXELS = 1_000_000

export async function applyToImage(chainBytes, file, opts = {}) {
  const mod = await loadConstruct()
  if (typeof mod.imageApplyBegin !== 'function') {
    throw new Error('The image engine is not built into this WASM module yet.')
  }
  const { decodeImage, encodeImage } = await import('./imageCodec.js')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let img
  try { img = await decodeImage(bytes) }                       // TIFF/PNG/JPEG, any space
  catch (e) { throw new Error(`Could not decode “${file.name}”: ${e.message}`) }

  const nSrc = img.channels
  const nPixels = img.width * img.height
  const intents = opts.intents ?? 1
  const firstInput = opts.firstInput ?? true
  const interp = interpNum(opts.interp)

  // Destination sample encoding (G1). 'same' follows the decoded source depth (8/16-bit
  // integer — float source decode is a separate follow-up). '8'/'16' are unsigned
  // integer; 'float' is 32-bit IEEE.
  const srcBits = img.bitDepth === 16 ? 16 : 8
  const enc = opts.outEncoding || 'same'
  let outBits, isFloat
  if (enc === 'float') { outBits = 32; isFloat = true }
  else if (enc === '16') { outBits = 16; isFloat = false }
  else if (enc === '8') { outBits = 8; isFloat = false }
  else { outBits = srcBits; isFloat = false }                  // 'same'

  // Build the CMM once; then stream the raster through it in bounded chunks.
  let begin
  try { begin = mod.imageApplyBegin(chainBytes, nSrc, intents, firstInput, interp) }
  catch (e) { throw toError(mod, e) }
  if (!begin || !begin.ok) throw new Error(begin?.error || 'Image processing failed.')
  const nDst = begin.nDst

  // Output raster: one contiguous buffer sized by the chosen encoding, with a typed
  // view for packing. 8-bit → Uint8, 16-bit → Uint16 (native LE), float → Float32.
  const outBuf = new Uint8Array(nPixels * nDst * (outBits / 8))
  const outU16 = outBits === 16 ? new Uint16Array(outBuf.buffer) : null
  const outF32 = isFloat ? new Float32Array(outBuf.buffer) : null
  const s = img.samples
  const is16 = img.bitDepth === 16
  try {
    for (let p0 = 0; p0 < nPixels; p0 += IMG_CHUNK_PIXELS) {
      const cnt = Math.min(IMG_CHUNK_PIXELS, nPixels - p0)
      // This chunk's source pixels → Float32 [0,1] (converted from the decoded 8/16-bit
      // samples on the fly, so the whole float image is never allocated at once).
      const chunk = new Float32Array(cnt * nSrc)
      const base = p0 * nSrc
      if (is16) {
        for (let k = 0; k < chunk.length; k++) { const j = (base + k) * 2; chunk[k] = (s[j] | (s[j + 1] << 8)) / 65535 }
      } else {
        for (let k = 0; k < chunk.length; k++) chunk[k] = s[base + k] / 255
      }
      let res
      try { res = mod.imageApplyChunk(new Uint8Array(chunk.buffer)) }   // eslint-disable-line no-await-in-loop
      catch (e) { throw toError(mod, e) }
      const dstF = res.pixels                                  // [0,1] normalized device floats
      const ob = p0 * nDst
      const kn = cnt * nDst
      if (isFloat) {
        // Float output keeps the CMM's normalized [0,1] device values verbatim (NaN → 0).
        for (let k = 0; k < kn; k++) { const v = dstF[k]; outF32[ob + k] = Number.isNaN(v) ? 0 : v }
      } else if (outU16) {
        for (let k = 0; k < kn; k++) { const v = dstF[k]; outU16[ob + k] = (v <= 0 || Number.isNaN(v)) ? 0 : v >= 1 ? 65535 : Math.round(v * 65535) }
      } else {
        for (let k = 0; k < kn; k++) { const v = dstF[k]; outBuf[ob + k] = (v <= 0 || Number.isNaN(v)) ? 0 : v >= 1 ? 255 : Math.round(v * 255) }
      }
    }
  } finally {
    try { mod.imageApplyEnd() } catch { /* ignore */ }
  }

  // Container choice. Float, separated planes, and explicit LZW/ZIP are TIFF-only knobs,
  // so any of them forces TIFF; likewise 4+ channels (CMYK / multichannel). Otherwise the
  // friendly default stays PNG for 1/3-channel 8/16-bit output.
  const planar = opts.planar === 'separate' ? 'separate' : 'contig'
  const compChosen = opts.compression && opts.compression !== 'none' ? opts.compression : null
  const forceTiff = isFloat || planar === 'separate' || !!compChosen ||
    nDst === 2 || nDst >= 4
  let format, photometric
  if (!forceTiff && (nDst === 1 || nDst === 3)) {
    format = 'png'; photometric = nDst === 1 ? 1 : 2
  } else {
    format = 'tiff'
    photometric = nDst === 1 ? 1 : nDst === 3 ? 2 : nDst === 4 ? 5 : 1
  }
  // Embed the chain's LAST profile (the output-space ICC), matching the CLI's "embed last
  // ICC" (G4). PNG (iCCP) and TIFF both carry it; JPEG isn't produced by this path.
  const profile = opts.embedIcc ? chainBytes[chainBytes.length - 1] : undefined
  // TIFF compression: explicit choice, else the historical LZW default. PNG ignores it.
  const compression = format === 'tiff'
    ? (opts.compression || 'lzw')
    : undefined
  const outBytes = await encodeImage({
    format, width: img.width, height: img.height, channels: nDst,
    bitDepth: outBits, photometric, samples: outBuf, profile,
    sampleFormat: isFloat ? 'float' : 'uint',
    compression, planar: format === 'tiff' ? planar : undefined,
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
