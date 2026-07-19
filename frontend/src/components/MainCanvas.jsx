// (c) 2026 William Li
//
// Centre canvas of the 2.x pool workbench: four tabs — Profile · Compare · Link ·
// SpecSep. Activation is by clicking a tab OR dragging profile(s) from the pool onto
// it (P1-a). Profile/Compare/Link keep a pool accumulator (removable chiclets, P1-e):
// Profile holds one (drag replaces / multi-drop → last wins); Compare & Link
// accumulate. SpecSep is self-contained (it gathers IMAGES, not pooled profiles) so
// it has no accumulator. Profile embeds today's ProfileViewer; Compare = gamut; Link
// = maker cards (V4 Display + Pipeline); SpecSep = spectral image assembler.
import { useCallback, useEffect, useState } from 'react'
import ProfileViewer from './ProfileViewer.jsx'
import ComparePanel from './ComparePanel.jsx'
import V4DisplayMaker from './V4DisplayMaker.jsx'
import PipelineBuilder from './PipelineBuilder.jsx'
import SpecSepPanel from './SpecSepPanel.jsx'
import { POOL_DND_MIME } from './PoolPane.jsx'
import { useT } from '../i18n.jsx'
import styles from './MainCanvas.module.css'

const TABS = ['Profile', 'Compare', 'Link', 'SpecSep']
// Tabs that gather IMAGES rather than pooled profiles — no pool accumulator bar.
const NO_ACCUM = new Set(['SpecSep'])

export default function MainCanvas({
  activeTab, onActivate, accum, getEntry, onDropOnTab, onDropFiles, onRemoveFromAccum,
  // Profile-tab viewer wiring (bound by App to the active Profile entry):
  profileEntry, initialTab, changedTagIds, onXmlChanged, onJsonChanged,
  onIccProduced, onSave,
  // Link-tab makers (DL-LINK1 / DL-PIPELINE1):
  onCreateV4, onBuildLink, onApplyImages,
  // Combine-tab maker state lifted to App (survives tab switches):
  pipeline, setPipeline, v4Roles, setV4Roles,
  // SpecSep tab (DL-PIPELINE1):
  onAssembleSpec,
}) {
  const t = useT()
  const [dropTab, setDropTab] = useState(null)
  const [panelDrag, setPanelDrag] = useState(false)

  // Safety net for the drag-highlight state. When a drop lands on a Link maker card,
  // the card stopPropagation()s it so it doesn't double-accumulate onto the tab — but
  // that also prevents the panel's own onDrop (which clears panelDrag) from firing, so
  // the highlight would stick on forever. `dragend` fires on the drag SOURCE at the end
  // of EVERY drag (drop, cancel, or drop-outside) and is not affected by a child's
  // stopPropagation, so clearing here always resets the highlight.
  useEffect(() => {
    const clear = () => { setPanelDrag(false); setDropTab(null) }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

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

  // Accumulator chiclets are themselves drag SOURCES (same POOL_DND_MIME as pool
  // rows), so a profile parked on a tab can be dragged down into a Link maker card
  // (V4 slots / Pipeline chain) without going back to the pool. Single id per chiclet.
  const onChicletDragStart = useCallback((id, e) => {
    e.dataTransfer.setData(POOL_DND_MIME, JSON.stringify([id]))
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

  // The whole panel is a drop target for the active tab. Clear the highlight only
  // when the pointer actually leaves the panel subtree (not when crossing into a
  // child), so it doesn't flicker over the embedded viewer.
  //
  // EXCEPTION: the Link (Combine) tab. Its maker cards (Observer Change, Link
  // Pipeline) each own their drop area, so a panel-wide drop target here just lit up
  // the whole canvas and let profiles land on empty space — confusing. On Link we
  // drop the panel target entirely; the cards handle their own drops (and still
  // accumulate onto the tab via onAccumulate). Profiles can also still be dropped on
  // the tab button and the accumulator strip.
  const panelDropProps = activeTab === 'Link' ? {} : {
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

      {/* Accumulator chiclets for the active tab (also a drop target). SpecSep is
          image-only, so it shows no profile accumulator. */}
      {!NO_ACCUM.has(activeTab) && (
      <div className={`${styles.accum} ${dropTab === activeTab ? styles.accumDrop : ''}`} {...dropProps(activeTab)}>
        {activeIds.length === 0 ? (
          <span className={styles.accumHint}>{t('accum_hint') || 'Drag profiles from the pool onto this tab'}</span>
        ) : activeIds.map((id) => {
          const entry = getEntry(id)
          if (!entry) return null
          return (
            <span key={id} className={styles.chiclet} title={entry.filename}
                  draggable onDragStart={(e) => onChicletDragStart(id, e)}>
              <span className={styles.chicletName}>{entry.filename}</span>
              <button className={styles.chicletX} onClick={() => onRemoveFromAccum(activeTab, id)}
                      title={t('accum_remove') || 'Remove'} aria-label={t('accum_remove') || 'Remove'}>×</button>
            </span>
          )
        })}
      </div>
      )}

      <div className={`${styles.panel} ${panelDrag ? styles.panelDrag : ''}`} role="tabpanel" {...panelDropProps}>
        {activeTab === 'Profile' && (
          <ProfilePanel
            entry={profileEntry} t={t} initialTab={initialTab} changedTagIds={changedTagIds}
            onXmlChanged={onXmlChanged} onJsonChanged={onJsonChanged}
            onIccProduced={onIccProduced} onSave={onSave}
          />
        )}
        {activeTab === 'Compare' && (
          activeIds.length === 0
            ? <Empty icon="📊"
                head={t('compare_empty_head') || 'Nothing to compare yet'}
                sub={t('compare_empty_sub') || 'Drag one or more profiles onto the Compare tab.'} />
            : <ComparePanel ids={activeIds} getEntry={getEntry} t={t} />
        )}
        {activeTab === 'Link' && (
          <LinkPanel t={t} getEntry={getEntry} onCreateV4={onCreateV4}
                     onBuildLink={onBuildLink} onApplyImages={onApplyImages}
                     onAccumulate={(ids) => onDropOnTab('Link', ids)}
                     pipeline={pipeline} setPipeline={setPipeline}
                     v4Roles={v4Roles} setV4Roles={setV4Roles} />
        )}
        {activeTab === 'SpecSep' && <SpecSepPanel onAssemble={onAssembleSpec} />}
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

// The Link tab is a canvas of "maker" cards: each combines profiles (dragged from
// the pool onto the card) into a new profile / transform. DL-LINK1 = the V4 Display
// Maker (fixed role slots); DL-PIPELINE1 = the Pipeline builder (an ordered chain →
// DeviceLink or image processing). Both drop results into the pool the same way.
function LinkPanel({ t, getEntry, onCreateV4, onBuildLink, onApplyImages, onAccumulate,
                    pipeline, setPipeline, v4Roles, setV4Roles }) {
  return (
    <div className={styles.linkCanvas}>
      <V4DisplayMaker getEntry={getEntry} onCreate={onCreateV4}
                      roles={v4Roles} setRoles={setV4Roles} />
      <PipelineBuilder getEntry={getEntry} onBuildLink={onBuildLink}
                       onApplyImages={onApplyImages} onAccumulate={onAccumulate}
                       pipeline={pipeline} setPipeline={setPipeline} />
    </div>
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
