// (c) 2026 William Li
import { useEffect, useState } from 'react'
import { enumerateVisualizations, renderGraph, tagEvalInfo, gamutVolume, roundTripDE } from '../lib/vizPlot.js'
import { channelColor } from './viz/colors.js'
import { labToRgb } from '../lib/rasterDecode.js'
import Collapsible from './viz/Collapsible.jsx'
import GraphSvg from './viz/GraphSvg.jsx'
import { useT } from '../i18n.jsx'
import styles from './AnalysisPanel.module.css'

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
// Whole-profile metrics per rendering intent: gamut volume (device→PCS) and B2A
// round-trip accuracy. Computed lazily (8 WASM calls, ~1-2s) and cached per
// profile so re-opening the section / tab is instant. Intents whose tags are
// absent are skipped (the engine returns an error we swallow).
const STATS_INTENTS = [
  { intent: 0, tag: 'A2B0', key: 'intent_perceptual', fallback: 'Perceptual' },
  { intent: 1, tag: 'A2B1', key: 'intent_relative',   fallback: 'Relative Colorimetric' },
  { intent: 2, tag: 'A2B2', key: 'intent_saturation', fallback: 'Saturation' },
  { intent: 3, tag: 'A2B1', key: 'intent_absolute',   fallback: 'Absolute Colorimetric' },
]
const statsCache = new WeakMap()   // bytes -> rows[]

function ProfileStatsSection({ bytes, t }) {
  const [state, setState] = useState(() => {
    const cached = statsCache.get(bytes)
    return cached ? { loading: false, rows: cached } : { loading: true, rows: [] }
  })

  useEffect(() => {
    const cached = statsCache.get(bytes)
    if (cached) { setState({ loading: false, rows: cached }); return }
    let cancelled = false
    setState({ loading: true, rows: [] })
    ;(async () => {
      const rows = []
      for (const it of STATS_INTENTS) {
        let vol = null, degenerate = false, rt = null
        try {
          const g = await gamutVolume(bytes, it.tag, it.intent)
          vol = g.volume; degenerate = !!g.degenerate   // iccviz flags a collapsed/unreliable gamut boundary
        } catch { /* AToB tag absent */ }
        try { rt = await roundTripDE(bytes, it.intent) } catch { /* AToB/BToA tags absent */ }
        if (vol != null || rt != null) rows.push({ key: it.key, fallback: it.fallback, vol, degenerate, rt })
      }
      if (cancelled) return
      statsCache.set(bytes, rows)
      setState({ loading: false, rows })
    })()
    return () => { cancelled = true }
  }, [bytes])

  const fmtVol = (v) => (v == null ? '—' : Math.round(v).toLocaleString())
  // Pad each round-trip column to a common width with figure spaces (U+2007 —
  // digit-width under tabular-nums) so the values stay decimal-aligned even
  // though the column is centre-aligned under its label.
  const RT = [
    { key: 'meanDE', label: t('stats_mean') || 'mean' },
    { key: 'p90DE',  label: t('stats_p90')  || 'P90' },
    { key: 'maxDE',  label: t('stats_max')  || 'max' },
  ]
  const rtPad = {}
  for (const { key } of RT) {
    const strs = state.rows.map((r) => (r.rt == null ? '—' : r.rt[key].toFixed(2)))
    const w = strs.reduce((m, s) => Math.max(m, s.length), 0)
    rtPad[key] = strs.map((s) => ' '.repeat(w - s.length) + s)
  }

  // iccviz sets `degenerate` when a gamut boundary collapsed / was mostly
  // non-finite, so that intent's volume is unreliable — flag it (⚠ on the cell +
  // a note below) rather than presenting a bogus number as trustworthy.
  const degenerateMsg = t('stats_gamut_degenerate') ||
    'The gamut boundary collapsed or was mostly undefined, so this gamut volume is unreliable.'
  const anyDegenerate = state.rows.some((r) => r.degenerate)

  return (
    <Collapsible title={t('analysis_stats_heading') || 'Profile Statistics'} defaultOpen>
      <p className={styles.sectionIntro}>
        {t('analysis_stats_intro') ||
          'Whole-profile metrics per rendering intent: the gamut volume enclosed by the device→PCS transform (ΔE*ab³), and the B2A round-trip accuracy — ΔE*ab of a Lab → device → Lab round trip through the profile.'}
      </p>
      {state.loading ? (
        <div className={styles.loading}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
      ) : !state.rows.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_stats_na') ||
            'No device↔PCS CLUTs in this profile — profile statistics do not apply (e.g. a matrix/TRC display profile).'}
        </div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th rowSpan={2}>{t('stats_intent') || 'Rendering intent'}</th>
              <th rowSpan={2} className={styles.statNum}>{t('stats_gamut_volume') || 'Gamut volume (ΔE³)'}</th>
              <th colSpan={3} style={{ textAlign: 'center' }}>{t('stats_roundtrip') || 'Round-trip ΔE'}</th>
            </tr>
            <tr>
              {RT.map(({ key, label }) => (
                <th key={key} className={styles.statNumC}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((r, i) => (
              <tr key={r.key}>
                <td>{t(r.key) || r.fallback}</td>
                <td className={styles.statNum}>
                  {fmtVol(r.vol)}
                  {r.degenerate && <span className={styles.warnMark} title={degenerateMsg} aria-label={degenerateMsg}> ⚠</span>}
                </td>
                {RT.map(({ key }) => (
                  <td key={key} className={styles.statNumC}>{rtPad[key][i]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {anyDegenerate && <div className={styles.statWarning}>⚠ {degenerateMsg}</div>}
    </Collapsible>
  )
}

function NeutralSection({ bytes, profileClass, tables, t }) {
  // Output (printer) profiles only — others get a localized error.
  const isOutput = String(profileClass || '').toLowerCase().includes('output')
  return (
    <Collapsible title={t('analysis_neutral_heading') || 'Neutral Axis Inking'} defaultOpen>
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
        const N = graph.series.length
        const sig = info?.dstSpaceSig || ''
        graph.series.forEach((s, i) => { s.color = neutralTraceColor(sig, s, i, N) })
        graph.yAxis = { ...graph.yAxis, label: t('analysis_neutral_yaxis') || '% ink' }
        setState({ loading: false, graph })
      },
      (e) => { if (!cancelled) setState({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes, table.id])
  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>
  return <GraphSvg graph={state.graph} legend resizable />
}

export default function AnalysisPanel({ bytes, profileClass }) {
  const t = useT()
  const [status, setStatus] = useState('loading')   // loading | ready | error
  const [error, setError] = useState(null)
  const [neutralTags, setNeutralTags] = useState([]) // [{ sig, id, intent }] (neutral B2A graphs)

  // One enumerate per profile feeds the neutral-axis graphs (per B2A table).
  useEffect(() => {
    let cancelled = false
    setStatus('loading'); setError(null); setNeutralTags([])
    enumerateVisualizations(bytes)
      .then((list) => {
        if (cancelled) return
        const neutral = []
        for (const d of list) {
          const sig = d.tagSig || (d.id.split(':')[1] || '')
          if (d.kind === KIND_NEUTRAL) {
            neutral.push({ sig, id: d.id, intent: B2A_INTENTS[sig] || sig })
          }
        }
        setNeutralTags(neutral)
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
      <ProfileStatsSection bytes={bytes} t={t} />
      <NeutralSection bytes={bytes} profileClass={profileClass} tables={neutralTags} t={t} />
    </div>
  )
}
