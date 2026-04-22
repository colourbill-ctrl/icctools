import { useRef, useState } from 'react'
import styles from './DropZone.module.css'

export default function DropZone({ onFile, disabled }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

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
      <p className={styles.headline}>Drop an ICC profile here</p>
      <p className={styles.sub}>or</p>
      <button
        className="btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        type="button"
      >
        Select ICC profile…
      </button>
      <p className={styles.hint}>.icc and .icm files</p>

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
