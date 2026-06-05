import { useMemo, useState } from 'react'
import { useT } from '../i18n.jsx'
import { interpretMessage } from '../lib/validationDetail.js'
import ValidationDetailModal from './ValidationDetailModal.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import styles from './ValidationPanel.module.css'

const ICONS = { valid: '✓', warning: '⚠', error: '✕', unknown: '?' }

// The WASM wrapper emits a fixed set of English status strings; map them to i18n
// keys so the status line localizes (unknown strings fall back to the raw text).
const STATUS_KEY = {
  'Profile is valid': 'status_valid',
  'Profile has warning(s)': 'status_warning',
  'Profile is non-compliant': 'status_noncompliant',
  'Critical validation error': 'status_critical',
  'Unknown validation status': 'status_unknown',
}

export default function ValidationPanel({ validation, data, bytes }) {
  const { level, status, messages } = validation
  const t = useT()
  const [selected, setSelected] = useState(null)

  // Localize the status line. The best-effort/partial case has its own status;
  // otherwise map the wrapper's fixed status strings, falling back to raw.
  const statusText = data?.partial
    ? t('status_partial')
    : status
      ? (STATUS_KEY[status] ? t(STATUS_KEY[status]) : status)
      : t('no_validation_output')

  // Interpret every message once: clean off the IccProfLib status prefix and
  // resolve a click target (header field-set or tag) where we can.
  const interpreted = useMemo(() => {
    // A best-effort/partial profile's messages are our own structural notes, not
    // IccProfLib report lines — show them verbatim at error severity and don't
    // make them clickable (the detail modal's describeTag would fail anyway).
    if (data?.partial) {
      return messages.map((raw) => ({ raw, severity: 'error', statusLabel: '', text: raw, target: null }))
    }
    const ctx = {
      header: data?.header,
      profileId: data?.profileId,
      tags: data?.tags,
      bytes,
    }
    return messages.map((raw) => interpretMessage(raw, ctx))
  }, [messages, data, bytes])

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.statusCard} ${styles[`level_${level}`]}`}>
        <span className={styles.icon}>{ICONS[level] ?? '?'}</span>
        <span className={styles.statusText}>{statusText}</span>
      </div>

      {interpreted.length > 0 && (
        <ul className={styles.messages}>
          {interpreted.map((item, i) => {
            const clickable = item.target != null
            return (
              <li key={i} className={styles.message}>
                {clickable ? (
                  <button
                    type="button"
                    className={styles.messageButton}
                    onClick={() => setSelected(item)}
                  >
                    <span className={`${styles.sevDot} ${styles[`sev_${item.severity}`]}`} aria-hidden>
                      {ICONS[item.severity === 'error' ? 'error' : item.severity] ?? '›'}
                    </span>
                    <span className={styles.messageText}>{item.text}</span>
                    <span className={styles.viewLink}>{t('validation_view_in_context')} ›</span>
                  </button>
                ) : (
                  <div className={styles.messageStatic}>
                    <span className={`${styles.sevDot} ${styles[`sev_${item.severity}`]}`} aria-hidden>
                      {ICONS[item.severity === 'error' ? 'error' : item.severity] ?? '›'}
                    </span>
                    <span className={styles.messageText}>{item.text}</span>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {messages.length === 0 && level === 'valid' && (
        <p className={styles.allClear}>{t('no_validation_messages')}</p>
      )}

      {selected && (
        <ErrorBoundary
          resetKey={selected}
          fallback={() => (
            <div className={styles.modalError} role="alert">
              <p>{selected.text}</p>
              <button type="button" onClick={() => setSelected(null)}>{t('close')}</button>
            </div>
          )}
        >
          <ValidationDetailModal
            interpretation={selected}
            tags={data?.tags}
            bytes={bytes}
            onClose={() => setSelected(null)}
          />
        </ErrorBoundary>
      )}
    </div>
  )
}
