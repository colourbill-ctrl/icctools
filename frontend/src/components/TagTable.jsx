import { Fragment, useEffect, useState } from 'react'
import { describeTag } from '../lib/validator.js'
import { enumerateVisualizations } from '../lib/vizPlot.js'
import { useT } from '../i18n.jsx'
import { useNumberBase } from '../numberBase.jsx'
import TagVisuals from './TagVisuals.jsx'
import styles from './TagTable.module.css'

// IccVizModel Kind enum values used here (ChromaticityXY / ClutImage).
const KIND_CHROMA = 2
const KIND_CLUT = 5

// Inline-expanding tag table. One row open at a time (accordion). Mirrors
// chardata's ICC viewer: click anywhere on a row to expand, the caret
// rotates, the verbosity-75 dump appears immediately, then upgrades to the
// verbosity-100 Describe() output once the WASM fetch completes. On mobile
// it's a much better UX than the old modal because there's no
// take-over-the-screen popup interrupting the scroll position.
export default function TagTable({ tags, bytes, changedTagIds, describable = true }) {
  const [openId, setOpenId]       = useState(null)
  const [descCache, setDescCache] = useState({})  // { [tagId]: { text, error, loading } }
  const [viz, setViz]             = useState(null) // { byTag: Map, chroma, gamut } | null
  const t = useT()
  const { fmt } = useNumberBase()

  // Round-trip edits replace the profile bytes — invalidate the cache and
  // collapse any open row so a stale Describe() text never lingers.
  useEffect(() => {
    setDescCache({})
    setOpenId(null)
    setViz(null)
  }, [bytes])

  // Enumerate the profile's visualizations the first time a tag is expanded
  // (deferred so the ~800 KB iccplot WASM isn't fetched for users who only skim
  // the tag list). Cached per profile; best-effort — on any failure the tags
  // simply fall back to the plain Describe() dump.
  useEffect(() => {
    if (!describable || !bytes || !openId || viz) return
    let cancelled = false
    enumerateVisualizations(bytes)
      .then((descs) => {
        if (cancelled) return
        const byTag = new Map()
        for (const d of descs) {
          if (!d.tagSig) continue
          if (!byTag.has(d.tagSig)) byTag.set(d.tagSig, [])
          byTag.get(d.tagSig).push(d)
        }
        const chroma = descs.find((d) => d.kind === KIND_CHROMA) || null
        const gamut = descs.find((d) => d.tagSig === 'gamt' && d.kind === KIND_CLUT) || null
        setViz({ byTag, chroma, gamut })
      })
      .catch(() => { if (!cancelled) setViz(null) })
    return () => { cancelled = true }
  }, [bytes, describable, openId, viz])

  // Fetch the verbosity-100 dump the first time a tag is expanded. Cancel
  // gracefully if the user re-clicks before the WASM call resolves.
  useEffect(() => {
    if (!describable || !openId || !bytes) return
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
    return <p className={styles.empty}>{t('no_tags')}</p>
  }

  function toggle(id) {
    setOpenId(prev => prev === id ? null : id)
  }

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.row} ${styles.head}`} role="row">
        <span className={`${styles.num} ${styles.colNum}`}>#</span>
        <span className={styles.colName}>{t('tag_name')}</span>
        <span className={styles.colId}>{t('tag_id')}</span>
        <span className={`${styles.num} ${styles.colOffset}`}>{t('tag_offset')}</span>
        <span className={`${styles.num} ${styles.colSize}`}>{t('tag_size')}</span>
        <span className={`${styles.num} ${styles.colPad}`}>{t('tag_pad')}</span>
      </div>
      {tags.map((tag, i) => {
        const isOpen  = openId === tag.id
        const changed = changedTagIds?.has(tag.id)
        const cached  = descCache[tag.id]
        const fullText = cached?.text
        const initial  = tag.description || t('tag_no_content')
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
              <span className={`${styles.colName} ${styles.name} ${changed ? styles.changed : ''}`} title={changed ? t('tag_bytes_changed') : undefined}>
                <span className={styles.caret} aria-hidden>▶</span>
                {changed && <span className={styles.changedDot} aria-hidden>●</span>}
                {tag.name}
              </span>
              <span className={styles.colId}>
                <code>{tag.id}</code>
              </span>
              <span className={`${styles.num} ${styles.mono} ${styles.colOffset}`}>
                {fmt(tag.offset)}
              </span>
              <span className={`${styles.num} ${styles.mono} ${styles.colSize}`}>
                {fmt(tag.size)}
              </span>
              <span className={`${styles.num} ${styles.mono} ${styles.colPad} ${padClass(tag.pad)}`}>
                {fmt(tag.pad)}
              </span>
              {/* Mobile-only summary line — desktop hides it via CSS. */}
              <span className={styles.meta} aria-hidden>
                <code className={styles.idInline}>{tag.id}</code>
                {' · '}{fmt(tag.size)}B
                {' · off '}{fmt(tag.offset)}
                {' · pad '}<span className={padMetaClass(tag.pad)}>{fmt(tag.pad)}</span>
              </span>
            </div>
            {isOpen && (
              <div className={styles.detail}>
                <div className={styles.detailMeta}>
                  <span><span className={styles.detailKey}>{t('tag_type')}</span> {tag.isArrayType ? t('tag_array_of', { type: tag.type }) : (tag.type || '—')}</span>
                  <span><span className={styles.detailKey}>{t('tag_offset')}</span> {fmt(tag.offset)}</span>
                  <span><span className={styles.detailKey}>{t('tag_size')}</span> {fmt(tag.size)} {t('bytes_suffix')}</span>
                </div>
                {describable ? (
                  <TagVisuals
                    tag={tag}
                    bytes={bytes}
                    descriptors={viz?.byTag.get(tag.id) || []}
                    chromaDesc={viz?.chroma || null}
                    gamutDesc={tag.id !== 'gamt' ? (viz?.gamut || null) : null}
                    dataNode={
                      <>
                        <pre className={styles.detailBody}>{shown}</pre>
                        {cached?.loading && (
                          <div className={styles.detailLoading} aria-live="polite">
                            {t('loading_full_description')}
                          </div>
                        )}
                        {cached?.error && (
                          <div className={styles.detailError} role="alert">
                            {t('failed_load_description')} {cached.error}
                          </div>
                        )}
                      </>
                    }
                  />
                ) : (
                  <pre className={styles.detailBody}>{t('tag_contents_unavailable')}</pre>
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
