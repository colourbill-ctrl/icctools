// (c) 2026 William Li
import styles from './vizShared.module.css'

// Non-fatal diagnostics raised while a graph/raster still rendered (e.g. a CLUT
// tile-count overflow). The engine carries these as data; we show them inline so
// they aren't silently lost — the very thing the diagnostics restore was about.
export default function VizWarnings({ items }) {
  if (!items || !items.length) return null
  return (
    <div className={styles.itemWarning}>
      {items.map((w, i) => <div key={i}>⚠ {w}</div>)}
    </div>
  )
}
