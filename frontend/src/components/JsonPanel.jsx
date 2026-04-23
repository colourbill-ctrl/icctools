import { useState } from 'react'
import { json as jsonLang } from '@codemirror/lang-json'
import TextEditor from './TextEditor.jsx'
import { iccToJson, jsonToIcc } from '../lib/jsonConverter.js'
import styles from './ConverterPanel.module.css'

export default function JsonPanel({
  bytes,           // Uint8Array of the currently-loaded profile
  json,            // current JSON string (null if not yet converted)
  jsonDirty,       // true if json !== last converter output
  onJsonChanged,   // (nextJson, { baseline }) => void
  onIccProduced,   // (newBytes) => void — caller re-validates
}) {
  const [busy, setBusy] = useState(null)   // 'toJson' | 'toIcc' | null
  const [error, setError] = useState(null)
  const [indent, setIndent] = useState(2)
  const [sort, setSort] = useState(false)

  async function handleToJson() {
    if (jsonDirty && json) {
      const ok = window.confirm(
        'You have unsaved JSON edits. Overwrite them with a fresh conversion from the ICC profile?'
      )
      if (!ok) return
    }
    setBusy('toJson'); setError(null)
    try {
      const result = await iccToJson(bytes, { indent, sort })
      onJsonChanged(result, { baseline: result })
    } catch (e) {
      setError(e.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  async function handleToIcc() {
    if (!json) return
    setBusy('toIcc'); setError(null)
    try {
      const newBytes = await jsonToIcc(json)
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
          onClick={handleToJson}
          disabled={busy !== null}
        >
          {busy === 'toJson' ? 'Converting…' : 'Convert to JSON'}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleToIcc}
          disabled={busy !== null || !json}
        >
          {busy === 'toIcc' ? 'Converting…' : 'Convert to ICC'}
        </button>

        <label className={styles.toolbarOption}>
          indent
          <input
            type="number"
            min="0"
            max="8"
            value={indent}
            onChange={(e) => setIndent(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
          />
        </label>
        <label className={styles.toolbarOption}>
          <input
            type="checkbox"
            checked={sort}
            onChange={(e) => setSort(e.target.checked)}
          />
          sort keys
        </label>

        {jsonDirty && json && (
          <span className={styles.dirtyTag}>● unsaved JSON edits</span>
        )}
      </div>

      {error && (
        <div className={styles.error}>
          <strong>Error:</strong> <pre className={styles.errorText}>{error}</pre>
        </div>
      )}

      {json === null ? (
        <div className={styles.placeholder}>
          Click <em>Convert to JSON</em> to generate an editable JSON representation
          of this profile. The JSON is produced by the same IccLibJSON code path
          used by the upstream <code>IccToJson</code> tool.
        </div>
      ) : (
        <TextEditor
          value={json}
          language={jsonLang()}
          onChange={(next) => onJsonChanged(next)}
        />
      )}
    </div>
  )
}
