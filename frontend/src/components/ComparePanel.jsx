// (c) 2026 William Li
//
// Compare tab — the sole home for gamut (P1-b): a 3-D gamut shell STACKED OVER a 2-D
// gamut slice, overlaying 1..N profiles from the tab accumulator in distinct colours.
// Both are faithful Plotly ports of chardata's renderPlot / renderSlicePlot, driven by
// the iccviz boundary MESH (device→PCS→Lab via IccProfLib; NO lcms2 — DL-SCOPE1). The
// mesh is built from the PROFILE (LUT or matrix/TRC), so matrix displays (AdobeRGB)
// render too. The 3-D shell is Plotly WebGL (needs 'unsafe-eval' — see index.html CSP
// note); the 2-D slice is SVG Plotly. Neither shows data points — gamut only.
import { useEffect, useMemo, useState } from 'react'
import { gamutMesh } from '../lib/vizPlot.js'
import { meshBounds, unionBounds } from '../lib/gamutGeom.js'
import GamutPlot3D from './viz/GamutPlot3D.jsx'
import GamutSlice2D from './viz/GamutSlice2D.jsx'
import styles from './ComparePanel.module.css'

// Rendering intents (ICC order). The mesh is built from the profile at the intent —
// no per-profile tag selection (matrix profiles have no AToB tag).
const INTENTS = [
  { intent: 0, key: 'intent_perceptual', fallback: 'Perceptual' },
  { intent: 1, key: 'intent_relative',   fallback: 'Relative Colorimetric' },
  { intent: 2, key: 'intent_saturation', fallback: 'Saturation' },
  { intent: 3, key: 'intent_absolute',   fallback: 'Absolute Colorimetric' },
]

// Distinct per-profile colours — first two match chardata's slots (a=blue, b=red).
const PALETTE = ['#4a90e2', '#e24a4a', '#3a9a3a', '#d98a1f', '#8e5ad0', '#17a2a2', '#c0508a', '#6b8e23']

const SLICE_AXES = [
  { axis: 0, key: 'gamut_slice_L', fallback: 'L*', comp: 'L' },
  { axis: 1, key: 'gamut_slice_a', fallback: 'a*', comp: 'a' },
  { axis: 2, key: 'gamut_slice_b', fallback: 'b*', comp: 'b' },
]

const meshCache = new WeakMap()   // bytes -> Map<intent, {mesh,bounds}|{meshError}>
function cacheGet(bytes, key) { const m = meshCache.get(bytes); return m ? m.get(key) : undefined }
function cacheSet(bytes, key, val) {
  let m = meshCache.get(bytes)
  if (!m) { m = new Map(); meshCache.set(bytes, m) }
  m.set(key, val)
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

export default function ComparePanel({ ids, getEntry, t }) {
  const [intent, setIntent] = useState(1)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [hidden, setHidden] = useState(() => new Set())
  // 3-D controls (chardata parity).
  const [shell, setShell] = useState(true)
  const [wire, setWire] = useState(false)
  const [opacity, setOpacity] = useState(0.55)
  const [colorBy, setColorBy] = useState('solid')
  const [rotMode, setRotMode] = useState('turntable')
  const [rollEnabled, setRollEnabled] = useState(false)
  const [rollSens, setRollSens] = useState(0.4)
  const [dragSens, setDragSens] = useState(1.0)
  const [axisNumbers, setAxisNumbers] = useState(false)   // numeric axis labels (default off)
  // Slice controls.
  const [sliceIdx, setSliceIdx] = useState(0)
  const [sliceVal, setSliceVal] = useState(50)

  const profiles = useMemo(
    () => ids.map((id, i) => {
      const e = getEntry(id)
      return e ? { id, name: e.filename, bytes: e.currentBytes, color: PALETTE[i % PALETTE.length] } : null
    }).filter(Boolean),
    [ids, getEntry],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const out = []
      for (const p of profiles) {
        let res = cacheGet(p.bytes, intent)
        if (!res) {
          try {
            const m = await gamutMesh(p.bytes, intent)
            res = { mesh: m, bounds: meshBounds(m) }
          } catch (e) { res = { meshError: e.message } }
          cacheSet(p.bytes, intent, res)
        }
        out.push({ ...p, ...res })
      }
      if (!cancelled) { setItems(out); setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [profiles, intent])

  const visible = useMemo(() => items.filter((it) => it.mesh && !hidden.has(it.id)), [items, hidden])
  const bounds = useMemo(() => unionBounds(visible.map((it) => it.bounds)), [visible])
  const meshes = useMemo(
    () => visible.map((it) => ({ id: it.id, name: it.name, color: it.color, mesh: it.mesh })),
    [visible],
  )

  const sliceDef = SLICE_AXES[sliceIdx]
  const sliceRange = useMemo(() => {
    if (!bounds) return { min: 0, max: 100 }
    const r = bounds[sliceDef.comp]
    return { min: Math.floor(r[0]), max: Math.ceil(r[1]) }
  }, [bounds, sliceDef])
  useEffect(() => { setSliceVal((v) => clamp(v, sliceRange.min, sliceRange.max)) }, [sliceRange])

  const toggle = (id) => setHidden((h) => {
    const n = new Set(h)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  if (!profiles.length) return null
  const intentLabel = (s) => t(s.key) || s.fallback

  return (
    <div className={styles.wrap}>
      {/* ── intent + legend ────────────────────────────────────────── */}
      <div className={styles.controls}>
        <label className={styles.ctl}>
          <span>{t('gamut_intent') || 'Rendering intent'}</span>
          <select value={intent} onChange={(e) => setIntent(Number(e.target.value))}>
            {INTENTS.map((s) => <option key={s.intent} value={s.intent}>{intentLabel(s)}</option>)}
          </select>
        </label>
        {loading && <span className={styles.loading}>{t('gamut_loading') || 'Building gamut…'}</span>}
      </div>

      <div className={styles.legend}>
        {items.map((it) => (
          <label key={it.id} className={`${styles.legendItem} ${(hidden.has(it.id) || !it.mesh) ? styles.legendOff : ''}`}
                 title={it.meshError ? (t('gamut_no_gamut') || 'no gamut') : (t('gamut_toggle') || 'Show / hide')}>
            <input type="checkbox" checked={!!it.mesh && !hidden.has(it.id)} disabled={!it.mesh} onChange={() => toggle(it.id)} />
            <span className={styles.swatch} style={{ background: it.mesh ? it.color : '#aaa' }} />
            <span className={styles.legendName}>{it.name}</span>
            {it.meshError && <span className={styles.legendTag}>{t('gamut_no_gamut') || 'no gamut'}</span>}
          </label>
        ))}
      </div>

      {bounds ? (
        <div className={styles.plots}>
          {/* ── 3-D shell (top) ──────────────────────────────────── */}
          <section className={styles.plotBox}>
            <div className={styles.sliceHead}>
              <h4 className={styles.plotTitle}>{t('gamut_3d_title') || '3-D gamut shell'}</h4>
              <div className={styles.sliceCtl}>
                <label className={styles.chk}><input type="checkbox" checked={shell} onChange={(e) => setShell(e.target.checked)} /> <span>{t('gamut_shell') || 'Shell'}</span></label>
                <label className={styles.chk}><input type="checkbox" checked={wire} onChange={(e) => setWire(e.target.checked)} /> <span>{t('gamut_wireframe') || 'Wireframe'}</span></label>
                <label className={styles.chk}><input type="checkbox" checked={axisNumbers} onChange={(e) => setAxisNumbers(e.target.checked)} /> <span>{t('gamut_axis_numbers') || 'Axis numbers'}</span></label>
                <span className={styles.ctlLabel}>{t('gamut_color_by') || 'Colour'}</span>
                <select value={colorBy} onChange={(e) => setColorBy(e.target.value)} className={styles.mini}>
                  <option value="solid">{t('gamut_color_solid') || 'Solid'}</option>
                  <option value="value">{t('gamut_color_value') || 'By value'}</option>
                  <option value="hue">{t('gamut_color_hue') || 'By hue'}</option>
                </select>
                <span className={styles.ctlLabel}>{t('gamut_opacity') || 'Opacity'}</span>
                <input type="range" min="0.15" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className={styles.sliceSlider} />
              </div>
              <div className={styles.sliceCtl}>
                <span className={styles.ctlLabel}>{t('gamut_rotation') || 'Rotation'}</span>
                <label className={styles.radio}><input type="radio" name="rotmode" checked={rotMode === 'turntable'} onChange={() => setRotMode('turntable')} /> <span>{t('gamut_turntable') || 'Turntable'}</span></label>
                <label className={styles.radio}><input type="radio" name="rotmode" checked={rotMode === 'orbit'} onChange={() => setRotMode('orbit')} /> <span>{t('gamut_orbit') || 'Orbit'}</span></label>
                <span className={styles.ctlLabel}>{t('gamut_drag_sens') || 'Drag speed'}</span>
                <input type="range" min="0.1" max="3" step="0.1" value={dragSens} onChange={(e) => setDragSens(Number(e.target.value))} className={styles.sliceSlider} />
                <label className={styles.chk}><input type="checkbox" checked={rollEnabled} onChange={(e) => setRollEnabled(e.target.checked)} /> <span>{t('gamut_roll') || 'Roll'}</span></label>
                <span className={styles.ctlLabel}>{t('gamut_roll_sens') || 'Roll speed'}</span>
                <input type="range" min="0.05" max="2" step="0.05" value={rollSens} disabled={!rollEnabled} onChange={(e) => setRollSens(Number(e.target.value))} className={styles.sliceSlider} />
              </div>
            </div>
            <GamutPlot3D meshes={meshes} bounds={bounds}
                         controls={{ shell, wire, opacity, colorBy, rotMode, rollEnabled, rollSens, dragSens, axisNumbers }} />
          </section>

          {/* ── 2-D slice (bottom) ───────────────────────────────── */}
          <section className={styles.plotBox}>
            <div className={styles.sliceHead}>
              <h4 className={styles.plotTitle}>{t('gamut_2d_title') || '2-D gamut slice'} — {sliceDef.fallback} = {sliceVal}</h4>
              <div className={styles.sliceCtl}>
                <span className={styles.ctlLabel}>{t('gamut_slice_axis') || 'Plane'}</span>
                {SLICE_AXES.map((s, i) => (
                  <label key={s.axis} className={styles.radio}>
                    <input type="radio" name="sliceaxis" checked={sliceIdx === i} onChange={() => setSliceIdx(i)} />
                    <span>{t(s.key) || s.fallback}</span>
                  </label>
                ))}
                <input type="range" min={sliceRange.min} max={sliceRange.max} step="1" value={sliceVal}
                       onChange={(e) => setSliceVal(Number(e.target.value))} className={styles.sliceSlider} />
              </div>
            </div>
            <GamutSlice2D meshes={meshes} bounds={bounds} axis={sliceDef.axis} value={sliceVal} />
          </section>
        </div>
      ) : !loading ? (
        <p className={styles.noGamut}>
          {t('gamut_none') || 'None of the selected profiles has a device→PCS transform to derive a gamut from.'}
        </p>
      ) : null}
    </div>
  )
}
