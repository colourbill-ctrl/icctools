import { useRef } from 'react'

export default function LoadButton({ onFile, disabled, label = 'Load ICC profile' }) {
  const inputRef = useRef(null)

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
        {label}
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
