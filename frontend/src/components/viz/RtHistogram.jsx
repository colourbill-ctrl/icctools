// (c) 2026 William Li
//
// Round-trip ΔE histogram — relative-frequency bars (left axis) + cumulative-
// frequency line (right axis). A port of chardata's Comparison-Statistics
// histogram (public/index.html::renderCmpHist) into profiletool's React shell, so
// the two apps read the same way. It owns the same "Horizontal scale" control
// (Integer ΔE / Auto-scale + Bins) and sits in a ResizablePlot so the user can
// drag its height (the standard profiletool plot affordance).
//
// Rendered with Plotly using SVG traces only (bar + scatter) — no WebGL — so it
// needs neither 'unsafe-eval' nor any CSP change (see the CSP note in index.html).
// Plotly is a large dependency, so it is lazy-loaded once on first histogram render
// and shared process-wide; the module promise is memoized so switching profiles /
// round-trip types / bin modes re-plots without re-fetching.
//
// The bin data crosses from the WASM engine as a FINE histogram (`hist[i]` = count
// of ΔE in [i·histBinW, (i+1)·histBinW), histBinW = 0.1); this component
// re-aggregates it into the chosen display bins (integer-ΔE, or N auto bins) and
// draws relative + cumulative frequencies.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n.jsx'
import ResizablePlot from './ResizablePlot.jsx'
import { loadPlotly } from './plotly.js'
import styles from './RtHistogram.module.css'

const MODE_KEY = 'profiletool.rtHistMode'
const BINS_KEY = 'profiletool.rtHistBins'
const HEIGHT_KEY = 'profiletool.rtHistHeight'

// Light/dark palette, mirroring chardata's histogram colours so the two match.
function palette(isDark) {
  return isDark
    ? { grid: '#2e2f34', plotBg: '#1e1f22', paperBg: '#1a1b1e', font: '#bbb', bar: '#3a6ea5', line: '#e09a4a' }
    : { grid: '#eee',    plotBg: '#fafafa', paperBg: '#ffffff', font: '#444', bar: '#4a90e2', line: '#e67e22' }
}

// Re-aggregate the fine WASM histogram into display bins.
//  - 'integer': width-1 ΔE bins = groups of (1/baseW) fine bins (exact; chardata's
//    default). 'auto': N equal-width bins over [0, maxΔE].
// In auto mode N is clamped so a display bin is never finer than the fine base —
// otherwise sub-base bins would alias into an empty/spiky "comb" (the fine data has
// no detail below baseW to distribute).
function buildBins(hist, baseW, mode, autoBins) {
  const n = hist.length
  const maxE = n * baseW
  if (mode === 'auto') {
    let N = Math.min(100, Math.max(1, autoBins | 0))
    N = Math.min(N, Math.max(1, Math.floor(maxE / baseW)))
    const W = maxE / N
    const counts = new Array(N).fill(0)
    for (let k = 0; k < n; k++) {
      let bi = Math.floor(((k + 0.5) * baseW) / W)
      if (bi >= N) bi = N - 1
      if (bi < 0) bi = 0
      counts[bi] += hist[k] || 0
    }
    return { counts, binW: W }
  }
  const group = Math.max(1, Math.round(1 / baseW))   // 10 fine bins per integer ΔE
  const N = Math.ceil(n / group)
  const counts = new Array(N).fill(0)
  for (let k = 0; k < n; k++) counts[Math.floor(k / group)] += hist[k] || 0
  return { counts, binW: 1 }
}

export default function RtHistogram({ hist, histBinW = 0.1, total, deLabel = 'ΔE' }) {
  const t = useT()
  const plotRef = useRef(null)
  const plotlyRef = useRef(null)

  const [mode, setMode] = useState(() => (localStorage.getItem(MODE_KEY) === 'auto' ? 'auto' : 'integer'))
  const [bins, setBins] = useState(() => {
    const b = parseInt(localStorage.getItem(BINS_KEY), 10)
    return (Number.isFinite(b) && b >= 1 && b <= 100) ? b : 20
  })
  const [dark, setDark] = useState(() => document.body.classList.contains('dark'))

  useEffect(() => { localStorage.setItem(MODE_KEY, mode) }, [mode])
  useEffect(() => { localStorage.setItem(BINS_KEY, String(bins)) }, [bins])

  // Theme flips → recolour (Plotly bakes concrete colours; it can't read CSS vars).
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.body.classList.contains('dark')))
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const { counts, binW } = useMemo(
    () => ((Array.isArray(hist) && hist.length) ? buildBins(hist, histBinW, mode, bins) : { counts: [], binW: 1 }),
    [hist, histBinW, mode, bins],
  )

  // Draw / redraw the plot when the data, bin mode, or theme changes. Height changes
  // do NOT hit this path — those go through onResize → Plotly.Plots.resize below.
  useEffect(() => {
    let cancelled = false
    const div = plotRef.current
    if (!div || !counts.length || !(total > 0)) return undefined
    ;(async () => {
      const Plotly = await loadPlotly()
      plotlyRef.current = Plotly
      if (cancelled || !plotRef.current) return
      const c = palette(dark)
      const nbins = counts.length
      const centers = counts.map((_, i) => (i + 0.5) * binW)
      const rel = counts.map((n) => n / total)
      let acc = 0
      const cum = counts.map((n) => (acc += n) / total)
      const cumX = [0, ...counts.map((_, i) => (i + 1) * binW)]
      const cumY = [0, ...cum]
      const xMax = nbins * binW
      const dtick = binW === 1 ? (nbins > 20 ? Math.ceil(nbins / 20) : 1) : undefined
      const fmtEdge = binW === 1 ? ((e) => String(e)) : ((e) => e.toFixed(2))
      const relLabel = t('relative_frequency') || 'Relative frequency'
      const cumLabel = t('cumulative_frequency') || 'Cumulative frequency'

      const barTrace = {
        type: 'bar', x: centers, y: rel, name: relLabel,
        marker: { color: c.bar, line: { color: c.paperBg, width: 1 } }, width: binW, yaxis: 'y',
        customdata: counts.map((_, i) => `[${fmtEdge(i * binW)}, ${fmtEdge((i + 1) * binW)})`),
        hovertemplate: `${deLabel} %{customdata}<br>%{y:.1%}<extra></extra>`,
      }
      const lineTrace = {
        type: 'scatter', mode: 'lines+markers', x: cumX, y: cumY, name: cumLabel,
        line: { color: c.line, width: 2 }, marker: { color: c.line, size: 5 }, yaxis: 'y2',
        hovertemplate: `${deLabel} ≤ %{x}<br>%{y:.1%}<extra></extra>`,
      }
      const layout = {
        margin: { l: 56, r: 56, t: 10, b: 46 }, bargap: 0, autosize: true,
        xaxis: { title: { text: deLabel, font: { color: c.font }, standoff: 4 },
          dtick, tick0: 0, range: [0, xMax], zeroline: false, showgrid: false, tickfont: { color: c.font } },
        yaxis: { title: { text: relLabel, font: { color: c.font }, standoff: 4 },
          rangemode: 'tozero', tickformat: '.0%', showgrid: true, gridcolor: c.grid, tickfont: { color: c.font } },
        yaxis2: { title: { text: cumLabel, font: { color: c.font }, standoff: 4 },
          overlaying: 'y', side: 'right', range: [0, 1.02], tickformat: '.0%', showgrid: false, tickfont: { color: c.font } },
        showlegend: true, legend: { orientation: 'h', x: 0, y: 1.12, font: { color: c.font } },
        plot_bgcolor: c.plotBg, paper_bgcolor: c.paperBg, font: { color: c.font },
      }
      Plotly.react(plotRef.current, [barTrace, lineTrace], layout, { responsive: true, displayModeBar: false })
    })()
    return () => { cancelled = true }
  }, [counts, binW, total, deLabel, dark, t])

  // Free Plotly's DOM nodes + listeners when this histogram unmounts.
  useEffect(() => () => {
    const d = plotRef.current
    if (d && plotlyRef.current) { try { plotlyRef.current.purge(d) } catch { /* already gone */ } }
  }, [])

  // ResizablePlot calls this on a height drag AND on any container width change
  // (e.g. the profiles pane collapsing) — re-lay Plotly out to the new box size.
  const onResize = useCallback(() => {
    const d = plotRef.current
    if (d && plotlyRef.current && d._fullLayout) plotlyRef.current.Plots.resize(d)
  }, [])

  const onBinsChange = (v) => {
    let n = parseInt(v, 10)
    if (!Number.isFinite(n)) n = 20
    setBins(Math.min(100, Math.max(1, n)))
  }

  return (
    <div>
      <div className={styles.controls}>
        <span className={styles.ctlLabel}>{t('hist_x_scale') || 'Horizontal scale'}</span>
        <label className={styles.radio}>
          <input type="radio" name="rt-hist-mode" checked={mode === 'integer'} onChange={() => setMode('integer')} />
          <span>{t('hist_integer_de') || 'Integer ΔE'}</span>
        </label>
        <label className={styles.radio}>
          <input type="radio" name="rt-hist-mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
          <span>{t('hist_auto_scale') || 'Auto-scale'}</span>
        </label>
        {mode === 'auto' && (
          <span className={styles.binsWrap}>
            <span>{t('hist_bins') || 'Bins'}</span>
            <input type="number" min="1" max="100" step="1" value={bins}
                   onChange={(e) => onBinsChange(e.target.value)} className={styles.binsInput} />
          </span>
        )}
      </div>
      <ResizablePlot storageKey={HEIGHT_KEY} onResize={onResize} defaultH={420} minH={240} maxH={1200}>
        <div ref={plotRef} style={{ width: '100%', height: '100%' }} />
      </ResizablePlot>
    </div>
  )
}
