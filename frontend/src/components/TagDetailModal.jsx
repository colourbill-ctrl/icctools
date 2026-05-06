import { useEffect, useState } from 'react'
import { describeTag } from '../lib/validator.js'
import styles from './TagDetailModal.module.css'

// The upfront tag.description is the verbosity-75 dump (no CLUT cells / curve
// points). On open we kick off a verbosity-100 fetch in the background and
// swap it in when ready — so simple tags feel instant and big LUT tags
// progressively upgrade rather than blocking validation.
export default function TagDetailModal({ tag, bytes, onClose }) {
  const [fullDescription, setFullDescription] = useState(null)
  const [loadingFull, setLoadingFull] = useState(false)
  const [fullError, setFullError] = useState(null)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!tag || !bytes) return
    let cancelled = false
    setFullDescription(null)
    setFullError(null)
    setLoadingFull(true)
    describeTag(bytes, tag.id)
      .then((text) => { if (!cancelled) setFullDescription(text) })
      .catch((e)   => { if (!cancelled) setFullError(e.message) })
      .finally(()  => { if (!cancelled) setLoadingFull(false) })
    return () => { cancelled = true }
  }, [tag, bytes])

  if (!tag) return null

  const typeLabel = tag.isArrayType ? `Array of ${tag.type}` : tag.type
  const shownDescription = fullDescription ?? tag.description ?? '(No content)'

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

        {loadingFull && (
          <div className={styles.loadingBar} aria-live="polite">
            Loading full description…
          </div>
        )}
        {fullError && (
          <div className={styles.errorBar} role="alert">
            Could not load full description: {fullError}
          </div>
        )}

        <pre className={styles.body}>{shownDescription}</pre>
      </div>
    </div>
  )
}
