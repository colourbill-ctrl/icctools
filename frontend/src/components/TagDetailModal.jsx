import { useEffect } from 'react'
import styles from './TagDetailModal.module.css'

export default function TagDetailModal({ tag, onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!tag) return null

  const typeLabel = tag.isArrayType ? `Array of ${tag.type}` : tag.type

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className={styles.titleBar}>
          <div className={styles.titleText}>
            <span className={styles.tagName}>{tag.name}</span>
            <code className={styles.tagSig}>{tag.id}</code>
          </div>
          <button className={styles.close} onClick={onClose} aria-label="Close" type="button">×</button>
        </header>

        <div className={styles.meta}>
          <div><span className={styles.metaKey}>Type</span><span className={styles.metaVal}>{typeLabel || '—'}</span></div>
          <div><span className={styles.metaKey}>Offset</span><span className={styles.metaVal}>{tag.offset}</span></div>
          <div><span className={styles.metaKey}>Size</span><span className={styles.metaVal}>{tag.size} bytes</span></div>
        </div>

        <pre className={styles.body}>{tag.description || '(No content)'}</pre>
      </div>
    </div>
  )
}
