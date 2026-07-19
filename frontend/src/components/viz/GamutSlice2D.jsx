// (c) 2026 William Li
//
// 2-D gamut slice — a faithful port of chardata's renderSlicePlot, boundary ONLY: for
// each profile, the convex hull of the gamut's intersection with a constant-L*/a*/b*
// plane, drawn as a translucent filled polygon (color+'33', line width 2). NO data
// points, no thickness/falloff — just the gamut-boundary slice. SVG Plotly (no WebGL).
//
// Plane→plot mapping (L* kept vertical for a*/b* slices), matching chardata:
//   axis 0  L* → x=a*, y=b*  (equal-aspect)
//   axis 1  a* → x=b*, y=L*
//   axis 2  b* → x=a*, y=L*
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n.jsx'
import ResizablePlot from './ResizablePlot.jsx'
import { loadPlotly } from './plotly.js'
import { sliceHull } from '../../lib/gamutGeom.js'

const AXES = [
  { xlabel: 'a*', ylabel: 'b*', equal: true },   // L* slice
  { xlabel: 'b*', ylabel: 'L*', equal: false },  // a* slice
  { xlabel: 'a*', ylabel: 'L*', equal: false },  // b* slice
]

function theme(dark) {
  return dark
    ? { grid: '#2e2f34', plotBg: '#1e1f22', paperBg: '#1a1b1e', font: '#bbb', frame: '#3a3b40' }
    : { grid: '#eef1f6', plotBg: '#ffffff', paperBg: '#ffffff', font: '#445', frame: '#d6dbe6' }
}
const pad = (lo, hi) => { const d = (hi - lo) * 0.05 || 5; return [lo - d, hi + d] }

export default function GamutSlice2D({ meshes, bounds, axis, value }) {
  const t = useT()
  const plotRef = useRef(null)
  const plotlyRef = useRef(null)
  const [dark, setDark] = useState(() => document.body.classList.contains('dark'))
  const A = AXES[axis] || AXES[0]

  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.body.classList.contains('dark')))
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const ranges = useMemo(() => {
    if (!bounds) return null
    const Ap = pad(bounds.a[0], bounds.a[1]), Bp = pad(bounds.b[0], bounds.b[1]), Lp = pad(bounds.L[0], bounds.L[1])
    if (axis === 0) return { x: Ap, y: Bp }
    if (axis === 1) return { x: Bp, y: Lp }
    return { x: Ap, y: Lp }
  }, [bounds, axis])

  useEffect(() => {
    let cancelled = false
    if (!plotRef.current || !ranges) return undefined
    ;(async () => {
      const Plotly = await loadPlotly()
      plotlyRef.current = Plotly
      if (cancelled || !plotRef.current) return
      const c = theme(dark)
      const traces = []
      for (const m of meshes) {
        const s = sliceHull(m.mesh, axis, value)
        if (!s || s.hull.length < 3) continue
        const hx = s.hull.map((p) => p[0]).concat([s.hull[0][0]])
        const hy = s.hull.map((p) => p[1]).concat([s.hull[0][1]])
        traces.push({
          type: 'scatter', x: hx, y: hy, name: m.name, mode: 'lines',
          fill: 'toself', fillcolor: m.color + '33', line: { color: m.color, width: 2 },
          showlegend: false, hovertemplate: '%{x:.2f}, %{y:.2f}<extra></extra>',
        })
      }

      const axisCfg = (title, range, extra) => ({
        title: { text: title, font: { color: c.font }, standoff: 4 },
        range, zeroline: true, zerolinecolor: c.frame, showgrid: true, gridcolor: c.grid,
        linecolor: c.frame, tickfont: { color: c.font }, ...extra,
      })
      const layout = {
        margin: { l: 54, r: 16, t: 12, b: 46 }, autosize: true,
        xaxis: axisCfg(A.xlabel, ranges.x, A.equal ? { scaleanchor: 'y', scaleratio: 1 } : {}),
        yaxis: axisCfg(A.ylabel, ranges.y, {}),
        showlegend: false, plot_bgcolor: c.plotBg, paper_bgcolor: c.paperBg,
        font: { color: c.font }, hovermode: 'closest',
      }
      Plotly.react(plotRef.current, traces, layout, { responsive: true, displayModeBar: false })
    })()
    return () => { cancelled = true }
  }, [meshes, ranges, axis, value, dark, A])

  useEffect(() => () => {
    const d = plotRef.current
    if (d && plotlyRef.current) { try { plotlyRef.current.purge(d) } catch { /* gone */ } }
  }, [])

  const onResize = () => {
    const d = plotRef.current
    if (d && plotlyRef.current && d._fullLayout) plotlyRef.current.Plots.resize(d)
  }

  return (
    <ResizablePlot storageKey="profiletool.gamutSliceHeight" onResize={onResize} defaultH={400} minH={260} maxH={1200}>
      <div ref={plotRef} style={{ width: '100%', height: '100%' }} aria-label={t('gamut_2d_title') || '2-D gamut slice'} />
    </ResizablePlot>
  )
}
