// (c) 2026 William Li
import { useEffect, useRef, useState } from 'react'
import { enumerateVisualizations, renderGraph, tagEvalInfo } from '../lib/vizPlot.js'
import { channelColor } from './viz/colors.js'
import { labToRgb } from '../lib/rasterDecode.js'
import Collapsible from './viz/Collapsible.jsx'
import GraphSvg from './viz/GraphSvg.jsx'
import { useT } from '../i18n.jsx'
import styles from './AnalysisPanel.module.css'

// Whole-profile analyses (the "first of a few"). Each analysis is a receiver for
// data produced by the iccviz IccVizModel and plotted in the app's own style.
//
// L* tone reversal (Kind::InkReversalL = 7, kept in sync with IccVizModel.hpp):
// the model samples a device→PCS AToB LUT on its lattice and, per ink channel,
// emits every (lower-ink, higher-ink) pair whose L* went UP — a tone reversal —
// as a 2-vertex polyline (low vertex labelled with the full ink vector, high
// vertex carrying ΔL* as aux). The per-channel epsilon filter and the ranked
// table are applied here, client-side, so the slider is instant.
const KIND_INK_REVERSAL_L = 7
const DEFAULT_EPSILON = 1.0
const PREFERRED_TABLE = 'A2B1'   // relative-colorimetric AToB; reversals are intent-invariant in L*

// Decode one reversal segment from a GraphSvg series. points = [xLo,Llo,xHi,Lhi];
// labels carry the ink vector (vertex 0) and ΔL* (vertex 1, as `a`).
function decodeSegments(graph) {
  return (graph.series || []).map((s) => {
    const byIndex = new Map((s.labels || []).map((l) => [l.i, l]))
    const p = s.points || []
    return {
      id: s.id,
      xLo: p[0], Llo: p[1], xHi: p[2], Lhi: p[3],
      dL: byIndex.get(1)?.a ?? (p[3] - p[1]),
      inkLo: byIndex.get(0)?.t ?? '',
    }
  }).filter((seg) => Number.isFinite(seg.xLo) && Number.isFinite(seg.dL))
}

// Purpose-built reversal plot: device-value (x, 0–1) vs L* (y, 0–100), one short
// line per reversal with endpoint dots so even a handful of small reversals are
// clearly visible (GraphSvg's thin polylines vanish at this scale). An empty
// channel renders the framed axes plus a centred ✓ so a CLEAN channel reads as
// clean — not as a missing/broken graph.
function ReversalPlot({ segments, color }) {
  const W = 520
  const m = { l: 38, r: 14, t: 10, b: 30 }
  const pw = W - m.l - m.r        // plot-area width
  const ph = pw                   // square plot area: the L* (y) axis spans the same
  const H = ph + m.t + m.b        // on-screen length as the %ink (x) axis

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
  const sx = (x) => m.l + clamp(x, 0, 1) * pw
  const sy = (L) => m.t + ph - (clamp(L, 0, 100) / 100) * ph
  const frac = [0, 0.25, 0.5, 0.75, 1]
  return (
    <svg className={styles.plot} viewBox={`0 0 ${W} ${H}`} role="img">
      <rect x={m.l} y={m.t} width={pw} height={ph} className={styles.frame} />
      {frac.map((f, i) => (
        <g key={i}>
          <line x1={m.l + f * pw} y1={m.t} x2={m.l + f * pw} y2={m.t + ph} className={styles.plotGrid} />
          <line x1={m.l} y1={m.t + f * ph} x2={m.l + pw} y2={m.t + f * ph} className={styles.plotGrid} />
        </g>
      ))}
      {segments.map((s, i) => (
        <g key={i} className={styles.seg}>
          <line x1={sx(s.xLo)} y1={sy(s.Llo)} x2={sx(s.xHi)} y2={sy(s.Lhi)} stroke={color} strokeWidth={1.4} />
          <circle cx={sx(s.xLo)} cy={sy(s.Llo)} r={2} fill={color} />
          <circle cx={sx(s.xHi)} cy={sy(s.Lhi)} r={2.6} fill={color} />
          <title>{`ΔL*=+${s.dL.toFixed(2)} · device ${s.xLo.toFixed(3)}→${s.xHi.toFixed(3)} · L* ${s.Llo.toFixed(2)}→${s.Lhi.toFixed(2)}`}</title>
        </g>
      ))}
      <text x={m.l} y={m.t + ph + 12} className={styles.axisVal} textAnchor="start">0</text>
      <text x={m.l + pw} y={m.t + ph + 12} className={styles.axisVal} textAnchor="end">1</text>
      <text x={m.l + pw / 2} y={m.t + ph + 24} className={styles.axisLabel} textAnchor="middle">% ink</text>
      <text x={m.l - 5} y={m.t + ph} className={styles.axisVal} textAnchor="end">0</text>
      <text x={m.l - 5} y={m.t + 8} className={styles.axisVal} textAnchor="end">100</text>
      <text transform={`translate(11 ${m.t + ph / 2}) rotate(-90)`} className={styles.axisLabel} textAnchor="middle">L*</text>
      {!segments.length && (
        <text x={m.l + pw / 2} y={m.t + ph / 2 + 4} className={styles.cleanMark} textAnchor="middle">✓</text>
      )}
    </svg>
  )
}

// "1.000" → "1", "0.400" → "0.4", "0.000" → "0" for compact ink-vector display.
function trimNum(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? String(+n.toFixed(3)) : String(v)
}

// Render the ink transition compactly: one vector with the varying channel `ch`
// shown inline as "lo→hi" and the (constant) others at their value. Far more
// readable than two full N-vectors for wide nCLR inksets (e.g. 7-colour).
function inkTransition(seg, ch) {
  const lo = seg.inkLo.split(',').map(trimNum)
  if (ch < 0 || ch >= lo.length) return `[${lo.join(', ')}]`
  const hi = trimNum(String(seg.xHi))
  return '[' + lo.map((v, i) => (i === ch ? `${v}→${hi}` : v)).join(', ') + ']'
}

// Localize the model's structured warnings. The reversal cap arrives as a
// locale-agnostic "reversal:capped:<total>:<shown>" marker (see IccVizModel.cpp);
// fold all such markers (one per capped channel) into a single localized note.
// Any other (already-human) warning passes through unchanged.
function formatWarnings(raw, t) {
  const out = []
  let capped = false, shown = 0
  for (const w of raw) {
    const m = /^reversal:capped:(\d+):(\d+)$/.exec(w)
    if (m) { capped = true; shown = Math.max(shown, Number(m[2])); continue }
    out.push(w)
  }
  if (capped) {
    out.unshift((t('analysis_reversal_capped') ||
      'Channels with many reversals show only the {shown} largest by ΔL*.').replace('{shown}', shown))
  }
  return out
}

// Non-fatal diagnostics the model carried as data (e.g. a capped reversal count).
function VizWarnings({ items }) {
  if (!items || !items.length) return null
  return (
    <div className={styles.itemWarning}>
      {items.map((w, i) => <div key={i}>⚠ {w}</div>)}
    </div>
  )
}

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
  const [tags, setTags] = useState([])              // [{ sig, channels:[{idx,id}] }] (reversal)
  const [neutralTags, setNeutralTags] = useState([]) // [{ sig, id, intent }] (neutral B2A graphs)
  const [selTag, setSelTag] = useState(null)
  const [epsilon, setEpsilon] = useState(DEFAULT_EPSILON)

  // One enumerate per profile feeds both analyses: reversal graphs (per AToB
  // channel) and neutral-axis graphs (per B2A table).
  useEffect(() => {
    let cancelled = false
    setStatus('loading'); setError(null); setTags([]); setNeutralTags([]); setSelTag(null)
    enumerateVisualizations(bytes)
      .then((list) => {
        if (cancelled) return
        const byTag = new Map()
        const neutral = []
        for (const d of list) {
          const sig = d.tagSig || (d.id.split(':')[1] || '')
          if (d.kind === KIND_INK_REVERSAL_L) {
            if (!byTag.has(sig)) byTag.set(sig, [])
            byTag.get(sig).push({ idx: d.idx, id: d.id })
          } else if (d.kind === KIND_NEUTRAL) {
            neutral.push({ sig, id: d.id, intent: B2A_INTENTS[sig] || sig })
          }
        }
        const grouped = [...byTag.entries()].map(([sig, channels]) => ({
          sig, channels: channels.sort((a, b) => a.idx - b.idx),
        }))
        setTags(grouped)
        setNeutralTags(neutral)
        const pref = grouped.find((g) => g.sig === PREFERRED_TABLE) || grouped[0] || null
        setSelTag(pref ? pref.sig : null)
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
      <NeutralSection bytes={bytes} profileClass={profileClass} tables={neutralTags} t={t} />
      <ReversalSection
        bytes={bytes} tags={tags} selTag={selTag} setSelTag={setSelTag}
        epsilon={epsilon} setEpsilon={setEpsilon} t={t}
      />
    </div>
  )
}

function ReversalSection({ bytes, tags, selTag, setSelTag, epsilon, setEpsilon, t }) {
  // Default-open; the per-channel render (seconds, for wide nCLR) is paid once and
  // cached (see reversalCache), so reopening the section or the tab is instant.
  return (
    <Collapsible title={t('analysis_reversal_heading') || 'L* Tone Reversal'} defaultOpen>
      <p className={styles.sectionIntro}>
        {t('analysis_reversal_intro') ||
          'Adding ink should never make a colour lighter. Each device channel is swept while the others are held; any step where L* rises is flagged. Algorithm originally due to Harold Boll.'}
      </p>

      {!tags.length ? (
        <div className={styles.notApplicable}>
          {t('analysis_reversal_na') || 'No device→PCS CLUT in this profile — the L* reversal scan does not apply (e.g. a matrix/TRC display profile).'}
        </div>
      ) : (
        <>
          <div className={styles.controls}>
            {tags.length > 1 && (
              <label className={styles.control}>
                <span>{t('analysis_table_label') || 'LUT table'}</span>
                <select value={selTag || ''} onChange={(e) => setSelTag(e.target.value)}>
                  {tags.map((g) => <option key={g.sig} value={g.sig}>{g.sig}</option>)}
                </select>
              </label>
            )}
            <label className={styles.control}>
              <span>{t('analysis_epsilon_label') || 'ΔL* threshold (ε)'} <strong>{epsilon.toFixed(1)}</strong></span>
              <input type="range" min="0" max="10" step="0.1" value={epsilon}
                     onChange={(e) => setEpsilon(parseFloat(e.target.value))} />
            </label>
          </div>

          <ReversalGraphs
            key={selTag}
            bytes={bytes}
            tag={tags.find((g) => g.sig === selTag) || tags[0]}
            epsilon={epsilon}
            t={t}
          />
        </>
      )}
    </Collapsible>
  )
}

const ROW_PAGE = 10   // rows revealed per "show more" click (and the initial count)

// Cache of computed reversal graphs so collapsing/reopening the section — or
// leaving and returning to the Analysis tab (which unmounts this component) —
// doesn't re-pay the per-channel render (seconds, for wide nCLR). Keyed on the
// `bytes` reference: a WeakMap, so the same loaded profile reuses its entry while
// reloading a profile (a fresh Uint8Array) misses and the old entry is GC'd — the
// cache clears itself on profile reload, no manual invalidation.
const reversalCache = new WeakMap()   // bytes -> Map(tag.sig -> { info, graphs, failures })
function reversalCacheFor(bytes) {
  let m = reversalCache.get(bytes)
  if (!m) { m = new Map(); reversalCache.set(bytes, m) }
  return m
}

function ReversalGraphs({ bytes, tag, epsilon, t }) {
  const [state, setState] = useState(() => {
    const cached = reversalCache.get(bytes)?.get(tag.sig)
    return cached ? { loading: false, ...cached } : { loading: true }
  })
  const [rowLimit, setRowLimit] = useState(ROW_PAGE)
  const [filterCh, setFilterCh] = useState(null)   // channel idx, or null = all channels

  useEffect(() => {
    if (reversalCacheFor(bytes).has(tag.sig)) return   // cached → instant, no recompute
    let cancelled = false
    setState({ loading: true })
    setRowLimit(ROW_PAGE); setFilterCh(null)        // reset table controls when the table changes
    Promise.all([
      tagEvalInfo(bytes, tag.sig).catch(() => null),  // channel labels + device space (best-effort)
      // allSettled: one channel failing to render degrades to a note, it does not
      // take the whole section down (graceful degradation for exotic LUTs).
      Promise.allSettled(tag.channels.map((c) => renderGraph(bytes, c.id).then((g) => ({ c, g })))),
    ]).then(
      ([info, settled]) => {
        if (cancelled) return
        const graphs = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
        const failures = settled.filter((r) => r.status === 'rejected')
          .map((r) => r.reason?.message || String(r.reason))
        const result = { info, graphs, failures }
        reversalCacheFor(bytes).set(tag.sig, result)
        setState({ loading: false, ...result })
      },
      (e) => { if (!cancelled) setState({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
  }, [bytes, tag.sig, tag.channels])

  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>

  const { info, graphs, failures = [] } = state
  if (!graphs.length) {
    // Every channel failed to render — graceful note rather than a broken section.
    return (
      <div className={styles.notApplicable}>
        {t('analysis_reversal_na') || 'The L* reversal scan does not apply to this profile.'}
        {failures[0] ? ` — ${failures[0]}` : ''}
      </div>
    )
  }

  const spaceSig = info?.srcSpaceSig || ''
  const nCh = info?.srcChannels || graphs.length
  const labelFor = (idx) => (info?.srcLabels?.[idx]) || `Ch${idx}`

  const channels = graphs.map(({ c, g }) => {
    const color = channelColor(spaceSig, c.idx, nCh)
    const allSegs = decodeSegments(g)
    const segs = allSegs.filter((s) => s.dL > epsilon)
    return { idx: c.idx, name: labelFor(c.idx), color, total: allSegs.length, segs, warnings: g.warnings || [] }
  })

  // All ε-passing reversals across channels, ranked by ΔL*; optionally narrowed to
  // one channel (the colour filter), then paged by rowLimit.
  const allRows = channels
    .flatMap((ch) => ch.segs.map((s) => ({ ...s, ch: ch.idx, chName: ch.name, color: ch.color })))
    .sort((a, b) => b.dL - a.dL)
  const filteredRows = filterCh == null ? allRows : allRows.filter((r) => r.ch === filterCh)
  const displayRows = filteredRows.slice(0, rowLimit)

  const totalShown = channels.reduce((n, ch) => n + ch.segs.length, 0)
  const warnings = formatWarnings([...channels.flatMap((ch) => ch.warnings), ...failures], t)
  const filterable = channels.filter((ch) => ch.segs.length > 0)   // chips for channels with rows

  return (
    <>
      <VizWarnings items={warnings} />
      <div className={styles.summary}>
        {totalShown > 0
          ? (t('analysis_reversal_count') || '{n} reversals above ε = {eps}')
              .replace('{n}', totalShown).replace('{eps}', epsilon.toFixed(1))
          : (t('analysis_reversal_none') || 'No L* reversals above ε = {eps}')
              .replace('{eps}', epsilon.toFixed(1))}
      </div>

      <div className={styles.grid}>
        {channels.map((ch) => (
          <div key={ch.idx} className={styles.cell}>
            <div className={styles.cellHead}>
              <span className={styles.dot} style={{ background: ch.color }} />
              <span style={{ color: ch.color }}>{ch.name}</span>
              <span className={styles.cellCount}>
                {ch.segs.length}{ch.total > ch.segs.length ? ` / ${ch.total}` : ''} ≥ ε
              </span>
            </div>
            <ReversalPlot segments={ch.segs} color={ch.color} />
          </div>
        ))}
      </div>

      {allRows.length > 0 && (
        <div className={styles.tableSection}>
          {/* colour filter: All + one chip per channel that has reversals */}
          <div className={styles.filterRow}>
            <button type="button"
              className={`${styles.filterChip} ${filterCh == null ? styles.filterActive : ''}`}
              onClick={() => { setFilterCh(null); setRowLimit(ROW_PAGE) }}>
              {t('analysis_filter_all') || 'All'}
            </button>
            {filterable.map((ch) => (
              <button key={ch.idx} type="button" title={ch.name}
                className={`${styles.filterChip} ${filterCh === ch.idx ? styles.filterActive : ''}`}
                onClick={() => { setFilterCh(filterCh === ch.idx ? null : ch.idx); setRowLimit(ROW_PAGE) }}>
                <span className={styles.dot} style={{ background: ch.color }} /> {ch.name}
              </button>
            ))}
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>#</th>
                <th>{t('analysis_col_channel') || 'Channel'}</th>
                <th>{t('analysis_col_ink') || 'Ink (low → high)'}</th>
                <th>L*</th>
                <th>ΔL*</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((r, i) => (
                <tr key={r.id + ':' + i}>
                  <td className={styles.num}>{i + 1}</td>
                  <td className={styles.chanCell}><span className={styles.dot} style={{ background: r.color }} /> {r.chName}</td>
                  <td className={styles.inkCell}>{inkTransition(r, r.ch)}</td>
                  <td className={styles.mono}>{r.Llo.toFixed(2)} → {r.Lhi.toFixed(2)}</td>
                  <td className={styles.mono}>+{r.dL.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {filteredRows.length > displayRows.length && (
            <button type="button" className={styles.showMore} onClick={() => setRowLimit((n) => n + ROW_PAGE)}>
              {(t('analysis_show_more') || 'Show more ({n})').replace('{n}', filteredRows.length - displayRows.length)}
            </button>
          )}
        </div>
      )}
    </>
  )
}
