import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import styles from './RasterCanvas.module.css'

const MIN_ZOOM = 0.25
const MAX_ZOOM = 64
const STEP = 1.25   // per button click / keyboard step

// Viewport (canvas display box) size bounds + persistence. The box is resizable
// via the corner grip; the chosen size is remembered across images and reloads.
const DEFAULT_W = 360
const DEFAULT_H = 320
const MIN_W = 240
const MIN_H = 180
const MAX_W = 1400
const MAX_H = 1200
const SIZE_KEY = 'profiletool.rasterSize'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function loadSize() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY))
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h))
      return { w: clamp(s.w, MIN_W, MAX_W), h: clamp(s.h, MIN_H, MAX_H) }
  } catch { /* ignore malformed/blocked storage */ }
  return { w: DEFAULT_W, h: DEFAULT_H }
}

/**
 * Draws a decoded raster (the CLUT lattice / gamut image) to a canvas, with
 * zoom + pan. `raster` is the output of decodeRaster(): { width, height, rgba,
 * photometric }. `caption` is an optional extra line (e.g. the gamut legend).
 *
 * The canvas bitmap is always the raster's NATIVE pixel size (drawn once via
 * putImageData); zoom/pan are a pure display transform on the canvas element, so
 * no re-render of the underlying samples is needed. `zoom` is relative to a
 * "fit" baseline (baseFit) that contains the native image in the viewport, so
 * 100% == fit-to-view and the reset button returns there.
 */
export default function RasterCanvas({ raster, caption }) {
  const canvasRef = useRef(null)
  const viewportRef = useRef(null)
  const baseFitRef = useRef(1)   // scale that fits native image in the viewport
  const drag = useRef(null)
  const resizing = useRef(null)

  const [size, setSize] = useState(loadSize)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // Mirror to refs so the native wheel listener / pointer handlers read latest.
  const zoomRef = useRef(zoom); zoomRef.current = zoom
  const panRef = useRef(pan); panRef.current = pan

  // Draw native pixels into the canvas bitmap once per raster.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = raster.width
    canvas.height = raster.height
    canvas.getContext('2d').putImageData(
      new ImageData(raster.rgba, raster.width, raster.height), 0, 0)
  }, [raster])

  // Remember the chosen viewport size across images and reloads.
  useEffect(() => {
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)) } catch { /* ignore */ }
  }, [size])

  // Keep pan so the image edges never pull away from the viewport edges.
  const clampPan = (p, z) => {
    const vp = viewportRef.current
    if (!vp) return p
    const s = baseFitRef.current * z
    const axis = (v, ext) => clamp(v, Math.min(0, ext), Math.max(0, ext))
    return {
      x: axis(p.x, vp.clientWidth - raster.width * s),
      y: axis(p.y, vp.clientHeight - raster.height * s),
    }
  }

  const centerPan = (z) => {
    const vp = viewportRef.current
    if (!vp) return { x: 0, y: 0 }
    const s = baseFitRef.current * z
    return {
      x: (vp.clientWidth - raster.width * s) / 2,
      y: (vp.clientHeight - raster.height * s) / 2,
    }
  }

  // Recompute the fit baseline + recenter on new raster; keep zoom but re-clamp
  // pan on viewport resize (window resize, settings blade opening, etc).
  useLayoutEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const measureFit = () =>
      Math.min(vp.clientWidth / raster.width, vp.clientHeight / raster.height) || 1
    baseFitRef.current = measureFit()
    setZoom(1)
    setPan(centerPan(1))

    const ro = new ResizeObserver(() => {
      baseFitRef.current = measureFit()
      // At the fit baseline keep the image centred as the box grows; once the
      // user has zoomed in, preserve their framing and just re-clamp.
      setPan((p) => (zoomRef.current === 1 ? centerPan(1) : clampPan(p, zoomRef.current)))
    })
    ro.observe(vp)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raster])

  // Zoom by `factor`, keeping the point (cx,cy) in viewport coords fixed.
  const zoomAt = (cx, cy, factor) => {
    const newZoom = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM)
    const ratio = newZoom / zoomRef.current
    if (ratio === 1) return
    const p = panRef.current
    const np = { x: cx - (cx - p.x) * ratio, y: cy - (cy - p.y) * ratio }
    setZoom(newZoom)
    setPan(clampPan(np, newZoom))
  }

  const zoomByButton = (factor) => {
    const vp = viewportRef.current
    if (!vp) return
    zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, factor)
  }

  const reset = () => {
    setZoom(1)
    setPan(centerPan(1))
  }

  // Ctrl/⌘ + wheel to zoom toward the cursor. Native non-passive listener so we
  // can preventDefault the page scroll only when actually zooming.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015))
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
    // Rebind per raster so zoomAt/clampPan close over the current image dims.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raster])

  const onPointerDown = (e) => {
    drag.current = { x: e.clientX, y: e.clientY, pan: panRef.current }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    setPan(clampPan({ x: d.pan.x + (e.clientX - d.x), y: d.pan.y + (e.clientY - d.y) }, zoomRef.current))
  }
  const endDrag = (e) => {
    if (drag.current && e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  // Corner grip: resize the display box. stopPropagation so it never starts a
  // pan on the underlying viewport.
  const onGripDown = (e) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizing.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h }
  }
  const onGripMove = (e) => {
    const r = resizing.current
    if (!r) return
    e.stopPropagation()
    setSize({
      w: clamp(r.w + (e.clientX - r.x), MIN_W, MAX_W),
      h: clamp(r.h + (e.clientY - r.y), MIN_H, MAX_H),
    })
  }
  const onGripUp = (e) => {
    if (!resizing.current) return
    e.stopPropagation()
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId)
    resizing.current = null
  }

  return (
    <div className={styles.rasterWrap}>
      <div className={styles.toolbar}>
        <button type="button" className={styles.zbtn} onClick={() => zoomByButton(1 / STEP)}
                title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" className={styles.pct} onClick={reset}
                title="Reset to fit" aria-label="Reset zoom to fit">{Math.round(zoom * 100)}%</button>
        <button type="button" className={styles.zbtn} onClick={() => zoomByButton(STEP)}
                title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" className={styles.zbtn} onClick={reset}
                title="Reset to fit" aria-label="Reset zoom to fit">⟳</button>
      </div>
      <div
        ref={viewportRef}
        className={styles.viewport}
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={reset}
      >
        <canvas
          ref={canvasRef}
          className={styles.raster}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${baseFitRef.current * zoom})`,
            transformOrigin: '0 0',
          }}
        />
        <div
          className={styles.grip}
          title="Drag to resize"
          aria-label="Resize image area"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
        />
      </div>
      <div className={styles.rasterMeta}>{raster.width}×{raster.height} · {raster.photometric}</div>
      {caption && <div className={styles.rasterMeta}>{caption}</div>}
    </div>
  )
}
