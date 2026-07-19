// (c) 2026 William Li
//
// V4 Display Maker — the first Link-tab "maker" card (DL-LINK1, phase-1 item 5).
// Combines a V5 RGB display + a V5 observer (ColorSpace-class PCC) profile into a
// V4 RGB matrix/TRC display profile via iccV5DspObsToV4Dsp.
//
// The WHOLE card is a single drag-and-drop target (drag rows straight from the
// Profiles pane). A dropped profile is routed BY ROLE — class 'mntr'+'RGB ' fills
// the display slot, class 'spac' fills the observer slot — and the newest per role
// replaces whatever was there. When both slots are filled the produce button
// lights up; producing asks for a name, runs the engine, and drops the result into
// the pool + the Link accumulator (one data copy, two handles). It deliberately
// occupies only part of the Link canvas — other makers (DeviceLink, …) sit beside it.
import { useCallback, useRef, useState } from 'react'
import { POOL_DND_MIME } from './PoolPane.jsx'
import { classifyV5Role } from '../lib/v4display.js'
import { useT } from '../i18n.jsx'
import styles from './V4DisplayMaker.module.css'

export default function V4DisplayMaker({ getEntry, onCreate, roles, setRoles }) {
  const t = useT()
  // Role slots (dsp / obs) are lifted to App so they survive tab switches within a
  // session (the pool is unchanged). Local fallback keeps the component usable if a
  // parent forgets to pass them.
  const [localRoles, setLocalRoles] = useState({ dsp: null, obs: null })
  const roleState = roles || localRoles
  const setRoleState = setRoles || setLocalRoles
  const dspId = roleState.dsp
  const obsId = roleState.obs
  const [dragOver, setDragOver] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [unrouted, setUnrouted] = useState(0)   // count of last drop's non-matching profiles
  const nameRef = useRef(null)

  const dsp = dspId ? getEntry(dspId) : null
  const obs = obsId ? getEntry(obsId) : null
  const ready = !!dsp && !!obs

  // Route each dropped pool row into its role slot (newest-per-role wins). We
  // stopPropagation so the drop doesn't ALSO bubble up to the tab accumulator.
  const onDrop = useCallback((e) => {
    e.preventDefault(); e.stopPropagation(); setDragOver(false)
    const raw = e.dataTransfer.getData(POOL_DND_MIME)
    if (!raw) return
    let ids; try { ids = JSON.parse(raw) } catch { return }
    if (!Array.isArray(ids)) return
    let miss = 0
    for (const id of ids) {
      const entry = getEntry(id)
      const role = entry ? classifyV5Role(entry.currentBytes) : null
      if (role === 'display') setRoleState((r) => ({ ...r, dsp: id }))
      else if (role === 'observer') setRoleState((r) => ({ ...r, obs: id }))
      else miss++
    }
    setUnrouted(miss)
    setError(null); setNotice(null)
  }, [getEntry])

  const onDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes(POOL_DND_MIME)) { e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  }, [])
  const onDragLeave = useCallback((e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false)
  }, [])

  function beginNaming() {
    if (!ready) return
    const base = (dsp.filename || 'display').replace(/\.(icc|icm)$/i, '')
    setName(`${base}-v4`)
    setNaming(true); setError(null); setNotice(null)
    // focus after the input mounts
    requestAnimationFrame(() => nameRef.current?.select())
  }

  async function create() {
    const clean = name.trim()
    if (!clean || !ready || busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await onCreate(dspId, obsId, clean)
      setNaming(false)
      setNotice(t('v4_made', { name: clean }) || `Created “${clean}” — added to the pool and this tab.`)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`${styles.card} ${dragOver ? styles.cardDrag : ''}`}
             onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <header className={styles.head}>
        <h3 className={styles.title}>{t('v4_maker_title') || 'V4 Display Maker'}</h3>
        <p className={styles.sub}>{t('v4_maker_sub') || 'Drag a V5 RGB display and a V5 observer profile here to build a V4 display profile.'}</p>
      </header>

      <div className={styles.slots}>
        <Slot label={t('v4_slot_display') || 'V5 RGB display'} entry={dsp}
              hint={t('v4_slot_display_hint') || 'drop a display profile'}
              onClear={() => setRoleState((r) => ({ ...r, dsp: null }))} clearLabel={t('accum_remove') || 'Remove'} />
        <Slot label={t('v4_slot_observer') || 'V5 observer (PCC)'} entry={obs}
              hint={t('v4_slot_observer_hint') || 'drop an observer profile'}
              onClear={() => setRoleState((r) => ({ ...r, obs: null }))} clearLabel={t('accum_remove') || 'Remove'} />
      </div>

      {unrouted > 0 && (
        <p className={styles.warn}>{t('v4_unrouted') || 'Ignored a profile that is neither a V5 RGB display nor an observer.'}</p>
      )}

      {!naming ? (
        <button className="btn-primary" type="button" disabled={!ready} onClick={beginNaming}>
          {t('v4_make_btn') || 'Make V4 Display Profile'}
        </button>
      ) : (
        <div className={styles.nameRow}>
          <input ref={nameRef} className={styles.nameInput} value={name}
                 onChange={(e) => setName(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setNaming(false) }}
                 placeholder={t('v4_name_ph') || 'Profile name'} aria-label={t('v4_name_ph') || 'Profile name'} />
          <button className="btn-primary" type="button" disabled={busy || !name.trim()} onClick={create}>
            {busy ? (t('v4_making') || 'Making…') : (t('v4_create') || 'Create')}
          </button>
          <button className={styles.cancel} type="button" disabled={busy} onClick={() => setNaming(false)}>
            {t('cancel') || 'Cancel'}
          </button>
        </div>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} aria-live="polite">{notice}</p>}
    </section>
  )
}

function Slot({ label, entry, hint, onClear, clearLabel }) {
  return (
    <div className={`${styles.slot} ${entry ? styles.slotFilled : ''}`}>
      <span className={styles.slotLabel}>{label}</span>
      {entry ? (
        <span className={styles.slotChip} title={entry.filename}>
          <span className={styles.slotName}>{entry.filename}</span>
          <button className={styles.slotX} type="button" onClick={onClear}
                  title={clearLabel} aria-label={clearLabel}>×</button>
        </span>
      ) : (
        <span className={styles.slotHint}>{hint}</span>
      )}
    </div>
  )
}
