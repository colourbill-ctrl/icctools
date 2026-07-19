// (c) 2026 William Li
//
// Spectral separation assembler (its own tab after Link, DL-PIPELINE1 / P1-c —
// iccSpecSepToTiff). Not a chain: a GATHER. The user drops N single-channel
// spectral image files, orders them (channel order matters), then Assemble writes
// one multi-channel TIFF and saves it. Images are never kept in the pool/store —
// dropped, assembled once, downloaded. Optionally an ICC profile can be embedded
// in the result (dragged from the pool — added in a later stage).
//
// Engine wiring lands in a later stage; Assemble surfaces a clear "engine arriving"
// notice today so the drop/order/save flow is judgeable first.
import { useCallback, useRef, useState } from 'react'
import { useT } from '../i18n.jsx'
import styles from './SpecSepPanel.module.css'

const IMG_RE = /\.(tiff?|png|jpe?g)$/i

// Content sniff — the first bytes of a TIFF / PNG / JPEG. The iccSpecSepToTiff test
// planes (tifffile.py's `spec_1`, `spec_2`, …) carry NO extension, yet our libtiff/libpng
// decoder reads them fine (it works on bytes, not the name). So accept a file whose
// CONTENT is a known raster even when its name has no image extension.
async function looksLikeImage(file) {
  try {
    const b = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    if (b.length < 3) return false
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return true // TIFF LE (II*\0)
    if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return true // TIFF BE (MM\0*)
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true // PNG (\x89PNG)
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true                  // JPEG (\xFF\xD8\xFF)
    return false
  } catch { return false }
}

export default function SpecSepPanel({ onAssemble }) {
  const t = useT()
  const [files, setFiles] = useState([])          // ordered File[]
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const inputRef = useRef(null)

  // Accept by name-extension OR content magic, so extensionless raster planes (the
  // iccSpecSepToTiff harvest set) ingest as well as named .tif/.png/.jpg files.
  const add = useCallback(async (list) => {
    const checked = await Promise.all(list.map(async (f) =>
      (IMG_RE.test(f.name) || (await looksLikeImage(f))) ? f : null))
    const imgs = checked.filter(Boolean)
    if (imgs.length) { setFiles((c) => [...c, ...imgs]); setError(null); setNotice(null) }
    else if (list.length) setError(t('ss_notimg') || 'None of those look like images (TIFF, PNG or JPEG).')
  }, [t])

  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setOver(false)
    add(Array.from(e.dataTransfer.files || []))
  }, [add])

  const move = (i, d) => setFiles((c) => {
    const j = i + d
    if (j < 0 || j >= c.length) return c
    const n = [...c]; [n[i], n[j]] = [n[j], n[i]]; return n
  })
  const removeAt = (i) => setFiles((c) => c.filter((_, k) => k !== i))

  async function assemble() {
    if (files.length < 2 || busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await onAssemble(files.slice())
      setNotice(t('ss_done', { n: files.length }) || `Assembled ${files.length} channels.`)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h3 className={styles.title}>{t('ss_title') || 'Assemble spectral TIFF'}</h3>
        <p className={styles.sub}>{t('ss_sub') || 'Drop single-channel spectral images in channel order, then assemble them into one multi-channel TIFF.'}</p>
      </header>

      <div
        className={`${styles.zone} ${over ? styles.zoneOver : ''}`}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setOver(true) } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false) }}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <span className={styles.zoneIcon} aria-hidden="true">🧩</span>
        <span className={styles.zoneText}>{t('ss_drop') || 'Drop spectral images here (or click to choose)'}</span>
        {/* No `accept` filter: the harvest planes are extensionless, which most pickers
            would hide. We content-sniff every file in `add()` instead, so a non-image is
            rejected with a clear message rather than silently dropped. */}
        <input ref={inputRef} type="file" multiple
               className={styles.hidden} onChange={(e) => { add(Array.from(e.target.files || [])); e.target.value = '' }} />
      </div>

      {files.length > 0 && (
        <ol className={styles.list}>
          {files.map((f, i) => (
            <li key={`${f.name}:${i}`} className={styles.row}>
              <span className={styles.ch}>{t('ss_ch') || 'ch'} {i + 1}</span>
              <span className={styles.fname} title={f.name}>{f.name}</span>
              <span className={styles.ctl}>
                <button className={styles.mini} type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('pl_move_left') || 'Move earlier'}>‹</button>
                <button className={styles.mini} type="button" disabled={i === files.length - 1} onClick={() => move(i, +1)} aria-label={t('pl_move_right') || 'Move later'}>›</button>
                <button className={styles.miniX} type="button" onClick={() => removeAt(i)} aria-label={t('accum_remove') || 'Remove'}>×</button>
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className={styles.actions}>
        <button className="btn-primary" type="button" disabled={files.length < 2 || busy} onClick={assemble}>
          {busy ? (t('ss_assembling') || 'Assembling…') : (t('ss_go') || 'Assemble & Save')}
        </button>
        {files.length > 0 && (
          <button className={styles.clear} type="button" onClick={() => { setFiles([]); setNotice(null); setError(null) }}>
            {t('pl_clear') || 'Clear'}
          </button>
        )}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}
    </div>
  )
}
