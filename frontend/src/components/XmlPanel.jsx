// (c) William Li 2026
import { useState } from 'react'
import { xml as xmlLang } from '@codemirror/lang-xml'
import TextEditor from './TextEditor.jsx'
import { iccToXml, xmlToIcc } from '../lib/xmlConverter.js'
import { renderRichText } from '../lib/richText.jsx'
import { useT } from '../i18n.jsx'
import styles from './ConverterPanel.module.css'

// The WASM converters run synchronously on the main thread, so without a
// forced frame yield the "Converting…" status set just above doesn't paint
// before the work blocks the UI thread. rAF + microtask flush is enough to
// let React commit the busy state and the browser render one frame.
function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })
}

export default function XmlPanel({
  bytes,           // Uint8Array of the currently-loaded profile
  xml,             // current XML string (null if not yet converted)
  xmlDirty,        // true if xml !== last converter output
  onXmlChanged,    // (nextXml, { baseline }) => void
  onIccProduced,   // (newBytes) => void — caller re-validates
}) {
  const [busy, setBusy] = useState(null)  // 'toXml' | 'toIcc' | null
  const [error, setError] = useState(null)
  const t = useT()

  async function handleToXml() {
    if (xmlDirty && xml) {
      const ok = window.confirm(t('confirm_overwrite_xml'))
      if (!ok) return
    }
    setBusy('toXml'); setError(null)
    try {
      await yieldToPaint()
      const result = await iccToXml(bytes)
      onXmlChanged(result, { baseline: result })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  async function handleToIcc() {
    if (!xml) return
    setBusy('toIcc'); setError(null)
    try {
      await yieldToPaint()
      const newBytes = await xmlToIcc(xml)
      onIccProduced(newBytes)
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className="btn-primary"
          onClick={handleToXml}
          disabled={busy !== null}
        >
          {t('convert_to_xml')}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleToIcc}
          disabled={busy !== null || !xml}
        >
          {t('convert_to_icc')}
        </button>
        {busy !== null && (
          <span className={styles.status} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            {busy === 'toXml' ? t('converting_to_xml') : t('converting_to_icc')}
          </span>
        )}
        {xmlDirty && xml && (
          <span className={styles.dirtyTag}>{t('unsaved_xml_edits')}</span>
        )}
      </div>

      {error && (
        <div className={styles.error}>
          <strong>{t('error_label')}</strong> <pre className={styles.errorText}>{error}</pre>
        </div>
      )}

      {xml === null ? (
        <div className={styles.placeholder}>
          {renderRichText(t('xml_placeholder'))}
        </div>
      ) : (
        <TextEditor
          value={xml}
          language={xmlLang()}
          onChange={(next) => onXmlChanged(next)}
        />
      )}
    </div>
  )
}
