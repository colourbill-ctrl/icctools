// (c) 2026 William Li
//
// Pipeline (Link-tab) chain model — the profiletool Phase-2 linking/apply UX WITHOUT
// a node graph. Every ICC transformation in the deferred tool set (iccApplyToLink /
// iccApplyNamedCmm / iccApplyProfiles) is a *linear* chain: an ordered list of
// profiles a payload flows through. There is no branching, so a node canvas is
// overkill (DL-PIPELINE1) — an ordered, reorderable list of profile "stages" plus a
// payload/sink is the whole model.
//
// This module is the pure-JS "type brain": given the ordered chain (pool entries),
// it decides — from each profile's header SIGNATURES — what OUTCOMES are possible:
//   • Make DeviceLink  — bake the chain into one 'link'-class profile → pool.
//   • Process images   — feed raster images through the chain → save each result.
// It reads the raw big-endian 4-char header signatures straight from the bytes
// (every pool entry holds them), NOT the localized human strings, so the logic is
// language- and version-stable — same discipline as lib/v4display.js. Deep space /
// direction validation stays with the WASM engine, which is authoritative and
// rejects any off-contract chain with a specific message; here we gate the UI
// optimistically so the user can build and see outcomes before producing.

// ICC header signature offsets (big-endian 4-char ASCII):
//   12..15 device/profile class · 16..19 data (device) colour space · 20..23 PCS.
const OFF_CLASS = 12
const OFF_DATA = 16
const OFF_PCS = 20

function sigAt(bytes, off) {
  if (!bytes || bytes.length < off + 4) return ''
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
}

// Device colour spaces that can be read/written as a raster image. RGB/GRAY/CMYK/CMY
// plus the ICC n-colour device spaces 'xCLR' (x = channel count, 2..F hex). PCS
// spaces (Lab/XYZ) are deliberately excluded — they are connection spaces, not
// picture pixels, so a chain that starts or ends in PCS can still Make-DeviceLink
// but is not offered image processing.
const IMAGE_SPACES = new Set(['RGB ', 'GRAY', 'CMYK', 'CMY '])
// A picture-representable device space: RGB/GRAY/CMYK/CMY or an ICC n-colour space
// ('xCLR', x = channel count 2..F). PCS spaces (Lab/XYZ) are connection spaces, not
// pixels, so a chain ending in PCS can Make-DeviceLink but not process images.
// Accepts a 4-char signature ('RGB ') or a trimmed label ('RGB').
export function isImageSpace(sig) {
  if (!sig) return false
  const s = sig.length === 4 ? sig : (sig.trim() + '    ').slice(0, 4)
  return IMAGE_SPACES.has(s) || /^[2-9A-F]CLR$/.test(s)
}

// Pretty a 4-char space signature for a label ('RGB ' → 'RGB', 'Lab ' → 'Lab').
export function spaceLabel(sig) {
  return (sig || '').trim() || '?'
}

/**
 * Per-profile facts a chain stage needs, read from the header signatures.
 * @param {{currentBytes?: Uint8Array}} entry pool entry
 */
export function profileFacts(entry) {
  const b = entry?.currentBytes
  const cls = sigAt(b, OFF_CLASS)
  const data = sigAt(b, OFF_DATA)
  const pcs = sigAt(b, OFF_PCS)
  const isLink = cls === 'link'
  return {
    cls,
    data,
    pcs,
    isLink,
    isAbstract: cls === 'abst',
    isNamed: cls === 'nmcl',
    // The device space the chain SEES entering this profile used forward.
    inputSpace: data,
    // What comes out the far side: a DeviceLink's B-side (header 'PCS' field) is a
    // *device* space, not a real PCS; every other class round-trips its own device.
    outputSpace: isLink ? pcs : data,
    known: !!data,   // parsed far enough to know the device space
  }
}

// A PCS connection space (Lab or XYZ). The CMM inter-converts the two at a PCS
// junction, so either counts as "PCS" when deciding a profile's direction.
export function isPCS(sig) {
  const s = (sig || '').trim()
  return s === 'Lab' || s === 'XYZ'
}

/**
 * Per-transform flow of an ordered chain, given the HEAD transform's direction.
 * Each profile contributes ONE transform whose direction alternates as the payload
 * bounces between device and PCS coordinates (the CIccCmm model). Returns a stage
 * per profile with its input→output spaces, whether a rendering intent applies, and
 * whether it is a PROBLEM (a space the profile can't accept, or a DeviceLink asked to
 * run backwards). This is the fast per-keystroke label/validation feedback; the WASM
 * chainInfo (with the same firstInput + intents) remains the authoritative gate.
 *
 * @param {Array<{currentBytes?:Uint8Array}|null>} entries ordered pool entries
 * @param {boolean} headForward  true = head runs device→PCS; false = PCS→device
 * @returns {{ stages: Array<{inSpace?:string,outSpace?:string,problem:boolean,
 *   canIntent:boolean,unknown?:boolean,klass?:string}>, ok:boolean,
 *   source:?string, dest:?string }}
 */
export function computeChainFlow(entries, headForward = true) {
  const facts = (entries || []).map((e) => (e ? profileFacts(e) : null))
  const stages = []
  let ok = facts.length > 0
  // Space the payload currently occupies (4-char sig), or null after a break.
  let cur = null
  const head = facts[0]
  if (head && head.known) cur = headForward ? head.data : head.pcs

  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]
    if (!f || !f.known) { stages.push({ unknown: true, problem: true, canIntent: false }); ok = false; cur = null; continue }
    let inSpace, outSpace, problem = false
    if (f.isLink) {
      // DeviceLink is one-way: A-side device (data) → B-side device (pcs field).
      inSpace = f.data; outSpace = f.pcs
      if (cur != null && cur !== f.data) problem = true   // can't invert / space mismatch
    } else if (f.isAbstract) {
      // Abstract runs PCS → PCS.
      inSpace = f.pcs; outSpace = f.pcs
      if (cur != null && !isPCS(cur)) problem = true
    } else {
      // Device-class (display/output/input/colorspace) is bidirectional device↔PCS.
      if (cur == null) { inSpace = f.data; outSpace = f.pcs }              // best-effort after a break
      else if (cur === f.data) { inSpace = f.data; outSpace = f.pcs }      // device→PCS
      else if (isPCS(cur) && isPCS(f.pcs)) { inSpace = f.pcs; outSpace = f.data }  // PCS→device
      else { problem = true; inSpace = cur; outSpace = '?' }               // upstream space this profile can't take
    }
    stages.push({
      inSpace: spaceLabel(inSpace), outSpace: spaceLabel(outSpace), problem,
      canIntent: !f.isLink && !f.isAbstract && !f.isNamed, klass: f.cls,
    })
    if (problem) { ok = false; cur = null } else cur = outSpace
  }

  let dest = null
  for (let i = stages.length - 1; i >= 0; i--) {
    if (!stages[i].unknown && !stages[i].problem) { dest = stages[i].outSpace; break }
  }
  return { stages, ok, source: stages[0] && !stages[0].unknown ? stages[0].inSpace : null, dest }
}

/**
 * Analyse an ordered chain of pool entries → outcomes + source/dest labels.
 * @param {Array<{id:string, filename:string, currentBytes?:Uint8Array}>} entries
 */
export function analyzeChain(entries) {
  const stages = (entries || []).map((e) => ({
    id: e.id, filename: e.filename, facts: profileFacts(e),
  }))
  if (!stages.length) {
    return { empty: true, ok: false, stages: [], outcomes: { link: false, image: false } }
  }
  const src = stages[0].facts.inputSpace
  const dst = stages[stages.length - 1].facts.outputSpace
  // "known" = every stage exposed a device space (a fully-parsed profile). A partial
  // parse (best-effort) can omit it; we then withhold outcomes rather than guess.
  const known = stages.every((s) => s.facts.known)
  const imageIn = isImageSpace(src)
  const imageOut = isImageSpace(dst)
  return {
    empty: false,
    ok: known,
    stages,
    sourceSpace: spaceLabel(src),
    destSpace: spaceLabel(dst),
    outcomes: {
      // A DeviceLink can always be baked from a connectable chain (the engine has
      // the final say on space compatibility); we enable it whenever spaces parsed.
      link: known,
      // Image processing needs a picture-representable space at BOTH ends.
      image: known && imageIn && imageOut,
    },
  }
}
