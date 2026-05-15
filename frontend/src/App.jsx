import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DropZone from './components/DropZone.jsx'
import LoadButton from './components/LoadButton.jsx'
import ProfileViewer from './components/ProfileViewer.jsx'
import { validateProfile, validateBytes, preloadValidator } from './lib/validator.js'
import { computeChangedTagIds } from './lib/tagDiff.js'
import styles from './App.module.css'

// Defence against a hostile postMessage opener (or accidental huge drop) that
// could OOM the tab by handing us a multi-GB Uint8Array. The validator path
// previously had no cap, while XML/JSON converters already enforce 32 MB.
const MAX_ICC_BYTES = 256 * 1024 * 1024

/**
 * App state model — a single `profile` object (or null):
 *   filename         — e.g. "foo.icc"
 *   originalBytes    — Uint8Array from the file the user loaded (never mutated)
 *   originalParsed   — parsed JSON from the first validateBytes() call
 *   currentBytes     — Uint8Array after any XML/JSON → ICC round-trip
 *   parsed           — parsed JSON of currentBytes
 *   xml              — string | null; present after Convert to XML
 *   xmlBaseline      — string | null; the last converter-produced XML, used to compute xmlDirty
 *   xmlDirty         — true if xml !== xmlBaseline
 *   json             — string | null; present after Convert to JSON
 *   jsonBaseline     — string | null; the last converter-produced JSON, used to compute jsonDirty
 *   jsonDirty        — true if json !== jsonBaseline
 *   iccDirty         — true if currentBytes !== originalBytes
 *
 * XML and JSON are kept as parallel fields (rather than a single generic
 * "text form" map) because each panel has distinct format-specific toolbar
 * state and the small amount of duplication is simpler than an abstraction
 * that will be broken by any future format-specific need.
 */

export default function App() {
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => { preloadValidator() }, [])

  const saveRef = useRef(null)

  const loadFromBytes = useCallback(async (filename, bytes) => {
    setLoading(true); setError(null); setProfile(null)
    try {
      if (bytes.length > MAX_ICC_BYTES) {
        throw new Error(`Profile is ${(bytes.length / (1024*1024)).toFixed(1)} MB; refusing to load anything larger than ${MAX_ICC_BYTES / (1024*1024)} MB.`)
      }
      const parsed = await validateBytes(bytes, filename)
      setProfile({
        filename,
        originalBytes:  bytes,
        originalParsed: parsed,
        currentBytes:   bytes,
        parsed,
        xml:            null,
        xmlBaseline:    null,
        xmlDirty:       false,
        json:           null,
        jsonBaseline:   null,
        jsonDirty:      false,
        iccDirty:       false,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleFile = useCallback(async (file) => {
    if (!file) return
    const buffer = await file.arrayBuffer()
    return loadFromBytes(file.name, new Uint8Array(buffer))
  }, [loadFromBytes])

  // Launch protocol: when opened with ?source=chardata, signal readiness to
  // window.opener and accept {type:'icctools:load', filename, bytes}.
  //
  // The opener must be same-origin in prod (chardata.colourbill.com/ →
  // chardata.colourbill.com/profiletool/) or one of the dev-host localhost
  // origins. We post 'ready' only to the matching origin so a hostile
  // opener at a different origin cannot induce us to leak anything (we don't
  // carry any state, but defence in depth), and we drop inbound 'load'
  // messages from non-allowlisted origins so a hostile site that opens us
  // with ?source=chardata cannot push bytes.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('source') !== 'chardata') return
    if (!window.opener) return

    const allowedOrigins = new Set([
      window.location.origin,             // prod same-origin
      'http://localhost:3001',            // dev: chardata
      'http://127.0.0.1:3001',
    ])

    function onMessage(ev) {
      if (ev.source !== window.opener) return
      if (!allowedOrigins.has(ev.origin)) return
      const msg = ev.data
      if (!msg || msg.type !== 'icctools:load') return
      const { filename, bytes } = msg
      if (!bytes) return
      const u8 = bytes instanceof Uint8Array ? bytes
        : bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
        : new Uint8Array(bytes)
      loadFromBytes(filename || 'profile.icc', u8)
    }
    window.addEventListener('message', onMessage)
    // Send 'ready' to every allowed origin; the opener whose origin matches
    // receives it, the others silently drop it.
    for (const origin of allowedOrigins) {
      try { window.opener.postMessage({ type: 'icctools:ready' }, origin) } catch (_) {}
    }
    return () => window.removeEventListener('message', onMessage)
  }, [loadFromBytes])

  // Each panel pushes edited text via onChange; we compute *Dirty here so
  // the panels don't need to track their own baselines.
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

  const handleJsonChanged = useCallback((nextJson, opts) => {
    setProfile(p => {
      if (!p) return p
      const baseline = opts?.baseline !== undefined ? opts.baseline : p.jsonBaseline
      return {
        ...p,
        json: nextJson,
        jsonBaseline: baseline,
        jsonDirty: nextJson !== baseline,
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
        // Both text-form buffers are now stale relative to the new bytes.
        // Leave them as-is so the user can still see what they submitted,
        // but rebase the baseline so they're reported clean (the bytes now
        // reflect them). The other form stays with its last baseline, so
        // editing XML and then re-running Convert to ICC doesn't mark a
        // pre-existing JSON representation as "dirty".
        xmlBaseline: p.xml,
        xmlDirty: false,
        jsonBaseline: p.json,
        jsonDirty: false,
        iccDirty: !bytesEqual(p.originalBytes, newBytes),
      }))
    } catch (e) {
      setError('Profile written from edits, but re-validation failed: ' + e.message)
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
        {!profile && <DropZone onFile={handleFile} disabled={loading} />}

        {profile && (
          <div className={styles.toolbar} ref={saveRef}>
            <LoadButton onFile={handleFile} disabled={loading} />
            <button
              type="button"
              className="btn-primary"
              onClick={handleSave}
              disabled={loading}
            >
              Save ICC profile
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
            json={profile.json}
            jsonDirty={profile.jsonDirty}
            changedTagIds={changedTagIds}
            onXmlChanged={handleXmlChanged}
            onJsonChanged={handleJsonChanged}
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
