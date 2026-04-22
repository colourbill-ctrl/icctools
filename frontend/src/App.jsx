import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DropZone from './components/DropZone.jsx'
import ProfileViewer from './components/ProfileViewer.jsx'
import { validateProfile, validateBytes, preloadValidator } from './lib/validator.js'
import { computeChangedTagIds } from './lib/tagDiff.js'
import styles from './App.module.css'

/**
 * App state model — a single `profile` object (or null):
 *   filename         — e.g. "foo.icc"
 *   originalBytes    — Uint8Array from the file the user loaded (never mutated)
 *   originalParsed   — parsed JSON from the first validateBytes() call
 *   currentBytes     — Uint8Array after any XML→ICC round-trip (=== original until then)
 *   parsed           — parsed JSON of currentBytes
 *   xml              — string | null; present after Convert to XML
 *   xmlBaseline      — string | null; the last converter-produced XML, used to compute xmlDirty
 *   xmlDirty         — true if xml !== xmlBaseline
 *   iccDirty         — true if currentBytes !== originalBytes
 */

export default function App() {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => { preloadValidator() }, [])

  const saveRef = useRef(null)

  const handleFile = useCallback(async (file) => {
    if (!file) return
    setLoading(true); setError(null); setProfile(null)
    try {
      const parsed = await validateProfile(file)
      const buffer = await file.arrayBuffer()
      const bytes  = new Uint8Array(buffer)
      setProfile({
        filename:       file.name,
        originalBytes:  bytes,
        originalParsed: parsed,
        currentBytes:   bytes,
        parsed,
        xml:            null,
        xmlBaseline:    null,
        xmlDirty:       false,
        iccDirty:       false,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // XmlPanel pushes edited text via onChange; we compute xmlDirty here to keep
  // it a derived field rather than a separate setter the caller has to manage.
  const handleXmlChanged = useCallback((nextXml, opts) => {
    setProfile(p => {
      if (!p) return p
      const baseline = opts?.baseline !== undefined ? opts.baseline : p.xmlBaseline
      return {
        ...p,
        xml: nextXml,
        xmlBaseline: baseline,
        xmlDirty: nextXml !== baseline,
      }
    })
  }, [])

  const handleIccProduced = useCallback(async (newBytes) => {
    setLoading(true); setError(null)
    try {
      const parsed = await validateBytes(newBytes, profile.filename)
      setProfile(p => ({
        ...p,
        currentBytes: newBytes,
        parsed,
        // XML we just round-tripped becomes the new baseline.
        xmlBaseline: p.xml,
        xmlDirty: false,
        iccDirty: !bytesEqual(p.originalBytes, newBytes),
      }))
    } catch (e) {
      setError('Profile written from XML, but re-validation failed: ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [profile])

  const handleSave = useCallback(() => {
    if (!profile) return
    const { filename, currentBytes, iccDirty } = profile
    const blob = new Blob([currentBytes], { type: 'application/vnd.iccprofile' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const m = filename.match(/^(.*?)(\.(icc|icm))?$/i)
    const stem = m?.[1] ?? filename
    const ext = m?.[3] ?? 'icc'
    a.download = iccDirty ? `${stem}-edited.${ext}` : filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [profile])

  const changedTagIds = useMemo(() => {
    if (!profile || !profile.iccDirty) return null
    return computeChangedTagIds(
      profile.originalBytes, profile.originalParsed,
      profile.currentBytes, profile.parsed
    )
  }, [profile])

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

        {profile && (
          <div className={styles.saveRow} ref={saveRef}>
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={loading}
            >
              Save ICC Profile
            </button>
            {profile.iccDirty && (
              <span className={styles.modifiedPill} aria-live="polite">
                ● Modified — unsaved edits
              </span>
            )}
          </div>
        )}

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

        {profile && (
          <ProfileViewer
            data={profile.parsed}
            bytes={profile.currentBytes}
            xml={profile.xml}
            xmlDirty={profile.xmlDirty}
            changedTagIds={changedTagIds}
            onXmlChanged={handleXmlChanged}
            onIccProduced={handleIccProduced}
          />
        )}
      </main>

      <footer className={styles.footer}>
        ICC Profile Validator · powered by IccProfLib
      </footer>
    </div>
  )
}

function bytesEqual(a, b) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
