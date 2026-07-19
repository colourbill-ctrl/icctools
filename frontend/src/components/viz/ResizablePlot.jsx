// (c) 2026 William Li
//
// Reusable resizable plot container — the STANDARD resize affordance for every
// plot in profiletool. A full-width box whose height the user drags via a bottom
// ns-resize grip bar (chardata's 3D/slice-plot pattern), with the height persisted
// per `storageKey`.
//
// It fires `onResize()` whenever the box changes size for ANY reason:
//   • the drag handle (height), and
//   • a width change from the surrounding layout — e.g. the profiles pane
//     collapsing/expanding, or a tab reflow — via a ResizeObserver on the box.
// A window-resize listener alone (Plotly's `responsive:true`) does NOT catch those
// layout-driven width changes, which is why a container ResizeObserver is required.
// A Plotly child responds by calling Plotly.Plots.resize in its onResize; an SVG
// child can re-read the box size. `onResize` should be a stable (useCallback'd)
// reference so the observer isn't torn down and re-created every render.
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './ResizablePlot.module.css'

export default function ResizablePlot({
  storageKey, minH = 220, maxH = 1200, defaultH = 420, onResize, children,
}) {
  const [height, setHeight] = useState(() => {
    const s = parseInt(localStorage.getItem(storageKey) || '', 10)
    return (Number.isFinite(s) && s >= minH && s <= maxH) ? s : defaultH
  })
  const boxRef = useRef(null)
  const drag = useRef(null)

  useEffect(() => { localStorage.setItem(storageKey, String(height)) }, [storageKey, height])

  // Observe the box for size changes (both the drag-driven height and any
  // layout-driven width change) and notify. ResizeObserver fires after layout, so
  // the box already has its new size when a Plotly child re-measures.
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => { if (onResize) onResize() })
    ro.observe(el)
    return () => ro.disconnect()
  }, [onResize])

  // Pointer drag on the grip → set the box height (clamped). Pointer capture keeps
  // the drag alive even if the cursor leaves the thin handle.
  const onPointerDown = useCallback((e) => {
    const startH = boxRef.current ? boxRef.current.getBoundingClientRect().height : height
    drag.current = { startY: e.clientY, startH }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.currentTarget.classList.add(styles.dragging)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }, [height])
  const onPointerMove = useCallback((e) => {
    if (!drag.current) return
    const h = Math.min(maxH, Math.max(minH, drag.current.startH + (e.clientY - drag.current.startY)))
    setHeight(h)
  }, [minH, maxH])
  const endDrag = useCallback((e) => {
    if (!drag.current) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    e.currentTarget.classList.remove(styles.dragging)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  return (
    <div>
      <div ref={boxRef} className={styles.box} style={{ height }}>{children}</div>
      <div
        className={styles.handle}
        title="Drag to resize"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  )
}
