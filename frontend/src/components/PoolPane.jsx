// (c) 2026 William Li
//
// Left info pane = the data-store list view (the "pool"). Collapsible + resizable.
// It is the load target (multi-file <input> + OS drop) and the drag SOURCE: rows
// drag onto the Profile/Compare/Link tabs' accumulators. Nothing here persists —
// the pool is session-only; the user's filesystem is the durable store (DL-STORE1).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n.jsx'
import { formatSize } from '../lib/pool.js'
import styles from './PoolPane.module.css'

// Custom drag MIME so tab drop-targets can tell a pool-row drag from an OS file.
export const POOL_DND_MIME = 'application/x-profiletool-pool-ids'

const WIDTH_KEY = 'profiletool.poolWidth'
const COLLAPSED_KEY = 'profiletool.poolCollapsed'
const MIN_W = 220, MAX_W = 620, DEFAULT_W = 320

export default function PoolPane({ entries, selectedIds, onSelect, onLoadFiles, onRemove }) {
  const t = useT()
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSED_KEY) === '1')
  const [width, setWidth] = useState(() => {
    const w = parseInt(localStorage.getItem(WIDTH_KEY) || '', 10)
    return Number.isFinite(w) ? Math.min(MAX_W, Math.max(MIN_W, w)) : DEFAULT_W
  })

  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0') }, [collapsed])
  useEffect(() => { localStorage.setItem(WIDTH_KEY, String(width)) }, [width])

  // Drag-to-resize the right edge.
  const dragState = useRef(null)
  const onResizeDown = useCallback((e) => {
    dragState.current = { startX: e.clientX, startW: width }
    const onMove = (ev) => {
      if (!dragState.current) return
      const next = dragState.current.startW + (ev.clientX - dragState.current.startX)
      setWidth(Math.min(MAX_W, Math.max(MIN_W, next)))
    }
    const onUp = () => {
      dragState.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    e.preventDefault()
  }, [width])

  // OS file drop / picker → load into the pool. (Row drags use POOL_DND_MIME and
  // land on the tabs, not here, so we only act on dropped *files*.)
  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false)
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length) onLoadFiles(files)
  }, [onLoadFiles])

  const handlePick = useCallback((e) => {
    const files = Array.from(e.target.files || [])
    if (files.length) onLoadFiles(files)
    e.target.value = ''
  }, [onLoadFiles])

  // A row drag carries either the whole current selection (if the row is part of
  // a multi-selection) or just itself. Tabs read POOL_DND_MIME on drop.
  const onRowDragStart = useCallback((id, e) => {
    const ids = selectedIds.has(id) && selectedIds.size > 1 ? [...selectedIds] : [id]
    e.dataTransfer.setData(POOL_DND_MIME, JSON.stringify(ids))
    e.dataTransfer.effectAllowed = 'copy'
  }, [selectedIds])

  if (collapsed) {
    return (
      <div className={styles.rail}>
        <button className={styles.railToggle} onClick={() => setCollapsed(false)}
                title={t('pool_expand') || 'Show profile pool'} aria-label={t('pool_expand') || 'Show profile pool'}>
          {/* chardata's file-blade glyph (document + chevron) as the open affordance */}
          <span className={styles.railIcon} aria-hidden="true">
            <svg width="15" height="18" viewBox="0 0 13 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 1.5C1 1.22 1.22 1 1.5 1H8L12 5V14.5C12 14.78 11.78 15 11.5 15H1.5C1.22 15 1 14.78 1 14.5V1.5Z" fill="#a8d4f0" stroke="#6aabd8" strokeWidth="1"/>
              <path d="M8 1V5H12" fill="#c8e8f8" stroke="#6aabd8" strokeWidth="1" strokeLinejoin="round"/>
            </svg>
          </span>
          <span className={styles.railChevron}>›</span>
          <span className={styles.railLabel}>{t('pool_title') || 'Profiles'}</span>
          {entries.length > 0 && <span className={styles.railCount}>{entries.length}</span>}
        </button>
      </div>
    )
  }

  return (
    <aside className={styles.pane} style={{ width }}>
      <div className={styles.head}>
        <span className={styles.headTitle}>
          {t('pool_title') || 'Profiles'}
          {entries.length > 0 && <span className={styles.count}>{entries.length}</span>}
        </span>
        <button className={styles.collapseBtn} onClick={() => setCollapsed(true)}
                title={t('pool_collapse') || 'Collapse'} aria-label={t('pool_collapse') || 'Collapse'}>‹</button>
      </div>

      <div className={styles.loadRow}>
        <button className="btn-primary" type="button" onClick={() => inputRef.current?.click()}>
          {t('pool_load') || 'Load Profiles'}
        </button>
        <input ref={inputRef} type="file" accept=".icc,.icm" multiple
               className={styles.hidden} onChange={handlePick} />
      </div>

      <div
        className={`${styles.body} ${dragOver ? styles.bodyDrag : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {entries.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>🎨</div>
            <p className={styles.emptyHead}>{t('pool_empty_head') || 'Drop ICC profiles here'}</p>
            <p className={styles.emptySub}>{t('pool_empty_sub') || 'or use “Load profiles…” — files stay on your device.'}</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {entries.map((e) => (
              <li
                key={e.id}
                className={`${styles.row} ${selectedIds.has(e.id) ? styles.rowSel : ''}`}
                draggable
                onDragStart={(ev) => onRowDragStart(e.id, ev)}
                onClick={(ev) => onSelect(e.id, ev)}
                title={e.filename}
              >
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{e.filename}</span>
                  <button className={styles.remove} title={t('pool_remove') || 'Remove'}
                          aria-label={t('pool_remove') || 'Remove'}
                          onClick={(ev) => { ev.stopPropagation(); onRemove(e.id) }}>×</button>
                </div>
                <div className={styles.badges}>
                  {e.meta.partial && <span className={`${styles.badge} ${styles.badgeWarn}`}>partial</span>}
                  {e.meta.profileClass && <span className={styles.badge}>{shortClass(e.meta.profileClass)}</span>}
                  {e.meta.colorSpace && <span className={styles.badge}>{e.meta.colorSpace.trim()}</span>}
                  {e.meta.version && <span className={styles.badgeDim}>v{e.meta.version}</span>}
                  {e.meta.sizeBytes ? <span className={styles.badgeDim}>{formatSize(e.meta.sizeBytes)}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.resize} onMouseDown={onResizeDown} role="separator" aria-orientation="vertical" />
    </aside>
  )
}

// The header value is verbose (e.g. "Display device profile (mntr)"); prefer the
// parenthesised 4-char signature when present, else the whole string (CSS clips).
function shortClass(s) {
  const m = String(s).match(/\(([^)]{1,8})\)\s*$/)
  return m ? m[1] : s
}
