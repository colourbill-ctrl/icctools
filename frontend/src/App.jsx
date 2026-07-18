// (c) 2026 William Li
//
// 2.x Profile Pool workbench shell. Left = the pool (PoolPane); centre = the
// Profile/Compare/Link tabs (MainCanvas); right = the settings blade (overlay,
// unchanged). The pool is session-ephemeral — nothing persists; the user's
// filesystem is the durable store (DL-STORE1). Today's single-profile app is
// reused verbatim as the Profile tab (embedded ProfileViewer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PoolPane from './components/PoolPane.jsx'
import MainCanvas from './components/MainCanvas.jsx'
import SettingsBlade from './components/SettingsBlade.jsx'
import SubscribeModal from './components/SubscribeModal.jsx'
import GuidePanel from './components/GuidePanel.jsx'
import { validateBytes, preloadValidator } from './lib/validator.js'
import { bestEffortParse } from './lib/bestEffortParse.js'
import { computeChangedTagIds } from './lib/tagDiff.js'
import { resolveTabAlias } from './lib/tabs.js'
import { entryId, deriveMeta } from './lib/pool.js'
import { useT } from './i18n.jsx'
import styles from './App.module.css'

// Defence against a hostile postMessage opener (or accidental huge drop) that
// could OOM the tab by handing us a multi-GB Uint8Array.
const MAX_ICC_BYTES = 256 * 1024 * 1024

function renderPoweredBy(template) {
  const [before, after] = String(template).split('{lib}')
  return (
    <>
      {before}
      <a href="https://github.com/InternationalColorConsortium/iccDEV"
         target="_blank" rel="noreferrer">IccProfLib</a>
      {after}
    </>
  )
}

const uniq = (arr) => [...new Set(arr)]

export default function App() {
  const [pool, setPool] = useState(() => new Map())        // id -> entry
  const [accum, setAccum] = useState({ Profile: null, Compare: [], Link: [] })
  const [activeTab, setActiveTab] = useState('Profile')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [initialTab, setInitialTab] = useState(null)       // from #tab= launch fragment
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const t = useT()

  useEffect(() => { preloadValidator() }, [])

  // Refs mirror state for synchronous reads inside async load loops.
  const poolRef = useRef(pool);  poolRef.current = pool
  const accumRef = useRef(accum); accumRef.current = accum

  // Validate bytes and add a pool entry (dedup by identity). `focus` opens it in
  // the Profile tab straight away — used by the launch protocols and the first
  // profile of a manual load so "load → see it" is preserved.
  const addEntryFromBytes = useCallback(async (filename, bytes, { focus = false } = {}) => {
    setLoading(true); setError(null)
    try {
      if (bytes.length > MAX_ICC_BYTES) {
        throw new Error(`Profile is ${(bytes.length / (1024*1024)).toFixed(1)} MB; refusing to load anything larger than ${MAX_ICC_BYTES / (1024*1024)} MB.`)
      }
      let parsed
      try {
        parsed = await validateBytes(bytes, filename)
      } catch (e) {
        // Critical validator error (e.g. a tag running past EOF): fall back to a
        // best-effort structural read so the profile is still inspectable.
        const partial = bestEffortParse(bytes, filename)
        if (!partial) throw e
        parsed = partial
      }
      const id = entryId(bytes, parsed)
      setPool((m) => {
        if (m.has(id)) return m   // already loaded — keep its edit state
        const nm = new Map(m)
        nm.set(id, {
          id, filename, meta: deriveMeta(parsed),
          originalBytes: bytes, originalParsed: parsed,
          currentBytes: bytes, parsed,
          xml: null, xmlBaseline: null, xmlDirty: false,
          json: null, jsonBaseline: null, jsonDirty: false,
          iccDirty: false,
        })
        return nm
      })
      // Open in Profile if requested, or if nothing is in the Profile slot yet.
      if (focus || accumRef.current.Profile == null) {
        setAccum((a) => ({ ...a, Profile: id }))
        setActiveTab('Profile')
      }
      setSelectedIds(new Set([id]))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Multi-file load from the pool pane. Focus the first one only when the pool
  // was empty (first-run convenience); subsequent files just populate the list.
  const addFiles = useCallback(async (files) => {
    const focusFirst = poolRef.current.size === 0
    for (let i = 0; i < files.length; i++) {
      const buf = await files[i].arrayBuffer()
      // eslint-disable-next-line no-await-in-loop
      await addEntryFromBytes(files[i].name, new Uint8Array(buf), { focus: focusFirst && i === 0 })
    }
  }, [addEntryFromBytes])

  const updateEntry = useCallback((id, updater) => {
    setPool((m) => {
      const e = m.get(id)
      if (!e) return m
      const nm = new Map(m)
      nm.set(id, updater(e))
      return nm
    })
  }, [])

  const removeEntry = useCallback((id) => {
    setPool((m) => { const nm = new Map(m); nm.delete(id); return nm })
    setAccum((a) => ({
      Profile: a.Profile === id ? null : a.Profile,
      Compare: a.Compare.filter((x) => x !== id),
      Link: a.Link.filter((x) => x !== id),
    }))
    setSelectedIds((s) => { const ns = new Set(s); ns.delete(id); return ns })
  }, [])

  // Drop pool row(s) onto a tab. Profile replaces (multi → last wins);
  // Compare/Link accumulate (dedup). Dropping switches to that tab.
  const dropOnTab = useCallback((tab, ids) => {
    setAccum((a) => {
      if (tab === 'Profile') return { ...a, Profile: ids[ids.length - 1] }
      return { ...a, [tab]: uniq([...a[tab], ...ids]) }
    })
    setActiveTab(tab)
  }, [])

  const removeFromAccum = useCallback((tab, id) => {
    setAccum((a) => tab === 'Profile'
      ? { ...a, Profile: a.Profile === id ? null : a.Profile }
      : { ...a, [tab]: a[tab].filter((x) => x !== id) })
  }, [])

  // Pool-row selection: plain = single, ctrl/meta = toggle, shift = range.
  const onSelectRow = useCallback((id, e) => {
    const order = [...poolRef.current.keys()]
    setSelectedIds((prev) => {
      if (e.shiftKey && prev.size) {
        const last = [...prev][prev.size - 1]
        const a = order.indexOf(last), b = order.indexOf(id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          return new Set(order.slice(lo, hi + 1))
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const ns = new Set(prev)
        ns.has(id) ? ns.delete(id) : ns.add(id)
        return ns
      }
      return new Set([id])
    })
  }, [])

  // ── Profile-tab viewer wiring (bound to the current Profile slot) ──────────
  const profileId = accum.Profile
  const profileEntry = profileId ? pool.get(profileId) : null

  const handleXmlChanged = useCallback((nextXml, opts) => {
    if (!profileId) return
    updateEntry(profileId, (p) => {
      const baseline = opts?.baseline !== undefined ? opts.baseline : p.xmlBaseline
      return { ...p, xml: nextXml, xmlBaseline: baseline, xmlDirty: nextXml !== baseline }
    })
  }, [profileId, updateEntry])

  const handleJsonChanged = useCallback((nextJson, opts) => {
    if (!profileId) return
    updateEntry(profileId, (p) => {
      const baseline = opts?.baseline !== undefined ? opts.baseline : p.jsonBaseline
      return { ...p, json: nextJson, jsonBaseline: baseline, jsonDirty: nextJson !== baseline }
    })
  }, [profileId, updateEntry])

  const handleIccProduced = useCallback(async (newBytes) => {
    if (!profileId) return
    setLoading(true); setError(null)
    try {
      const entry = poolRef.current.get(profileId)
      const parsed = await validateBytes(newBytes, entry?.filename || 'profile.icc')
      updateEntry(profileId, (p) => ({
        ...p,
        currentBytes: newBytes,
        parsed,
        meta: deriveMeta(parsed),
        xmlBaseline: p.xml, xmlDirty: false,
        jsonBaseline: p.json, jsonDirty: false,
        iccDirty: !bytesEqual(p.originalBytes, newBytes),
      }))
    } catch (e) {
      setError(t('revalidation_failed') + ' ' + e.message)
    } finally {
      setLoading(false)
    }
  }, [profileId, updateEntry, t])

  const handleSave = useCallback(() => {
    if (!profileEntry) return
    const { filename, currentBytes, iccDirty } = profileEntry
    const blob = new Blob([currentBytes], { type: 'application/vnd.iccprofile' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const m = filename.match(/^(.*?)(\.(icc|icm))?$/i)
    const stem = m?.[1] ?? filename
    const ext = m?.[3] ?? 'icc'
    a.download = iccDirty ? `${stem}-edited.${ext}` : filename
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }, [profileEntry])

  const changedTagIds = useMemo(() => {
    if (!profileEntry || !profileEntry.iccDirty) return null
    return computeChangedTagIds(
      profileEntry.originalBytes, profileEntry.originalParsed,
      profileEntry.currentBytes, profileEntry.parsed
    )
  }, [profileEntry])

  // ── Launch protocols (unchanged behaviour; now load into the pool) ─────────
  const loadFromUrl = useCallback(async (rawUrl) => {
    let url
    try { url = new URL(rawUrl, window.location.href) }
    catch { setError(`${t('url_invalid')} ${rawUrl}`); return }
    if (url.protocol !== 'https:' && url.origin !== window.location.origin) {
      setError(`${t('url_invalid')} ${rawUrl}`); return
    }
    if (url.origin !== window.location.origin &&
        !window.confirm(`${t('url_confirm')}\n\n${url.origin}`)) return
    setLoading(true); setError(null)
    let bytes
    try {
      const res = await fetch(url.href, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
    await addEntryFromBytes(filenameFromUrl(url), bytes, { focus: true })
  }, [addEntryFromBytes, t])

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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('source') !== 'chardata') return
    if (!window.opener) return
    const allowedOrigins = new Set([
      window.location.origin,
      'http://localhost:3001',
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
      addEntryFromBytes(filename || 'profile.icc', u8, { focus: true })
    }
    window.addEventListener('message', onMessage)
    for (const origin of allowedOrigins) {
      try { window.opener.postMessage({ type: 'profiletool:ready' }, origin) } catch (_) {}
    }
    return () => window.removeEventListener('message', onMessage)
  }, [addEntryFromBytes])

  const entries = useMemo(() => [...pool.values()], [pool])
  const getEntry = useCallback((id) => pool.get(id) || null, [pool])

  return (
    <>
      <div className={styles.app}>
        <header className={styles.topbar}>
          <h1 className={styles.title}>{t('app_title')}</h1>
          <span className={styles.tagline}>
            {t('subtitle_pre')}{' '}
            <a href="https://github.com/InternationalColorConsortium/iccDEV" target="_blank" rel="noreferrer">iccDEV</a>
            {' '}{t('subtitle_post')}
          </span>
          <span className={styles.topSpacer} />
          {loading && <span className={styles.status}><span className={styles.spinner} /> {t('validating')}</span>}
        </header>

        {error && (
          <div className={styles.errorBanner}>
            <strong>{t('error_label')}</strong> {error}
            <button className={styles.errorClose} onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        <div className={styles.shell}>
          <PoolPane
            entries={entries}
            selectedIds={selectedIds}
            onSelect={onSelectRow}
            onLoadFiles={addFiles}
            onRemove={removeEntry}
          />
          <MainCanvas
            activeTab={activeTab}
            onActivate={setActiveTab}
            accum={accum}
            getEntry={getEntry}
            onDropOnTab={dropOnTab}
            onRemoveFromAccum={removeFromAccum}
            profileEntry={profileEntry}
            initialTab={initialTab}
            changedTagIds={changedTagIds}
            onXmlChanged={handleXmlChanged}
            onJsonChanged={handleJsonChanged}
            onIccProduced={handleIccProduced}
            onSave={handleSave}
          />
        </div>

        <footer className={styles.footer}>
          <div className={styles.copyright}>
            {t('product_name')}{' '}
            <span className={styles.version}>v{__APP_VERSION__}</span>. &copy; 2026 William Li.{' '}
            <a href="https://colourbill.com/" target="_blank" rel="noopener">colourbill.com</a>{' '}
            <a href="#" className={styles.subscribe} title={t('sub_link_title')}
               onClick={(e) => { e.preventDefault(); setSubscribeOpen(true) }}>
              <span aria-hidden="true">&#9993;</span> {t('sub_link')}
            </a>
          </div>
          <div className={styles.poweredBy}>{renderPoweredBy(t('powered_by'))}</div>
        </footer>
      </div>
      <SubscribeModal open={subscribeOpen} onClose={() => setSubscribeOpen(false)} />
      <SettingsBlade onOpenHelp={() => setGuideOpen(true)} />
      <GuidePanel open={guideOpen} onClose={() => setGuideOpen(false)} />
    </>
  )
}

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
