import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DropZone from './components/DropZone.jsx'
import LoadButton from './components/LoadButton.jsx'
import ProfileViewer from './components/ProfileViewer.jsx'
import SettingsBlade from './components/SettingsBlade.jsx'
import { validateProfile, validateBytes, preloadValidator } from './lib/validator.js'
import { bestEffortParse } from './lib/bestEffortParse.js'
import { computeChangedTagIds } from './lib/tagDiff.js'
import { resolveTabAlias } from './lib/tabs.js'
import { useT } from './i18n.jsx'
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
  // Resolved from a `#…&tab=` launch fragment; seeds ProfileViewer's open tab.
  const [initialTab, setInitialTab] = useState(null)
  const t = useT()

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
      // The validator hit a critical error (e.g. a tag whose data runs past
      // end-of-file). Rather than a dead-end, do a best-effort structural read
      // of the header + tag directory so the user can inspect it — clearly
      // flagged as a critical, do-not-apply profile.
      const partial = bytes.length <= MAX_ICC_BYTES ? bestEffortParse(bytes, filename) : null
      if (partial) {
        setProfile({
          filename,
          originalBytes:  bytes,
          originalParsed: partial,
          currentBytes:   bytes,
          parsed:         partial,
          xml:            null,
          xmlBaseline:    null,
          xmlDirty:       false,
          json:           null,
          jsonBaseline:   null,
          jsonDirty:      false,
          iccDirty:       false,
        })
      } else {
        setError(e.message)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const handleFile = useCallback(async (file) => {
    if (!file) return
    const buffer = await file.arrayBuffer()
    return loadFromBytes(file.name, new Uint8Array(buffer))
  }, [loadFromBytes])

  // Fetch a profile from a URL (the `#url=` launch fragment) and feed the bytes
  // through the same path as a local file: validation, the 256 MB cap, and the
  // best-effort fallback all live in loadFromBytes. The network fetch is the
  // only extra step; the remote host must permit cross-origin reads (CORS) and
  // be reachable under the page's CSP connect-src (https:). The bytes are never
  // re-sent anywhere — they only flow into the validator.
  const loadFromUrl = useCallback(async (rawUrl) => {
    let url
    try {
      url = new URL(rawUrl, window.location.href)
    } catch {
      setError(`${t('url_invalid')} ${rawUrl}`)
      return
    }
    // Only https:, or any same-origin scheme (covers http://localhost in dev).
    // Cross-origin http: is blocked by the CSP connect-src (`https:`) anyway, so
    // reject it here for a clean message instead of an opaque CSP console error.
    if (url.protocol !== 'https:' && url.origin !== window.location.origin) {
      setError(`${t('url_invalid')} ${rawUrl}`)
      return
    }
    // A crafted `#url=` link fetches on page load with no interaction, turning a
    // shared link into a "make the victim's browser GET this URL" primitive.
    // CORS still blocks reading a cross-origin body and fetch sends no
    // cross-origin cookies, so this isn't credentialed SSRF — but gate any
    // off-origin fetch behind an explicit confirmation so a hostile link can't
    // silently reach out. Same-origin loads (and the chardata handoff) proceed.
    if (url.origin !== window.location.origin &&
        !window.confirm(`${t('url_confirm')}\n\n${url.origin}`)) {
      return
    }
    setLoading(true); setError(null); setProfile(null)
    let bytes
    try {
      const res = await fetch(url.href, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // A crafted #url= link auto-fetches on load, so a multi-GB (or
      // length-lying chunked) body could OOM the tab before loadFromBytes runs
      // its cap. Reject on a declared over-cap length, then stream with a
      // running cap that aborts the download the moment it overflows.
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_ICC_BYTES) {
        throw new Error(`response declares ${(declared / (1024*1024)).toFixed(1)} MB; limit is ${MAX_ICC_BYTES / (1024*1024)} MB`)
      }
      bytes = await readCapped(res, MAX_ICC_BYTES)
    } catch (e) {
      setLoading(false)
      setError(`${t('url_fetch_failed')} ${url.href} — ${e.message}`)
      return
    }
    await loadFromBytes(filenameFromUrl(url), bytes)
  }, [loadFromBytes, t])

  // Launch via URL fragment: #url=<encoded profile URL>&tab=<alias>
  //   • url=  — fetched and loaded like a local file (see loadFromUrl)
  //   • tab=  — resolved to a stable tab key (see lib/tabs.js) and used as the
  //             opening tab once the profile is shown
  // Both are optional. The fragment (unlike a query string) is never sent to a
  // server, so the profile URL stays on the client. Runs once on mount.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash) return
    const params = new URLSearchParams(hash)
    const tabKey = resolveTabAlias(params.get('tab'))
    if (tabKey) setInitialTab(tabKey)
    const url = params.get('url')
    if (url) loadFromUrl(url)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Launch protocol: when opened with ?source=chardata, signal readiness to
  // window.opener and accept {type:'profiletool:load', filename, bytes}.
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
      if (!msg || msg.type !== 'profiletool:load') return
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
      try { window.opener.postMessage({ type: 'profiletool:ready' }, origin) } catch (_) {}
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
      setError(t('revalidation_failed') + ' ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [profile, t])

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
    <>
      <div className={styles.layout}>
        <header className={styles.header}>
          <h1 className={styles.title}>{t('app_title')}</h1>
          <p className={styles.subtitle}>
            {t('subtitle_pre')}{' '}
            <a href="https://github.com/InternationalColorConsortium/iccDEV" target="_blank" rel="noreferrer">iccDEV</a>
            {' '}{t('subtitle_post')}
          </p>
        </header>

        <div className={styles.banner}>
          {t('banner_part1')} <strong>ICC.1</strong> {t('banner_part2')}{' '}
          <a href="https://github.com/InternationalColorConsortium/iccDEV" target="_blank" rel="noreferrer">iccDEV</a> {t('banner_part3')}
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
                {t('save_profile')}
              </button>
              {profile.iccDirty && (
                <span className={styles.modifiedPill} aria-live="polite">
                  {t('modified_pill')}
                </span>
              )}
            </div>
          )}

          {loading && (
            <div className={styles.status}>
              <span className={styles.spinner} /> {t('validating')}
            </div>
          )}

          {error && (
            <div className={styles.errorBanner}>
              <strong>{t('error_label')}</strong> {error}
            </div>
          )}

          {profile && (
            <ProfileViewer
              data={profile.parsed}
              bytes={profile.currentBytes}
              initialTab={initialTab}
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
          {t('footer')}
          {' · '}
          <span className={styles.version}>v{__APP_VERSION__}</span>
        </footer>
      </div>
      <SettingsBlade />
    </>
  )
}

// Stream a fetch response into a Uint8Array, aborting the download as soon as
// it exceeds `cap` bytes. This bounds memory for the #url= launch even when the
// server omits/under-reports Content-Length (chunked transfer). Falls back to a
// buffered read (still cap-checked) when the platform lacks a streaming body.
async function readCapped(res, cap) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > cap) throw new Error(`response exceeds ${cap / (1024*1024)} MB limit`)
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      try { await reader.cancel() } catch (_) { /* best effort */ }
      throw new Error(`response exceeds ${cap / (1024*1024)} MB limit`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength }
  return out
}

// Derive a display filename from a profile URL: the last path segment, decoded,
// query/fragment stripped. Falls back to a generic name.
function filenameFromUrl(url) {
  try {
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch (_) { /* fall through */ }
  return 'profile.icc'
}

function bytesEqual(a, b) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
