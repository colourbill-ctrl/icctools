// (c) 2026 William Li
import { useEffect, useState } from 'react'
import { enumerateVisualizations, renderGraph, tagEvalInfo, gamutVolume, roundTripDE, roundTrip } from '../lib/vizPlot.js'
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

// ── Round-Trip (PRMG) ─────────────────────────────────────────────────────────
// The IccProfLib-canonical round trip — parity with the `iccRoundTrip` CLI, and
// distinct from the Profile-Statistics overview above (which uses iccviz's cheaper
// single-direction bespoke metric). Seeds from the device cube and reports BOTH
// directions plus the PRMG interoperability histogram, with live intent / MPE
// controls. Computed lazily on first open (Collapsible mounts children on demand)
// and cached per (profile, intent, useMpe) so re-selecting is instant.
const RT_INTENTS = [
  { intent: 0, key: 'intent_perceptual', fallback: 'Perceptual' },
  { intent: 1, key: 'intent_relative',   fallback: 'Relative Colorimetric' },
  { intent: 2, key: 'intent_saturation', fallback: 'Saturation' },
  { intent: 3, key: 'intent_absolute',   fallback: 'Absolute Colorimetric' },
]
const rtCache = new WeakMap()   // bytes -> Map<`${intent}:${useMpe}`, { data } | { error }>

function RoundTripSection({ bytes, t }) {
  return (
    <Collapsible title={t('analysis_rt_heading') || 'Round-Trip (PRMG)'}>
      <p className={styles.sectionIntro}>
        {t('analysis_rt_intro') ||
          'Device-cube round trip through the profile, matching the iccRoundTrip reference tool. Round Trip 1 is the device→PCS→device error (ΔE*ab); Round Trip 2 is the PCS round-trip stability. The PRMG histogram reports interoperability against the Perceptual Reference Medium Gamut.'}
      </p>
      <RoundTripBody bytes={bytes} t={t} />
    </Collapsible>
  )
}

function RoundTripBody({ bytes, t }) {
  const [intent, setIntent] = useState(1)      // default: relative colorimetric (CLI default)
  const [useMpe, setUseMpe] = useState(false)  // default: colorimetric (lut) tags
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    const cacheKey = `${intent}:${useMpe}`
    let byKey = rtCache.get(bytes)
    if (byKey && byKey.has(cacheKey)) { setState({ loading: false, ...byKey.get(cacheKey) }); return }
    let cancelled = false
    setState({ loading: true })
    ;(async () => {
      let result
      try { result = { data: await roundTrip(bytes, intent, useMpe) } }
      catch (e) { result = { error: e.message } }
      if (!byKey) { byKey = new Map(); rtCache.set(bytes, byKey) }
      byKey.set(cacheKey, result)
      if (!cancelled) setState({ loading: false, ...result })
    })()
    return () => { cancelled = true }
  }, [bytes, intent, useMpe])

  return (
    <>
      <div className={styles.controls}>
        <label className={styles.control}>
          <span>{t('analysis_intent_label') || 'Rendering intent'}</span>
          <select value={intent} onChange={(e) => setIntent(Number(e.target.value))}>
            {RT_INTENTS.map((it) => (
              <option key={it.intent} value={it.intent}>{t(it.key) || it.fallback}</option>
            ))}
          </select>
        </label>
        <label className={`${styles.control} ${styles.controlInline}`}>
          <input type="checkbox" checked={useMpe} onChange={(e) => setUseMpe(e.target.checked)} />
          <span>{t('analysis_rt_usempe') || 'Use MPE (color) tags'}</span>
        </label>
      </div>
      {state.loading ? (
        <div className={styles.loading}><span className={styles.spinner} /> {t('analysis_loading') || 'Analysing…'}</div>
      ) : state.error ? (
        <div className={styles.notApplicable}>
          {t('analysis_rt_na') ||
            'This profile cannot be round-tripped — it lacks the device↔PCS transforms this metric needs (e.g. a one-way or abstract profile).'}
        </div>
      ) : (
        <RoundTripResult data={state.data} t={t} />
      )}
    </>
  )
}

// Renders one round-trip result object (already parsed + error-checked by the
// vizPlot loader). Every field is treated as *untrusted shape* here: the object
// crosses the WASM→JS boundary, so we guard each access rather than assume the
// C++ always populated it — a future engine change or a partial result can't
// throw a render-time TypeError and blank the whole Analysis tab.
function RoundTripResult({ data, t }) {
  // The #1405 wide-device-space guard: EvaluateProfile deliberately refuses a
  // device space too wide to sample. It's a skip, not a failure — surface it as
  // an informational note (mirrors the CLI printing the status and exiting 0).
  if (data.status === 'tooManySamples') {
    return (
      <div className={styles.notApplicable}>
        {t('analysis_rt_toomany') ||
          'Round trip skipped: the device colour space is too wide to evaluate (too many samples).'}
      </div>
    )
  }

  // RT1/RT2 are required on a successful result; if either is missing the result
  // is malformed (not a real profile outcome), so fall back to the NA note
  // rather than dereferencing undefined below.
  const rt1 = data.roundTrip1, rt2 = data.roundTrip2
  if (!rt1 || !rt2) {
    return (
      <div className={styles.notApplicable}>
        {t('analysis_rt_na') ||
          'This profile cannot be round-tripped — it lacks the device↔PCS transforms this metric needs (e.g. a one-way or abstract profile).'}
      </div>
    )
  }

  // ΔE cells: '—' for a missing/non-numeric value (never a NaN or "undefined").
  const fmt = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—')
  // Worst-Lab triple: only format when it's the expected 3-number array.
  const fmtLab = (lab) =>
    (Array.isArray(lab) && lab.length === 3 && lab.every((v) => typeof v === 'number' && Number.isFinite(v)))
      ? lab.map((v) => v.toFixed(2)).join(', ')
      : '—'
  const rows = [
    { label: t('analysis_rt_min')  || 'Min ΔE',  a: fmt(rt1.minDE),  b: fmt(rt2.minDE) },
    { label: t('analysis_rt_mean') || 'Mean ΔE', a: fmt(rt1.meanDE), b: fmt(rt2.meanDE) },
    { label: t('analysis_rt_max')  || 'Max ΔE',  a: fmt(rt1.maxDE),  b: fmt(rt2.maxDE) },
  ]

  // PRMG histogram. `prmg` is absent/`ok:false` when the PRMG pass was skipped
  // (its status is independent of the round trip itself — the CLI still prints
  // RT1/RT2 in that case), so everything below is gated on `prmg.ok && total`.
  const prmg = data.prmg
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const total = prmg ? num(prmg.total) : 0
  // Share of samples at or under each ΔE threshold. Guard total>0 so we never
  // divide by zero (a valid-but-empty PRMG pass) — show '—' instead of NaN.
  const pct = (n) => (total > 0 ? (100 * num(n) / total).toFixed(1) + '%' : '—')
  const buckets = prmg && prmg.ok ? [
    { le: '1.0', n: num(prmg.de1) }, { le: '2.0', n: num(prmg.de2) }, { le: '3.0', n: num(prmg.de3) },
    { le: '5.0', n: num(prmg.de5) }, { le: '10.0', n: num(prmg.de10) },
  ] : []

  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{t('analysis_rt_metric') || 'Metric'}</th>
            <th className={styles.statNumC} title={t('analysis_rt_rt1_desc') || 'device → PCS → device'}>
              {t('analysis_rt_rt1') || 'Round Trip 1'}</th>
            <th className={styles.statNumC} title={t('analysis_rt_rt2_desc') || 'PCS round-trip stability'}>
              {t('analysis_rt_rt2') || 'Round Trip 2'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className={styles.statNumC}>{r.a}</td>
              <td className={styles.statNumC}>{r.b}</td>
            </tr>
          ))}
          <tr>
            <td>{t('analysis_rt_worstlab') || 'Worst L, a, b'}</td>
            <td className={styles.statNumC}>{fmtLab(rt1.maxLab)}</td>
            <td className={styles.statNumC}>{fmtLab(rt2.maxLab)}</td>
          </tr>
        </tbody>
      </table>

      <p className={styles.rtGamut}>
        <strong>{t('analysis_rt_gamut') || 'Specified gamut'}:</strong>{' '}
        {prmg && prmg.ok
          ? (prmg.implied ? (t('analysis_rt_gamut_prmg') || 'Perceptual Reference Medium Gamut')
                          : (t('analysis_rt_gamut_none') || 'Not specified'))
          : (t('analysis_rt_gamut_na') || 'Not evaluated')}
      </p>

      {prmg && prmg.ok && total ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th colSpan={3} style={{ textAlign: 'left' }}>
                {t('analysis_rt_prmg_heading') || 'PRMG interoperability'}
              </th>
            </tr>
            <tr>
              <th>{t('analysis_rt_prmg_de') || 'Round-trip ΔE'}</th>
              <th className={styles.statNumC}>{t('analysis_rt_count') || 'Count'}</th>
              <th className={styles.statNumC}>{t('analysis_rt_pct') || 'Share'}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bk) => (
              <tr key={bk.le}>
                <td>≤ {bk.le}</td>
                <td className={styles.statNumC}>{bk.n.toLocaleString()}</td>
                <td className={styles.statNumC}>{pct(bk.n)}</td>
              </tr>
            ))}
            <tr>
              <td>{t('analysis_rt_total') || 'Total'}</td>
              <td className={styles.statNumC}>{total.toLocaleString()}</td>
              <td className={styles.statNumC} />
            </tr>
          </tbody>
        </table>
      ) : (
        <div className={styles.notApplicable}>
          {(t('analysis_rt_prmg_skipped') || 'PRMG not evaluated')}
          {prmg && prmg.message ? `: ${prmg.message}` : ''}
        </div>
      )}
    </>
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
      <RoundTripSection bytes={bytes} t={t} />
      <NeutralSection bytes={bytes} profileClass={profileClass} tables={neutralTags} t={t} />
    </div>
  )
}
