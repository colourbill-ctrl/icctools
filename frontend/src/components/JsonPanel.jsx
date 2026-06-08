import { useState } from 'react'
import { json as jsonLang } from '@codemirror/lang-json'
import TextEditor from './TextEditor.jsx'
import { iccToJson, jsonToIcc } from '../lib/jsonConverter.js'
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
  const t = useT()

  async function handleToJson() {
    if (jsonDirty && json) {
      const ok = window.confirm(t('confirm_overwrite_json'))
      if (!ok) return
    }
    setBusy('toJson'); setError(null)
    try {
      await yieldToPaint()
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
      await yieldToPaint()
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
          {t('convert_to_json')}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleToIcc}
          disabled={busy !== null || !json}
        >
          {t('convert_to_icc')}
        </button>
        {busy !== null && (
          <span className={styles.status} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" />
            {busy === 'toJson' ? t('converting_to_json') : t('converting_to_icc')}
          </span>
        )}

        <label className={styles.toolbarOption}>
          {t('json_indent')}
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
          {t('json_sort_keys')}
        </label>

        {jsonDirty && json && (
          <span className={styles.dirtyTag}>{t('unsaved_json_edits')}</span>
        )}
      </div>

      {error && (
        <div className={styles.error}>
          <strong>{t('error_label')}</strong> <pre className={styles.errorText}>{error}</pre>
        </div>
      )}

      {json === null ? (
        <div className={styles.placeholder}>
          {renderRichText(t('json_placeholder'))}
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
