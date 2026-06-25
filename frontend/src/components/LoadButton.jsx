// (c) 2026 William Li
import { useRef } from 'react'
import { useT } from '../i18n.jsx'

export default function LoadButton({ onFile, disabled, label }) {
  const inputRef = useRef(null)
  const t = useT()
  const buttonLabel = label ?? t('load_profile')

  function handleChange(e) {
    const file = e.target.files[0]
    if (file) onFile(file)
    e.target.value = ''
  }

  return (
    <>
      <button
        className="btn-primary"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        type="button"
      >
        {buttonLabel}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".icc,.icm"
        style={{ display: 'none' }}
        onChange={handleChange}
        disabled={disabled}
      />
    </>
  )
}
