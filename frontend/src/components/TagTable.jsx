import { Fragment, useEffect, useState } from 'react'
import { describeTag } from '../lib/validator.js'
import styles from './TagTable.module.css'

// Inline-expanding tag table. One row open at a time (accordion). Mirrors
// chardata's ICC viewer: click anywhere on a row to expand, the caret
// rotates, the verbosity-75 dump appears immediately, then upgrades to the
// verbosity-100 Describe() output once the WASM fetch completes. On mobile
// it's a much better UX than the old modal because there's no
// take-over-the-screen popup interrupting the scroll position.
export default function TagTable({ tags, bytes, changedTagIds }) {
  const [openId, setOpenId]       = useState(null)
  const [descCache, setDescCache] = useState({})  // { [tagId]: { text, error, loading } }

  // Round-trip edits replace the profile bytes — invalidate the cache and
  // collapse any open row so a stale Describe() text never lingers.
  useEffect(() => {
    setDescCache({})
    setOpenId(null)
  }, [bytes])

  // Fetch the verbosity-100 dump the first time a tag is expanded. Cancel
  // gracefully if the user re-clicks before the WASM call resolves.
  useEffect(() => {
    if (!openId || !bytes) return
    const cached = descCache[openId]
    if (cached && (cached.text != null || cached.error != null)) return
    let cancelled = false
    setDescCache(c => ({ ...c, [openId]: { loading: true } }))
    describeTag(bytes, openId)
      .then((text) => {
        if (cancelled) return
        setDescCache(c => ({ ...c, [openId]: { text, loading: false } }))
      })
      .catch((e) => {
        if (cancelled) return
        setDescCache(c => ({ ...c, [openId]: { error: e.message, loading: false } }))
      })
    return () => { cancelled = true }
    // descCache intentionally not in deps — we read it for the early-out,
    // but writes from the same effect would loop. Keying on openId+bytes
    // is enough because cache resets only when bytes change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, bytes])

  if (tags.length === 0) {
    return <p className={styles.empty}>No tags found.</p>
  }

  function toggle(id) {
    setOpenId(prev => prev === id ? null : id)
  }

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.row} ${styles.head}`} role="row">
        <span className={`${styles.num} ${styles.colNum}`}>#</span>
        <span className={styles.colName}>Tag Name</span>
        <span className={styles.colId}>ID</span>
        <span className={`${styles.num} ${styles.colOffset}`}>Offset</span>
        <span className={`${styles.num} ${styles.colSize}`}>Size</span>
        <span className={`${styles.num} ${styles.colPad}`}>Pad</span>
      </div>
      {tags.map((tag, i) => {
        const isOpen  = openId === tag.id
        const changed = changedTagIds?.has(tag.id)
        const cached  = descCache[tag.id]
        const fullText = cached?.text
        const initial  = tag.description || '(No content)'
        const shown    = fullText ?? initial
        return (
          <Fragment key={i}>
            <div
              className={`${styles.row} ${styles.clickable} ${isOpen ? styles.open : ''}`}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => toggle(tag.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle(tag.id)
                }
              }}
            >
              <span className={`${styles.num} ${styles.colNum} ${styles.muted}`}>{i + 1}</span>
              <span className={`${styles.colName} ${styles.name} ${changed ? styles.changed : ''}`} title={changed ? 'Bytes changed since load' : undefined}>
                <span className={styles.caret} aria-hidden>▶</span>
                {changed && <span className={styles.changedDot} aria-hidden>●</span>}
                {tag.name}
              </span>
              <span className={styles.colId}>
                <code>{tag.id}</code>
              </span>
              <span className={`${styles.num} ${styles.mono} ${styles.colOffset}`}>
                {tag.offset}
              </span>
              <span className={`${styles.num} ${styles.mono} ${styles.colSize}`}>
                {tag.size}
              </span>
              <span className={`${styles.num} ${styles.mono} ${styles.colPad} ${padClass(tag.pad)}`}>
                {tag.pad}
              </span>
              {/* Mobile-only summary line — desktop hides it via CSS. */}
              <span className={styles.meta} aria-hidden>
                <code className={styles.idInline}>{tag.id}</code>
                {' · '}{tag.size?.toLocaleString?.() ?? tag.size}B
                {' · off '}{tag.offset?.toLocaleString?.() ?? tag.offset}
                {' · pad '}<span className={padMetaClass(tag.pad)}>{tag.pad}</span>
              </span>
            </div>
            {isOpen && (
              <div className={styles.detail}>
                <div className={styles.detailMeta}>
                  <span><span className={styles.detailKey}>Type</span> {tag.isArrayType ? `Array of ${tag.type}` : (tag.type || '—')}</span>
                  <span><span className={styles.detailKey}>Offset</span> {tag.offset}</span>
                  <span><span className={styles.detailKey}>Size</span> {tag.size} bytes</span>
                </div>
                <pre className={styles.detailBody}>{shown}</pre>
                {cached?.loading && (
                  <div className={styles.detailLoading} aria-live="polite">
                    Loading full description…
                  </div>
                )}
                {cached?.error && (
                  <div className={styles.detailError} role="alert">
                    Could not load full description: {cached.error}
                  </div>
                )}
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

function padClass(pad) {
  if (pad < 0) return styles.padError
  if (pad > 3) return styles.padWarning
  return ''
}

function padMetaClass(pad) {
  if (pad < 0) return styles.padMetaError
  if (pad > 3) return styles.padMetaWarning
  return ''
}
