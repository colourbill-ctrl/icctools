import { useEffect, useState } from 'react'
import { describeTag } from '../lib/validator.js'
import { useT } from '../i18n.jsx'
import styles from './ValidationDetailModal.module.css'

const ICONS = { error: '✕', warning: '⚠', info: 'ℹ' }

// Left-hand badge for a highlighted field: "Required: 0" for a zero-check,
// "Expected: …" when the rule knows the wanted value, else a generic "Invalid".
function violationBadge(v, t) {
  if (v.expected == null) return t('validation_invalid')
  if (v.expected === '0') return t('validation_required_zero')
  return t('validation_expected', { value: v.expected })
}

/**
 * Focused dialog that shows a single validation finding in context.
 *
 * Driven by an `interpretation` from lib/validationDetail.js. For a header
 * finding it lists the triggering field plus the exact violating fields and
 * their current values; for a tag finding it shows the tag's identity and its
 * full Describe() dump (same on-demand WASM call the Tags tab uses).
 */
export default function ValidationDetailModal({ interpretation, tags, bytes, onClose }) {
  const t = useT()
  const { severity, statusLabel, text, target } = interpretation

  // Close on Escape; lock background scroll while open.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('validation_detail_title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span className={`${styles.chip} ${styles[`sev_${severity}`]}`}>
            <span aria-hidden>{ICONS[severity] ?? 'ℹ'}</span>
            {statusLabel || t('validation_detail_title')}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label={t('close')}>
            ✕
          </button>
        </div>

        <p className={styles.message}>{text}</p>

        {target?.kind === 'header' && <HeaderTarget target={target} t={t} />}
        {target?.kind === 'tag' && (
          <TagTarget tagId={target.tagId} tagName={target.tagName} tags={tags} bytes={bytes} t={t} />
        )}
      </div>
    </div>
  )
}

function HeaderTarget({ target, t }) {
  const { triggerField, requirement, violations } = target
  return (
    <div className={styles.body}>
      {triggerField && (
        <table className={styles.fields}>
          <tbody>
            <tr className={styles.trigger}>
              <td className={styles.tagBadge}>{t('validation_trigger_field')}</td>
              <td className={styles.fieldKey}>{triggerField.label}</td>
              <td className={styles.fieldVal}><code>{triggerField.value}</code></td>
            </tr>
          </tbody>
        </table>
      )}

      {requirement && <p className={styles.requirement}>{requirement}</p>}

      {violations.length > 0 ? (
        <table className={styles.fields}>
          <thead>
            <tr>
              <th />
              <th className={styles.colKey}>{t('validation_field')}</th>
              <th className={styles.colVal}>{t('validation_current_value')}</th>
            </tr>
          </thead>
          <tbody>
            {violations.map((v) => (
              <tr key={v.label} className={styles.violation}>
                <td className={styles.required}>{violationBadge(v, t)}</td>
                <td className={styles.fieldKey}>{v.label}</td>
                <td className={styles.fieldVal}><code>{v.value}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className={styles.note}>{t('validation_no_location')}</p>
      )}
    </div>
  )
}

function TagTarget({ tagId, tagName, tags, bytes, t }) {
  const tag = (tags || []).find((x) => x.id === tagId)
  const [state, setState] = useState({ loading: true })

  useEffect(() => {
    if (!bytes || !tagId) { setState({ error: 'no bytes' }); return }
    let cancelled = false
    setState({ loading: true })
    describeTag(bytes, tagId)
      .then((text) => { if (!cancelled) setState({ text, loading: false }) })
      .catch((e) => { if (!cancelled) setState({ error: e.message, loading: false }) })
    return () => { cancelled = true }
  }, [bytes, tagId])

  return (
    <div className={styles.body}>
      <div className={styles.tagMeta}>
        <span className={styles.tagName}>{tag?.name || tagName}</span>
        <code className={styles.tagIdCode}>{tagId}</code>
        {tag && (
          <span className={styles.tagDims}>
            <span><span className={styles.detailKey}>{t('tag_type')}</span> {tag.type || '—'}</span>
            <span><span className={styles.detailKey}>{t('tag_offset')}</span> {tag.offset}</span>
            <span><span className={styles.detailKey}>{t('tag_size')}</span> {tag.size} {t('bytes_suffix')}</span>
          </span>
        )}
      </div>
      {state.loading && <div className={styles.loading}>{t('loading_full_description')}</div>}
      {state.error && <div className={styles.error}>{t('failed_load_description')} {state.error}</div>}
      {state.text != null && <pre className={styles.dump}>{state.text}</pre>}
    </div>
  )
}
