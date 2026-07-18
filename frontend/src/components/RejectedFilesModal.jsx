// (c) 2026 William Li
//
// Single dialog listing every file a load rejected (not an ICC profile, too
// large, unparseable). Shown once per load batch — never one popup per file.
import { useT } from '../i18n.jsx'
import styles from './RejectedFilesModal.module.css'

export default function RejectedFilesModal({ files, onClose }) {
  const t = useT()
  if (!files || files.length === 0) return null
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>
          {(t('reject_title') || 'Some files were not loaded').replace('{n}', String(files.length))}
        </h2>
        <p className={styles.intro}>
          {t('reject_intro') || 'These files are not ICC profiles, so they were not added to the pool:'}
        </p>
        <ul className={styles.list}>
          {files.map((f, i) => (
            <li key={i} className={styles.item}>
              <span className={styles.name}>{f.filename}</span>
              <span className={styles.reason}>{f.reason}</span>
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          <button className="btn-primary" type="button" onClick={onClose}>{t('reject_ok') || 'OK'}</button>
        </div>
      </div>
    </div>
  )
}
