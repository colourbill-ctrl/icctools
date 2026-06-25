// (c) 2026 William Li
import { useState } from 'react'
import styles from './Collapsible.module.css'

/**
 * A lightweight collapsible section for the inline tag visualizations. `title`
 * is the always-visible header (click to toggle); `defaultOpen` seeds the state.
 * Styled to sit inside the Tags-tab expanded detail and stack cleanly on mobile.
 */
export default function Collapsible({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={styles.section}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`${styles.caret} ${open ? styles.caretOpen : ''}`} aria-hidden>▶</span>
        {title}
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </section>
  )
}
