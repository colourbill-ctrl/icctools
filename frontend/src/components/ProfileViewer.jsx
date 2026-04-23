import { lazy, Suspense, useState } from 'react'
import ValidationPanel from './ValidationPanel.jsx'
import HeaderTable from './HeaderTable.jsx'
import TagTable from './TagTable.jsx'
import TagDetailModal from './TagDetailModal.jsx'
import styles from './ProfileViewer.module.css'

// XmlPanel and JsonPanel each pull in CodeMirror + a language bundle. Keep
// both out of the main bundle — only fetched when the user opens the tab.
const XmlPanel  = lazy(() => import('./XmlPanel.jsx'))
const JsonPanel = lazy(() => import('./JsonPanel.jsx'))

const TABS = ['Header', 'Tags', 'Validation', 'Raw Output', 'XML', 'JSON']

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
  const [selectedTag, setSelectedTag] = useState(null)

  return (
    <div className={styles.viewer}>
      <div className={styles.titleBar}>
        <span className={styles.filename}>{data.filename}</span>
        <span className={styles.meta}>
          {data.sizeBytes != null && (
            <>{data.sizeBytes.toLocaleString()} bytes</>
          )}
          {data.libraryVersion && (
            <> · IccProfLib {data.libraryVersion}</>
          )}
        </span>
        <ValidationBadge level={data.validation.level} />
      </div>

      <nav className={styles.tabs} role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
            onClick={() => setActiveTab(tab)}
            type="button"
          >
            {tab}
            {tab === 'Tags' && data.tags.length > 0 && (
              <span className={styles.badge}>{data.tags.length}</span>
            )}
          </button>
        ))}
      </nav>

      <div className={styles.panel}>
        {activeTab === 'Header'     && <HeaderTable header={data.header} profileId={data.profileId} />}
        {activeTab === 'Tags'       && <TagTable tags={data.tags} onTagClick={setSelectedTag} changedTagIds={changedTagIds} />}
        {activeTab === 'Validation' && <ValidationPanel validation={data.validation} />}
        {activeTab === 'Raw Output' && <RawOutput data={data} />}
        {activeTab === 'XML'        && (
          <Suspense fallback={<div className={styles.loading}>Loading XML editor…</div>}>
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
          <Suspense fallback={<div className={styles.loading}>Loading JSON editor…</div>}>
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

      {selectedTag && (
        <TagDetailModal tag={selectedTag} onClose={() => setSelectedTag(null)} />
      )}
    </div>
  )
}

function ValidationBadge({ level }) {
  const labels = { valid: 'Valid', warning: 'Warning', error: 'Error', unknown: 'Unknown' }
  return (
    <span className={`${styles.validBadge} ${styles[`valid_${level}`]}`}>
      {labels[level] ?? level}
    </span>
  )
}

function RawOutput({ data }) {
  return <pre className={styles.raw}>{JSON.stringify(data, null, 2)}</pre>
}
