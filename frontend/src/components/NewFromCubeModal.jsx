// (c) 2026 William Li
//
// "New from .cube" producer dialog (Group B / iccFromCube parity). The user
// supplies an Adobe/Resolve .cube 3D-LUT — by picking/dropping a file or pasting
// the text — and we build an ICC DeviceLink from it. The heavy lifting (parse +
// build + serialize) is the iccconstruct wasm module, reached via the parent's
// onCreate; this component only gathers the text and reports the outcome.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n.jsx'
import styles from './NewFromCubeModal.module.css'

export default function NewFromCubeModal({ open, onClose, onCreate }) {
  const t = useT()
  const [text, setText] = useState('')
  const [filename, setFilename] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef(null)

  // Reset all local state whenever the dialog opens, so a previous attempt's
  // text/error never leaks into a fresh one.
  useEffect(() => {
    if (open) { setText(''); setFilename(''); setBusy(false); setError(null); setDragOver(false) }
  }, [open])

  // Read a picked/dropped .cube into the textarea. Guard the type loosely (the
  // wasm engine is the real validator) and surface read failures inline.
  const ingestFile = useCallback((file) => {
    if (!file) return
    setFilename(file.name)
    const reader = new FileReader()
    reader.onload = () => setText(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => setError(t('cube_err_read') || 'Could not read that file.')
    reader.readAsText(file)
  }, [t])

  const onPick = useCallback((e) => {
    const file = e.target.files && e.target.files[0]
    ingestFile(file)
    e.target.value = ''   // allow re-picking the same file
  }, [ingestFile])

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files && e.dataTransfer.files[0]
    ingestFile(file)
  }, [ingestFile])

  const submit = useCallback(async () => {
    // Guard: nothing to build. (The engine also rejects empty/《no LUT》 input,
    // but stopping here avoids a needless wasm round-trip.)
    if (!text.trim() || busy) return
    setBusy(true); setError(null)
    try {
      await onCreate(text, filename)
      // parent closes the dialog on success
    } catch (e) {
      setError(e?.message || String(e))
      setBusy(false)
    }
  }, [text, filename, busy, onCreate])

  if (!open) return null

  return (
    <div className={styles.backdrop} onClick={busy ? undefined : onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>{t('cube_title') || 'New profile from .cube'}</h2>
        <p className={styles.intro}>
          {t('cube_intro') ||
            'Build an ICC DeviceLink from an Adobe/Resolve .cube 3D-LUT. The result is added to your pool and downloaded.'}
        </p>

        <div
          className={`${styles.drop} ${dragOver ? styles.dropActive : ''}`}
          onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <button className={styles.pickBtn} type="button" onClick={() => inputRef.current?.click()}>
            {t('cube_pick') || 'Choose .cube file'}
          </button>
          <span className={styles.dropHint}>{t('cube_drop') || 'or drop it here, or paste below'}</span>
          <input ref={inputRef} type="file" accept=".cube" className={styles.hidden} onChange={onPick} />
        </div>

        {filename && <div className={styles.fileTag}>{filename}</div>}

        <textarea
          className={styles.textarea}
          value={text}
          spellCheck={false}
          placeholder={t('cube_placeholder') || 'TITLE "My LUT"\nLUT_3D_SIZE 33\n0.0 0.0 0.0\n…'}
          onChange={(e) => { setText(e.target.value); if (!e.target.value) setFilename('') }}
        />

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button className={styles.cancel} type="button" onClick={onClose} disabled={busy}>
            {t('cube_cancel') || 'Cancel'}
          </button>
          <button className="btn-primary" type="button" onClick={submit} disabled={busy || !text.trim()}>
            {busy
              ? (t('cube_creating') || 'Creating…')
              : (t('cube_create') || 'Create DeviceLink')}
          </button>
        </div>
      </div>
    </div>
  )
}
