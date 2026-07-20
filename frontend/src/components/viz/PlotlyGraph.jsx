// (c) 2026 William Li
//
// Reusable Plotly renderer for an IccVizModel graph object
//   graph = { title, description, xAxis:{label,min,max,equalAspect}, yAxis, series[] }
// where each series is { id, name, role:'primary'|'hint', shape:'polyline'|
// 'closedPath'|'scatter', color?, points:[x0,y0,x1,y1,…], labels:[{i,t}] }.
//
// This is profiletool's ONE plotting stack: it replaces the bespoke GraphSvg for
// line/scatter plots so every plot shares the same interactions (hover readouts,
// click-legend toggles, PNG export) and the standard drag-resize bar (ResizablePlot).
// SVG traces only (bar/scatter/line) — no WebGL — so no CSP change is needed.
//
// Plotly is lazy-loaded once and shared process-wide (same loader as RtHistogram);
// the ~3.5 MB module is already paid for by the round-trip histogram.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useT } from '../../i18n.jsx'
import ResizablePlot from './ResizablePlot.jsx'
import { loadPlotly } from './plotly.js'
import { colorFor } from './colors.js'
import styles from './PlotlyGraph.module.css'

const TONE_KEY = 'profiletool.curveToneMode'

function theme(isDark) {
  return isDark
    ? { grid: '#2e2f34', plotBg: '#1e1f22', paperBg: '#1a1b1e', font: '#bbb', frame: '#3a3b40' }
    : { grid: '#eef1f6', plotBg: '#ffffff', paperBg: '#ffffff', font: '#445', frame: '#d6dbe6' }
}

// One IccVizGraph series → one or more Plotly traces. Preserves the series'
// explicit colour (LUT/neutral traces set it) and the primary/hint weighting; hint
// geometry is thin, semi-transparent and kept out of the legend (matches GraphSvg).
//
// `hl` is the lower-cased highlight token (or null). It reproduces GraphSvg's
// highlight/dim behaviour: a whole series dims when neither its colorHint nor id
// matches; within a scatter series, the point whose label matches is enlarged with
// a ring and the rest dim. Used by the chromaticity plots (highlight the white
// point, or a colorant primary).
// `tone`: plot the departure from the linear y=x identity (y' = y − x) instead of
// the raw curve — the classic "tone increase" view of a TRC / LUT curve. Only
// meaningful for curves whose x and y share a domain (input vs output, both 0..1),
// which is why it is opt-in per plot.
function seriesToTraces(s, hl, tone) {
  const pts = s.points || []
  const x = [], y = []
  for (let i = 0; i < pts.length; i += 2) { x.push(pts[i]); y.push(pts[i + 1]) }
  // Never apply the y−x tone transform to a secondary-axis series: it carries a
  // different quantity than x, so the subtraction would be meaningless.
  if (tone && !s.useY2) for (let i = 0; i < y.length; i++) y[i] -= x[i]
  const color = s.color || colorFor(s)
  const isHint = s.role === 'hint'
  const named = !!s.name
  const seriesDimmed = hl != null
    && (s.colorHint || '').toLowerCase() !== hl && (s.id || '').toLowerCase() !== hl

  if (s.shape === 'scatter') {
    const labelMap = new Map((s.labels || []).map((l) => [l.i, l.t]))
    const text = x.map((_, i) => labelMap.get(i) || '')
    const anyText = text.some(Boolean)
    // Per-point hit test (label === highlight). Hits enlarge + stay opaque; when a
    // highlight is active every non-hit point dims (mirrors GraphSvg's isMiss).
    const hits = text.map((tt) => hl != null && tt && tt.toLowerCase() === hl)
    const anyHit = hits.some(Boolean)
    const size = x.map((_, i) => (isHint ? 4 : (hits[i] ? 9 : 6)))
    const opacity = x.map((_, i) => ((hl != null && !hits[i]) ? 0.35 : 1))
    const base = {
      type: 'scatter',   // SVG scatter (never scattergl) so no WebGL / CSP eval
      mode: anyText ? 'markers+text' : 'markers',
      x, y, name: s.name || undefined,
      marker: { color, size, opacity }, text: anyText ? text : undefined,
      textposition: 'top center', textfont: { size: 9, color },
      showlegend: named && !isHint,
      hovertemplate: anyText ? '%{text}<extra></extra>' : '%{x:.3g}, %{y:.3g}<extra></extra>',
    }
    const traces = [base]
    if (anyHit) {   // open ring around each highlighted point
      const hx = [], hy = []
      x.forEach((_, i) => { if (hits[i]) { hx.push(x[i]); hy.push(y[i]) } })
      traces.push({
        type: 'scatter', mode: 'markers', x: hx, y: hy, showlegend: false,
        marker: { color: 'rgba(0,0,0,0)', size: 18, line: { color, width: 1.5 } },
        hoverinfo: 'skip',
      })
    }
    return traces
  }

  // polyline / closedPath → a line trace (closed by repeating the first vertex).
  const lx = [...x], ly = [...y]
  if (s.shape === 'closedPath' && x.length) { lx.push(x[0]); ly.push(y[0]) }
  return [{
    type: 'scatter', mode: 'lines', x: lx, y: ly, name: s.name || undefined,
    line: { color, width: isHint ? 1 : 2, dash: s.dash || undefined },
    opacity: seriesDimmed ? 0.35 : (isHint ? 0.7 : 1),
    // A secondary-axis series is drawn against y2; everything else keeps the default.
    yaxis: s.useY2 ? 'y2' : undefined,
    showlegend: named, hovertemplate: '%{x:.3g}, %{y:.3g}<extra></extra>',
  }]
}

// A usable [min,max] pair → an explicit axis range; otherwise let Plotly autorange.
// max must exceed min: the model uses minHint == maxHint to mean "no hint" (an axis
// whose extent is data-dependent), and a [0,0] range would collapse the plot.
function axisRange(a) {
  return (a && Number.isFinite(a.min) && Number.isFinite(a.max) && a.max !== a.min)
    ? [a.min, a.max] : undefined
}

export default function PlotlyGraph({ graph, legend = false, highlight, toneOption = false, storageKey = 'profiletool.plotHeight', defaultH = 360 }) {
  const t = useT()
  // Unique radio-group name per plot instance — two curve plots (input + output)
  // share a storageKey, so keying the radio `name` on storageKey would merge their
  // radios into one native group and none would light up. useId keeps them distinct.
  const uid = useId()
  const plotRef = useRef(null)
  const plotlyRef = useRef(null)
  const [dark, setDark] = useState(() => document.body.classList.contains('dark'))
  // Curve display mode (only offered when `toneOption`): 'xy' = raw curve (default),
  // 'tone' = departure from linear (y − x). Persisted across plots/reloads.
  const [toneMode, setToneMode] = useState(() =>
    (toneOption && localStorage.getItem(TONE_KEY) === 'tone') ? 'tone' : 'xy')
  useEffect(() => { if (toneOption) localStorage.setItem(TONE_KEY, toneMode) }, [toneOption, toneMode])
  const tone = toneOption && toneMode === 'tone'

  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.body.classList.contains('dark')))
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const div = plotRef.current
    if (!div || !graph || !Array.isArray(graph.series)) return undefined
    ;(async () => {
      const Plotly = await loadPlotly()
      plotlyRef.current = Plotly
      if (cancelled || !plotRef.current) return
      const c = theme(dark)
      const hl = highlight ? String(highlight).toLowerCase() : null
      // Hint traces first so primary data draws on top (GraphSvg ordering).
      const ordered = [...graph.series].sort((a, b) => (a.role === 'hint' ? 0 : 1) - (b.role === 'hint' ? 0 : 1))
      const traces = ordered.flatMap((s) => seriesToTraces(s, hl, tone))
      const anyNamed = traces.some((tr) => tr.showlegend)

      const hasY2 = !!graph.hasY2 && graph.series.some((s) => s.useY2)
      const layout = {
        // A right-hand axis needs room for its ticks and title, so widen that margin
        // only when one is actually present.
        margin: { l: 56, r: hasY2 ? 58 : 16, t: 12, b: 46 }, autosize: true,
        xaxis: {
          title: { text: graph.xAxis?.label || '', font: { color: c.font }, standoff: 4 },
          range: axisRange(graph.xAxis), zeroline: false, showgrid: true, gridcolor: c.grid,
          linecolor: c.frame, tickfont: { color: c.font },
        },
        yaxis: {
          // In tone mode the axis shows the departure from linear; autorange it (the
          // values are small ± swings) and draw the y=0 line as the linear baseline.
          title: {
            text: tone ? (t('curve_tone_axis') || 'Tone increase (out − in)') : (graph.yAxis?.label || ''),
            font: { color: c.font }, standoff: 4,
          },
          range: tone ? undefined : axisRange(graph.yAxis),
          zeroline: tone, zerolinecolor: c.frame,
          showgrid: true, gridcolor: c.grid, linecolor: c.frame, tickfont: { color: c.font },
        },
        showlegend: legend && anyNamed,
        legend: { orientation: 'h', x: 0, y: 1.12, font: { color: c.font } },
        plot_bgcolor: c.plotBg, paper_bgcolor: c.paperBg, font: { color: c.font },
        hovermode: 'closest',
      }
      // Secondary y axis for series measured in a different quantity than the primary
      // one (ΔE*ab beside colorant %). `rangemode: 'tozero'` keeps the baseline at 0 so
      // the curve's height stays honest — autoranging both ends would magnify noise on
      // a near-perfect profile into something that looks like a problem.
      if (hasY2) {
        layout.yaxis2 = {
          title: { text: graph.y2Axis?.label || '', font: { color: c.font }, standoff: 4 },
          range: axisRange(graph.y2Axis), rangemode: 'tozero',
          overlaying: 'y', side: 'right',
          showgrid: false,                 // one grid only; two would read as a lattice
          zeroline: false, linecolor: c.frame, tickfont: { color: c.font },
        }
      }
      // Equal-aspect plots (e.g. a*b* / chromaticity) lock the y scale to x.
      if (graph.xAxis?.equalAspect) { layout.yaxis.scaleanchor = 'x'; layout.yaxis.scaleratio = 1 }
      // Optional description → a subtle top-right annotation (parity with GraphSvg).
      if (graph.description) {
        layout.annotations = [{
          text: graph.description, showarrow: false, xref: 'paper', yref: 'paper',
          x: 1, y: 1, xanchor: 'right', yanchor: 'bottom', font: { size: 9, color: c.font },
        }]
      }
      Plotly.react(plotRef.current, traces, layout, { responsive: true, displayModeBar: false })
    })()
    return () => { cancelled = true }
  }, [graph, dark, legend, highlight, tone, t])

  useEffect(() => () => {
    const d = plotRef.current
    if (d && plotlyRef.current) { try { plotlyRef.current.purge(d) } catch { /* already gone */ } }
  }, [])

  // Re-lay Plotly out on a height drag or any container width change (pane toggle).
  const onResize = useCallback(() => {
    const d = plotRef.current
    if (d && plotlyRef.current && d._fullLayout) plotlyRef.current.Plots.resize(d)
  }, [])

  return (
    <div>
      {toneOption && (
        <div className={styles.controls}>
          <span className={styles.ctlLabel}>{t('curve_scale') || 'Vertical scale'}</span>
          <label className={styles.radio}>
            <input type="radio" name={`curvemode-${uid}`} checked={toneMode === 'xy'} onChange={() => setToneMode('xy')} />
            <span>{t('curve_mode_xy') || 'X–Y'}</span>
          </label>
          <label className={styles.radio}>
            <input type="radio" name={`curvemode-${uid}`} checked={toneMode === 'tone'} onChange={() => setToneMode('tone')} />
            <span>{t('curve_mode_tone') || 'Tone increase'}</span>
          </label>
        </div>
      )}
      <ResizablePlot storageKey={storageKey} onResize={onResize} defaultH={defaultH} minH={220} maxH={1200}>
        <div ref={plotRef} style={{ width: '100%', height: '100%' }} />
      </ResizablePlot>
    </div>
  )
}
