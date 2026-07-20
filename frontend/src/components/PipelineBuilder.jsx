// (c) 2026 William Li
//
// Link Pipeline — the Combine-tab chain builder (Phase-2, DL-PIPELINE1). Drop profiles
// (from the pool or a tab accumulator) into an ORDERED chain, then either:
//   • Make DeviceLink — bake the chain into one 'link' profile → lands in the pool.
//   • Transform Image — run ONE dropped image through the chain (iccApplyProfiles) →
//     downloads the result. profiletool is an experimentation tool, so one image at a
//     time is deliberate (no batch). The image is accepted + VALIDATED at the top via a
//     streaming header probe (type + size + colour space) WITHOUT loading its pixels.
//   • Transform Data — run ONE dropped colour dataset (CGATS/CSV/CxF/JSON) through the
//     chain (iccApplyNamedCmm equivalent) → shows a result table with Save. The data
//     slot sits beside the image slot; both validate live against the chain HEAD.
//
// The data methods interpret the dataset's kinds (device / Lab / XYZ / spectral) and
// feed whichever the chain's input space needs; spectral→colorimetry is canonical
// iccDEV (CIccColorimetricCalculator, WASM). Observer/illuminant/M-condition, the
// Prefer-colorimetry-source listbox, and duplicate filtering are persisted controls.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { POOL_DND_MIME } from './PoolPane.jsx'
import { spaceLabel, computeChainFlow, computeInvertPlan } from '../lib/pipeline.js'
import {
  chainInfo, transformData as engineTransformData, invertData as engineInvertData, spectralToXYZ,
  profileApplyCaps, OBSERVERS, ILLUMINANTS, RENDERING_INTENTS,
} from '../lib/pipelineEngine.js'
import {
  parseDataText, summarizeDataset, classifyColumns, spaceKind,
  buildTransformInput, deduplicateRows, destHeaders,
} from '../lib/dataParse.js'
import { probeImageFromFile, findEmbeddedProfileFromFile } from '../lib/imageCodec.js'
import DataResultModal from './DataResultModal.jsx'
import { useT } from '../i18n.jsx'
import styles from './PipelineBuilder.module.css'

// Cap on the image we'll transform (matches the WASM applyImage 64 MP guard). Checked
// from the streaming probe's dimensions — no pixels loaded.
const MAX_IMAGE_PIXELS = 64_000_000
// A dropped dataset is text — small. Guard the read so a huge mislabelled file can't
// stall the tab (the WASM applyValues also caps at 5M patches).
const MAX_DATA_CHARS = 64 * 1024 * 1024
// Private drag type for reordering chain stages by dragging. Distinct from
// POOL_DND_MIME so a stage-reorder drag never triggers the profile-drop highlight,
// and a pool-profile drag never looks like a reorder.
const REORDER_MIME = 'application/x-pipeline-reorder'

// Persist a control in localStorage (data-method observer/illuminant/dedup settings
// live inside this UI only — design decision #3).
function usePersisted(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return initial
      return typeof initial === 'number' ? Number(raw)
        : typeof initial === 'boolean' ? raw === '1' : raw
    } catch { return initial }
  })
  useEffect(() => {
    try { localStorage.setItem(key, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)) } catch { /* ignore */ }
  }, [key, v])
  return [v, setV]
}

const PREFER_LABELS = { lab: 'Lab', xyz: 'XYZ', spectral: 'Spectral' }

// Invert Transform (iccApplySearch) is hidden for now — the search engine still traps
// under WASM on some v5 iccMAX profiles (see memory iccdev-cmmsearch-v5-wasm-trap) and
// awaits worker isolation (task #81). The button, direction selector and note are gated
// on this flag; the engine/state stay wired so re-enabling is a one-line change.
const SHOW_INVERT = false

// Extended rendering-intent flavours (iccApplyProfiles parity, G6). Base 0-3 are always
// offered; no-D2Bx (10-13) needs a profile carrying D2Bx/B2Dx MPE tags and BPC (40-42)
// needs a LUT-based profile — both gated per profile via profileApplyCaps. Labels are
// technical terms kept in English (like RENDERING_INTENTS); extended-intent i18n rides
// the deferred backfill (task #68).
const INTENT_NO_D2BX = [
  { id: 10, label: 'Perceptual (no D2Bx)', short: 'Perc·n' },
  { id: 11, label: 'Relative (no D2Bx)', short: 'Rel·n' },
  { id: 12, label: 'Saturation (no D2Bx)', short: 'Sat·n' },
  { id: 13, label: 'Absolute (no D2Bx)', short: 'Abs·n' },
]
const INTENT_BPC = [
  { id: 40, label: 'Perceptual + BPC', short: 'Perc·B' },
  { id: 41, label: 'Relative + BPC', short: 'Rel·B' },
  { id: 42, label: 'Saturation + BPC', short: 'Sat·B' },
]
// Option list a single profile's RI listbox offers, given its caps.
function intentOptionsFor(caps) {
  const out = RENDERING_INTENTS.slice()
  if (caps?.hasD2Bx) out.push(...INTENT_NO_D2BX)
  if (caps?.hasLut) out.push(...INTENT_BPC)
  return out
}
// Keep the current selection representable even if a profile swap drops its flavour from
// the caps-gated list (otherwise the <select> would blank out).
function withCurrent(options, cur) {
  if (options.some((o) => o.id === cur)) return options
  return [...options, { id: cur, label: `Intent ${cur}`, short: String(cur) }]
}

// Plain-language description of each base rendering intent, plus the two modifier
// families (BPC / no-D2Bx), so the compact RI listboxes carry a tooltip explaining the
// current choice (e.g. the cramped "Perc·B" resolves to Perceptual + black-point
// compensation). Kept English like the intent labels (extended-intent i18n is deferred).
const INTENT_DESC = {
  0: 'Perceptual — compresses the source gamut so the whole image keeps a natural look; best for photographs.',
  1: 'Relative Colorimetric — reproduces in-gamut colours exactly and remaps the white point; out-of-gamut colours clip to the boundary.',
  2: 'Saturation — favours vivid, saturated colour over accuracy; suited to charts and business graphics.',
  3: 'Absolute Colorimetric — reproduces exact colour values including the media white; used to proof one medium on another.',
}
function intentDescription(id) {
  const base = ((id % 10) + 10) % 10
  const baseDesc = INTENT_DESC[base] || `Rendering intent ${id}`
  if (id >= 40 && id <= 42) return `${baseDesc}\n+ Black-point compensation: maps source black to destination black to preserve shadow detail.`
  if (id >= 10 && id <= 13) return `${baseDesc}\n(no D2Bx/B2Dx): bypasses the v4.3+ multi-processing tables, using the classic A2B/B2A path.`
  return baseDesc
}

export default function PipelineBuilder({ getEntry, onBuildLink, onApplyImages, onAddProfile, onAccumulate, pipeline, setPipeline }) {
  const t = useT()
  // The whole pipeline config (chain + per-transform intents + head direction +
  // global intent) is lifted to App so it survives Combine↔other-tab switches within
  // a session (the pool is unchanged, so it should persist). `chain` and `intents`
  // are kept strictly parallel by the mutation helpers below.
  const chain = pipeline.chain
  const intents = pipeline.intents
  const headForward = pipeline.headForward
  const globalIntent = pipeline.globalIntent
  // Invert Transform direction: false = invert the LAST chain stage (data enters at the
  // first), true = invert the FIRST stage (chain reversed for the search engine).
  const invertReverse = !!pipeline.invertReverse
  const setInvertReverse = (val) => setPipeline((p) => ({ ...p, invertReverse: val }))

  // Append profiles to the chain (+ a matching intent = current global) and reflect
  // them in the accumulator. Every other mutation keeps chain/intents in lock-step.
  const appendStages = (ids) => setPipeline((p) => ({
    ...p, chain: [...p.chain, ...ids], intents: [...p.intents, ...ids.map(() => p.globalIntent)],
  }))
  // Put a profile at the HEAD of the chain (G9: an extracted embedded profile is the
  // image's source space, so it belongs first).
  const prependStage = (id) => setPipeline((p) => ({
    ...p, chain: [id, ...p.chain], intents: [p.globalIntent, ...p.intents],
  }))
  const swapStages = (i, j) => setPipeline((p) => {
    if (j < 0 || j >= p.chain.length) return p
    const c = [...p.chain], it = [...p.intents]
    ;[c[i], c[j]] = [c[j], c[i]]; [it[i], it[j]] = [it[j], it[i]]
    return { ...p, chain: c, intents: it }
  })
  const removeStage = (i) => setPipeline((p) => ({
    ...p, chain: p.chain.filter((_, k) => k !== i), intents: p.intents.filter((_, k) => k !== i),
  }))
  const clearStages = () => setPipeline((p) => ({ ...p, chain: [], intents: [] }))
  const reorderStages = (from, to) => setPipeline((p) => {
    if (from === to || from < 0 || from >= p.chain.length || to < 0 || to >= p.chain.length) return p
    const c = [...p.chain], it = [...p.intents]
    const [mc] = c.splice(from, 1); c.splice(to, 0, mc)
    const [mi] = it.splice(from, 1); it.splice(to, 0, mi)
    return { ...p, chain: c, intents: it }
  })
  const setIntentAt = (i, val) => setPipeline((p) => {
    const it = [...p.intents]; it[i] = val; return { ...p, intents: it }
  })
  // Selecting the global intent re-applies it to EVERY transform (and re-solidifies
  // the global listbox text). Changing any individual intent leaves globalIntent as
  // the last global pick — the mismatch greys the global listbox (see intentsMixed).
  const setGlobalIntent = (val) => setPipeline((p) => ({
    ...p, globalIntent: val, intents: p.chain.map(() => val),
  }))
  const toggleHeadDir = () => setPipeline((p) => ({ ...p, headForward: !p.headForward }))

  const [dragOver, setDragOver] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const nameRef = useRef(null)
  const imgInputRef = useRef(null)
  const dataInputRef = useRef(null)

  // Held image + its streaming header probe (NOT its pixels).
  const [image, setImage] = useState(null)         // File | null
  const [imageInfo, setImageInfo] = useState(null) // { ok, width, height, channels, photometric } | null
  const [imageErr, setImageErr] = useState(null)
  const [imgChecking, setImgChecking] = useState(false)
  const [imgOver, setImgOver] = useState(false)
  const [progress, setProgress] = useState(0)   // 0..1 during Transform Image
  // G9: an ICC embedded in the dropped image, offered for extraction into the chain.
  const [embedded, setEmbedded] = useState(null)     // Uint8Array | null
  const [extracting, setExtracting] = useState(false)

  // Held dataset (parsed + summarised on drop; the transform runs on demand).
  const [dataParsed, setDataParsed] = useState(null)   // { name, format, headers, rows, … }
  const [dataSummary, setDataSummary] = useState(null) // summarizeDataset result
  const [dataErr, setDataErr] = useState(null)
  const [dataOver, setDataOver] = useState(false)
  const [result, setResult] = useState(null)           // DataResultModal payload | null

  // Persisted data-method controls.
  // Observer + illuminant are the two first-class spectral-conversion inputs
  // (illuminant defaults to D50 — the PCS reference white). Measurement CONDITION
  // (M0–M3) is intentionally NOT exposed: it is not a first-class input to the
  // CIccColorimetricCalculator (it only ever modified the illuminant, e.g. M1→D50),
  // so a control for it was more confusing than useful. The engine defaults to M0
  // (chosen illuminant, unmodified).
  const [observer, setObserver] = usePersisted('profiletool.dm.observer', 1)
  const [illuminant, setIlluminant] = usePersisted('profiletool.dm.illuminant', 1)   // 1 = D50
  const [prefer, setPrefer] = usePersisted('profiletool.dm.prefer', '')   // '' = auto (first available)
  const [filterDup, setFilterDup] = usePersisted('profiletool.dm.filterdup', false)
  const [dupMethod, setDupMethod] = usePersisted('profiletool.dm.dupmethod', 'median')

  // Persisted image output options (iccApplyProfiles destination knobs, G1-G5). Encoding
  // + compression + planar shape the saved TIFF; embed-ICC tags the output with the
  // chain's last profile; CMM interpolation is the global apply interpolation (also fed
  // to DeviceLink / Transform Data so the whole tab is consistent).
  const [outEncoding, setOutEncoding] = usePersisted('profiletool.img.enc', 'same')     // same|8|16|float
  // Default 'none' so the friendly PNG default holds for RGB/Gray; picking LZW/ZIP is an
  // opt-in to TIFF output (they're TIFF-only knobs, so they force the container).
  const [compression, setCompression] = usePersisted('profiletool.img.comp', 'none')    // none|lzw|zip
  const [planar, setPlanar] = usePersisted('profiletool.img.planar', 'contig')          // contig|separate
  const [embedIcc, setEmbedIcc] = usePersisted('profiletool.img.embed', true)
  const [interp, setInterp] = usePersisted('profiletool.img.interp', 'tetrahedral')     // tetrahedral|linear

  const stageEntries = useMemo(() => chain.map((id) => getEntry(id)), [chain, getEntry])
  const broken = stageEntries.some((e) => !e)

  // Per-stage extended-intent availability (G6). profileApplyCaps reports the tag/version
  // facts that gate the no-D2Bx / BPC flavours; base 0-3 are always offered. Recomputed
  // when the chain's profiles change (a swap/edit gives a fresh entry object).
  const [stageCaps, setStageCaps] = useState([])
  useEffect(() => {
    if (broken || chain.length === 0) { setStageCaps([]); return }
    let cancelled = false
    Promise.all(stageEntries.map((e) => e ? profileApplyCaps(e.currentBytes).catch(() => null) : null))
      .then((caps) => { if (!cancelled) setStageCaps(caps) })
    return () => { cancelled = true }
  }, [stageEntries, broken, chain.length])
  // Global RI listbox = base plus any flavour ANY chained profile supports.
  const globalIntentOptions = useMemo(() => {
    const out = RENDERING_INTENTS.slice()
    if (stageCaps.some((c) => c?.hasD2Bx)) out.push(...INTENT_NO_D2BX)
    if (stageCaps.some((c) => c?.hasLut)) out.push(...INTENT_BPC)
    return out
  }, [stageCaps])

  // AUTHORITATIVE chain validation (WASM CMM assembly). Gates outcomes; drives warnings.
  const [info, setInfo] = useState(null)
  const [checking, setChecking] = useState(false)
  const intentsKey = intents.join(',')   // stable dep for the intents array
  useEffect(() => {
    if (broken || chain.length === 0) { setInfo(null); setChecking(false); return }
    let cancelled = false
    setChecking(true)
    const bytes = stageEntries.map((e) => e.currentBytes)
    // Authoritative validation with the CHOSEN per-transform intents + head direction +
    // interpolation (so a linear-interp chain is gated/analysed as it will be applied).
    chainInfo(bytes, intents, headForward, interp)
      .then((r) => { if (!cancelled) { setInfo(r); setChecking(false) } })
      .catch(() => { if (!cancelled) { setInfo({ ok: false, error: 'Could not analyse the chain.' }); setChecking(false) } })
    return () => { cancelled = true }
  }, [stageEntries, broken, chain.length, intentsKey, headForward, interp])   // eslint-disable-line react-hooks/exhaustive-deps

  // Fast per-transform flow (labels + per-stage problems) from the header signatures.
  // The WASM `info` is the authoritative gate; `flow` drives the directional labels,
  // the RI-applicability per stage, and the red-outline problem markers.
  const flow = useMemo(() => computeChainFlow(stageEntries, headForward), [stageEntries, headForward])
  // A stage is problematic if the flow model flags it OR the WASM broke at it.
  const stageBad = (i) => flow.stages[i]?.problem || (info && info.ok === false && info.failedStage === i + 1)
  const hasProblem = flow.stages.some((s) => s.problem)

  // Global-intent listbox greys when the per-transform intents aren't all the global
  // value (i.e. at least one was changed individually).
  const intentsMixed = chain.length > 0 && !intents.every((x) => x === globalIntent)

  // Build/transform are gated on BOTH the authoritative WASM result and the fast flow
  // (so a detected problem refuses the operation even before the WASM round-trip lands).
  const canLink = !broken && !checking && info?.ok === true && !hasProblem

  // ── image ↔ chain-source LIVE validation ────────────────────────────────────
  const imgStatus = useMemo(
    () => imageStatus({ image, imageInfo, imgChecking, imageErr, info, checking }),
    [image, imageInfo, imgChecking, imageErr, info, checking],
  )
  const canTransform = !busy && imgStatus.ready && !hasProblem

  // ── data ↔ chain-source LIVE validation ─────────────────────────────────────
  const dataStatus = useMemo(
    () => dataMethodStatus({ dataParsed, dataSummary, dataErr, info, checking, prefer }),
    [dataParsed, dataSummary, dataErr, info, checking, prefer],
  )
  const canTransformData = !busy && dataStatus.ready && !hasProblem

  // Which colorimetry source a PCS-input chain will actually use (Prefer or first).
  const effPrefer = useMemo(() => {
    const srcs = dataSummary?.colorimetrySources || []
    if (!srcs.length) return null
    return srcs.includes(prefer) ? prefer : srcs[0]
  }, [dataSummary, prefer])
  const hasSpectral = !!dataSummary?.kinds?.some((k) => k.kind === 'spectral')

  // ── Invert Transform (iccApplySearch) ───────────────────────────────────────
  // The engine order (reversed when the user inverts the FIRST stage) + its intents.
  const engineChain = useMemo(() => (invertReverse ? [...chain].reverse() : chain), [chain, invertReverse])
  const engineIntents = useMemo(() => (invertReverse ? [...intents].reverse() : intents), [intents, invertReverse])
  const invPlan = useMemo(() => computeInvertPlan(stageEntries, invertReverse), [stageEntries, invertReverse])
  // Authoritative source-space/connectivity for the SEARCH: the forward chainInfo of the
  // engine-ordered chain, always in the natural device→PCS direction (firstInput=true) —
  // the search reads its input in that source space and produces the inverted stage's
  // device space, so forward chainInfo is the right, SAFE gate (searchInfo can trap on
  // pathological v5 profiles, so we never call it passively). Independent of the head
  // toggle, which only affects the forward DeviceLink/image/data paths.
  const [invInfo, setInvInfo] = useState(null)
  const [invChecking, setInvChecking] = useState(false)
  const engineIntentsKey = engineIntents.join(',')
  useEffect(() => {
    // SHOW_INVERT gates the WORK as well as the UI — no point loading the construct module
    // and validating an inversion for a feature that renders nowhere.
    if (!SHOW_INVERT || broken || chain.length < 2 || chain.length > 3) { setInvInfo(null); setInvChecking(false); return }
    let cancelled = false
    setInvChecking(true)
    const bytes = engineChain.map((id) => getEntry(id)?.currentBytes).filter(Boolean)
    chainInfo(bytes, engineIntents, true)
      .then((r) => { if (!cancelled) { setInvInfo(r); setInvChecking(false) } })
      .catch(() => { if (!cancelled) { setInvInfo({ ok: false, error: 'Could not analyse the inversion.' }); setInvChecking(false) } })
    return () => { cancelled = true }
  }, [engineChain, broken, chain.length, engineIntentsKey, getEntry])   // eslint-disable-line react-hooks/exhaustive-deps
  const invDataStatus = useMemo(
    () => dataMethodStatus({ dataParsed, dataSummary, dataErr, info: invInfo, checking: invChecking, prefer }),
    [dataParsed, dataSummary, dataErr, invInfo, invChecking, prefer],
  )
  const canInvert = !busy && invPlan.ok && invInfo?.ok === true && invDataStatus.ready

  // Accept an image: streaming probe (type + size + colour space), pixels NOT loaded.
  const acceptImage = useCallback(async (file) => {
    if (!file) return
    setImage(null); setImageInfo(null); setImageErr(null); setImgChecking(true); setEmbedded(null)
    setError(null); setNotice(null)
    let probe
    try { probe = await probeImageFromFile(file) }
    catch (e) { probe = { ok: false, error: e?.message || String(e) } }
    if (!probe.ok) {
      setImgChecking(false)
      setImageErr(probe.error || (t('pl_img_badtype') || 'Not a supported image (TIFF, PNG or JPEG).'))
      return
    }
    const px = (probe.width || 0) * (probe.height || 0)
    if (px > MAX_IMAGE_PIXELS) {
      setImgChecking(false)
      setImageErr(t('pl_img_toolarge', { mp: Math.round(px / 1e6), max: MAX_IMAGE_PIXELS / 1e6 })
        || `Image too large (${Math.round(px / 1e6)} MP; limit ${MAX_IMAGE_PIXELS / 1e6} MP).`)
      return
    }
    setImage(file); setImageInfo(probe); setImgChecking(false)
    // G9: metadata-only sniff for an embedded ICC (pixels still not loaded). If present,
    // offer to extract it into the chain — never auto-adds.
    if (onAddProfile) {
      try {
        const prof = await findEmbeddedProfileFromFile(file)
        if (prof && prof.length) setEmbedded(prof instanceof Uint8Array ? prof : new Uint8Array(prof))
      } catch { /* extraction is optional — ignore a probe failure */ }
    }
  }, [t, onAddProfile])

  const onImageDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setImgOver(false)
    const f = Array.from(e.dataTransfer.files || [])[0]
    if (f) acceptImage(f)
  }, [acceptImage])
  const clearImage = () => { setImage(null); setImageInfo(null); setImageErr(null); setImgChecking(false); setEmbedded(null) }

  // G9: extract the image's embedded ICC → new pool profile, placed at the head of the
  // chain (its source space) + accumulated on the Link tab.
  async function extractEmbedded() {
    if (!embedded || extracting || !onAddProfile) return
    setExtracting(true); setError(null); setNotice(null)
    try {
      const stem = (image?.name || 'image').replace(/\.[^.]+$/, '')
      const id = await onAddProfile(`${stem}-embedded.icc`, embedded)
      prependStage(id)
      onAccumulate?.([id])
      setEmbedded(null)
      setNotice(t('pl_extract_done') || 'Extracted the embedded profile — added to the pool and placed first in the chain.')
    } catch (e) { setError(e?.message || String(e)) } finally { setExtracting(false) }
  }

  // Accept a dataset: read text → parse → summarise. Held; transformed on demand.
  const acceptData = useCallback(async (file) => {
    if (!file) return
    setDataParsed(null); setDataSummary(null); setDataErr(null)
    setError(null); setNotice(null)
    // Cap by file.size BEFORE reading — decoding a huge file into a JS string first and
    // checking afterwards is exactly the OOM the guard exists to prevent (App.jsx's ICC
    // ingest already caps up front; this path had drifted from that pattern).
    if (file.size > MAX_DATA_CHARS) { setDataErr(t('pl_data_toolarge') || 'Data file too large.'); return }
    let text
    try { text = await file.text() }
    catch { setDataErr(t('pl_data_read') || 'Could not read that file.'); return }
    if (text.length > MAX_DATA_CHARS) { setDataErr(t('pl_data_toolarge') || 'Data file too large.'); return }
    try {
      const parsed = parseDataText(file.name, text)
      const summary = summarizeDataset(parsed)
      setDataParsed({ ...parsed, name: file.name })
      setDataSummary(summary)
    } catch (e) { setDataErr(e?.message || String(e)) }
  }, [t])

  const onDataDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setDataOver(false)
    const f = Array.from(e.dataTransfer.files || [])[0]
    if (f) acceptData(f)
  }, [acceptData])
  const clearData = () => { setDataParsed(null); setDataSummary(null); setDataErr(null) }

  // ── chain drop / reorder ────────────────────────────────────────────────────
  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    const raw = e.dataTransfer.getData(POOL_DND_MIME)
    if (!raw) return
    let ids; try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || !ids.length) return
    appendStages(ids)
    onAccumulate?.(ids)
    setError(null); setNotice(null); setNaming(false)
  }, [onAccumulate])   // eslint-disable-line react-hooks/exhaustive-deps
  const onDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes(POOL_DND_MIME)) { e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  }, [])
  const onDragLeave = useCallback((e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false) }, [])

  const move = (i, d) => swapStages(i, i + d)
  const removeAt = (i) => removeStage(i)
  const clearChain = () => { clearStages(); setNaming(false); setError(null); setNotice(null) }

  // ── drag-reorder a stage within the vertical chain ──────────────────────────
  const [dragIdx, setDragIdx] = useState(null)   // stage being dragged
  const [dropIdx, setDropIdx] = useState(null)   // stage the pointer is over
  const reorder = (from, to) => reorderStages(from, to)
  const onStageDragStart = (e, i) => {
    e.dataTransfer.setData(REORDER_MIME, String(i))
    e.dataTransfer.effectAllowed = 'move'
    setDragIdx(i)
  }
  const onStageDragOver = (e, i) => {
    if (!e.dataTransfer.types.includes(REORDER_MIME)) return   // let pool-profile drags bubble
    e.preventDefault(); e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    if (dropIdx !== i) setDropIdx(i)
  }
  const onStageDrop = (e, i) => {
    if (!e.dataTransfer.types.includes(REORDER_MIME)) return
    e.preventDefault(); e.stopPropagation()
    const from = parseInt(e.dataTransfer.getData(REORDER_MIME), 10)
    if (Number.isInteger(from)) reorder(from, i)
    setDragIdx(null); setDropIdx(null)
  }
  const onStageDragEnd = () => { setDragIdx(null); setDropIdx(null) }

  // ── outcome: Make DeviceLink ────────────────────────────────────────────────
  function beginNaming() {
    if (!canLink) return
    const base = (stageEntries[0]?.filename || 'link').replace(/\.(icc|icm)$/i, '')
    setName(`${base}-link`)
    setNaming(true); setError(null); setNotice(null)
    requestAnimationFrame(() => nameRef.current?.select())
  }
  async function buildLink() {
    const clean = name.trim()
    if (!clean || !canLink || busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await onBuildLink(chain.slice(), clean, { intents: intents.slice(), firstInput: headForward, interp })
      setNaming(false)
      setNotice(t('pl_link_made', { name: clean }) || `Created “${clean}” — added to the pool and this tab.`)
    } catch (e) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  // ── outcome: Transform Image ────────────────────────────────────────────────
  async function transformImage() {
    if (!canTransform || busy || !image) return
    // Output container mirrors lib/pipelineEngine.js applyToImage so we can name the file
    // up front: the friendly default is PNG for 1/3-channel 8/16-bit output, but the
    // TIFF-only knobs (float, LZW/ZIP, separated planes) — and 4+ channels — force TIFF.
    // The transform can take seconds and consume the user activation, so on Chromium we
    // open the Save dialog NOW (fresh gesture) and write to the handle after; other
    // browsers fall back to prompt-for-name + download post-transform.
    const nDst = info?.destSamples || 0
    const forceTiff = outEncoding === 'float' || planar === 'separate' ||
      (compression && compression !== 'none') || nDst === 2 || nDst >= 4
    const isPng = !forceTiff && (nDst === 1 || nDst === 3)
    const ext = isPng ? 'png' : 'tif'
    const mime = isPng ? 'image/png' : 'image/tiff'
    const stem = (image.name || 'image').replace(/\.[^.]+$/, '')
    const suggested = `${stem}-converted.${ext}`

    let handle = null
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: suggested,
          types: [{ description: `${ext.toUpperCase()} image`, accept: { [mime]: [`.${ext}`] } }],
        })
      } catch (e) {
        if (e && e.name === 'AbortError') return   // user cancelled the Save dialog — do nothing
        handle = null                              // other failure → fall back after the transform
      }
    }

    setBusy(true); setError(null); setNotice(null); setProgress(0)
    try {
      const results = await onApplyImages(chain.slice(), [image], {
        intents: intents.slice(), firstInput: headForward, interp,
        outEncoding, compression, planar, embedIcc,
        onProgress: setProgress,
      })
      const out = results && results[0]
      if (!out) throw new Error('No image was produced.')
      if (handle) {
        const writable = await handle.createWritable()
        await writable.write(out.bytes)
        await writable.close()
      } else {
        const { saveBinaryFile } = await import('../lib/dataExport.js')
        const saved = await saveBinaryFile(out.bytes, out.filename || suggested, mime)
        if (!saved) { setBusy(false); return }   // cancelled at the name prompt
      }
      // Say so when the transform clamped or produced non-finite values — otherwise a
      // degenerate profile or a heavily out-of-gamut absolute-colorimetric run just looks
      // like a clean conversion.
      let msg = t('pl_img_done') || 'Saved the transformed image.'
      const bad = (out.clipped || 0) + (out.nonFinite || 0)
      if (bad > 0 && out.totalSamples) {
        const pct = (bad * 100) / out.totalSamples
        msg += ' ' + (t('pl_img_clipped', { pct: pct.toFixed(pct < 1 ? 2 : 1) })
          || `${pct.toFixed(pct < 1 ? 2 : 1)}% of samples were out of range and were clamped.`)
      }
      setNotice(msg)
    } catch (err) { setError(err?.message || String(err)) } finally { setBusy(false); setProgress(0) }
  }

  // ── outcome: Transform Data (iccApplyNamedCmm equivalent) ───────────────────
  async function doTransformData() {
    if (!canTransformData || busy || !dataParsed || !info?.ok) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const chainBytes = stageEntries.map((e) => e.currentBytes)
      const need = { kind: spaceKind(info.sourceSpace), nSrc: info.sourceSamples }

      // Optional duplicate filtering (device rows only, aggregated median/mean).
      let workParsed = dataParsed
      const devCols = dataSummary.classification.device
      if (filterDup && dataSummary.duplicates.dupeRows > 0 && devCols.length) {
        workParsed = { ...dataParsed, rows: deduplicateRows(dataParsed.headers, dataParsed.rows, devCols, dupMethod) }
      }

      // Spectral→colorimetry (canonical iccDEV) when the PCS input prefers spectral.
      let spectralXYZRows = null
      if (need.kind !== 'device' && effPrefer === 'spectral') {
        const wcls = classifyColumns(workParsed.headers)
        const nm = wcls.spectral.map((s) => s.nm)
        const specKind = dataSummary.kinds.find((k) => k.kind === 'spectral')
        const scale = specKind?.encoding === 'percent' ? 0.01 : 1
        const specRows = workParsed.rows.map((row) => wcls.spectral.map((s) => (parseFloat(row[s.idx]) || 0) * scale))
        const { xyz } = await spectralToXYZ(specRows, {
          startNm: nm[0], endNm: nm[nm.length - 1], observer, illuminant,   // mCond defaults to M0 (no condition control)
        })
        spectralXYZRows = xyz
      }

      const input = buildTransformInput(workParsed, need, need.kind === 'device' ? null : effPrefer, spectralXYZRows)
      const dstKind = spaceKind(info.destSpace)
      const dstEncoding = dstKind === 'device' ? 'percent' : 'value'

      const res = await engineTransformData(chainBytes, input.samples, input.nSrc, {
        intents: intents.slice(), firstInput: headForward, srcEncoding: input.srcEncoding, dstEncoding, interp,
      })

      // Assemble the result table: source cols (fed) + dest cols (produced).
      const nDst = res.destSamples
      const dHeaders = destHeaders(res.dstSpace, nDst)
      const destCells = input.sourceCells.map((_, i) => {
        const row = []
        for (let c = 0; c < nDst; c++) row.push(res.values[i * nDst + c])
        return row
      })
      const nameIdx = classifyColumns(workParsed.headers).nameIdx
      const names = nameIdx >= 0 ? workParsed.rows.map((r) => r[nameIdx]) : null

      setResult({
        title: t('dm_transform_data') || 'Transform Data',
        srcSpace: res.srcSpace, dstSpace: res.dstSpace,
        srcEncoding: input.srcEncoding, dstEncoding,
        names, sourceHeaders: input.sourceHeaders, sourceCells: input.sourceCells,
        destHeaders: dHeaders, destCells, datasetName: dataParsed.name,
      })
    } catch (e) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  // ── outcome: Invert Transform (iccApplySearch equivalent) ───────────────────
  // Same dataset prep as Transform Data, but the LAST stage of the engine-ordered chain
  // is inverted via search (Nelder-Mead) instead of run forward. The dataset must be in
  // the search source space (invInfo.sourceSpace) — identical gating to Transform Data —
  // and the produced device values carry a per-row cost (invertibility/metamerism index).
  async function doInvertData() {
    if (!canInvert || busy || !dataParsed || !invInfo?.ok) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const chainBytes = engineChain.map((id) => getEntry(id).currentBytes)
      const need = { kind: spaceKind(invInfo.sourceSpace), nSrc: invInfo.sourceSamples }

      let workParsed = dataParsed
      const devCols = dataSummary.classification.device
      if (filterDup && dataSummary.duplicates.dupeRows > 0 && devCols.length) {
        workParsed = { ...dataParsed, rows: deduplicateRows(dataParsed.headers, dataParsed.rows, devCols, dupMethod) }
      }

      let spectralXYZRows = null
      if (need.kind !== 'device' && effPrefer === 'spectral') {
        const wcls = classifyColumns(workParsed.headers)
        const nm = wcls.spectral.map((s) => s.nm)
        const specKind = dataSummary.kinds.find((k) => k.kind === 'spectral')
        const scale = specKind?.encoding === 'percent' ? 0.01 : 1
        const specRows = workParsed.rows.map((row) => wcls.spectral.map((s) => (parseFloat(row[s.idx]) || 0) * scale))
        const { xyz } = await spectralToXYZ(specRows, { startNm: nm[0], endNm: nm[nm.length - 1], observer, illuminant })
        spectralXYZRows = xyz
      }

      const input = buildTransformInput(workParsed, need, need.kind === 'device' ? null : effPrefer, spectralXYZRows)
      // The inverted stage produces a device space → percent tints; the search seeds from
      // the inverted stage's forward intent (engineIntents' last), forward intents drive
      // the rest of the chain.
      const initIntent = engineIntents[engineIntents.length - 1] ?? globalIntent
      const res = await engineInvertData(chainBytes, input.samples, input.nSrc, {
        intents: engineIntents.slice(), initIntent, srcEncoding: input.srcEncoding, dstEncoding: 'percent', wantCost: true,
      })

      const nDst = res.destSamples
      const dHeaders = destHeaders(res.dstSpace, nDst)
      const destCells = input.sourceCells.map((_, i) => {
        const row = []
        for (let c = 0; c < nDst; c++) row.push(res.values[i * nDst + c])
        return row
      })
      const nameIdx = classifyColumns(workParsed.headers).nameIdx
      const names = nameIdx >= 0 ? workParsed.rows.map((r) => r[nameIdx]) : null
      const costs = res.cost ? Array.from(res.cost) : null

      setResult({
        title: t('dm_invert_data') || 'Invert Transform',
        srcSpace: res.srcSpace, dstSpace: res.dstSpace,
        srcEncoding: input.srcEncoding, dstEncoding: 'percent',
        names, sourceHeaders: input.sourceHeaders, sourceCells: input.sourceCells,
        destHeaders: dHeaders, destCells, datasetName: dataParsed.name,
        costs, costLabel: t('dm_cost') || 'ΔE cost',
      })
    } catch (e) { setError(e?.message || String(e)) } finally { setBusy(false) }
  }

  return (
    <section className={styles.card}>
      <header className={styles.head}>
        <h3 className={styles.title}>{t('pl_title') || 'Link Pipeline'}</h3>
        <p className={styles.sub}>{t('pl_sub') || 'Build a chain of profiles, then make a DeviceLink, transform an image, or transform a colour dataset through it.'}</p>
      </header>

      {/* ── top row: image slot + data slot (each drop-highlights on its own) ── */}
      <div className={styles.topRow}>
        {/* image slot */}
        <div
          className={`${styles.slot} ${image ? styles.slotFilled : ''} ${imgOver ? styles.slotOver : ''} ${imgStatus.warn ? styles.slotWarn : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setImgOver(true) } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setImgOver(false) }}
          onDrop={onImageDrop}
        >
          {!image ? (
            <button type="button" className={styles.slotOpen} onClick={() => imgInputRef.current?.click()}>
              <span className={styles.slotIcon} aria-hidden="true">🖼️</span>
              <span className={styles.slotText}>
                {imgChecking ? (t('pl_img_checking') || 'Checking image…')
                  : imageErr ? imageErr
                  : (t('pl_img_drop') || 'Drop an image to transform (TIFF/PNG/JPEG)')}
              </span>
            </button>
          ) : (
            <div className={styles.chip}>
              <span className={styles.slotIcon} aria-hidden="true">🖼️</span>
              <span className={styles.chipMeta} title={image.name}>
                <span className={styles.chipName}>{image.name}</span>
                <span className={styles.chipDims}>
                  {imageInfo ? `${imageInfo.width}×${imageInfo.height} · ${imgSpaceLabel(imageInfo)}` : ''}
                </span>
              </span>
              <button className={styles.chipX} type="button" onClick={clearImage}
                      title={t('accum_remove') || 'Remove'} aria-label={t('accum_remove') || 'Remove'}>×</button>
            </div>
          )}
          <input ref={imgInputRef} type="file" className={styles.hidden}
                 accept=".tif,.tiff,.png,.jpg,.jpeg,image/tiff,image/png,image/jpeg"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) acceptImage(f); e.target.value = '' }} />
        </div>

        {/* data slot */}
        <div
          className={`${styles.slot} ${dataParsed ? styles.slotFilled : ''} ${dataOver ? styles.slotOver : ''} ${dataStatus.warn ? styles.slotWarn : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setDataOver(true) } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDataOver(false) }}
          onDrop={onDataDrop}
        >
          {!dataParsed ? (
            <button type="button" className={styles.slotOpen} onClick={() => dataInputRef.current?.click()}>
              <span className={styles.slotIcon} aria-hidden="true">🔢</span>
              <span className={styles.slotText}>
                {dataErr ? dataErr : (t('pl_data_drop') || 'Drop a colour dataset (CGATS/CSV/CxF/JSON)')}
              </span>
            </button>
          ) : (
            <div className={styles.chip}>
              <span className={styles.slotIcon} aria-hidden="true">🔢</span>
              <span className={styles.chipMeta} title={dataParsed.name}>
                <span className={styles.chipName}>{dataParsed.name}</span>
                <span className={styles.chipDims}>{datasetChipText(dataSummary)}</span>
              </span>
              <button className={styles.chipX} type="button" onClick={clearData}
                      title={t('accum_remove') || 'Remove'} aria-label={t('accum_remove') || 'Remove'}>×</button>
            </div>
          )}
          <input ref={dataInputRef} type="file" className={styles.hidden}
                 accept=".txt,.csv,.cgats,.it8,.cxf,.xml,.json,text/plain,text/csv,application/json"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) acceptData(f); e.target.value = '' }} />
        </div>
      </div>
      {(imgStatus.msg || dataStatus.msg) && (
        <div className={styles.hintRow}>
          {imgStatus.msg && <p className={imgStatus.blocked ? styles.warn : styles.hint}>{imgStatus.msg}</p>}
          {dataStatus.msg && <p className={dataStatus.blocked ? styles.warn : styles.hint}>{dataStatus.msg}</p>}
        </div>
      )}

      {/* G9: the dropped image carries an embedded ICC — offer to extract it into the
          chain (its source space). Never auto-adds; the user decides. */}
      {embedded && image && (
        <div className={styles.extractBar}>
          <span className={styles.extractText}>
            {t('pl_extract_prompt') || 'This image has an embedded ICC profile.'}
          </span>
          <button className={styles.extractBtn} type="button" disabled={extracting} onClick={extractEmbedded}>
            {extracting ? (t('pl_extracting') || 'Extracting…') : (t('pl_extract_btn') || 'Extract & add to chain')}
          </button>
          <button className={styles.extractSkip} type="button" onClick={() => setEmbedded(null)}
                  aria-label={t('pl_extract_skip') || 'Dismiss'}>×</button>
        </div>
      )}

      {/* ── ACTIVE AREA: the profile-drop target (card minus the two sub-boxes). Only
             this region highlights when a profile is dragged in — never the whole
             Combine canvas. Holds the dataset controls, the vertical chain, the
             chain summary, and the action buttons. ──────────────────────────────── */}
      <div className={`${styles.activeZone} ${dragOver ? styles.activeZoneDrag : ''}`}
           onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>

        {/* dataset properties + controls (design decision #5 summary + controls) */}
        {dataParsed && dataSummary && (
          <div className={styles.dataControls}>
            <p className={styles.dataSummary}>{datasetSummaryText(dataSummary, t)}</p>
            <div className={styles.ctlRow}>
              {(dataSummary.colorimetrySources.length > 1) && (
                <label className={styles.ctl}>
                  {t('dm_prefer') || 'Prefer'}
                  <select value={effPrefer || ''} onChange={(e) => setPrefer(e.target.value)}>
                    {dataSummary.colorimetrySources.map((s) => (
                      <option key={s} value={s}>{PREFER_LABELS[s] || s}</option>
                    ))}
                  </select>
                </label>
              )}
              {hasSpectral && (
                <>
                  <label className={styles.ctl}>
                    {t('dm_observer') || 'Observer'}
                    <select value={observer} onChange={(e) => setObserver(Number(e.target.value))}>
                      {OBSERVERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </label>
                  <label className={styles.ctl}>
                    {t('dm_illuminant') || 'Illuminant'}
                    <select value={illuminant} onChange={(e) => setIlluminant(Number(e.target.value))}>
                      {ILLUMINANTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                  </label>
                </>
              )}
              {dataSummary.duplicates.dupeRows > 0 && (
                <label className={styles.ctlCheck}>
                  <input type="checkbox" checked={filterDup} onChange={(e) => setFilterDup(e.target.checked)} />
                  {t('dm_filter_dup', { n: dataSummary.duplicates.dupeRows }) || `Filter ${dataSummary.duplicates.dupeRows} duplicate(s)`}
                  {filterDup && (
                    <select value={dupMethod} onChange={(e) => setDupMethod(e.target.value)}>
                      <option value="median">{t('dm_median') || 'median'}</option>
                      <option value="mean">{t('dm_mean') || 'mean'}</option>
                    </select>
                  )}
                </label>
              )}
            </div>
          </div>
        )}

        {/* the ordered chain — a VERTICAL stack: source at the top, sink at the bottom.
            Each profile contributes ONE transform whose direction (input→output) is
            shown and whose rendering intent is chosen per transform. The head's
            direction can be flipped (⇅), rippling through the rest. The first stage is
            offset left and the last offset right to mark the flow's entry/exit; drag a
            stage's grip (or use ▲/▼) to reorder. */}
        {chain.length === 0 ? (
          <div className={styles.dropHint}>{t('pl_drop_hint') || 'Drop profiles to start the chain'}</div>
        ) : (
          <>
            {/* global rendering intent — sets ALL transforms; greys when any differ */}
            <div className={styles.chainCtls}>
              <label className={`${styles.ctl} ${intentsMixed ? styles.ctlMixed : ''}`}
                     title={intentsMixed ? (t('pl_ri_mixed') || 'Transforms use different intents') : ''}>
                {t('pl_global_ri') || 'Rendering intent (all)'}
                <select value={globalIntent} onChange={(e) => setGlobalIntent(Number(e.target.value))}
                        title={intentDescription(globalIntent)}>
                  {withCurrent(globalIntentOptions, globalIntent).map((o) =>
                    <option key={o.id} value={o.id} title={intentDescription(o.id)}>{o.label}</option>)}
                </select>
              </label>
            </div>
            <ol className={styles.chain}>
              {chain.map((id, i) => {
                const entry = stageEntries[i]
                const fs = flow.stages[i] || {}
                const first = i === 0
                const last = i === chain.length - 1
                // Position class: head LEFT, tail RIGHT, middles CENTRE (first wins for a single item).
                const posClass = first ? styles.stageFirst : last ? styles.stageLast : styles.stageMiddle
                const bad = stageBad(i)
                const conn = !last ? fs.outSpace : null   // connecting space (this transform's output)
                return (
                  <li key={`${id}:${i}`} className={styles.stageItem}>
                    <div
                      className={`${styles.stage} ${entry ? '' : styles.stageBroken} ${bad ? styles.stageProblem : ''} ${posClass} ${dragIdx === i ? styles.stageDragging : ''} ${dropIdx === i && dragIdx !== i ? styles.stageDropTarget : ''}`}
                      title={entry?.filename || t('pl_removed') || 'removed from pool'}
                      onDragOver={(e) => onStageDragOver(e, i)}
                      onDrop={(e) => onStageDrop(e, i)}
                    >
                      <span className={styles.stageGrip} aria-hidden="true"
                            draggable onDragStart={(e) => onStageDragStart(e, i)} onDragEnd={onStageDragEnd}>⠿</span>
                      <span className={styles.stageNum}>{i + 1}</span>
                      <span className={styles.stageBody}>
                        <span className={styles.stageName}>{entry?.filename || t('pl_removed') || 'removed'}</span>
                      </span>
                      {/* the transform this profile performs + its rendering intent,
                          kept side by side (the RI applies to this in→out transform) */}
                      {!fs.unknown && (
                        <span className={styles.stageTransform}>
                          <span className={styles.stageSpace}>
                            {fs.inSpace}<span aria-hidden="true"> → </span>{fs.outSpace}
                          </span>
                          {fs.canIntent && (
                            <select className={styles.stageRi} value={intents[i] ?? globalIntent}
                                    title={`${t('pl_stage_ri') || 'Rendering intent for this transform'}\n\n${intentDescription(intents[i] ?? globalIntent)}`}
                                    onChange={(e) => setIntentAt(i, Number(e.target.value))}>
                              {withCurrent(intentOptionsFor(stageCaps[i]), intents[i] ?? globalIntent)
                                .map((o) => <option key={o.id} value={o.id} title={`${o.label}\n\n${intentDescription(o.id)}`}>{o.short}</option>)}
                            </select>
                          )}
                        </span>
                      )}
                      <span className={styles.stageCtl}>
                        {first && (
                          <button className={styles.headDir} type="button" onClick={toggleHeadDir}
                                  title={t('pl_flip_dir') || 'Flip chain direction (reverses the head transform, rippling through the chain)'}
                                  aria-label={t('pl_flip_dir') || 'Flip chain direction'}>⇅</button>
                        )}
                        <button className={styles.mini} type="button" disabled={first}
                                onClick={() => move(i, -1)} title={t('pl_move_up') || 'Move up'} aria-label={t('pl_move_up') || 'Move up'}>▲</button>
                        <button className={styles.mini} type="button" disabled={last}
                                onClick={() => move(i, +1)} title={t('pl_move_down') || 'Move down'} aria-label={t('pl_move_down') || 'Move down'}>▼</button>
                        <button className={styles.miniX} type="button"
                                onClick={() => removeAt(i)} title={t('accum_remove') || 'Remove'} aria-label={t('accum_remove') || 'Remove'}>×</button>
                      </span>
                    </div>
                    {!last && (
                      <div className={styles.connector} aria-hidden="true">
                        <span className={styles.connLine} />
                        {conn && conn !== '?' && <span className={styles.connSpace}>{conn}</span>}
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          </>
        )}

        {/* chain summary / validation */}
        {chain.length > 0 && (
          <div className={styles.summary}>
            {broken ? (
              <span className={styles.warn}>{t('pl_broken') || 'A chained profile was removed from the pool — remove it to continue.'}</span>
            ) : checking ? (
              <span className={styles.checking}>{t('pl_checking') || 'Checking chain…'}</span>
            ) : info?.ok ? (
              <span className={styles.flow}>
                {t('pl_flow') || 'Chain'}: <b>{spaceLabel(info.sourceSpace)}</b> <span aria-hidden="true">→</span> <b>{spaceLabel(info.destSpace)}</b>
              </span>
            ) : (
              <span className={styles.warn}>{chainError(info, t)}</span>
            )}
            <button className={styles.clear} type="button" onClick={clearChain}>{t('pl_clear') || 'Clear'}</button>
          </div>
        )}
      </div>

      {/* Outcome buttons live OUTSIDE the drop-highlight active area — a profile drag
          never lights them up, and dropping on a button never lands in the chain. */}
      {!naming ? (
        <>
        <div className={styles.actions}>
          <button className="btn-primary" type="button" disabled={!canLink} onClick={beginNaming}>
            {t('pl_make_link') || 'Make DeviceLink'}
          </button>
          <button className="btn-primary" type="button" disabled={!canTransform} onClick={transformImage}>
            {busy && image
              ? `${t('pl_transforming') || 'Transforming…'}${progress > 0 ? ` ${Math.round(progress * 100)}%` : ''}`
              : (t('pl_transform') || 'Transform Image')}
          </button>
          <button className="btn-primary" type="button" disabled={!canTransformData} onClick={doTransformData}>
            {busy && dataParsed ? (t('dm_transforming') || 'Transforming…') : (t('dm_transform_data') || 'Transform Data')}
          </button>
          {/* Invert Transform (iccApplySearch): the last (engine-ordered) stage is inverted
              via search. Hidden for now behind SHOW_INVERT (see the flag near the top) —
              the search path awaits worker isolation. */}
          {SHOW_INVERT && (
            <div className={styles.invertGroup}>
              <button className="btn-primary" type="button" disabled={!canInvert} onClick={doInvertData}
                      title={invPlan.ok
                        ? (t('dm_invert_hint', { in: invPlan.dataSpace, out: invPlan.outSpace })
                          || `Data in ${invPlan.dataSpace} → search ${invPlan.outSpace}`)
                        : (t('dm_invert_need') || 'Invert needs a 2–3 profile chain')}>
                {busy && dataParsed ? (t('dm_inverting') || 'Inverting…') : (t('dm_invert_data') || 'Invert Transform')}
              </button>
              {chain.length >= 2 && chain.length <= 3 && (
                <label className={styles.invertDir}>
                  <span>{t('dm_invert_which') || 'Invert'}</span>
                  <select value={invertReverse ? '1' : '0'} onChange={(e) => setInvertReverse(e.target.value === '1')}
                          aria-label={t('dm_invert_which') || 'Which stage to invert'}>
                    <option value="0">{t('dm_invert_last') || 'last stage'}{invPlan.ok ? ` → ${invPlan.outSpace}` : ''}</option>
                    <option value="1">{t('dm_invert_first') || 'first stage'}</option>
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
        {/* Image output options (iccApplyProfiles destination knobs, G1-G5). Shown only
            with a valid image loaded, sitting directly under the Transform Image button. */}
        {image && imageInfo?.ok && (
          <div className={styles.imgOptions}>
            <span className={styles.imgOptTitle}>{t('img_out_title') || 'Image output options'}</span>
            <div className={styles.imgOptRow}>
              <label className={styles.ctl}>
                {t('img_out_enc') || 'Encoding'}
                <select value={outEncoding} onChange={(e) => setOutEncoding(e.target.value)}>
                  <option value="same">{t('img_enc_same') || 'Same as source'}</option>
                  <option value="8">{t('img_enc_8') || '8-bit'}</option>
                  <option value="16">{t('img_enc_16') || '16-bit'}</option>
                  <option value="float">{t('img_enc_float') || 'Float (32-bit)'}</option>
                </select>
              </label>
              <label className={styles.ctl}>
                {t('img_out_comp') || 'Compression'}
                <select value={compression} onChange={(e) => setCompression(e.target.value)}>
                  <option value="none">{t('img_comp_none') || 'None'}</option>
                  <option value="lzw">LZW</option>
                  <option value="zip">ZIP</option>
                </select>
              </label>
              <label className={styles.ctl}>
                {t('img_out_planar') || 'Planar'}
                <select value={planar} onChange={(e) => setPlanar(e.target.value)}>
                  <option value="contig">{t('img_planar_contig') || 'Composite'}</option>
                  <option value="separate">{t('img_planar_sep') || 'Separated'}</option>
                </select>
              </label>
              <label className={styles.ctl}>
                {t('img_out_interp') || 'CMM interpolation'}
                <select value={interp} onChange={(e) => setInterp(e.target.value)}>
                  <option value="tetrahedral">{t('img_interp_tetra') || 'Tetrahedral'}</option>
                  <option value="linear">{t('img_interp_linear') || 'Linear'}</option>
                </select>
              </label>
              <label className={styles.ctlCheck}>
                <input type="checkbox" checked={embedIcc} onChange={(e) => setEmbedIcc(e.target.checked)} />
                {t('img_out_embed') || 'Embed ICC'}
              </label>
            </div>
            <p className={styles.imgOptHint}>
              {t('img_out_hint') || 'Encoding, compression and planar shape the saved TIFF. RGB/Gray output stays PNG unless a TIFF-only option (float, LZW/ZIP, separated) is set.'}
            </p>
          </div>
        )}
        {SHOW_INVERT && chain.length >= 2 && chain.length <= 3 && invPlan.ok && (
          <p className={styles.invertNote}>
            {t('dm_invert_note', { in: invPlan.dataSpace, out: invPlan.outSpace })
              || `Inverting “${invPlan.invertedName}” — the dataset must be ${invPlan.dataSpace}; produces ${invPlan.outSpace} with a per-patch invertibility cost.`}
          </p>
        )}
        </>
      ) : (
        <div className={styles.nameRow}>
          <input ref={nameRef} className={styles.nameInput} value={name}
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') buildLink(); if (e.key === 'Escape') setNaming(false) }}
                 placeholder={t('pl_name_ph') || 'DeviceLink name'} aria-label={t('pl_name_ph') || 'DeviceLink name'} />
          <button className="btn-primary" type="button" disabled={busy || !name.trim()} onClick={buildLink}>
            {busy ? (t('pl_making') || 'Making…') : (t('v4_create') || 'Create')}
          </button>
          <button className={styles.cancel} type="button" disabled={busy} onClick={() => setNaming(false)}>
            {t('cancel') || 'Cancel'}
          </button>
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}

      <DataResultModal open={!!result} result={result} onClose={() => setResult(null)} />
    </section>
  )
}

// Photometric + channel count → a short colour-space label for the held image.
function imgSpaceLabel(info) {
  if (!info) return '?'
  const ch = info.channels
  switch (info.photometric) {
    case 2: return 'RGB'
    case 5: return ch === 4 ? 'CMYK' : `${ch}-channel`
    case 8: return 'Lab'
    case 0: case 1: return ch === 1 ? 'Gray' : `${ch}-channel`
    default: return `${ch}-channel`
  }
}
function imgKind(info) {
  switch (info?.photometric) {
    case 2: return 'RGB'
    case 5: return info.channels === 4 ? 'CMYK' : 'CLR'
    case 8: return 'Lab'
    case 0: case 1: return info.channels === 1 ? 'GRAY' : 'CLR'
    default: return 'CLR'
  }
}
function chainKind(sig) {
  const s = (sig || '').trim()
  if (s === 'RGB') return 'RGB'
  if (s === 'CMYK') return 'CMYK'
  if (s === 'GRAY') return 'GRAY'
  if (s === 'Lab') return 'LAB'
  if (s === 'XYZ') return 'XYZ'
  return /CLR/.test(s) ? 'CLR' : s
}

// Live image↔chain status. `ready` gates Transform (channel-count match + valid chain).
function imageStatus({ image, imageInfo, imgChecking, imageErr, info, checking }) {
  if (imgChecking) return { ready: false, msg: null }
  if (imageErr) return { ready: false, blocked: true, msg: null }
  if (!image || !imageInfo?.ok) return { ready: false, msg: null }
  if (checking) return { ready: false, msg: null }
  if (!info?.ok) return { ready: false, msg: null }
  const need = info.sourceSamples, have = imageInfo.channels
  const iLabel = imgSpaceLabel(imageInfo)
  const cLabel = spaceLabel(info.sourceSpace)
  if (need !== have) {
    return { ready: false, blocked: true,
      msg: `Image: ${iLabel} (${have}ch) doesn’t fit the ${cLabel} chain input (${need}ch).` }
  }
  const iKind = imgKind(imageInfo), cKind = chainKind(info.sourceSpace)
  if (iKind !== cKind && iKind !== 'CLR' && cKind !== 'CLR') {
    return { ready: true, warn: true,
      msg: `Image looks ${iLabel} but the chain starts in ${cLabel} — result may be wrong.` }
  }
  return { ready: true, msg: `Image ${iLabel} → ${spaceLabel(info.destSpace)}.` }
}

// Live dataset↔chain status. `ready` gates Transform Data: the dataset must be able to
// supply the chain's HEAD input space (device channels, or colorimetry for a PCS input).
function dataMethodStatus({ dataParsed, dataSummary, dataErr, info, checking, prefer }) {
  if (dataErr) return { ready: false, blocked: true, msg: null } // shown in the slot
  if (!dataParsed || !dataSummary) return { ready: false, msg: null }
  if (checking) return { ready: false, msg: null }
  if (!info?.ok) return { ready: false, msg: null }
  const kind = spaceKind(info.sourceSpace)
  const cLabel = spaceLabel(info.sourceSpace)
  const dLabel = spaceLabel(info.destSpace)
  if (kind === 'device') {
    const dev = dataSummary.kinds.find((k) => k.kind === 'device')
    if (!dev) return { ready: false, blocked: true, msg: `Chain needs ${cLabel} device data — this dataset has none.` }
    if (dev.channels.length !== info.sourceSamples) {
      return { ready: false, blocked: true,
        msg: `Dataset has ${dev.channels.length} device channel(s); the chain needs ${info.sourceSamples} (${cLabel}).` }
    }
    return { ready: true, msg: `Data ${dev.channels.length}-ch → ${dLabel}.` }
  }
  // PCS input — need a colorimetry source.
  const srcs = dataSummary.colorimetrySources
  if (!srcs.length) return { ready: false, blocked: true, msg: `Chain needs ${cLabel} colorimetry — this dataset has no Lab/XYZ/spectral.` }
  if (info.sourceSamples !== 3) return { ready: false, blocked: true, msg: `Chain input ${cLabel} is not a 3-channel PCS.` }
  const use = srcs.includes(prefer) ? prefer : srcs[0]
  return { ready: true, msg: `Data ${PREFER_LABELS[use] || use} → ${dLabel}.` }
}

// Compact chip text under a dataset filename: patch count + kinds.
function datasetChipText(summary) {
  if (!summary) return ''
  const kinds = summary.kinds.map((k) => k.kind === 'device' ? `${k.channels.length}ch`
    : k.kind === 'spectral' ? 'spec' : k.kind).join('+')
  return `${summary.patchCount} · ${summary.format.toUpperCase()} · ${kinds}`
}

// Full dataset-properties line (design decision #5).
function datasetSummaryText(summary, t) {
  const parts = []
  parts.push(summary.cxfVariant || summary.format.toUpperCase())
  parts.push(`${summary.patchCount} ${t('dm_patches') || 'patches'}`)
  for (const k of summary.kinds) parts.push(`${k.label} (${k.encoding})`)
  if (summary.duplicates.dupeRows > 0) {
    const de = summary.duplicates.de
    parts.push((t('dm_dupes', { n: summary.duplicates.dupeRows }) || `${summary.duplicates.dupeRows} duplicates`)
      + (de ? ` · ΔE≈${de.mean.toFixed(2)}` : ''))
  }
  return parts.join(' · ')
}

// Explanatory text for an invalid chain, from the authoritative chainInfo result.
function chainError(info, t) {
  if (!info) return t('pl_unknown') || 'The chain could not be analysed.'
  const detail = info.error || ''
  const stage = info.failedStage
  if (stage && stage > 0) {
    return t('pl_no_connect_stage', { n: stage, detail })
      || `Profile ${stage} does not connect to the previous stage${detail ? ` (${detail})` : ''}.`
  }
  return t('pl_no_connect', { detail })
    || `The chain does not connect${detail ? ` (${detail})` : ''}.`
}
