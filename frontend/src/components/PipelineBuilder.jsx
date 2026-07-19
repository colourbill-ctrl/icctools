// (c) 2026 William Li
//
// Pipeline builder — the Link-tab "chain maker" (Phase-2, DL-PIPELINE1). Same grab-
// and-drop mechanism as the V4 Display Maker, but instead of fixed role slots the
// user drops profiles (from the pool or a tab accumulator) into an ORDERED, reorder-
// able chain. The chain's profile types decide what it can PRODUCE (lib/pipeline.js):
//   • Make DeviceLink — bake the chain into one 'link' profile → lands in the pool
//     exactly like a V4 Display (a pool handle you can inspect/save).
//   • Process images  — when the chain starts AND ends in a picture space, an image
//     drop zone goes live (green cue); dropping images runs them through the chain
//     and saves each result. Images are NEVER kept in the pool/store — they are
//     dropped, processed once, and downloaded (keeps the store profiles-only).
//
// Engines are wired in a later stage; producing today surfaces a clear "engine
// arriving" notice so the whole flow (build → name → route) is judgeable first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { POOL_DND_MIME } from './PoolPane.jsx'
import { isImageSpace, spaceLabel } from '../lib/pipeline.js'
import { chainInfo } from '../lib/pipelineEngine.js'
import { useT } from '../i18n.jsx'
import styles from './PipelineBuilder.module.css'

export default function PipelineBuilder({ getEntry, onBuildLink, onApplyImages, onAccumulate }) {
  const t = useT()
  const [chain, setChain] = useState([])          // ordered array of pool ids (dups allowed)
  const [dragOver, setDragOver] = useState(false)
  const [imgOver, setImgOver] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const nameRef = useRef(null)

  // Resolve each stage id → entry (may be null if the profile was removed from the
  // pool while chained).
  const stageEntries = useMemo(() => chain.map((id) => getEntry(id)), [chain, getEntry])
  const broken = stageEntries.some((e) => !e)

  // AUTHORITATIVE validation: the WASM CMM assembly (chainInfo) is the only thing that
  // truly knows whether the chain connects — a header-signature guess cannot. Runs on
  // every chain edit; latest result wins; empty/broken chains skip the call. Outcomes
  // are gated on info.ok so an invalid combination can never be produced, and info.error
  // drives the explanatory warning.
  const [info, setInfo] = useState(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    if (broken || chain.length === 0) { setInfo(null); setChecking(false); return }
    let cancelled = false
    setChecking(true)
    const bytes = stageEntries.map((e) => e.currentBytes)
    chainInfo(bytes)
      .then((r) => { if (!cancelled) { setInfo(r); setChecking(false) } })
      .catch(() => { if (!cancelled) { setInfo({ ok: false, error: 'Could not analyse the chain.' }); setChecking(false) } })
    return () => { cancelled = true }
  }, [stageEntries, broken, chain.length])

  const canLink = !broken && !checking && info?.ok === true
  const canImage = canLink && isImageSpace(info.sourceSpace) && isImageSpace(info.destSpace)

  // Append dropped pool rows to the END of the chain (order preserved, duplicates
  // allowed — a chain may legitimately repeat an abstract profile). stopPropagation
  // so the tab's own drop handler doesn't ALSO fire (double-handling); instead we
  // accumulate explicitly via onAccumulate, so a profile dropped straight into the
  // chain also parks on the Link tab (the pipeline's working set).
  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    const raw = e.dataTransfer.getData(POOL_DND_MIME)
    if (!raw) return
    let ids; try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids) || !ids.length) return
    setChain((c) => [...c, ...ids])
    onAccumulate?.(ids)
    setError(null); setNotice(null); setNaming(false)
  }, [onAccumulate])

  const onDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes(POOL_DND_MIME)) {
      e.preventDefault(); e.stopPropagation(); setDragOver(true)
    }
  }, [])
  const onDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
  }, [])

  const move = (i, d) => setChain((c) => {
    const j = i + d
    if (j < 0 || j >= c.length) return c
    const n = [...c]; [n[i], n[j]] = [n[j], n[i]]; return n
  })
  const removeAt = (i) => setChain((c) => c.filter((_, k) => k !== i))
  const clearChain = () => { setChain([]); setNaming(false); setError(null); setNotice(null) }

  function beginNaming() {
    if (!canLink) return
    const base = (stageEntries[0]?.filename || 'link').replace(/\.(icc|icm)$/i, '')
    setName(`${base}-link`)
    setNaming(true); setError(null); setNotice(null)
    requestAnimationFrame(() => nameRef.current?.select())
  }

  async function buildLink() {
    const clean = name.trim()
    if (!clean || !canLink || busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await onBuildLink(chain.slice(), clean)
      setNaming(false)
      setNotice(t('pl_link_made', { name: clean }) || `Created “${clean}” — added to the pool and this tab.`)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // Image drop: OS image files run through the chain → save each. stopPropagation so
  // the images are NOT also loaded into the pool by the tab's file-drop handler.
  const onImgDrop = useCallback(async (e) => {
    e.preventDefault(); e.stopPropagation(); setImgOver(false)
    if (!canImage || busy) return
    const files = Array.from(e.dataTransfer.files || [])
    if (!files.length) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const n = await onApplyImages(chain.slice(), files)
      setNotice(t('pl_img_done', { n: n ?? files.length }) || `Processed ${n ?? files.length} image(s).`)
    } catch (err) {
      setError(err?.message || String(err))
    } finally {
      setBusy(false)
    }
  }, [canImage, busy, chain, onApplyImages, t])

  const onImgDragOver = useCallback((e) => {
    if (canImage && e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); setImgOver(true) }
  }, [canImage])

  return (
    <section className={`${styles.card} ${dragOver ? styles.cardDrag : ''}`}
             onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className={styles.head}>
        <h3 className={styles.title}>{t('pl_title') || 'Pipeline'}</h3>
        <p className={styles.sub}>{t('pl_sub') || 'Drag profiles here to build a transform chain, then make a DeviceLink or process images.'}</p>
      </header>

      {/* ── the ordered chain ─────────────────────────────────────── */}
      {chain.length === 0 ? (
        <div className={styles.dropHint}>{t('pl_drop_hint') || 'Drop profiles to start the chain'}</div>
      ) : (
        <div className={styles.chain}>
          {chain.map((id, i) => {
            const entry = stageEntries[i]
            return (
              <div key={`${id}:${i}`} className={styles.stageWrap}>
                {i > 0 && <span className={styles.arrow} aria-hidden="true">→</span>}
                <div className={`${styles.stage} ${entry ? '' : styles.stageBroken}`}
                     title={entry?.filename || t('pl_removed') || 'removed from pool'}>
                  <span className={styles.stageNum}>{i + 1}</span>
                  <span className={styles.stageName}>{entry?.filename || t('pl_removed') || 'removed'}</span>
                  <span className={styles.stageCtl}>
                    <button className={styles.mini} type="button" disabled={i === 0}
                            onClick={() => move(i, -1)} title={t('pl_move_left') || 'Move earlier'} aria-label={t('pl_move_left') || 'Move earlier'}>‹</button>
                    <button className={styles.mini} type="button" disabled={i === chain.length - 1}
                            onClick={() => move(i, +1)} title={t('pl_move_right') || 'Move later'} aria-label={t('pl_move_right') || 'Move later'}>›</button>
                    <button className={styles.miniX} type="button"
                            onClick={() => removeAt(i)} title={t('accum_remove') || 'Remove'} aria-label={t('accum_remove') || 'Remove'}>×</button>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── outcome summary / authoritative validation ────────────── */}
      {chain.length > 0 && (
        <div className={styles.summary}>
          {broken ? (
            <span className={styles.warn}>{t('pl_broken') || 'A chained profile was removed from the pool — remove it to continue.'}</span>
          ) : checking ? (
            <span className={styles.checking}>{t('pl_checking') || 'Checking chain…'}</span>
          ) : info?.ok ? (
            <span className={styles.flow}>
              {t('pl_flow') || 'Chain'}: <b>{spaceLabel(info.sourceSpace)}</b> <span aria-hidden="true">→</span> <b>{spaceLabel(info.destSpace)}</b>
            </span>
          ) : (
            <span className={styles.warn}>{chainError(info, t)}</span>
          )}
          <button className={styles.clear} type="button" onClick={clearChain}>{t('pl_clear') || 'Clear'}</button>
        </div>
      )}

      {/* ── outcome 1: Make DeviceLink → pool ─────────────────────── */}
      <div className={styles.outcome}>
        {!naming ? (
          <button className="btn-primary" type="button" disabled={!canLink} onClick={beginNaming}>
            {t('pl_make_link') || 'Make DeviceLink'}
          </button>
        ) : (
          <div className={styles.nameRow}>
            <input ref={nameRef} className={styles.nameInput} value={name}
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter') buildLink(); if (e.key === 'Escape') setNaming(false) }}
                   placeholder={t('pl_name_ph') || 'DeviceLink name'} aria-label={t('pl_name_ph') || 'DeviceLink name'} />
            <button className="btn-primary" type="button" disabled={busy || !name.trim()} onClick={buildLink}>
              {busy ? (t('pl_making') || 'Making…') : (t('v4_create') || 'Create')}
            </button>
            <button className={styles.cancel} type="button" disabled={busy} onClick={() => setNaming(false)}>
              {t('cancel') || 'Cancel'}
            </button>
          </div>
        )}
      </div>

      {/* ── outcome 2: process images (live only when both ends are picture spaces) ── */}
      <div
        className={`${styles.imgZone} ${canImage ? styles.imgLive : styles.imgIdle} ${imgOver ? styles.imgOver : ''}`}
        onDragOver={onImgDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setImgOver(false) }}
        onDrop={onImgDrop}
      >
        <span className={styles.imgIcon} aria-hidden="true">🖼️</span>
        {canImage ? (
          <span className={styles.imgText}>
            {t('pl_img_live', { src: spaceLabel(info.sourceSpace), dst: spaceLabel(info.destSpace) })
              || `Drop ${spaceLabel(info.sourceSpace)} images to convert to ${spaceLabel(info.destSpace)} — results download, nothing is stored.`}
          </span>
        ) : (
          <span className={styles.imgText}>
            {chain.length === 0 ? (t('pl_img_need_chain') || 'Build a chain to process images')
              : checking ? (t('pl_checking') || 'Checking chain…')
              : !info?.ok ? (t('pl_img_invalid') || 'Fix the chain before processing images')
              : (t('pl_img_not_image') || 'This chain does not start and end in an image colour space')}
          </span>
        )}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}
    </section>
  )
}

// Explanatory text for an invalid chain, from the authoritative chainInfo result. The
// engine's terse status ("Invalid space link") is kept in parentheses for precision,
// wrapped in a plain-language sentence that names the offending stage.
function chainError(info, t) {
  if (!info) return t('pl_unknown') || 'The chain could not be analysed.'
  const detail = info.error || ''
  const stage = info.failedStage
  if (stage && stage > 0) {
    return t('pl_no_connect_stage', { n: stage, detail })
      || `Profile ${stage} does not connect to the previous stage${detail ? ` (${detail})` : ''}.`
  }
  return t('pl_no_connect', { detail })
    || `The chain does not connect${detail ? ` (${detail})` : ''}.`
}
