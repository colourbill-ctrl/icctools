// (c) 2026 William Li
//
// 3-D gamut shell — a faithful port of chardata's renderPlot: a Plotly WebGL scene
// showing ONLY the gamut (mesh3d shell + deduped-edge wireframe — NO data points),
// overlaying 1..N profiles, with custom axis lines through the NEUTRAL origin (0,0,0)
// and the scene's own axes hidden. Plotly's gl path needs 'unsafe-eval' (see the
// index.html CSP note) — this is the ONE WebGL view; every other plot stays SVG-only.
//
// Controls (chardata parity): colour by solid / value / hue; rotation mode
// (turntable / orbit); enable roll + roll sensitivity; drag-rotate sensitivity. The
// rotation controls act on Plotly's live gl3d camera (rotateSpeed + .rotate()).
//
// Vertex convention: the iccviz mesh is interleaved [L*, a*, b*]; Plotly plots
// x=a*, y=b*, z=L* (chardata's mapping).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n.jsx'
import ResizablePlot from './ResizablePlot.jsx'
import { loadPlotly } from './plotly.js'

function theme(dark) {
  return dark
    ? { sceneBg: '#1a1b1e', paperBg: '#1a1b1e', axis: '#8a8f99', label: '#ccd' }
    : { sceneBg: '#ffffff', paperBg: '#ffffff', axis: '#5a6472', label: '#334' }
}

// Lab → sRGB hex (D65), ported from chardata labToRgb — the "colour by value" mode.
function labToRgb(L, a, b) {
  const Xn = 0.9505, Yn = 1.0, Zn = 1.089
  const f = (tt) => (tt > 0.008856 ? tt ** 3 : (tt - 16 / 116) / 7.787)
  const fy = (L + 16) / 116
  const X = Xn * f(a / 500 + fy), Y = Yn * f(fy), Z = Zn * f(fy - b / 200)
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
  let g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
  let bv = 0.0557 * X - 0.204 * Y + 1.057 * Z
  const gc = (v) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
  const hex = (v) => Math.round(gc(v) * 255).toString(16).padStart(2, '0')
  return '#' + hex(r) + hex(g) + hex(bv)
}
// Hue angle → saturated HSL, ported from chardata hueToColor — the "colour by hue" mode.
const hueToColor = (a, b) => `hsl(${(((Math.atan2(b, a) * 180) / Math.PI + 360) % 360).toFixed(1)},90%,45%)`

function meshArrays(mesh) {
  const V = mesh.vertices, T = mesh.triangles
  const n = V.length / 3
  const ax = new Array(n), bx = new Array(n), lx = new Array(n)
  // finite[i] tracks whether vertex i is drawable — the engine emits an out-of-gamut /
  // non-invertible cube sample as a NaN vertex, and any triangle touching one must be
  // dropped (same contract the 2-D slice honours via gamutGeom finiteV). Feeding NaN to
  // Plotly's mesh3d/wireframe is undefined — it can render stray facets or holes.
  const finite = new Array(n)
  for (let i = 0; i < n; i++) {
    const L = V[i * 3], a = V[i * 3 + 1], b = V[i * 3 + 2]
    lx[i] = L; ax[i] = a; bx[i] = b
    finite[i] = Number.isFinite(L) && Number.isFinite(a) && Number.isFinite(b)
  }
  const m = T.length / 3
  const ti = [], tj = [], tk = []
  for (let i = 0; i < m; i++) {
    const p = T[i * 3], q = T[i * 3 + 1], s = T[i * 3 + 2]
    if (finite[p] && finite[q] && finite[s]) { ti.push(p); tj.push(q); tk.push(s) }
  }
  return { ax, bx, lx, ti, tj, tk }
}

// Per-vertex colours for value/hue modes (null for solid → the trace uses m.color).
function vertexColors(arr, colorBy) {
  if (colorBy === 'solid') return null
  const { ax, bx, lx } = arr
  return ax.map((a, i) => (colorBy === 'value' ? labToRgb(lx[i], a, bx[i]) : hueToColor(a, bx[i])))
}

function wireframeSegments(arr, vcol) {
  const { ax, bx, lx, ti, tj, tk } = arr
  const seen = new Set()
  const wx = [], wy = [], wz = [], wc = []
  const add = (p, q) => {
    const key = p < q ? p * 1e7 + q : q * 1e7 + p
    if (seen.has(key)) return
    seen.add(key)
    wx.push(ax[p], ax[q], null); wy.push(bx[p], bx[q], null); wz.push(lx[p], lx[q], null)
    if (vcol) wc.push(vcol[p], vcol[q], vcol[q])
  }
  for (let i = 0; i < ti.length; i++) { add(ti[i], tj[i]); add(tj[i], tk[i]); add(tk[i], ti[i]) }
  return { wx, wy, wz, wc }
}

const pad = (lo, hi) => { const d = (hi - lo) * 0.05 || 5; return [lo - d, hi + d] }
const niceInterval = (span) => {
  const raw = span / 8, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag
  return mag * (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10)
}
const tickPositions = (range, interval) => {
  const ticks = []
  const start = Math.ceil((range[0] + 1e-9) / interval) * interval
  for (let tp = start; tp < range[1] - 1e-9; tp += interval)
    if (Math.abs(tp) > interval * 0.01) ticks.push(parseFloat(tp.toFixed(8)))
  return ticks
}

export default function GamutPlot3D({ meshes, bounds, controls }) {
  const t = useT()
  const plotRef = useRef(null)
  const plotlyRef = useRef(null)
  const [dark, setDark] = useState(() => document.body.classList.contains('dark'))
  const {
    shell = true, wire = true, opacity = 0.55, colorBy = 'solid',
    rotMode = 'turntable', rollEnabled = false, rollSens = 0.4, dragSens = 1.0,
  } = controls || {}
  // Live-camera knobs read by the (once-attached) roll handler + the sens effects.
  const rollRef = useRef({ enabled: rollEnabled, sens: rollSens })
  const dragRef = useRef(dragSens)
  const rollAttached = useRef(false)

  useEffect(() => { rollRef.current = { enabled: rollEnabled, sens: rollSens } }, [rollEnabled, rollSens])

  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.body.classList.contains('dark')))
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  const arrays = useMemo(() => meshes.map((m) => ({ ...m, arr: meshArrays(m.mesh) })), [meshes])
  const axisRanges = useMemo(() => {
    if (!bounds) return null
    return {
      x: pad(bounds.a[0], bounds.a[1]),
      y: pad(bounds.b[0], bounds.b[1]),
      z: [Math.min(0, bounds.L[0]), bounds.L[1] + (bounds.L[1] - bounds.L[0]) * 0.05 || 5],
    }
  }, [bounds])

  const getCamera = () => {
    const el = plotRef.current
    try { return (el && el._fullLayout && el._fullLayout.scene && el._fullLayout.scene._scene && el._fullLayout.scene._scene.camera) || null }
    catch { return null }
  }

  // Trace + scene build (re-renders on data / appearance change; camera persists via uirevision).
  useEffect(() => {
    let cancelled = false
    if (!plotRef.current || !axisRanges) return undefined
    ;(async () => {
      const Plotly = await loadPlotly()
      plotlyRef.current = Plotly
      if (cancelled || !plotRef.current) return
      const c = theme(dark)
      const traces = []

      for (const m of arrays) {
        const { ax, bx, lx, ti, tj, tk } = m.arr
        const vcol = vertexColors(m.arr, colorBy)
        if (shell) {
          const tr = {
            type: 'mesh3d', name: m.name + ' shell', showlegend: false,
            x: ax, y: bx, z: lx, i: ti, j: tj, k: tk,
            opacity, flatshading: false, hoverinfo: 'skip',
            lighting: { ambient: 0.6, diffuse: 0.85, specular: 0.12, roughness: 0.5, fresnel: 0.2 },
          }
          if (vcol) tr.vertexcolor = vcol; else tr.color = m.color
          traces.push(tr)
        }
      }
      for (const m of arrays) {
        if (!wire) continue
        const vcol = vertexColors(m.arr, colorBy)
        const { wx, wy, wz, wc } = wireframeSegments(m.arr, vcol)
        traces.push({
          type: 'scatter3d', mode: 'lines', name: m.name + ' wireframe', showlegend: false,
          x: wx, y: wy, z: wz, line: { color: wc.length ? wc : m.color, width: 1.5 }, hoverinfo: 'skip',
        })
      }

      // Custom axis lines / ticks / labels through the neutral origin (0,0,0).
      const { x: xR, y: yR, z: zR } = axisRanges
      const mkLine = (x, y, z) => ({ type: 'scatter3d', mode: 'lines', x, y, z, line: { color: c.axis, width: 5 }, hoverinfo: 'none', showlegend: false })
      const mkTicks = (positions, ax, tickLen) => {
        const xs = [], ys = [], zs = []
        positions.forEach((p) => {
          if (ax === 'x') { xs.push(p, p, null); ys.push(-tickLen, tickLen, null); zs.push(0, 0, null) }
          else if (ax === 'y') { xs.push(-tickLen, tickLen, null); ys.push(p, p, null); zs.push(0, 0, null) }
          else { xs.push(-tickLen, tickLen, null); ys.push(0, 0, null); zs.push(p, p, null) }
        })
        return { type: 'scatter3d', mode: 'lines', x: xs, y: ys, z: zs, line: { color: c.axis, width: 2 }, hoverinfo: 'none', showlegend: false }
      }
      const mkLabel = (x, y, z, txt) => ({ type: 'scatter3d', mode: 'text', x: [x], y: [y], z: [z], text: [txt], textfont: { color: c.label, size: 13 }, hoverinfo: 'none', showlegend: false })
      const tickLen = Math.max(xR[1] - xR[0], yR[1] - yR[0], zR[1] - zR[0]) * 0.025
      traces.push(
        mkLine([xR[0], xR[1]], [0, 0], [0, 0]), mkLine([0, 0], [yR[0], yR[1]], [0, 0]), mkLine([0, 0], [0, 0], [0, zR[1]]),
        mkTicks(tickPositions(xR, niceInterval(xR[1] - xR[0])), 'x', tickLen),
        mkTicks(tickPositions(yR, niceInterval(yR[1] - yR[0])), 'y', tickLen),
        mkTicks(tickPositions(zR, niceInterval(zR[1] - zR[0])), 'z', tickLen),
        mkLabel(xR[1], 0, 0, 'a*'), mkLabel(0, yR[1], 0, 'b*'), mkLabel(0, 0, zR[1], 'L*'),
      )

      const axisBase = { showbackground: false, showgrid: false, showline: false, zeroline: false, showticklabels: false, title: { text: '' } }
      const layout = {
        margin: { t: 8, r: 8, b: 8, l: 8 }, autosize: true, uirevision: 'gamut',
        scene: {
          bgcolor: c.sceneBg, dragmode: rotMode, aspectmode: 'data',
          xaxis: { ...axisBase, range: xR }, yaxis: { ...axisBase, range: yR }, zaxis: { ...axisBase, range: zR },
        },
        showlegend: false, paper_bgcolor: c.paperBg,
      }
      await Plotly.react(plotRef.current, traces, layout, { responsive: true, displayModeBar: false })
      if (cancelled) return
      // Re-apply live-camera drag speed (the camera object is fresh after react).
      const cam = getCamera()
      if (cam) cam.rotateSpeed = dragRef.current
      // Attach the capture-phase roll interceptor once (chardata attachPlotRollWheel).
      if (!rollAttached.current && plotRef.current) {
        plotRef.current.addEventListener('wheel', onRollWheel, { capture: true, passive: false })
        rollAttached.current = true
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrays, axisRanges, dark, shell, wire, opacity, colorBy])

  // Rotation mode → relayout the live scene (no re-render, no view reset — chardata onPlotRotMode).
  useEffect(() => {
    const el = plotRef.current, Plotly = plotlyRef.current
    if (el && Plotly && el._fullLayout && el._fullLayout.scene) Plotly.relayout(el, { 'scene.dragmode': rotMode })
  }, [rotMode])

  // Drag-orbit sensitivity → the live camera's rotateSpeed (chardata applyPlotDragSpeed).
  useEffect(() => { dragRef.current = dragSens; const cam = getCamera(); if (cam) cam.rotateSpeed = dragSens }, [dragSens])

  // Roll wheel: intercept horizontal-dominant wheels; roll the camera (chardata
  // _onPlotRollWheel). Stable identity (useCallback []) so add/removeEventListener
  // pair correctly on unmount; it reads live values through refs.
  const onRollWheel = useCallback((ev) => {
    if (Math.abs(ev.deltaX) <= Math.abs(ev.deltaY)) return   // vertical → let Plotly zoom
    ev.preventDefault(); ev.stopPropagation()
    if (!rollRef.current.enabled) return
    const el = plotRef.current
    const cam = el && el._fullLayout && el._fullLayout.scene && el._fullLayout.scene._scene && el._fullLayout.scene._scene.camera
    if (cam && typeof cam.rotate === 'function') cam.rotate(0, 0, ev.deltaX * Math.PI * rollRef.current.sens / window.innerWidth)
  }, [])

  useEffect(() => () => {
    const d = plotRef.current
    if (d) { try { d.removeEventListener('wheel', onRollWheel, { capture: true }) } catch { /* noop */ } }
    if (d && plotlyRef.current) { try { plotlyRef.current.purge(d) } catch { /* gone */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onResize = () => {
    const d = plotRef.current
    if (d && plotlyRef.current && d._fullLayout) plotlyRef.current.Plots.resize(d)
  }

  return (
    <ResizablePlot storageKey="profiletool.gamut3dHeight" onResize={onResize} defaultH={460} minH={280} maxH={1400}>
      <div ref={plotRef} style={{ width: '100%', height: '100%' }} aria-label={t('gamut_3d_title') || '3-D gamut shell'} />
    </ResizablePlot>
  )
}
