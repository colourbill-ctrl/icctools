// (c) 2026 William Li
//
// Serialize a Transform-Data result table back out to the supported point-data
// formats, for the results-modal "Save" button. Input is the same flat
// { headers, rows } representation the parsers produce (dataParse.js), so a
// round-trip (drop CGATS → transform → Save CGATS) stays in-family.
//
// The result table is the CONCATENATION of the source columns fed to the chain
// and the destination columns it produced, optionally preceded by a SAMPLE_NAME
// column. All three writers take that unified { headers, rows } — the caller
// assembles it once (PipelineBuilder) and picks a format here.

// ── CSV ───────────────────────────────────────────────────────────────────────
export function toCSV({ headers, rows }) {
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [headers.map(esc).join(',')]
  for (const r of rows) lines.push(r.map(esc).join(','))
  return lines.join('\r\n') + '\r\n'
}

// ── CGATS.17 (tab-delimited data + DATA_FORMAT block) ─────────────────────────
// A minimal but valid CGATS: the standard preamble, a SAMPLE_ID injected as the
// first field (CGATS convention), NUMBER_OF_SETS, and the format/data blocks.
export function toCGATS({ headers, rows }, { title } = {}) {
  const fmt = ['SAMPLE_ID', ...headers]
  const out = []
  out.push('CGATS.17')
  out.push('ORIGINATOR\t"profiletool"')
  if (title) out.push(`DESCRIPTOR\t"${title.replace(/"/g, '')}"`)
  out.push(`NUMBER_OF_FIELDS\t${fmt.length}`)
  out.push('BEGIN_DATA_FORMAT')
  out.push(fmt.join('\t'))
  out.push('END_DATA_FORMAT')
  out.push(`NUMBER_OF_SETS\t${rows.length}`)
  out.push('BEGIN_DATA')
  rows.forEach((r, i) => out.push([i + 1, ...r.map((v) => (v == null ? '' : v))].join('\t')))
  out.push('END_DATA')
  return out.join('\r\n') + '\r\n'
}

// ── IccConnect colorData JSON (schema docs/icc-connect-config.schema.json) ─────
// Emits the machine format the CLI apps read back: a colorData block whose entries
// carry BOTH the source samples (sv/sn) and the transformed destination samples
// (v/n), so the file records the full transform, not just one side.
export function toIccConnectJSON({ srcSpace, dstSpace, srcEncoding, dstEncoding, names, srcRows, dstRows }) {
  const data = srcRows.map((sv, i) => {
    const entry = {
      i,
      sv: sv.map(Number),
      v: (dstRows[i] || []).map(Number),
    }
    if (names && names[i]) {
      entry.sn = names[i]
      entry.n = names[i]
    }
    return entry
  })
  const obj = {
    colorData: {
      srcSpace: srcSpace || '',
      srcEncoding: srcEncoding || 'value',
      space: dstSpace || '',
      encoding: dstEncoding || 'value',
      data,
    },
  }
  return JSON.stringify(obj, null, 2) + '\n'
}

// Trigger a client-side download of text as a file (no server round-trip). Used as
// the fallback when the File System Access API is unavailable.
export function downloadText(text, filename, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Save text to a user-chosen file. Chromium browsers get a REAL save dialog (choose
// name AND browse to a folder) via the File System Access API; other browsers
// (Firefox/Safari) don't expose it, so we at least prompt for a file name before the
// plain download. Must be called from a user gesture (the Save button click).
// Returns true if a file was written/downloaded, false if the user cancelled.
export async function saveTextFile(text, suggestedName, mime = 'text/plain') {
  const ext = (suggestedName.match(/\.([^.]+)$/)?.[1] || 'txt').toLowerCase()
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: `${ext.toUpperCase()} file`, accept: { [mime]: [`.${ext}`] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(text)
      await writable.close()
      return true
    } catch (e) {
      if (e && e.name === 'AbortError') return false   // user cancelled the dialog
      // Any other failure (permission, unsupported in a sandboxed frame, …) → fall
      // through to the download fallback so Save still works.
    }
  }
  // Fallback: at least let the user set the file name, then download it.
  let name = suggestedName
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    const entered = window.prompt('Save as (file name):', suggestedName)
    if (entered === null) return false                 // cancelled
    name = entered.trim() || suggestedName
  }
  downloadText(text, name, mime)
  return true
}

// Binary counterpart of saveTextFile for produced files (e.g. a transformed image).
// Same behaviour: real Save dialog on Chromium, prompt-for-name + download elsewhere.
// Must be called from a user gesture (a fresh one — a long transform can consume the
// activation, so callers that do heavy work first should acquire the handle before it;
// this is the fallback path once no handle exists). Returns true if written, false if
// the user cancelled.
export async function saveBinaryFile(bytes, suggestedName, mime = 'application/octet-stream') {
  const ext = (suggestedName.match(/\.([^.]+)$/)?.[1] || 'bin').toLowerCase()
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: `${ext.toUpperCase()} file`, accept: { [mime]: [`.${ext}`] } }],
      })
      const writable = await handle.createWritable()
      await writable.write(bytes)
      await writable.close()
      return true
    } catch (e) {
      if (e && e.name === 'AbortError') return false
      // fall through to the download fallback
    }
  }
  let name = suggestedName
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    const entered = window.prompt('Save as (file name):', suggestedName)
    if (entered === null) return false
    name = entered.trim() || suggestedName
  }
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
