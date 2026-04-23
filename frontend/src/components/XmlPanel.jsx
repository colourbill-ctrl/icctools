import { useState } from 'react'
import { xml as xmlLang } from '@codemirror/lang-xml'
import TextEditor from './TextEditor.jsx'
import { iccToXml, xmlToIcc } from '../lib/xmlConverter.js'
import styles from './ConverterPanel.module.css'

export default function XmlPanel({
  bytes,           // Uint8Array of the currently-loaded profile
  xml,             // current XML string (null if not yet converted)
  xmlDirty,        // true if xml !== last converter output
  onXmlChanged,    // (nextXml, { baseline }) => void
  onIccProduced,   // (newBytes) => void — caller re-validates
}) {
  const [busy, setBusy] = useState(null)  // 'toXml' | 'toIcc' | null
  const [error, setError] = useState(null)

  async function handleToXml() {
    if (xmlDirty && xml) {
      const ok = window.confirm(
        'You have unsaved XML edits. Overwrite them with a fresh conversion from the ICC profile?'
      )
      if (!ok) return
    }
    setBusy('toXml'); setError(null)
    try {
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
          {busy === 'toXml' ? 'Converting…' : 'Convert to XML'}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleToIcc}
          disabled={busy !== null || !xml}
        >
          {busy === 'toIcc' ? 'Converting…' : 'Convert to ICC'}
        </button>
        {xmlDirty && xml && (
          <span className={styles.dirtyTag}>● unsaved XML edits</span>
        )}
      </div>

      {error && (
        <div className={styles.error}>
          <strong>Error:</strong> <pre className={styles.errorText}>{error}</pre>
        </div>
      )}

      {xml === null ? (
        <div className={styles.placeholder}>
          Click <em>Convert to XML</em> to generate an editable XML representation
          of this profile. The XML is produced by the same IccLibXML code path
          used by the upstream <code>IccToXml</code> tool.
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
