import { lazy, Suspense, useState } from 'react'
import ValidationPanel from './ValidationPanel.jsx'
import HeaderTable from './HeaderTable.jsx'
import TagTable from './TagTable.jsx'
import { useT } from '../i18n.jsx'
import styles from './ProfileViewer.module.css'

// XmlPanel and JsonPanel each pull in CodeMirror + a language bundle. Keep
// both out of the main bundle — only fetched when the user opens the tab.
const XmlPanel  = lazy(() => import('./XmlPanel.jsx'))
const JsonPanel = lazy(() => import('./JsonPanel.jsx'))

// Tab keys are stable internal identifiers; labels come from i18n.
const TABS = [
  { key: 'Header',     i18n: 'tab_header' },
  { key: 'Tags',       i18n: 'tab_tags' },
  { key: 'Validation', i18n: 'tab_validation' },
  { key: 'Raw Output', i18n: 'tab_raw' },
  { key: 'XML',        i18n: 'tab_xml' },
  { key: 'JSON',       i18n: 'tab_json' },
]

export default function ProfileViewer({
  data,
  bytes,
  xml,
  xmlDirty,
  json,
  jsonDirty,
  changedTagIds,
  onXmlChanged,
  onJsonChanged,
  onIccProduced,
}) {
  const [activeTab, setActiveTab] = useState('Header')
  const t = useT()

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

      <nav className={styles.tabs} role="tablist">
        {TABS.map(({ key, i18n }) => (
          <button
            key={key}
            role="tab"
            aria-selected={activeTab === key}
            className={`${styles.tab} ${activeTab === key ? styles.activeTab : ''}`}
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
        {activeTab === 'Header'     && <HeaderTable header={data.header} profileId={data.profileId} />}
        {activeTab === 'Tags'       && <TagTable tags={data.tags} bytes={bytes} changedTagIds={changedTagIds} />}
        {activeTab === 'Validation' && <ValidationPanel validation={data.validation} />}
        {activeTab === 'Raw Output' && <RawOutput data={data} />}
        {activeTab === 'XML'        && (
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
        {activeTab === 'JSON'       && (
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
