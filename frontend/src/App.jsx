// (c) 2026 William Li
//
// 2.x Profile Pool workbench shell. Left = the pool (PoolPane, full height);
// right column = topbar / Profile·Compare·Link tabs (MainCanvas) / footer. The
// settings blade + guide are fixed overlays on top (no layout push). The pool is
// session-ephemeral — nothing persists; the user's filesystem is the durable
// store (DL-STORE1). Today's single-profile app is reused verbatim as the Profile
// tab (embedded ProfileViewer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PoolPane from './components/PoolPane.jsx'
import MainCanvas from './components/MainCanvas.jsx'
import SettingsBlade from './components/SettingsBlade.jsx'
import SubscribeModal from './components/SubscribeModal.jsx'
import GuidePanel from './components/GuidePanel.jsx'
import RejectedFilesModal from './components/RejectedFilesModal.jsx'
import NewFromCubeModal from './components/NewFromCubeModal.jsx'
import { validateBytes, preloadValidator } from './lib/validator.js'
import { bestEffortParse } from './lib/bestEffortParse.js'
import { computeChangedTagIds } from './lib/tagDiff.js'
import { resolveTabAlias } from './lib/tabs.js'
import { entryId, deriveMeta } from './lib/pool.js'
import { classifyFile, ACCEPTED_KINDS, FileKind, rejectReason } from './lib/fileKind.js'
import { findEmbeddedProfile, findEmbeddedProfileFromFile } from './lib/imageCodec.js'
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
         target="_blank" rel="noreferrer">IccDEV</a>
      {after}
    </>
  )
}

const uniq = (arr) => [...new Set(arr)]

export default function App() {
  const [pool, setPool] = useState(() => new Map())        // id -> entry
  const [accum, setAccum] = useState({ Profile: null, Compare: [], Link: [], SpecSep: [] })
  // Combine-tab maker state lifted to App so it SURVIVES tab switches (the maker
  // cards unmount when you leave the Combine tab; local state would be lost, but the
  // pool/datastore hasn't changed, so the chain and the Observer-Change slots should
  // persist for the session — just like the accumulators above).
  // Link Pipeline config: ordered pool ids + a parallel per-transform rendering
  // intent, the head-transform direction, and the last global intent chosen.
  const [pipeline, setPipeline] = useState({ chain: [], intents: [], headForward: true, globalIntent: 1, invertReverse: false })
  const [v4Roles, setV4Roles] = useState({ dsp: null, obs: null })  // Observer-Change slots
  const [activeTab, setActiveTab] = useState('Profile')
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [rejected, setRejected] = useState(null)           // [{filename, reason}] | null
  const [initialTab, setInitialTab] = useState(null)       // from #tab= launch fragment
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [newCubeOpen, setNewCubeOpen] = useState(false)   // "New from .cube" producer
  const t = useT()

  useEffect(() => { preloadValidator() }, [])

  // Refs mirror state for synchronous reads inside async load loops.
  const poolRef = useRef(pool);  poolRef.current = pool
  const accumRef = useRef(accum); accumRef.current = accum

  // Validate ICC bytes and add a pool entry (dedup by identity). Returns the
  // entry id; throws only if the bytes surfaced as ICC ('acsp') but are wholly
  // unparseable (caller turns that into a rejection).
  const addIccEntry = useCallback(async (filename, bytes) => {
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
    return id
  }, [])

  // Classify one IN-MEMORY buffer and either load it or return a rejection. Used
  // by the launch protocols (#url= / postMessage), where the bytes are already fully
  // in hand. An IMAGE buffer has its embedded ICC extracted via the canonical codecs
  // (lib/imageCodec::findEmbeddedProfile). File loads use ingestFile() instead (which
  // classifies from a front slice before reading the file whole). Both share the same
  // accept policy + addIccEntry tail.
  const ingestOne = useCallback(async (filename, bytes) => {
    if (bytes.length > MAX_ICC_BYTES) {
      return { reject: { filename, reason: `too large (> ${MAX_ICC_BYTES / (1024*1024)} MB)` } }
    }
    const { kind } = classifyFile(bytes, filename)
    if (!ACCEPTED_KINDS.has(kind)) {
      return { reject: { filename, reason: rejectReason(kind) } }
    }
    // IMAGE: pull the embedded profile and ingest THAT (not the image). No
    // embedded profile → a clean rejection, same channel as any other reject.
    if (kind === FileKind.IMAGE) {
      const profile = await findEmbeddedProfile(bytes)
      if (!profile) return { reject: { filename, reason: rejectReason(FileKind.IMAGE) } }
      bytes = profile
      filename = embeddedName(filename)
    }
    try {
      const id = await addIccEntry(filename, bytes)
      return { id }
    } catch {
      return { reject: { filename, reason: 'could not be read as an ICC profile' } }
    }
  }, [addIccEntry])

  // Classify + load one File without reading the whole thing to *classify*. We sniff
  // a small front slice for the magic, then:
  //  • IMAGE  → STREAM the embedded ICC out of the File: a worker runs the canonical
  //             codecs (libtiff/libpng/libjpeg) reading only the metadata region on
  //             demand (lib/imageCodec.js::findEmbeddedProfileFromFile) — never the
  //             pixels, so a huge image isn't loaded to grab its profile. The extracted
  //             profile is size-checked below.
  //  • ICC    → size-cap the FILE (checked against file.size before allocating, so
  //             a huge file is rejected without ever reading it), then read whole.
  const ingestFile = useCallback(async (file) => {
    const name = file.name
    let head
    try {
      head = new Uint8Array(await file.slice(0, 64).arrayBuffer())   // enough for 'acsp'@36 + magics
    } catch {
      return { reject: { filename: name, reason: 'could not be read' } }
    }
    const { kind } = classifyFile(head, name)
    if (!ACCEPTED_KINDS.has(kind)) return { reject: { filename: name, reason: rejectReason(kind) } }

    if (kind === FileKind.IMAGE) {
      // STREAMING extraction: a worker reads only the image's metadata (header/IFD/
      // markers + the profile blob) via libtiff/libpng/libjpeg — never the pixels — so
      // a huge image never loads into memory just to grab its profile.
      let profile
      try { profile = await findEmbeddedProfileFromFile(file) } catch { profile = null }
      if (!profile) return { reject: { filename: name, reason: rejectReason(FileKind.IMAGE) } }
      if (profile.length > MAX_ICC_BYTES) {
        return { reject: { filename: name, reason: `embedded profile too large (> ${MAX_ICC_BYTES / (1024*1024)} MB)` } }
      }
      try { return { id: await addIccEntry(embeddedName(name), profile) } }
      catch { return { reject: { filename: name, reason: 'embedded data is not a valid ICC profile' } } }
    }

    // ICC — cap by file.size BEFORE allocating the buffer.
    if (file.size > MAX_ICC_BYTES) {
      return { reject: { filename: name, reason: `too large (> ${MAX_ICC_BYTES / (1024*1024)} MB)` } }
    }
    let bytes
    try { bytes = new Uint8Array(await file.arrayBuffer()) } catch {
      return { reject: { filename: name, reason: 'could not be read' } }
    }
    try { return { id: await addIccEntry(name, bytes) } }
    catch { return { reject: { filename: name, reason: 'could not be read as an ICC profile' } } }
  }, [addIccEntry])

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
      SpecSep: a.SpecSep.filter((x) => x !== id),
    }))
    setSelectedIds((s) => { const ns = new Set(s); ns.delete(id); return ns })
  }, [])

  // Drop pool row(s) onto a tab. Profile replaces (multi → last wins);
  // Compare/Link accumulate (dedup). Dropping switches to that tab.
  const dropOnTab = useCallback((tab, ids) => {
    if (!ids || !ids.length) return
    setAccum((a) => tab === 'Profile'
      ? { ...a, Profile: ids[ids.length - 1] }
      : { ...a, [tab]: uniq([...a[tab], ...ids]) })
    setActiveTab(tab)
  }, [])

  const removeFromAccum = useCallback((tab, id) => {
    setAccum((a) => tab === 'Profile'
      ? { ...a, Profile: a.Profile === id ? null : a.Profile }
      : { ...a, [tab]: a[tab].filter((x) => x !== id) })
  }, [])

  // Load a batch of files (pool-pane picker/drop, or canvas OS-drop). `tab`, when
  // given (canvas drop), accumulates the loaded profiles onto that tab — the same
  // end effect as loading them then dragging them across. All rejects from the
  // batch are reported together in one dialog (never one popup per file).
  const loadFiles = useCallback(async (files, { tab } = {}) => {
    setLoading(true); setError(null)
    const wasEmpty = poolRef.current.size === 0
    const rejects = [], ids = []
    for (let i = 0; i < files.length; i++) {
      // ingestFile streams: it never reads the whole file to classify, and images
      // yield only their embedded profile (the raster is never loaded).
      // eslint-disable-next-line no-await-in-loop
      const r = await ingestFile(files[i])
      if (r.id) ids.push(r.id)
      else rejects.push(r.reject)
    }
    setLoading(false)
    if (ids.length) {
      // Loading does NOT select anything in the profiles pane — the pool is just
      // populated; the user picks/drags rows themselves. (A canvas drop still
      // accumulates onto its target tab, and an empty pool still auto-opens the
      // first profile so the Profile tab isn't blank on a fresh single load.)
      if (tab) dropOnTab(tab, ids)
      else if (wasEmpty || accumRef.current.Profile == null) {
        setAccum((a) => ({ ...a, Profile: ids[0] })); setActiveTab('Profile')
      }
    }
    if (rejects.length) setRejected(rejects)
  }, [ingestFile, dropOnTab])

  // Single-file ingest for the launch protocols (#url=, chardata postMessage):
  // open in Profile on success, report on rejection.
  const ingestSingle = useCallback(async (filename, bytes) => {
    setLoading(true); setError(null)
    const r = await ingestOne(filename, bytes)
    setLoading(false)
    if (r.id) {
      // Open it in the Profile tab, but don't select the pane row (see loadFiles).
      setAccum((a) => ({ ...a, Profile: r.id })); setActiveTab('Profile')
    } else {
      setRejected([r.reject])
    }
  }, [ingestOne])

  // Producer — build an ICC DeviceLink from .cube text (Group B / iccFromCube).
  // The wasm module is lazy-imported so users who never open the producer don't
  // pay for it. On success we both add the result to the pool (via the same
  // ingest path as a loaded profile, so it validates + opens in Profile) and
  // download the .icc. Errors propagate to the modal, which shows the engine's
  // specific reason ("LUT too large to process", …) inline.
  const createFromCube = useCallback(async (cubeText, filename) => {
    const { fromCube } = await import('./lib/cubeConverter.js')
    const bytes = await fromCube(cubeText, filename)          // throws with a readable message
    const stem = (filename || 'devicelink').replace(/\.cube$/i, '').replace(/[^\w.-]+/g, '_') || 'devicelink'
    const outName = `${stem}.icc`

    // Download the generated profile.
    const blob = new Blob([bytes], { type: 'application/vnd.iccprofile' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = outName
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)

    // Add to the pool + open in Profile (reuses the validate/dedup ingest path).
    await ingestSingle(outName, bytes)
    setNewCubeOpen(false)
  }, [ingestSingle])

  // Link-tab maker — V4 Display (DL-LINK1, item 5). Combine a pooled V5 display +
  // V5 observer into a V4 display profile. The result goes into the pool AND the
  // Link accumulator: ONE data copy, a handle in each place. No auto-download —
  // the user saves from the pool/Profile view like any other entry. Throws the
  // engine's specific rejection so the maker card surfaces it inline.
  const createV4Display = useCallback(async (dspId, obsId, name) => {
    const dsp = poolRef.current.get(dspId)
    const obs = poolRef.current.get(obsId)
    if (!dsp || !obs) throw new Error('One of the selected profiles is no longer in the pool.')
    const { makeV4Display } = await import('./lib/v4display.js')
    const bytes = await makeV4Display(dsp.currentBytes, obs.currentBytes)   // throws readable message
    const stem = (name || 'display-v4').replace(/\.(icc|icm)$/i, '').replace(/[^\w.-]+/g, '_') || 'display-v4'
    const id = await addIccEntry(`${stem}.icc`, bytes)   // → pool (Profiles pane handle)
    setAccum((a) => ({ ...a, Link: uniq([...a.Link, id]) }))   // → Link accumulator handle
    return id
  }, [addIccEntry])

  // ── Pipeline (DL-PIPELINE1) — Link-tab ordered-chain maker ─────────────────
  // A chain of pooled profiles bakes into a DeviceLink (→ pool + Link accumulator,
  // like the V4 maker: ONE data copy, a handle in each place) OR runs raster images
  // through the same transform (→ download each result; images are NEVER stored, so
  // the pool stays profiles-only). The WASM engines (iccApplyToLink / iccApplyProfiles
  // ports) land in a later stage; lib/pipelineEngine.js is the seam and today throws
  // a clear pending message so the whole build → name → route flow is judgeable now.
  const buildDeviceLink = useCallback(async (chainIds, name, opts = {}) => {
    const entries = chainIds.map((id) => poolRef.current.get(id))
    if (entries.some((e) => !e)) throw new Error('A chained profile is no longer in the pool.')
    const { buildLink } = await import('./lib/pipelineEngine.js')
    const bytes = await buildLink(entries.map((e) => e.currentBytes), opts)
    const stem = (name || 'devicelink').replace(/\.(icc|icm)$/i, '').replace(/[^\w.-]+/g, '_') || 'devicelink'
    const id = await addIccEntry(`${stem}.icc`, bytes)              // → pool handle
    setAccum((a) => ({ ...a, Link: uniq([...a.Link, id]) }))        // → Link accumulator handle
    return id
  }, [addIccEntry])

  // Runs each image through the chain and RETURNS the produced {bytes, filename}
  // results (no download here) — the caller drives the Save dialog so it can acquire
  // the file handle from a fresh user gesture before the transform runs.
  const applyImagesThroughChain = useCallback(async (chainIds, files, opts = {}) => {
    const entries = chainIds.map((id) => poolRef.current.get(id))
    if (entries.some((e) => !e)) throw new Error('A chained profile is no longer in the pool.')
    const { applyToImage } = await import('./lib/pipelineEngine.js')
    const chainBytes = entries.map((e) => e.currentBytes)
    const results = []
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await applyToImage(chainBytes, file, opts))
    }
    return results
  }, [])

  // Add a profile EXTRACTED from a dropped image's embedded ICC to the pool (Pipeline
  // builder, G9). Same addIccEntry tail as any load, so the extracted profile becomes a
  // normal pool entry the caller can place at the head of the chain. Returns the new id.
  const addExtractedProfile = useCallback(async (name, bytes) => {
    if (!bytes || !bytes.length) throw new Error('No embedded profile to extract.')
    if (bytes.length > MAX_ICC_BYTES) throw new Error(`Embedded profile too large (> ${MAX_ICC_BYTES / (1024 * 1024)} MB).`)
    return addIccEntry(name, bytes)
  }, [addIccEntry])

  // Spectral assembler (SpecSep tab) — gather N single-channel images → one multi-
  // channel TIFF, downloaded. Also engine-pending.
  const assembleSpectral = useCallback(async (files) => {
    const { assembleSpecSep } = await import('./lib/pipelineEngine.js')
    const out = await assembleSpecSep(files)
    downloadBytes(out.bytes, out.filename)
    return files.length
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

  // ── Launch protocols (unchanged behaviour; now funnel through ingestSingle) ─
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
    await ingestSingle(filenameFromUrl(url), bytes)
  }, [ingestSingle, t])

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
    // Same-origin always; chardata's dev server ONLY in a dev build. Shipping the
    // localhost entries to production made any co-resident process on port 3001 a trusted
    // sender of `profiletool:load` — bytes ingested with no confirmation dialog — and the
    // ready-broadcast below actively announced this tab to it. In production chardata is
    // served from the same origin, so the dev entries buy nothing there.
    const allowedOrigins = new Set([window.location.origin])
    if (import.meta.env.DEV) {
      allowedOrigins.add('http://localhost:3001')
      allowedOrigins.add('http://127.0.0.1:3001')
    }
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
      ingestSingle(filename || 'profile.icc', u8)
    }
    window.addEventListener('message', onMessage)
    for (const origin of allowedOrigins) {
      try { window.opener.postMessage({ type: 'profiletool:ready' }, origin) } catch (_) {}
    }
    return () => window.removeEventListener('message', onMessage)
  }, [ingestSingle])

  const entries = useMemo(() => [...pool.values()], [pool])
  const getEntry = useCallback((id) => pool.get(id) || null, [pool])
  const onDropFiles = useCallback((files, tab) => loadFiles(files, { tab }), [loadFiles])

  return (
    <>
      <div className={styles.app}>
        <PoolPane
          entries={entries}
          selectedIds={selectedIds}
          onSelect={onSelectRow}
          onLoadFiles={loadFiles}
          onRemove={removeEntry}
          onNewFromCube={() => setNewCubeOpen(true)}
        />
        <div className={styles.rightCol}>
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

          <MainCanvas
            activeTab={activeTab}
            onActivate={setActiveTab}
            accum={accum}
            getEntry={getEntry}
            onDropOnTab={dropOnTab}
            onDropFiles={onDropFiles}
            onRemoveFromAccum={removeFromAccum}
            profileEntry={profileEntry}
            initialTab={initialTab}
            changedTagIds={changedTagIds}
            onXmlChanged={handleXmlChanged}
            onJsonChanged={handleJsonChanged}
            onIccProduced={handleIccProduced}
            onSave={handleSave}
            onCreateV4={createV4Display}
            onBuildLink={buildDeviceLink}
            onApplyImages={applyImagesThroughChain}
            onAddProfile={addExtractedProfile}
            onAssembleSpec={assembleSpectral}
            pipeline={pipeline}
            setPipeline={setPipeline}
            v4Roles={v4Roles}
            setV4Roles={setV4Roles}
          />

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
      </div>
      <RejectedFilesModal files={rejected} onClose={() => setRejected(null)} />
      <NewFromCubeModal open={newCubeOpen} onClose={() => setNewCubeOpen(false)} onCreate={createFromCube} />
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

// Pool-row label for a profile lifted out of an image: strip the image
// extension and tag it as embedded so the source is obvious in the list.
// (The label is cosmetic — dedup keys on the profile's own identity, not this.)
function embeddedName(imageName) {
  const stem = (imageName || 'image').replace(/\.(tiff?|png|jpe?g)$/i, '')
  return `${stem} (embedded).icc`
}

function bytesEqual(a, b) {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Save bytes to the user's disk (browser download → their chosen folder). Used by
// the pipeline image-processing + spectral-assembly outputs, which are NOT stored in
// the pool. Mirrors the anchor-download pattern in handleSave/createFromCube.
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename || 'output.bin'
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}
