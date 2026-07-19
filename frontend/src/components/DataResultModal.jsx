// (c) 2026 William Li
//
// Transform-Data / Invert-Data result window (Link-Pipeline data methods). A
// canvas pop-up that shows the input↔output colour table and offers Save to the
// supported point-data formats. Pure presenter: the parent (PipelineBuilder) has
// already run the WASM transform and assembled the columns; this component renders
// them and serializes on Save via lib/dataExport.
import { useEffect, useMemo, useState } from 'react'
import { toCSV, toCGATS, toIccConnectJSON, saveTextFile } from '../lib/dataExport.js'
import { useT } from '../i18n.jsx'
import styles from './DataResultModal.module.css'

// Cap the DOM table so a 10k-patch dataset doesn't freeze the tab. The full set is
// always what Save writes — only the on-screen preview is capped.
const MAX_VISIBLE_ROWS = 500

export default function DataResultModal({ open, onClose, result }) {
  const t = useT()
  const [format, setFormat] = useState('csv')

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Unified preview table: [name?] + source cols + dest cols.
  const table = useMemo(() => {
    if (!result) return null
    const { names, sourceHeaders, sourceCells, destHeaders, destCells } = result
    const hasName = names && names.some((n) => n)
    const headers = [...(hasName ? ['Sample'] : []), ...sourceHeaders, ...destHeaders]
    const rows = sourceCells.map((sc, i) => [
      ...(hasName ? [names[i] || ''] : []),
      ...sc.map(fmtCell),
      ...(destCells[i] || []).map(fmtCell),
    ])
    return { headers, rows, hasName, srcCount: sourceHeaders.length }
  }, [result])

  if (!open || !result || !table) return null

  const onSave = async () => {
    const { names, sourceHeaders, sourceCells, destHeaders, destCells, srcSpace, dstSpace, srcEncoding, dstEncoding } = result
    const base = (result.datasetName || 'transform').replace(/\.[^.]+$/, '')
    // Each writer produces (text, filename, mime); saveTextFile opens a real Save
    // dialog (Chromium) or prompts for a name (Firefox/Safari) — from this click.
    if (format === 'json') {
      const text = toIccConnectJSON({
        srcSpace, dstSpace, srcEncoding, dstEncoding, names,
        srcRows: sourceCells.map((r) => r.map((v) => parseFloat(v))),
        dstRows: destCells.map((r) => r.map((v) => parseFloat(v))),
      })
      await saveTextFile(text, `${base}-transformed.json`, 'application/json')
      return
    }
    // Flat table for CSV/CGATS: name? + source + dest columns.
    const hasName = names && names.some((n) => n)
    const headers = [...(hasName ? ['SAMPLE_NAME'] : []), ...sourceHeaders, ...destHeaders]
    const rows = sourceCells.map((sc, i) => [
      ...(hasName ? [names[i] || ''] : []),
      ...sc, ...(destCells[i] || []),
    ])
    if (format === 'cgats') {
      await saveTextFile(toCGATS({ headers, rows }, { title: base }), `${base}-transformed.txt`, 'text/plain')
    } else {
      await saveTextFile(toCSV({ headers, rows }), `${base}-transformed.csv`, 'text/csv')
    }
  }

  const shown = Math.min(table.rows.length, MAX_VISIBLE_ROWS)

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header className={styles.head}>
          <div>
            <h2 className={styles.title}>{result.title || (t('dm_result_title') || 'Transform result')}</h2>
            <p className={styles.sub}>
              {t('dm_result_flow', { src: result.srcSpace, dst: result.dstSpace, n: table.rows.length })
                || `${result.srcSpace} → ${result.dstSpace} · ${table.rows.length} patch${table.rows.length === 1 ? '' : 'es'}`}
            </p>
          </div>
          <button className={styles.close} type="button" onClick={onClose}
                  aria-label={t('close') || 'Close'} title={t('close') || 'Close'}>×</button>
        </header>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {table.headers.map((h, i) => (
                  <th key={i} className={i >= (table.hasName ? 1 : 0) + table.srcCount ? styles.destCol : ''}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.slice(0, shown).map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className={ci >= (table.hasName ? 1 : 0) + table.srcCount ? styles.destCol : ''}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {table.rows.length > shown && (
            <p className={styles.more}>
              {t('dm_result_more', { shown, total: table.rows.length })
                || `Showing first ${shown} of ${table.rows.length} — Save writes them all.`}
            </p>
          )}
        </div>

        <footer className={styles.foot}>
          <label className={styles.saveAs}>
            {t('dm_save_as') || 'Save as'}
            <select value={format} onChange={(e) => setFormat(e.target.value)}>
              <option value="csv">CSV</option>
              <option value="cgats">CGATS.17</option>
              <option value="json">IccConnect JSON</option>
            </select>
          </label>
          <button className="btn-primary" type="button" onClick={onSave}>{t('dm_save') || 'Save'}</button>
          <button className={styles.doneBtn} type="button" onClick={onClose}>{t('done') || 'Done'}</button>
        </footer>
      </div>
    </div>
  )
}

// Render a numeric cell compactly (≤3 dp, trailing zeros trimmed); pass text through.
function fmtCell(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!isFinite(n) || (typeof v === 'string' && v.trim() === '')) return v ?? ''
  return (Math.round(n * 1000) / 1000).toString()
}
