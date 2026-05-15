import { useRef, useState } from 'react'
import { useT } from '../i18n.jsx'
import styles from './DropZone.module.css'

export default function DropZone({ onFile, disabled }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const t = useT()

  function handleDragOver(e) {
    e.preventDefault()
    if (!disabled) setDragging(true)
  }

  function handleDragLeave() {
    setDragging(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    const file = e.dataTransfer.files[0]
    if (file) onFile(file)
  }

  function handleChange(e) {
    const file = e.target.files[0]
    if (file) onFile(file)
    // Reset so the same file can be re-selected
    e.target.value = ''
  }

  return (
    <div
      className={`${styles.zone} ${dragging ? styles.dragging : ''} ${disabled ? styles.disabled : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-label="Drop zone for ICC profile files"
    >
      <div className={styles.icon}>🎨</div>
      <p className={styles.headline}>{t('dropzone_headline')}</p>
      <p className={styles.sub}>{t('dropzone_or')}</p>
      <button
        className="btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        type="button"
      >
        {t('dropzone_button')}
      </button>
      <p className={styles.hint}>{t('dropzone_hint')}</p>

      <input
        ref={inputRef}
        type="file"
        accept=".icc,.icm"
        className={styles.hidden}
        onChange={handleChange}
        disabled={disabled}
      />
    </div>
  )
}
