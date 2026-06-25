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
