import { useT } from '../i18n.jsx'
import styles from './ValidationPanel.module.css'

const ICONS = { valid: '✓', warning: '⚠', error: '✕', unknown: '?' }

export default function ValidationPanel({ validation }) {
  const { level, status, messages } = validation
  const t = useT()

  return (
    <div className={styles.wrapper}>
      <div className={`${styles.statusCard} ${styles[`level_${level}`]}`}>
        <span className={styles.icon}>{ICONS[level] ?? '?'}</span>
        <span className={styles.statusText}>{status || t('no_validation_output')}</span>
      </div>

      {messages.length > 0 && (
        <ul className={styles.messages}>
          {messages.map((msg, i) => (
            <li key={i} className={styles.message}>
              <span className={styles.bullet}>›</span>
              {msg}
            </li>
          ))}
        </ul>
      )}

      {messages.length === 0 && level === 'valid' && (
        <p className={styles.allClear}>{t('no_validation_messages')}</p>
      )}
    </div>
  )
}
