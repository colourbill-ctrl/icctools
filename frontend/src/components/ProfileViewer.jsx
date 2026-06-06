import { lazy, Suspense, useState } from 'react'
import ValidationPanel from './ValidationPanel.jsx'
import HeaderTable from './HeaderTable.jsx'
import TagTable from './TagTable.jsx'
import { useT } from '../i18n.jsx'
import { TAB_DEFS as TABS } from '../lib/tabs.js'
import styles from './ProfileViewer.module.css'

// XmlPanel and JsonPanel each pull in CodeMirror + a language bundle. Keep
// both out of the main bundle — only fetched when the user opens the tab.
const XmlPanel       = lazy(() => import('./XmlPanel.jsx'))
const JsonPanel      = lazy(() => import('./JsonPanel.jsx'))
// PAWG assessment report; its WASM module loads on tab open.
const PawgPanel      = lazy(() => import('./PawgPanel.jsx'))

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

  // A best-effort/partial profile (the validator couldn't fully parse it) is
  // read-only and can't be round-tripped, so hide the XML/JSON converter tabs
  // and fall back to a visible tab if the active one is now hidden.
  const tabs = data.partial
    ? TABS.filter(tab => tab.key !== 'XML' && tab.key !== 'JSON')
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
        <ValidationBadge level={data.validation.level} t={t} />
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
        {active === 'Validation' && <ValidationPanel validation={data.validation} data={data} bytes={bytes} />}
        {active === 'PAWG'       && (
          <Suspense fallback={<div className={styles.loading}>{t('loading_pawg') || 'Loading Profile Assessment WG report…'}</div>}>
            <PawgPanel bytes={bytes} />
          </Suspense>
        )}
        {active === 'Raw Output' && <RawOutput data={data} />}
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

function ValidationBadge({ level, t }) {
  const labelKey = { valid: 'badge_valid', warning: 'badge_warning', error: 'badge_error', unknown: 'badge_unknown' }[level]
  return (
    <span className={`${styles.validBadge} ${styles[`valid_${level}`]}`}>
      {labelKey ? t(labelKey) : level}
    </span>
  )
}

function RawOutput({ data }) {
  return <pre className={styles.raw}>{JSON.stringify(data, null, 2)}</pre>
}
