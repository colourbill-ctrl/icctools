import { useState, useCallback, useEffect } from 'react'
import DropZone from './components/DropZone.jsx'
import ProfileViewer from './components/ProfileViewer.jsx'
import { validateProfile, preloadValidator } from './lib/validator.js'
import styles from './App.module.css'

export default function App() {
  const [result, setResult]   = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  // Warm the WASM module while the user is still choosing a file.
  useEffect(() => { preloadValidator() }, [])

  const handleFile = useCallback(async (file) => {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const data = await validateProfile(file)
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <span className={styles.logo}>International Color Consortium</span>
        <span className={styles.subtitle}>Profile Validator</span>
      </header>

      <div className={styles.banner}>
        Upload an ICC profile to validate it against the <strong>ICC.1</strong> specification
        using the <a href="https://github.com/InternationalColorConsortium/iccDEV" target="_blank" rel="noreferrer">iccDEV</a> reference implementation.
      </div>

      <main className={styles.main}>
        <DropZone onFile={handleFile} disabled={loading} />

        {loading && (
          <div className={styles.status}>
            <span className={styles.spinner} /> Validating…
          </div>
        )}

        {error && (
          <div className={styles.errorBanner}>
            <strong>Error:</strong> {error}
          </div>
        )}

        {result && <ProfileViewer data={result} />}
      </main>

      <footer className={styles.footer}>
        ICC Profile Validator · powered by IccProfLib
      </footer>
    </div>
  )
}
