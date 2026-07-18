// (c) 2026 William Li
//
// Centre canvas of the 2.x pool workbench: three tabs — Profile · Compare · Link.
// Activation is by clicking a tab OR dragging profile(s) from the pool onto it
// (P1-a). Each tab keeps its own accumulator (removable chiclets, P1-e): Profile
// holds one (drag replaces / multi-drop → last wins); Compare & Link accumulate.
// Profile embeds today's ProfileViewer; Compare (gamut, P1-b) and Link (node
// canvas, canvas phase) are step-1 placeholders.
import { useCallback, useState } from 'react'
import ProfileViewer from './ProfileViewer.jsx'
import { POOL_DND_MIME } from './PoolPane.jsx'
import { useT } from '../i18n.jsx'
import styles from './MainCanvas.module.css'

const TABS = ['Profile', 'Compare', 'Link']

export default function MainCanvas({
  activeTab, onActivate, accum, getEntry, onDropOnTab, onDropFiles, onRemoveFromAccum,
  // Profile-tab viewer wiring (bound by App to the active Profile entry):
  profileEntry, initialTab, changedTagIds, onXmlChanged, onJsonChanged,
  onIccProduced, onSave,
}) {
  const t = useT()
  const [dropTab, setDropTab] = useState(null)
  const [panelDrag, setPanelDrag] = useState(false)

  const idsFor = (tab) => tab === 'Profile' ? (accum.Profile ? [accum.Profile] : []) : (accum[tab] || [])

  // We accept two drag kinds anywhere on the canvas: internal pool-row drags
  // (POOL_DND_MIME → accumulate onto the target tab) and OS file drags (Files →
  // load into the pool AND accumulate onto the tab — the same end effect as
  // loading then dragging across).
  const acceptDrag = (e) => e.dataTransfer.types.includes(POOL_DND_MIME) || e.dataTransfer.types.includes('Files')

  const routeDrop = useCallback((tab, e) => {
    e.preventDefault(); setDropTab(null); setPanelDrag(false)
    const raw = e.dataTransfer.getData(POOL_DND_MIME)
    if (raw) {
      let ids; try { ids = JSON.parse(raw) } catch { return }
      if (Array.isArray(ids) && ids.length) onDropOnTab(tab, ids)
      return
    }
    const files = Array.from(e.dataTransfer.files || [])
    if (files.length && onDropFiles) onDropFiles(files, tab)
  }, [onDropOnTab, onDropFiles])

  const dropProps = (tab) => ({
    onDragOver: (e) => { if (acceptDrag(e)) { e.preventDefault(); setDropTab(tab) } },
    onDragLeave: () => setDropTab((d) => (d === tab ? null : d)),
    onDrop: (e) => routeDrop(tab, e),
  })

  // The whole panel is a drop target for the active tab. Clear the highlight only
  // when the pointer actually leaves the panel subtree (not when crossing into a
  // child), so it doesn't flicker over the embedded viewer.
  const panelDropProps = {
    onDragOver: (e) => { if (acceptDrag(e)) { e.preventDefault(); setPanelDrag(true) } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setPanelDrag(false) },
    onDrop: (e) => routeDrop(activeTab, e),
  }

  const tabLabel = (tab) => t('tab_' + tab.toLowerCase()) || tab
  const activeIds = idsFor(activeTab)

  return (
    <section className={styles.canvas}>
      <nav className={styles.tabBar} role="tablist">
        {TABS.map((tab) => {
          const n = idsFor(tab).length
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={activeTab === tab}
              className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''} ${dropTab === tab ? styles.tabDrop : ''}`}
              onClick={() => onActivate(tab)}
              {...dropProps(tab)}
            >
              {tabLabel(tab)}
              {n > 0 && <span className={styles.tabCount}>{n}</span>}
            </button>
          )
        })}
      </nav>

      {/* Accumulator chiclets for the active tab (also a drop target). */}
      <div className={`${styles.accum} ${dropTab === activeTab ? styles.accumDrop : ''}`} {...dropProps(activeTab)}>
        {activeIds.length === 0 ? (
          <span className={styles.accumHint}>{t('accum_hint') || 'Drag profiles from the pool onto this tab'}</span>
        ) : activeIds.map((id) => {
          const entry = getEntry(id)
          if (!entry) return null
          return (
            <span key={id} className={styles.chiclet} title={entry.filename}>
              <span className={styles.chicletName}>{entry.filename}</span>
              <button className={styles.chicletX} onClick={() => onRemoveFromAccum(activeTab, id)}
                      title={t('accum_remove') || 'Remove'} aria-label={t('accum_remove') || 'Remove'}>×</button>
            </span>
          )
        })}
      </div>

      <div className={`${styles.panel} ${panelDrag ? styles.panelDrag : ''}`} role="tabpanel" {...panelDropProps}>
        {activeTab === 'Profile' && (
          <ProfilePanel
            entry={profileEntry} t={t} initialTab={initialTab} changedTagIds={changedTagIds}
            onXmlChanged={onXmlChanged} onJsonChanged={onJsonChanged}
            onIccProduced={onIccProduced} onSave={onSave}
          />
        )}
        {activeTab === 'Compare' && <ComparePanel ids={activeIds} getEntry={getEntry} t={t} />}
        {activeTab === 'Link' && <LinkPanel t={t} />}
      </div>
    </section>
  )
}

function ProfilePanel({ entry, t, initialTab, changedTagIds, onXmlChanged, onJsonChanged, onIccProduced, onSave }) {
  if (!entry) {
    return (
      <Empty icon="🔍"
        head={t('profile_empty_head') || 'No profile selected'}
        sub={t('profile_empty_sub') || 'Drag a profile from the pool onto the Profile tab to inspect it.'} />
    )
  }
  return (
    <div className={styles.profileWrap}>
      <div className={styles.profileBar}>
        <span className={styles.profileName}>{entry.filename}</span>
        {entry.iccDirty && <span className={styles.modifiedPill}>{t('modified_pill') || 'Modified'}</span>}
        <span className={styles.spacer} />
        <button className="btn-primary" type="button" onClick={onSave}>{t('save_profile') || 'Save profile'}</button>
      </div>
      <ProfileViewer
        data={entry.parsed}
        bytes={entry.currentBytes}
        initialTab={initialTab}
        xml={entry.xml}
        xmlDirty={entry.xmlDirty}
        json={entry.json}
        jsonDirty={entry.jsonDirty}
        changedTagIds={changedTagIds}
        onXmlChanged={onXmlChanged}
        onJsonChanged={onJsonChanged}
        onIccProduced={onIccProduced}
      />
    </div>
  )
}

// Step-1 placeholder — gamut views (chardata 3D mesh + 2D slice, driven by
// IccProfLib/iccviz) land in the P1-b build step; here we confirm the accumulated
// set so the interaction is exercisable end to end.
function ComparePanel({ ids, getEntry, t }) {
  if (!ids.length) {
    return (
      <Empty icon="📊"
        head={t('compare_empty_head') || 'Nothing to compare yet'}
        sub={t('compare_empty_sub') || 'Drag one or more profiles onto the Compare tab.'} />
    )
  }
  return (
    <div className={styles.placeholder}>
      <p className={styles.placeholderHead}>{t('compare_soon') || 'Gamut comparison'}</p>
      <p className={styles.placeholderSub}>
        {t('compare_soon_sub') || '3D gamut & 2D slice views are coming here. Accumulated:'}
      </p>
      <ul className={styles.placeholderList}>
        {ids.map((id) => { const e = getEntry(id); return e ? <li key={id}>{e.filename}</li> : null })}
      </ul>
    </div>
  )
}

function LinkPanel({ t }) {
  return (
    <Empty icon="🔗"
      head={t('link_soon') || 'Linking'}
      sub={t('link_soon_sub') || 'DeviceLink production and multi-profile transforms arrive in a later phase.'} />
  )
}

function Empty({ icon, head, sub }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>{icon}</div>
      <p className={styles.emptyHead}>{head}</p>
      <p className={styles.emptySub}>{sub}</p>
    </div>
  )
}
