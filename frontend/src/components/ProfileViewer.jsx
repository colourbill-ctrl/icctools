// (c) 2026 William Li
import { lazy, Suspense, useEffect, useState } from 'react'
import HeaderTable from './HeaderTable.jsx'
import TagTable from './TagTable.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { preloadPlotly } from './viz/plotly.js'
import { useT } from '../i18n.jsx'
import { TAB_DEFS as TABS } from '../lib/tabs.js'
import styles from './ProfileViewer.module.css'

// XmlPanel and JsonPanel each pull in CodeMirror + a language bundle. Keep
// both out of the main bundle — only fetched when the user opens the tab.
const XmlPanel       = lazy(() => import('./XmlPanel.jsx'))
const JsonPanel      = lazy(() => import('./JsonPanel.jsx'))
// The Validation tab renders the Profile Assessment WG report; its WASM module
// loads on tab open. (Tab key is still 'PAWG' — see lib/tabs.js.)
const PawgPanel      = lazy(() => import('./PawgPanel.jsx'))
// The Analysis tab hosts whole-profile quality analyses (profile statistics,
// neutral-axis inking), driven by the iccviz IccVizModel WASM module — loaded on tab open.
const AnalysisPanel  = lazy(() => import('./AnalysisPanel.jsx'))

// Tab identity + URL-fragment aliases live in lib/tabs.js (TAB_DEFS).

export default function ProfileViewer({
  data,
  bytes,
  initialTab,
  xml,
  xmlDirty,
  json,
  jsonDirty,
  changedTagIds,
  onXmlChanged,
  onJsonChanged,
  onIccProduced,
}) {
  // A `#…&tab=` launch fragment (resolved by App) seeds the opening tab; if it
  // names a hidden/unknown tab the `active` fallback below lands on Header.
  const [activeTab, setActiveTab] = useState(initialTab || 'Header')
  const t = useT()

  // Warm the Plotly chunk on idle once a profile is open, so the first plot (a
  // tag's curves, or an Analysis chart) doesn't stall the click on the ~3.5 MB
  // module parse. Cheap no-op if already loading/loaded.
  useEffect(() => { if (bytes) preloadPlotly() }, [bytes])

  // The upper-right pill reflects the Validation (Profile Assessment WG) result.
  // We run the report up front so the pill is present without opening the tab;
  // PawgPanel re-runs it on open (the WASM parse cache makes that cheap).
  // null = not yet known / not run; otherwise 'pass' | 'warn' | 'fail'.
  const [pawgState, setPawgState] = useState(null)

  useEffect(() => {
    setPawgState(null)
    // A partial profile can't be assessed (the Validation tab is hidden too).
    if (data.partial) return
    let cancelled = false
    import('../lib/pawg.js')
      .then(({ pawgReport }) => pawgReport(bytes))
      .then((r) => {
        if (cancelled) return
        const s = r.summary
        setPawgState(s.fail > 0 ? 'fail' : s.warn > 0 ? 'warn' : 'pass')
      })
      .catch(() => { if (!cancelled) setPawgState(null) })
    return () => { cancelled = true }
  }, [bytes, data.partial])

  // A best-effort/partial profile (the validator couldn't fully parse it) is
  // read-only and can't be round-tripped, so hide the XML/JSON converter tabs
  // and fall back to a visible tab if the active one is now hidden.
  const tabs = data.partial
    ? TABS.filter(tab => tab.key !== 'XML' && tab.key !== 'JSON' && tab.key !== 'PAWG' && tab.key !== 'Analysis')
    : TABS
  const active = tabs.some(tab => tab.key === activeTab) ? activeTab : 'Header'

  return (
    <div className={styles.viewer}>
      <div className={styles.titleBar}>
        <span className={styles.filename}>{data.filename}</span>
        <span className={styles.meta}>
          {data.sizeBytes != null && (
            <>{data.sizeBytes.toLocaleString()} {t('bytes_suffix')}</>
          )}
          {data.libraryVersion && (
            <> · IccProfLib {data.libraryVersion}</>
          )}
        </span>
        <ValidationBadge state={pawgState} t={t} />
      </div>

      {data.partial && (
        <div className={styles.partialBanner} role="alert">
          <span className={styles.partialIcon} aria-hidden>⚠</span>
          <span>{t('partial_banner')}</span>
        </div>
      )}

      <nav className={styles.tabs} role="tablist">
        {tabs.map(({ key, i18n }) => (
          <button
            key={key}
            role="tab"
            aria-selected={active === key}
            className={`${styles.tab} ${active === key ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(key)}
            type="button"
          >
            {t(i18n)}
            {key === 'Tags' && data.tags.length > 0 && (
              <span className={styles.badge}>{data.tags.length}</span>
            )}
          </button>
        ))}
      </nav>

      <div className={styles.panel}>
        {active === 'Header'     && <HeaderTable header={data.header} profileId={data.profileId} />}
        {active === 'Tags'       && <TagTable tags={data.tags} bytes={bytes} changedTagIds={changedTagIds} describable={!data.partial} />}
        {active === 'PAWG'       && (
          <Suspense fallback={<div className={styles.loading}>{t('loading_pawg') || 'Loading Profile Assessment WG report…'}</div>}>
            <PawgPanel bytes={bytes} />
          </Suspense>
        )}
        {active === 'Analysis'   && (
          /* Boundaried: the Analysis tab hosts several independent analyses, each
             fed by untrusted profile data through a WASM engine. Without this, one
             bad render takes the WHOLE React tree down and the browser tab goes
             blank — no message, nothing to act on. Reset when the profile changes. */
          <ErrorBoundary
            resetKey={bytes}
            fallback={(err) => (
              <div className={styles.panelError}>
                <strong>{t('error_label')}</strong> {err?.message || String(err)}
              </div>
            )}
          >
            <Suspense fallback={<div className={styles.loading}>{t('analysis_loading') || 'Analysing…'}</div>}>
              <AnalysisPanel bytes={bytes} profileClass={data.header?.['Profile Class']} />
            </Suspense>
          </ErrorBoundary>
        )}
        {active === 'XML'        && (
          <Suspense fallback={<div className={styles.loading}>{t('loading_xml_editor')}</div>}>
            <XmlPanel
              bytes={bytes}
              xml={xml}
              xmlDirty={xmlDirty}
              onXmlChanged={onXmlChanged}
              onIccProduced={onIccProduced}
            />
          </Suspense>
        )}
        {active === 'JSON'       && (
          <Suspense fallback={<div className={styles.loading}>{t('loading_json_editor')}</div>}>
            <JsonPanel
              bytes={bytes}
              json={json}
              jsonDirty={jsonDirty}
              onJsonChanged={onJsonChanged}
              onIccProduced={onIccProduced}
            />
          </Suspense>
        )}
      </div>
    </div>
  )
}

// Pill driven by the Validation (Profile Assessment WG) result. `state` is the
// overall verdict derived from the report summary: any FAIL → fail, else any
// WARN → warn, else pass. Hidden until the report has run (or for profiles that
// can't be assessed).
function ValidationBadge({ state, t }) {
  if (!state) return null
  const MAP = {
    pass: { cls: 'valid_valid',   key: 'badge_pass' },
    warn: { cls: 'valid_warning', key: 'badge_warning' },
    fail: { cls: 'valid_error',   key: 'badge_fail' },
  }
  const m = MAP[state]
  return (
    <span className={`${styles.validBadge} ${styles[m.cls]}`}>
      {t(m.key)}
    </span>
  )
}
