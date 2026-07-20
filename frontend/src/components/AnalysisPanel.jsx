// (c) 2026 William Li
import { useEffect, useState } from 'react'
import {
  enumerateVisualizations, renderGraph, tagEvalInfo, gamutVolume, roundTripStats,
  whiteBlackPoints, hueExtrema, shadowInkPaths,
} from '../lib/vizPlot.js'
import { channelColor } from './viz/colors.js'
import { labToRgb } from '../lib/rasterDecode.js'
import Collapsible from './viz/Collapsible.jsx'
import PlotlyGraph from './viz/PlotlyGraph.jsx'
import RtHistogram from './viz/RtHistogram.jsx'
import RasterView from './viz/RasterView.jsx'
import { useT } from '../i18n.jsx'
import styles from './AnalysisPanel.module.css'

// ── CLUT / Gamut image tables ────────────────────────────────────────────────
// The CLUT lattice images (per LUT table) and the gamut in/out map used to live
// inline in each tag's detail; they now have their own Analysis sections, each
// with a rendering-intent selector. IccVizModel Kind::ClutImage (in sync with
// IccVizModel.hpp) marks a raster; the gamut tag ('gamt') is the special gamut map.
const KIND_CLUT = 5
// LUT tag signature → rendering intent (both device→PCS AToB and PCS→device BToA
// tables, plus preview). The signature itself disambiguates direction in the label.
const LUT_INTENT = {
  A2B0: 'perceptual', A2B1: 'relative', A2B2: 'saturation', A2B3: 'absolute',
  B2A0: 'perceptual', B2A1: 'relative', B2A2: 'saturation', B2A3: 'absolute',
  pre0: 'perceptual', pre1: 'relative', pre2: 'saturation',
}
// Display order for the intent selector; unknown sigs sort last (stable).
const LUT_ORDER = ['A2B0', 'A2B1', 'A2B2', 'A2B3', 'B2A0', 'B2A1', 'B2A2', 'B2A3', 'pre0', 'pre1', 'pre2']
const lutRank = (sig) => { const i = LUT_ORDER.indexOf(sig); return i < 0 ? 99 : i }

// Whole-profile analyses. Each analysis is a receiver for data produced by the
// iccviz IccVizModel and plotted in the app's own style.

// ─────────────────────────────────────────────────────────────────────────────
// Neutral Axis Inking
//
// Sweeps the neutral axis (a*=b*=0) from white (L*=100) to black (L*=0) through a
// chosen B2A table (PCS→device) and plots how much of each device colorant the
// profile lays down — the classic GCR / neutral-build curve. Output profiles only.
// ─────────────────────────────────────────────────────────────────────────────
const KIND_NEUTRAL = 8           // IccVizModel Kind::NeutralAxisInking (in sync with IccVizModel.hpp)
// B2A tag → rendering-intent i18n key (the selector offers whichever B2A tables exist).
const B2A_INTENTS = { B2A0: 'perceptual', B2A1: 'relative', B2A2: 'saturation' }
const NEUTRAL_MIN_TRACE_L = 55   // floor L* of a colorant trace so dark/spot inks stay visible
const KNOWN_SPACES = new Set(['CMYK', 'RGB', 'GRAY'])
// The two round-trip curves iccviz adds to the neutral graph are NOT colorants, so
// they stay out of the channel palette: a neutral grey for the tone response and a
// warm accent for the neutrality error, both legible on the light and dark
// backgrounds, each dashed so it reads as a reference curve over the ink separation.
// The second curve is Δa*b* (lightness excluded) — see buildNeutralAxisGraph for why.
const TONE_SERIES_ID = 'tone'
const DE_SERIES_ID = 'neutrality'
// The Δa*b* neutrality trace is computed by the engine but WITHDRAWN from the plot
// pending further review of what it should measure (task #96). Flip to true to bring
// it back — PlotlyGraph only raises the secondary axis when a series actually uses it,
// so dropping the series also drops the axis, with no other change needed.
const SHOW_NEUTRALITY = false
const TONE_COLOR = '#8a8f98'
const DE_COLOR = '#e08a3c'

// Trace colour for a neutral-inking curve: the canonical channel colour for the
// well-known device spaces; for nCLR, the colorant's OWN appearance — its Lab (of
// 100% ink, computed by iccViz via A2B1 and carried in series.colorHint) mapped to
// sRGB, with L* floored so dark/spot inks (e.g. black, violet) read against the
// background instead of vanishing.
function neutralTraceColor(spaceSig, series, idx, count) {
  if (!KNOWN_SPACES.has((spaceSig || '').trim()) && series.colorHint) {
    const lab = series.colorHint.split(',').map(Number)
    if (lab.length === 3 && lab.every(Number.isFinite)) {
      const [r, g, b] = labToRgb(Math.max(lab[0], NEUTRAL_MIN_TRACE_L), lab[1], lab[2])
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  return channelColor(spaceSig, idx, count)
}

// ── Profile Statistics ────────────────────────────────────────────────────────
// Whole-profile metrics for ONE selected rendering intent: the gamut volume
// (device→PCS) and a chosen round-trip accuracy metric. Both the rendering intent
// AND the round-trip *type* are picked from listboxes; the table, histogram and
// description all update on selection (design doc DL-A1, refined 2026-07-18 to two
// listboxes + P90 + a below-table histogram + a dynamic type description).
//
// Per the project principle, the iccRoundTrip CLI's console layout is NOT the
// authority — all four types are presented in one uniform in-app table (min / mean
// / P90 / max + a cumulative ≤1/2/3/5/10 histogram + worst-error colour), even
// though the CLI prints different fields for each. The metrics are grounded in the
// underlying colour math; the presentation is ours.

// Rendering intents, in ICC order. `tag` is the device→PCS (AToB) table whose
// gamut volume we measure for that intent (absolute reuses the relative table).
const STATS_INTENTS = [
  { intent: 0, tag: 'A2B0', key: 'intent_perceptual', fallback: 'Perceptual' },
  { intent: 1, tag: 'A2B1', key: 'intent_relative',   fallback: 'Relative Colorimetric' },
  { intent: 2, tag: 'A2B2', key: 'intent_saturation', fallback: 'Saturation' },
  { intent: 3, tag: 'A2B1', key: 'intent_absolute',   fallback: 'Absolute Colorimetric' },
]

// The four round-trip types behind the type listbox. `desc*` is a short,
// code-grounded explanation shown beside the selector; it updates with the
// selection. `usesMpe` marks the types the use-MPE toggle actually affects — RT0's
// iccviz engine ignores it, so the checkbox is a no-op there.
const RT_TYPES = [
  {
    key: 'RT0', usesMpe: false,
    labelKey: 'analysis_rt_type_rt0', labelFallback: 'In-gamut overview (RT0)',
    descKey: 'analysis_rt_desc_rt0',
    descFallback: 'iccviz overview: a device-value grid is taken to PCS, back to device, and to PCS again; ΔE*ab is measured between the two PCS passes. A fast in-gamut stability check.',
  },
  {
    key: 'RT1', usesMpe: true,
    labelKey: 'analysis_rt_type_rt1', labelFallback: 'Inversion + gamut (RT1)',
    descKey: 'analysis_rt_desc_rt1',
    descFallback: 'iccRoundTrip Round Trip 1: ΔE*ab between each device colour’s PCS and its PCS after one Lab → device → Lab round trip. Reflects inversion accuracy and gamut mapping.',
  },
  {
    key: 'RT2', usesMpe: true,
    labelKey: 'analysis_rt_type_rt2', labelFallback: 'Reproducibility (RT2)',
    descKey: 'analysis_rt_desc_rt2',
    descFallback: 'iccRoundTrip Round Trip 2: ΔE*ab between the first and second round trips — how stable a repeated PCS round trip is (reproducibility, independent of the first trip’s gamut clipping).',
  },
  {
    key: 'PRMG', usesMpe: true,
    labelKey: 'analysis_rt_type_prmg', labelFallback: 'PRMG interoperability',
    descKey: 'analysis_rt_desc_prmg',
    descFallback: 'iccRoundTrip PRMG: PCS colours inside the Perceptual Reference Medium Gamut are round-tripped once (Lab → device → Lab); the ΔE*ab distribution indicates cross-profile interoperability.',
  },
]

// Gamut volume depends only on the intent; round-trip stats on (intent, use-MPE).
// Cache each separately so toggling use-MPE doesn't recompute the (expensive)
// gamut boundary, and so re-opening the tab / re-selecting is instant.
const gamutCache = new WeakMap()    // bytes -> Map<intent, {volume,degenerate}|{error}>
const rtStatsCache = new WeakMap()  // bytes -> Map<`${intent}:${useMpe}`, {data}|{error}>

function ProfileStatsSection({ bytes, t }) {
  const [intent, setIntent] = useState(1)   // relative colorimetric (iccRoundTrip default)
  const [type, setType] = useState('RT0')   // in-gamut overview — the cheapest, most familiar
  const [useMpe, setUseMpe] = useState(false)
  const [gamut, setGamut] = useState({ loading: true })
  const [rts, setRts] = useState({ loading: true })

  // Gamut volume — depends only on the intent.
  useEffect(() => {
    let cancelled = false
    let byIntent = gamutCache.get(bytes)
    if (byIntent && byIntent.has(intent)) { setGamut({ loading: false, ...byIntent.get(intent) }); return }
    setGamut({ loading: true })
    const info = STATS_INTENTS.find((s) => s.intent === intent) || STATS_INTENTS[1]
    ;(async () => {
      let result
      try {
        const g = await gamutVolume(bytes, info.tag, intent)
        // iccviz flags a collapsed/unreliable gamut boundary; carry that forward.
        result = { volume: g.volume, degenerate: !!g.degenerate }
      } catch (e) { result = { error: e.message } }   // AToB tag absent, etc.
      if (!byIntent) { byIntent = new Map(); gamutCache.set(bytes, byIntent) }
      byIntent.set(intent, result)
      if (!cancelled) setGamut({ loading: false, ...result })
    })()
    return () => { cancelled = true }
  }, [bytes, intent])

  // Round-trip stats — one WASM call returns ALL four types for (intent, useMpe),
  // so switching the *type* selector never recomputes (it just re-reads the cache).
  useEffect(() => {
    let cancelled = false
    const cacheKey = `${intent}:${useMpe}`
    let byKey = rtStatsCache.get(bytes)
    if (byKey && byKey.has(cacheKey)) { setRts({ loading: false, ...byKey.get(cacheKey) }); return }
    setRts({ loading: true })
    ;(async () => {
      let result
      try { result = { data: await roundTripStats(bytes, intent, useMpe) } }
      catch (e) { result = { error: e.message } }
      if (!byKey) { byKey = new Map(); rtStatsCache.set(bytes, byKey) }
      byKey.set(cacheKey, result)
      if (!cancelled) setRts({ loading: false, ...result })
    })()
    return () => { cancelled = true }
  }, [bytes, intent, useMpe])

  const typeMeta = RT_TYPES.find((x) => x.key === type) || RT_TYPES[0]

  return (
    <Collapsible title={t('analysis_stats_heading') || 'Profile Statistics'}>
      <p className={styles.sectionIntro}>
        {t('analysis_stats_intro2') ||
          'Whole-profile metrics for one rendering intent: the gamut volume enclosed by the device→PCS transform (ΔE*ab³), and a round-trip accuracy metric. Choose the rendering intent and the round-trip type — the table and histogram update to match.'}
      </p>

      <div className={styles.controls}>
        <label className={styles.control}>
          <span>{t('analysis_intent_label') || 'Rendering intent'}</span>
          <select value={intent} onChange={(e) => setIntent(Number(e.target.value))}>
            {STATS_INTENTS.map((s) => (
              <option key={s.intent} value={s.intent}>{t(s.key) || s.fallback}</option>
            ))}
          </select>
        </label>
        <label className={styles.control}>
          <span>{t('analysis_rt_type_label') || 'Round-trip type'}</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {RT_TYPES.map((x) => (
              <option key={x.key} value={x.key}>{t(x.labelKey) || x.labelFallback}</option>
            ))}
          </select>
        </label>
        <label className={`${styles.control} ${styles.controlInline}`}
               title={typeMeta.usesMpe ? '' : (t('analysis_rt_mpe_na') || 'Has no effect on this round-trip type')}>
          <input type="checkbox" checked={useMpe} disabled={!typeMeta.usesMpe}
                 onChange={(e) => setUseMpe(e.target.checked)} />
          <span>{t('analysis_rt_usempe') || 'Use MPE (color) tags'}</span>
        </label>
      </div>

      {/* Dynamic, code-grounded description of the selected round-trip type. */}
      <p className={styles.typeDesc}>{t(typeMeta.descKey) || typeMeta.descFallback}</p>

      <StatsTable gamut={gamut} rts={rts} type={type} t={t} />
    </Collapsible>
  )
}

// Renders the gamut + round-trip stats table, the cumulative ΔE histogram, and the
// per-type extras (worst-Lab, and the PRMG "specified gamut" line). Every value
// crosses the WASM→JS boundary, so each field is shape-guarded before formatting —
// a partial or malformed result degrades to '—' or a note, never a render-time
// TypeError that would blank the whole Analysis tab.
function StatsTable({ gamut, rts, type, t }) {
  if (gamut.loading || rts.loading) {
    return <div className={styles.loading}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
  }

  // A top-level round-trip failure (module load / JSON parse) means the whole
  // metric is unavailable — distinct from a per-type "not applicable" below.
  if (rts.error) {
    return <div className={styles.notApplicable}>{t('analysis_rt_na') ||
      'This profile cannot be round-tripped — it lacks the device↔PCS transforms this metric needs (e.g. a one-way or abstract profile).'}</div>
  }

  // Shape guards: every number is validated before use; '—' for anything missing.
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const fmt2 = (v) => { const n = num(v); return n == null ? '—' : n.toFixed(2) }
  const fmtVol = (v) => { const n = num(v); return n == null ? '—' : Math.round(n).toLocaleString() }
  const fmtLab = (lab) =>
    (Array.isArray(lab) && lab.length === 3 && lab.every((v) => typeof v === 'number' && Number.isFinite(v)))
      ? lab.map((v) => v.toFixed(2)).join(', ') : null

  const st = rts.data && rts.data.types ? rts.data.types[type] : null

  // Per-type not-computed states. `st.ok === false` is a genuine "this type can't
  // be evaluated for this profile" (not a hard error) — including the #1405
  // wide-device-space skip, surfaced as its own gentler note.
  if (!st) {
    return <div className={styles.notApplicable}>{t('analysis_rt_na') ||
      'This profile cannot be round-tripped — it lacks the device↔PCS transforms this metric needs.'}</div>
  }
  if (st.ok === false) {
    // When BOTH the gamut volume and this round trip are unavailable, the profile
    // simply has no device↔PCS CLUTs to analyse (e.g. a matrix/TRC display profile).
    if (gamut.error && st.status !== 'tooManySamples') {
      return <div className={styles.notApplicable}>{t('analysis_stats_na') ||
        'No device↔PCS CLUTs in this profile — profile statistics do not apply (e.g. a matrix/TRC display profile).'}</div>
    }
    if (st.status === 'tooManySamples') {
      return <div className={styles.notApplicable}>{t('analysis_rt_toomany') ||
        'Round trip skipped: the device colour space is too wide to evaluate (too many samples).'}</div>
    }
    return <div className={styles.notApplicable}>
      {(t('analysis_rt_type_na') || 'This round-trip type is not available for this profile.')}
      {st.message ? ` (${st.message})` : ''}
    </div>
  }

  const degenerateMsg = t('stats_gamut_degenerate') ||
    'The gamut boundary collapsed or was mostly undefined, so this gamut volume is unreliable.'

  // Distribution: `hist` is the WASM's integer-ΔE bin counts (bin i = [i, i+1));
  // the RtHistogram turns it into relative + cumulative frequencies. `total` is the
  // sample count (guarded so an empty distribution shows a note instead of a plot).
  const total = num(st.total) || 0
  const hist = Array.isArray(st.hist) ? st.hist : []

  const worst = fmtLab(st.worstLab)

  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.statNum}>{t('stats_gamut_volume') || 'Gamut volume (ΔE³)'}</th>
            <th className={styles.statNumC}>{t('analysis_rt_min') || 'Min ΔE'}</th>
            <th className={styles.statNumC}>{t('stats_mean') || 'Mean ΔE'}</th>
            <th className={styles.statNumC}>{t('stats_std') || 'Std Dev'}</th>
            <th className={styles.statNumC}>{t('stats_p90') || 'P90 ΔE'}</th>
            <th className={styles.statNumC}>{t('stats_max') || 'Max ΔE'}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={styles.statNum}>
              {gamut.error ? '—' : fmtVol(gamut.volume)}
              {!gamut.error && gamut.degenerate &&
                <span className={styles.warnMark} title={degenerateMsg} aria-label={degenerateMsg}> ⚠</span>}
            </td>
            <td className={styles.statNumC}>{fmt2(st.min)}</td>
            <td className={styles.statNumC}>{fmt2(st.mean)}</td>
            <td className={styles.statNumC}>{fmt2(st.std)}</td>
            <td className={styles.statNumC}>{fmt2(st.p90)}</td>
            <td className={styles.statNumC}>{fmt2(st.max)}</td>
          </tr>
        </tbody>
      </table>

      {/* PRMG only: the "Specified Gamut" declaration (from the rendering-intent-
          gamut tag; only meaningful for perceptual/saturation intents). */}
      {type === 'PRMG' && (
        <p className={styles.rtGamut}>
          <strong>{t('analysis_rt_gamut') || 'Specified gamut'}:</strong>{' '}
          {st.implied ? (t('analysis_rt_gamut_prmg') || 'Perceptual Reference Medium Gamut')
                      : (t('analysis_rt_gamut_none') || 'Not specified')}
        </p>
      )}

      {/* ΔE distribution: relative-frequency bars + cumulative-frequency line
          (chardata's Comparison-Statistics histogram), drawn from the WASM's
          integer-ΔE bin counts. `total` gated so an empty distribution shows a note. */}
      <p className={styles.rtGamut}>
        <strong>{t('analysis_rt_hist_heading') || 'Round-trip ΔE distribution'}</strong>
        {' '}<span className={styles.histCount}>({t('analysis_rt_total') || 'Total'}: {total.toLocaleString()})</span>
      </p>
      {total > 0 && Array.isArray(hist) && hist.length ? (
        <RtHistogram hist={hist} histBinW={num(st.histBinW) || 0.1} total={total} />
      ) : (
        <div className={styles.notApplicable}>
          {t('analysis_rt_hist_empty') || 'No round-trip samples fell inside the evaluated region.'}
        </div>
      )}

      {/* Worst-error colour: the device/PCS colour where this round trip fails hardest. */}
      {worst && (
        <p className={styles.rtGamut}>
          <strong>{t('analysis_rt_worstlab') || 'Worst L, a, b'}:</strong> {worst}
        </p>
      )}
    </>
  )
}

function NeutralSection({ bytes, profileClass, tables, t }) {
  // Output (printer) profiles only — others get a localized error.
  const isOutput = String(profileClass || '').toLowerCase().includes('output')
  return (
    <Collapsible title={t('analysis_neutral_heading') || 'Neutral Axis Inking'}>
      <p className={styles.sectionIntro}>
        {t('analysis_neutral_intro') ||
          'Device colorant laid down along the neutral axis (a*=b*=0) as lightness goes from white (L*=100) to black (L*=0).'}
      </p>
      {!isOutput ? (
        <div className={styles.itemError}>
          {t('analysis_neutral_err_output') || 'Neutral axis inking is only available for output (printer) profiles.'}
        </div>
      ) : !tables.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_neutral_na') || 'This profile has no B2A (PCS→device) table to sample.'}
        </div>
      ) : (
        <NeutralBody bytes={bytes} tables={tables} t={t} />
      )}
    </Collapsible>
  )
}

function NeutralBody({ bytes, tables, t }) {
  const [sel, setSel] = useState(() => (tables.find((x) => x.sig === 'B2A1') || tables[0]).sig)
  const table = tables.find((x) => x.sig === sel) || tables[0]
  return (
    <>
      {tables.length > 1 && (
        <div className={styles.controls}>
          <label className={styles.control}>
            <span>{t('analysis_intent_label') || 'Rendering intent'}</span>
            <select value={sel} onChange={(e) => setSel(e.target.value)}>
              {tables.map((x) => <option key={x.sig} value={x.sig}>{(t('intent_' + x.intent) || x.intent)} ({x.sig})</option>)}
            </select>
          </label>
        </div>
      )}
      <NeutralPlot key={table.sig} bytes={bytes} table={table} t={t} />
    </>
  )
}

// Plot the iccViz-computed neutral-inking graph. The data analysis (sampling the
// B2A table along the neutral axis) lives in IccVizModel; here we only colour the
// curves, localize the axis label, and draw — legend BELOW so curves are never hidden.
function NeutralPlot({ bytes, table, t }) {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let cancelled = false
    setState({ loading: true })
    Promise.all([
      renderGraph(bytes, table.id),
      tagEvalInfo(bytes, table.sig).catch(() => null),   // device space → per-channel colours
    ]).then(
      ([graph, info]) => {
        if (cancelled) return
        if (!SHOW_NEUTRALITY) graph.series = graph.series.filter((s) => s.id !== DE_SERIES_ID)
        const sig = info?.dstSpaceSig || ''
        // Colour ONLY the colorant traces from the channel palette, and index them
        // among themselves — the tone/ΔE curves would otherwise consume palette slots
        // and shift every ink's colour.
        const inks = graph.series.filter((s) => s.id !== TONE_SERIES_ID && s.id !== DE_SERIES_ID)
        inks.forEach((s, i) => { s.color = neutralTraceColor(sig, s, i, inks.length) })
        for (const s of graph.series) {
          if (s.id === TONE_SERIES_ID) {
            s.color = TONE_COLOR; s.dash = 'dashdot'
            s.name = t('analysis_neutral_tone') || 'L* out (tone)'
          } else if (s.id === DE_SERIES_ID) {
            s.color = DE_COLOR; s.dash = 'dot'
            s.name = t('analysis_neutral_de') || 'Δa*b*'
          }
        }
        graph.yAxis = { ...graph.yAxis, label: t('analysis_neutral_yaxis') || '% ink' }
        // iccviz emits an ASCII "da*b*" fallback; localize it here (the engine never
        // carries display strings).
        if (graph.hasY2) graph.y2Axis = { ...graph.y2Axis, label: t('analysis_neutral_de') || 'Δa*b*' }
        setState({ loading: false, graph })
      },
      (e) => { if (!cancelled) setState({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, table.id])
  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>
  // Neutral inking is a multi-line plot — rendered with the shared Plotly stack
  // (drag-resize bar via ResizablePlot, native legend toggles), replacing GraphSvg.
  return <PlotlyGraph graph={state.graph} legend storageKey="profiletool.neutralHeight" defaultH={360} />
}

// ── CLUT Image / Gamut Image ──────────────────────────────────────────────────
// Each shows one raster (a CLUT lattice image, or the gamut in/out map) chosen by
// a rendering-intent selector, via the shared RasterView (native-pixel canvas with
// zoom / pan / reset / corner-resize).

// Human label for a LUT table in the intent selector, e.g. "Relative Colorimetric
// — A2B1". Unknown signatures show the raw sig.
function lutLabel(sig, t) {
  const intent = LUT_INTENT[sig]
  if (!intent) return sig
  return `${t('intent_' + intent) || intent} — ${sig}`
}

// Default to the relative-colorimetric device→PCS table when present.
function defaultTableId(tables) {
  const pref = tables.find((x) => x.sig === 'A2B1') || tables[0]
  return pref ? pref.id : undefined
}

function RasterSelect({ bytes, tables, gamut, t }) {
  // Select by descriptor id (unique) so duplicate sigs, if any, never collide.
  const [selId, setSelId] = useState(() => defaultTableId(tables))
  const table = tables.find((x) => x.id === selId) || tables[0]
  return (
    <>
      {tables.length > 1 && (
        <div className={styles.controls}>
          <label className={styles.control}>
            <span>{t('analysis_intent_label') || 'Rendering intent'}</span>
            <select value={table.id} onChange={(e) => setSelId(e.target.value)}>
              {tables.map((x) => <option key={x.id} value={x.id}>{lutLabel(x.sig, t)}</option>)}
            </select>
          </label>
        </div>
      )}
      {/* key on id so switching tables remounts the raster loader/canvas cleanly. */}
      <RasterView key={table.id} bytes={bytes} id={table.id} gamut={gamut} />
    </>
  )
}

function ClutImageSection({ bytes, tables, t }) {
  return (
    <Collapsible title={t('analysis_clut_heading') || 'CLUT Image'}>
      <p className={styles.sectionIntro}>
        {t('analysis_clut_intro') ||
          'The colour lookup table (CLUT) of a device↔PCS transform, tiled into an image. Pick which rendering-intent table to view.'}
      </p>
      {!tables.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_clut_na') || 'This profile has no CLUT-based device↔PCS tables to visualize.'}
        </div>
      ) : (
        <RasterSelect bytes={bytes} tables={tables} gamut={false} t={t} />
      )}
    </Collapsible>
  )
}

function GamutImageSection({ bytes, tables, t }) {
  return (
    <Collapsible title={t('analysis_gamut_heading') || 'Gamut Image'}>
      <p className={styles.sectionIntro}>
        {t('analysis_gamut_intro') ||
          'The gamut tag’s in/out-of-gamut map: neutral where a PCS colour is reproducible, red where it falls outside the device gamut.'}
      </p>
      {!tables.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_gamut_na') || 'This profile has no gamut tag to visualize.'}
        </div>
      ) : (
        <RasterSelect bytes={bytes} tables={tables} gamut t={t} />
      )}
    </Collapsible>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Extrema Colorimetry  (media white / black point + TAC, and per-hue extrema)
//
// Two related readouts about the ENDS of what a profile can print:
//   • White / black point in relative AND absolute colorimetry, the inking the
//     profile chooses for black, and the resulting total area coverage. Black is
//     tag-driven — each B2A table picks its own black inking — so this follows the
//     rendering-intent selector.
//   • Per-hue full-tone vs maximum-chroma colorimetry, measured through A2B1 and
//     therefore intent-INDEPENDENT (labelled as such so the selector above it isn't
//     misread as applying).
// ─────────────────────────────────────────────────────────────────────────────

// t() returns the KEY itself when a string is missing (see i18n.jsx), and a key is
// truthy — so the `t(k) || 'fallback'` idiom used throughout this file never actually
// falls back; it relies on the key existing. That is fine for literal keys, which are
// checked against the dictionary, but not for a key built at runtime: an unrecognised
// name would render as "hue_cyan". Compare against the key so those degrade to the
// engine's own English name instead.
function tOr(t, key, fallback) {
  const s = t(key)
  return s === key ? fallback : s
}

const fmt2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—')

// Render a 3-vector as THREE separate cells, so each component sits under its own
// header. `ok` false (e.g. no absolute colorimetry) emits three em dashes rather than
// one merged cell, keeping the column grid intact.
function triadCells(v, ok, keyPrefix) {
  const fin = ok && Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
  return [0, 1, 2].map((i) => (
    <td key={keyPrefix + i} className={`${styles.statNum} ${i === 0 ? styles.groupStart : ''}`}>
      {fin ? v[i].toFixed(2) : '—'}
    </td>
  ))
}

function ExtremaBody({ bytes, tables, t }) {
  const [sel, setSel] = useState(() => (tables.find((x) => x.sig === 'B2A1') || tables[0]).sig)
  const [wb, setWb] = useState({ loading: true })
  const [hx, setHx] = useState({ loading: true })

  // White/black depends on the selected B2A table…
  useEffect(() => {
    let cancelled = false
    setWb({ loading: true })
    whiteBlackPoints(bytes, sel).then(
      (r) => { if (!cancelled) setWb({ loading: false, data: r }) },
      (e) => { if (!cancelled) setWb({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
  }, [bytes, sel])

  // …the per-hue extrema do not: A2B1 only, so fetch once per profile.
  useEffect(() => {
    let cancelled = false
    setHx({ loading: true })
    hueExtrema(bytes).then(
      (r) => { if (!cancelled) setHx({ loading: false, data: r }) },
      (e) => { if (!cancelled) setHx({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
  }, [bytes])

  const w = wb.data
  return (
    <>
      {tables.length > 1 && (
        <div className={styles.controls}>
          <label className={styles.control}>
            <span>{t('analysis_intent_label') || 'Rendering intent'}</span>
            <select value={sel} onChange={(e) => setSel(e.target.value)}>
              {tables.map((x) => (
                <option key={x.sig} value={x.sig}>{(t('intent_' + x.intent) || x.intent)} ({x.sig})</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <p className={styles.typeDesc}>
        {t('analysis_extrema_method') ||
          'White point is the colour of zero colorant — bare substrate. Black point is found by pushing PCS black (L*=0, a*=b*=0) through the selected B2A table to get the inking the profile chooses for black, then reading that inking back through A2B1. Total area coverage (TAC) is the sum of that inking. Absolute colorimetry shows the substrate’s own colour; relative re-references it to a perfect white.'}
      </p>

      {wb.loading ? (
        <div className={styles.loading}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
      ) : wb.error ? (
        <div className={styles.notApplicable}>{wb.error}</div>
      ) : (
        <>
          {/* Two-row header: a colorimetry group spanning three axis columns, so each
              of L*, a* and b* is a real column its value can align under. */}
          <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th rowSpan={2} />
                <th colSpan={3} className={`${styles.groupHead} ${styles.groupStart}`}>
                  {t('analysis_extrema_rel') || 'Relative'}
                </th>
                <th colSpan={3} className={`${styles.groupHead} ${styles.groupStart}`}>
                  {t('analysis_extrema_abs') || 'Absolute'}
                </th>
              </tr>
              <tr>
                <th className={`${styles.statNum} ${styles.groupStart}`}>L*</th>
                <th className={styles.statNum}>a*</th>
                <th className={styles.statNum}>b*</th>
                <th className={`${styles.statNum} ${styles.groupStart}`}>L*</th>
                <th className={styles.statNum}>a*</th>
                <th className={styles.statNum}>b*</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{t('analysis_extrema_white') || 'White point'}</th>
                {triadCells(w.whiteLabRel, true, 'wr')}
                {triadCells(w.whiteLabAbs, w.hasAbsolute, 'wa')}
              </tr>
              <tr>
                <th scope="row">{t('analysis_extrema_black') || 'Black point'}</th>
                {triadCells(w.blackLabRel, true, 'br')}
                {triadCells(w.blackLabAbs, w.hasAbsolute, 'ba')}
              </tr>
            </tbody>
          </table>
          </div>

          <p className={styles.rtGamut}>
            <strong>{t('analysis_extrema_blackink') || 'Inking at black point'}:</strong>{' '}
            {w.blackInk.map((v) => (v * 100).toFixed(1) + '%').join('  ')}
            {'  |  '}
            <strong>{t('analysis_extrema_tac') || 'TAC'}:</strong> {(w.tac * 100).toFixed(1)}%
          </p>
          {!w.hasAbsolute && (
            <div className={styles.notApplicable}>
              {t('analysis_extrema_noabs') ||
                'This profile has no media white point tag, so absolute colorimetry is unavailable.'}
            </div>
          )}
        </>
      )}

      <h4 className={styles.heading}>{t('analysis_extrema_hue_heading') || 'Full tone vs maximum chroma'}</h4>
      <p className={styles.sectionIntro}>
        {t('analysis_extrema_hue_intro') ||
          'Where each ink corner lands, and the most chromatic point on the way there. Measured through A2B1, so these rows do not change with the rendering intent above. On a well-behaved profile the two rows match; if maximum chroma arrives before full tone, the extra ink past that point is only darkening.'}
      </p>
      {hx.loading ? (
        <div className={styles.loading}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
      ) : hx.error ? (
        <div className={styles.notApplicable}>{hx.error}</div>
      ) : (
        <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th rowSpan={2}>{t('analysis_extrema_hue') || 'Hue'}</th>
              <th colSpan={3} className={`${styles.groupHead} ${styles.groupStart}`}>
                {t('analysis_extrema_fulltone') || 'Full tone'}
              </th>
              <th colSpan={3} className={`${styles.groupHead} ${styles.groupStart}`}>
                {t('analysis_extrema_maxc') || 'Max C*'}
              </th>
              <th rowSpan={2} className={`${styles.statNum} ${styles.groupStart}`}>
                {t('analysis_extrema_at') || 'At ink'}
              </th>
            </tr>
            <tr>
              <th className={`${styles.statNum} ${styles.groupStart}`}>h°</th>
              <th className={styles.statNum}>C*</th>
              <th className={styles.statNum}>L*</th>
              <th className={`${styles.statNum} ${styles.groupStart}`}>h°</th>
              <th className={styles.statNum}>C*</th>
              <th className={styles.statNum}>L*</th>
            </tr>
          </thead>
          <tbody>
            {hx.data.entries.map((e) => {
              // Flag the diagnostic case: maximum chroma reached before full tone.
              const early = e.rampFraction < 0.999
              return (
                <tr key={e.name}>
                  <th scope="row">{tOr(t, 'hue_' + e.name.toLowerCase(), e.name)}</th>
                  {e.fullToneHCL.map((v, i) => (
                    <td key={'f' + i} className={`${styles.statNum} ${i === 0 ? styles.groupStart : ''}`}>
                      {fmt2(v)}
                    </td>
                  ))}
                  {e.maxChromaHCL.map((v, i) => (
                    <td key={'m' + i} className={`${styles.statNum} ${i === 0 ? styles.groupStart : ''}`}>
                      {fmt2(v)}
                      {/* Flag on C*, the column the warning is actually about. */}
                      {early && i === 1 && (
                        <span className={styles.warnMark}
                              title={t('analysis_extrema_early') ||
                                'Maximum chroma is reached before full tone — ink past this point only darkens.'}>
                          {' '}⚠
                        </span>
                      )}
                    </td>
                  ))}
                  <td className={`${styles.statNum} ${styles.groupStart}`}>
                    {(e.rampFraction * 100).toFixed(0)}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
    </>
  )
}

function ExtremaSection({ bytes, profileClass, tables, t }) {
  const isOutput = (profileClass || '').toLowerCase().includes('output')
  return (
    <Collapsible title={t('analysis_extrema_heading') || 'Extrema Colorimetry'}>
      <p className={styles.sectionIntro}>
        {t('analysis_extrema_intro') ||
          'The ends of the profile’s reproduction range: substrate white, the darkest black it will print, the ink that black costs, and where each hue reaches its most saturated point.'}
      </p>
      {!isOutput ? (
        <div className={styles.itemError}>
          {t('analysis_extrema_err_output') ||
            'Extrema colorimetry is only available for output (printer) profiles — it assumes zero colorant means bare substrate.'}
        </div>
      ) : !tables.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_neutral_na') || 'This profile has no B2A (PCS→device) table to sample.'}
        </div>
      ) : (
        <ExtremaBody bytes={bytes} tables={tables} t={t} />
      )}
    </Collapsible>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Ink Usage in Shadows
//
// Four straight sweeps across the a*b* plane at one constant, deliberately dark
// L*, pushed through a chosen B2A table. Because every sample shares an L*, any
// step or reversal in a colorant is attributable to hue/chroma handling alone —
// which is exactly where shadow gamut-mapping artefacts show up.
// ─────────────────────────────────────────────────────────────────────────────
function ShadowBody({ bytes, tables, t }) {
  const [sel, setSel] = useState(() => (tables.find((x) => x.sig === 'B2A1') || tables[0]).sig)
  const [state, setState] = useState({ loading: true })

  // Style the four graphs ONCE, here, rather than during render: PlotlyGraph keys its
  // effect on the graph object's identity, so rebuilding them on every render would
  // re-run Plotly.react each time the component re-renders (a theme toggle, a parent
  // update). Mirrors how NeutralPlot prepares its graph.
  useEffect(() => {
    let cancelled = false
    setState({ loading: true })
    Promise.all([
      shadowInkPaths(bytes, sel),
      tagEvalInfo(bytes, sel).catch(() => null),   // device space → per-channel colours
    ]).then(
      ([r, ti]) => {
        if (cancelled) return
        const sig = ti?.dstSpaceSig || ''
        const graphs = r.graphs.map((g) => {
          g.series.forEach((s, k) => { s.color = neutralTraceColor(sig, s, k, g.series.length) })
          g.yAxis = { ...g.yAxis, label: t('analysis_neutral_yaxis') || '% ink' }
          g.xAxis = { ...g.xAxis, label: t('analysis_shadow_xaxis') || 'Position along path' }
          return g
        })
        setState({ loading: false, data: { ...r, graphs } })
      },
      (e) => { if (!cancelled) setState({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, sel])

  return (
    <>
      {tables.length > 1 && (
        <div className={styles.controls}>
          <label className={styles.control}>
            <span>{t('analysis_intent_label') || 'Rendering intent'}</span>
            <select value={sel} onChange={(e) => setSel(e.target.value)}>
              {tables.map((x) => (
                <option key={x.sig} value={x.sig}>{(t('intent_' + x.intent) || x.intent)} ({x.sig})</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {state.loading ? (
        <div className={styles.loading}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
      ) : state.error ? (
        <div className={styles.notApplicable}>{state.error}</div>
      ) : (
        <>
          <p className={styles.rtGamut}>
            <strong>{t('analysis_shadow_plane') || 'Constant L* plane'}:</strong> {fmt2(state.data.lStar)}
            {state.data.bpcApplied && (
              <>
                {'  '}
                <span className={styles.histCount}>
                  ({t('analysis_shadow_bpc') || 'black-point compensated from'} {fmt2(state.data.lStarRaw)})
                </span>
              </>
            )}
          </p>
          {state.data.graphs.map((g, i) => (
            <div key={g.title}>
              <h4 className={styles.heading}>
                {(t('analysis_shadow_path') || 'Path')} {g.title.replace(' deg', '°')}
              </h4>
              {/* Legend on the first plot only — all four share the same colorants,
                  so repeating it four times would just cost vertical space. */}
              <PlotlyGraph graph={g} legend={i === 0}
                           storageKey="profiletool.shadowHeight" defaultH={220} />
            </div>
          ))}
        </>
      )}
    </>
  )
}

function ShadowSection({ bytes, profileClass, tables, t }) {
  const isOutput = (profileClass || '').toLowerCase().includes('output')
  return (
    <Collapsible title={t('analysis_shadow_heading') || 'Ink Usage in Shadows'}>
      <p className={styles.sectionIntro}>
        {t('analysis_shadow_intro') ||
          'Four straight paths across the a*b* plane at one constant, deliberately dark lightness, run through the selected B2A table. Every sample shares the same L*, so any abrupt step or reversal in a colorant comes from hue and chroma handling alone — the signature of a shadow gamut-mapping artefact.'}
      </p>
      {!isOutput ? (
        <div className={styles.itemError}>
          {t('analysis_shadow_err_output') || 'Ink usage in shadows is only available for output (printer) profiles.'}
        </div>
      ) : !tables.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_neutral_na') || 'This profile has no B2A (PCS→device) table to sample.'}
        </div>
      ) : (
        <ShadowBody bytes={bytes} tables={tables} t={t} />
      )}
    </Collapsible>
  )
}

export default function AnalysisPanel({ bytes, profileClass }) {
  const t = useT()
  const [status, setStatus] = useState('loading')   // loading | ready | error
  const [error, setError] = useState(null)
  const [neutralTags, setNeutralTags] = useState([]) // [{ sig, id, intent }] (neutral B2A graphs)
  const [clutTables, setClutTables] = useState([])   // [{ sig, id }] CLUT lattice images
  const [gamutTables, setGamutTables] = useState([]) // [{ sig, id }] gamut in/out maps

  // One enumerate per profile feeds the neutral-axis graphs (per B2A table) and the
  // CLUT / gamut image sections.
  useEffect(() => {
    let cancelled = false
    setStatus('loading'); setError(null)
    setNeutralTags([]); setClutTables([]); setGamutTables([])
    enumerateVisualizations(bytes)
      .then((list) => {
        if (cancelled) return
        const neutral = [], clut = [], gamut = []
        for (const d of list) {
          const sig = d.tagSig || (d.id.split(':')[1] || '')
          if (d.kind === KIND_NEUTRAL) {
            neutral.push({ sig, id: d.id, intent: B2A_INTENTS[sig] || sig })
          } else if (d.kind === KIND_CLUT) {
            // The gamut tag's raster is the gamut map; every other LUT tag's is a CLUT.
            (sig === 'gamt' ? gamut : clut).push({ sig, id: d.id })
          }
        }
        clut.sort((a, b) => lutRank(a.sig) - lutRank(b.sig))
        setNeutralTags(neutral); setClutTables(clut); setGamutTables(gamut)
        setStatus('ready')
      })
      .catch((e) => { if (!cancelled) { setError(e.message); setStatus('error') } })
    return () => { cancelled = true }
  }, [bytes])

  if (status === 'loading') {
    return <div className={styles.status}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
  }
  if (status === 'error') {
    return <div className={styles.errorBanner}><strong>{t('error_label')}</strong> {error}</div>
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.panelTitle}>{t('analysis_title') || 'Analysis'}</h2>
      <p className={styles.intro}>{t('analysis_intro') || 'Profile-wide quality analyses derived from the device→PCS transform.'}</p>
      {/* Every section starts collapsed: each one costs a WASM analysis pass, so
          opening is the user's explicit choice rather than four transforms firing
          the moment the tab is shown. */}
      <ProfileStatsSection bytes={bytes} t={t} />
      <ExtremaSection bytes={bytes} profileClass={profileClass} tables={neutralTags} t={t} />
      <NeutralSection bytes={bytes} profileClass={profileClass} tables={neutralTags} t={t} />
      <ShadowSection bytes={bytes} profileClass={profileClass} tables={neutralTags} t={t} />
      <ClutImageSection bytes={bytes} tables={clutTables} t={t} />
      <GamutImageSection bytes={bytes} tables={gamutTables} t={t} />
    </div>
  )
}
