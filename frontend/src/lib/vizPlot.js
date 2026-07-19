// (c) 2026 William Li
/**
 * Lazy-loaded data-first visualization client (iccplot.mjs/wasm, built from
 * validator-wasm/plot-wrapper.cpp + IccVizModel.cpp).
 *
 * Unlike visualizer.js (which drives the legacy iccProfileVisualize PDF/TIFF
 * report), this returns the *data* behind each plot so the caller draws it in
 * its own style:
 *   enumerateVisualizations(bytes) → [{kind,id,title,output}, …]  (PDF order)
 *   renderGraph(bytes, id)         → {title,description,xAxis,yAxis,series[]}
 *   renderRaster(bytes, id)        → {width,height,channels,bits,photometric,samples}
 *
 * Same fetch+blob+import pattern as the other WASM clients; the ~800 KB module
 * is only fetched when a tag is first expanded in the Tags tab (which drives the
 * inline per-tag graphs + evaluator). The WASM keeps a parse cache, so enumerate
 * + per-graph renders + per-point evaluations of one profile parse it once.
 */

const WASM_DIR = import.meta.env.BASE_URL + 'wasm/'
let modulePromise = null

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const res = await fetch(WASM_DIR + 'iccplot.mjs')
      if (!res.ok) throw new Error(`Failed to load graph module: HTTP ${res.status}`)
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

// Same embind exception unwrap as xmlConverter.js / jsonConverter.js. The C++
// wrappers now return {"error": …} for handled failures, but an embind throw can
// still escape (e.g. OOM marshalling the return value); getExceptionMessage
// turns the opaque CppException into a readable .what() string.
function toError(mod, e) {
  if (mod && mod.getExceptionMessage) {
    try {
      const msg = mod.getExceptionMessage(e)
      return new Error(Array.isArray(msg) ? (msg[1] || msg[0]) : String(msg))
    } catch { /* fall through */ }
  }
  return e instanceof Error ? e : new Error(String(e))
}

/** List every available visualization, in the same order iccProfileVisualize emits. */
export async function enumerateVisualizations(bytes) {
  const mod = await loadModule()
  let out
  try { out = mod.enumerate(bytes) } catch (e) { throw toError(mod, e) }
  const arr = JSON.parse(out)
  if (arr && arr.error) throw new Error(arr.error)
  return arr
}

/** Render one graph by id → {title, description, xAxis, yAxis, series[]}. */
export async function renderGraph(bytes, id) {
  const mod = await loadModule()
  let out
  try { out = mod.renderGraph(bytes, id) } catch (e) { throw toError(mod, e) }
  const g = JSON.parse(out)
  if (g.error) throw new Error(g.error)
  return g
}

/**
 * Describe a LUT tag's transform for the evaluator UI →
 * {srcSpace,dstSpace,srcChannels,dstChannels,srcIsPcs,dstIsPcs,
 *  srcLabels[],dstLabels[],gridPoints[]}. `tagSig` is the 4-char tag id.
 */
export async function tagEvalInfo(bytes, tagSig) {
  const mod = await loadModule()
  const r = JSON.parse(mod.tagEvalInfo(bytes, tagSig))
  if (r.error) throw new Error(r.error)
  return r
}

/**
 * Apply the selected tag's transform to one input point (IccProfLib, no lcms2).
 * `input` is an array in the source space's human units (device 0..1; PCS as
 * Lab L*,a*,b* or XYZ) — unless `inputIsNormalized`, in which case the values are
 * taken as the internal normalized encoding (grid-point input). →
 * {outNorm[], outHuman[], dstSpace, dstIsPcs}.
 */
export async function evaluateTag(bytes, tagSig, input, inputIsNormalized = false) {
  const mod = await loadModule()
  const r = JSON.parse(mod.evaluateTag(bytes, tagSig, JSON.stringify(input), inputIsNormalized))
  if (r.error) throw new Error(r.error)
  return r
}

/**
 * Gamut volume (ΔE*ab³) enclosed by the gamut of one device→PCS (AToB) tag at a
 * rendering intent, via boundary voxelisation + flood-fill (IccProfLib, no lcms2).
 * `tagSig` is the 4-char AToB tag id ('A2B0'|'A2B1'|'A2B2'); `intent` is the ICC
 * value 0 perceptual / 1 relative / 2 saturation / 3 absolute. Typical pairs:
 * ('A2B0',0), ('A2B1',1), ('A2B2',2), ('A2B1',3) for absolute. →
 * {volume, voxels, samplesPerAxis, voxelSize, nColorants}.
 */
export async function gamutVolume(bytes, tagSig, intent) {
  const mod = await loadModule()
  let out
  try { out = mod.gamutVolume(bytes, tagSig, intent) } catch (e) { throw toError(mod, e) }
  const r = JSON.parse(out)
  if (r.error) throw new Error(r.error)
  return r
}

/**
 * Gamut boundary MESH for the profile's device→PCS transform at a rendering intent —
 * the drawable surface behind the Compare-tab 3-D gamut plot and (via sliceHull, JS
 * side) the 2-D slice. Built from the PROFILE (A2B LUT or matrix/TRC), so it is
 * intent-driven and works for matrix display profiles (AdobeRGB) too. `intent` is the
 * ICC value 0 perceptual / 1 relative / 2 saturation / 3 absolute; `steps` ≤0
 * auto-picks the grid density from the colorant count.
 *
 * Returns TYPED ARRAYS (not JSON — the mesh is thousands of numbers):
 *   { nColorants, samplesPerAxis,
 *     vertices : Float32Array,   // L*,a*,b* interleaved, 3 per vertex
 *     triangles: Int32Array }    // index triples into `vertices`, 3 per triangle
 * The returned arrays are JS-heap copies (independent of the WASM heap), so they
 * survive later module calls. A triangle may reference a non-finite vertex (a
 * device point that mapped outside a computable PCS) — the renderer drops those.
 */
export async function gamutMesh(bytes, intent, steps = 0) {
  const mod = await loadModule()
  let r
  try { r = mod.gamutMesh(bytes, intent, steps) } catch (e) { throw toError(mod, e) }
  if (r.error) throw new Error(r.error)
  return {
    nColorants: r.nColorants,
    samplesPerAxis: r.samplesPerAxis,
    vertices: r.vertices,     // already a JS-side Float32Array (embind .set-copied)
    triangles: r.triangles,   // already a JS-side Int32Array
  }
}

/**
 * Round-trip statistics for ONE rendering intent, covering all four types the
 * Analysis-tab Profile-Statistics table exposes through its type selector. One
 * call returns every type so switching the selector is instant; only changing the
 * intent or the use-MPE toggle needs a fresh call (memoize JS-side per
 * (profile, intent, useMpe)).
 *
 * `intent`: 0 perceptual / 1 relative / 2 saturation / 3 absolute.
 * `useMpe` : false = colorimetric (lut) tags, true = MPE/color tags (applies to
 *            RT1/RT2/PRMG; RT0's iccviz engine ignores it).
 *
 * Every type shares ONE uniform shape (grounded in the underlying colour math,
 * not the iccRoundTrip CLI's console layout — see design doc DL-A1):
 *   { ok:true, n, total, min, mean, std, p90, max,
 *     hist:[c0, c1, …],                 // integer-ΔE bin counts (bin i = [i, i+1))
 *     buckets:[≤1, ≤2, ≤3, ≤5, ≤10],   // cumulative counts (kept for smoketest A/B)
 *     worstLab:[L,a,b]?,                // omitted when the distribution is empty
 *     implied?:bool }                   // PRMG only: "Specified Gamut" declaration
 * or, when a type could not be computed:
 *   { ok:false, message, status? }      // status:'tooManySamples' = #1405 skip
 *
 * → { intent, useMpe, types: { RT0, RT1, RT2, PRMG } }
 *   RT0  = iccviz in-gamut overview (device grid → PCS → device → PCS)
 *   RT1  = device-cube ΔE(deviceLab, round1)  — inversion + gamut
 *   RT2  = device-cube ΔE(round1, round2)     — reproducibility
 *   PRMG = Perceptual Reference Medium Gamut interoperability histogram
 * A top-level `.error` (module/parse failure) still throws; per-type `ok:false`
 * does NOT throw — the UI shows that type as "not evaluated".
 */
export async function roundTripStats(bytes, intent, useMpe = false) {
  const mod = await loadModule()
  let out
  try { out = mod.roundTripStats(bytes, intent, useMpe) } catch (e) { throw toError(mod, e) }
  const r = JSON.parse(out)
  if (r.error) throw new Error(r.error)
  return r
}

/** Render one raster by id → {width,height,channels,bitsPerChannel,photometric,samples}. */
export async function renderRaster(bytes, id) {
  const mod = await loadModule()
  const r = mod.renderRaster(bytes, id)
  if (r.error) throw new Error(r.error)
  // Copy samples off the WASM heap so they survive later calls.
  return {
    width: r.width, height: r.height, channels: r.channels,
    bitsPerChannel: r.bitsPerChannel, photometric: r.photometric,
    normalizedICC: r.normalizedICC, samples: Uint8Array.from(r.samples),
    warnings: r.warnings ? Array.from(r.warnings) : [],   // non-fatal diagnostics
  }
}
