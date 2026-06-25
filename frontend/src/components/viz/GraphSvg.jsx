// (c) William Li 2026
import { useMemo, useState } from 'react'
import { colorFor } from './colors.js'
import styles from './GraphSvg.module.css'

/**
 * Generalized SVG renderer for an IccVizModel-style graph:
 *   graph = { title, description, xAxis:{label,min,max,equalAspect}, yAxis, series[] }
 * Each series may carry an explicit `color` (LUT curve traces set this); otherwise
 * the colour comes from colorFor(series).
 *
 * Props:
 *   graph     — the graph object (series mixed Primary + Hint).
 *   highlight — optional: emphasize the point/series whose vertex label or
 *               colorHint/id matches (case-insensitive); dim the rest. Used by the
 *               chromaticity plot shown under the white-point / colorant tags.
 *   legend    — optional: show an interactive legend with per-series on/off toggles.
 */
export default function GraphSvg({ graph, highlight, legend = false }) {
  const [hidden, setHidden] = useState(() => new Set())
  const hl = highlight ? String(highlight).toLowerCase() : null

  const W = 520
  const m = { l: 46, r: 16, t: 10, b: 34 }
  const pw = W - m.l - m.r
  const ph = graph.xAxis.equalAspect ? pw : 300
  const H = ph + m.t + m.b

  const xmin = graph.xAxis.min, xmax = graph.xAxis.max
  const ymin = graph.yAxis.min, ymax = graph.yAxis.max
  const sx = (x) => m.l + ((x - xmin) / (xmax - xmin || 1)) * pw
  const sy = (y) => m.t + ph - ((y - ymin) / (ymax - ymin || 1)) * ph

  const grid = useMemo(() => {
    const fr = [0, 0.25, 0.5, 0.75, 1]
    const g = []
    fr.forEach((f, i) => {
      const gx = m.l + f * pw, gy = m.t + f * ph
      g.push(<line key={`vx${i}`} x1={gx} y1={m.t} x2={gx} y2={m.t + ph} className={styles.grid} />)
      g.push(<line key={`hz${i}`} x1={m.l} y1={gy} x2={m.l + pw} y2={gy} className={styles.grid} />)
    })
    return g
  }, [pw, ph])

  const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2))
  const seriesColor = (s) => s.color || colorFor(s)
  const dimmed = (s) => hl != null && (s.colorHint || '').toLowerCase() !== hl && (s.id || '').toLowerCase() !== hl

  const drawn = []
  // hint first, then primary, so data sits on top
  const ordered = [...graph.series].sort((a, b) => (a.role === 'hint' ? 0 : 1) - (b.role === 'hint' ? 0 : 1))
  for (const s of ordered) {
    if (hidden.has(s.id)) continue
    const color = seriesColor(s)
    const pts = s.points
    const labelMap = new Map((s.labels || []).map((l) => [l.i, l]))
    if (s.shape === 'polyline' || s.shape === 'closedPath') {
      let str = ''
      for (let i = 0; i < pts.length; i += 2) str += `${sx(pts[i]).toFixed(1)},${sy(pts[i + 1]).toFixed(1)} `
      const op = dimmed(s) ? 0.3 : 1
      const common = { points: str.trim(), fill: 'none', stroke: color, strokeWidth: s.role === 'hint' ? 1 : 1.8, opacity: op }
      drawn.push(s.shape === 'closedPath'
        ? <polygon key={s.id} {...common} strokeLinejoin="round" />
        : <polyline key={s.id} {...common} strokeLinejoin="round" />)
    } else { // scatter
      const marks = []
      for (let i = 0, v = 0; i < pts.length; i += 2, v++) {
        const px = sx(pts[i]), py = sy(pts[i + 1])
        const lab = labelMap.get(v)
        const isHit = hl != null && lab && lab.t && lab.t.toLowerCase() === hl
        const isMiss = hl != null && !isHit
        const r = s.role === 'hint' ? 1.5 : (isHit ? 5 : 3)
        if (isHit) marks.push(<circle key={`r${v}`} cx={px} cy={py} r={r + 3} fill="none" stroke={color} strokeWidth={1.5} />)
        marks.push(<circle key={`c${v}`} cx={px} cy={py} r={r} fill={color} opacity={isMiss ? 0.35 : 1} />)
        if (lab && lab.t) marks.push(
          <text key={`t${v}`} x={px + 4} y={py - 3} className={styles.pointLabel}
                fill={color} opacity={isMiss ? 0.5 : 1} fontWeight={isHit ? 700 : 400}>{lab.t}</text>)
      }
      drawn.push(<g key={s.id} opacity={dimmed(s) ? 0.4 : 1}>{marks}</g>)
    }
  }

  // legend: skip hint geometry that has no useful name
  const legendSeries = legend ? graph.series.filter((s) => s.name) : []

  return (
    <div className={styles.wrap}>
      <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={graph.title}>
        <rect x={m.l} y={m.t} width={pw} height={ph} className={styles.frame} />
        {grid}
        {drawn}
        <text x={m.l} y={m.t + ph + 14} className={styles.axisVal} textAnchor="start">{fmt(xmin)}</text>
        <text x={m.l + pw} y={m.t + ph + 14} className={styles.axisVal} textAnchor="end">{fmt(xmax)}</text>
        <text x={m.l + pw / 2} y={m.t + ph + 28} className={styles.axisLabel} textAnchor="middle">{graph.xAxis.label}</text>
        <text x={m.l - 6} y={m.t + ph} className={styles.axisVal} textAnchor="end">{fmt(ymin)}</text>
        <text x={m.l - 6} y={m.t + 8} className={styles.axisVal} textAnchor="end">{fmt(ymax)}</text>
        <text transform={`translate(12 ${m.t + ph / 2}) rotate(-90)`} className={styles.axisLabel} textAnchor="middle">{graph.yAxis.label}</text>
        {graph.description && (
          <text x={m.l + pw} y={m.t + 12} className={styles.descLabel} textAnchor="end">{graph.description}</text>
        )}
      </svg>
      {legendSeries.length > 0 && (
        <div className={styles.legend}>
          {legendSeries.map((s) => {
            const off = hidden.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                className={`${styles.legendItem} ${off ? styles.legendOff : ''}`}
                onClick={() => setHidden((prev) => {
                  const next = new Set(prev)
                  next.has(s.id) ? next.delete(s.id) : next.add(s.id)
                  return next
                })}
                aria-pressed={!off}
              >
                <span className={styles.swatch} style={{ background: seriesColor(s), color: seriesColor(s) }} />
                {s.name}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
