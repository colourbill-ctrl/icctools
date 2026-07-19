// (c) 2026 William Li
//
// Point-data parsing + classification for the Link-Pipeline data methods
// (Transform Data / Invert Data — profiletool's iccApplyNamedCmm / iccApplySearch
// equivalents). This is the pure-JS front end: it turns a dropped CGATS / CSV /
// CxF / IccConnect-JSON file into ONE unified representation and describes what it
// found, but does NO colour math — spectral→colorimetry and the actual transform
// run in WASM (iccDEV is canonical for the maths; see data-methods-design memory).
//
// The parsers are ported faithfully from chardata's dep-free engine
// (~/code/chardata/public/index.html) so the two apps read the same real-world
// files identically. Two deliberate DIVERGENCES from chardata, per the profiletool
// design decisions (data-methods-design memory):
//   • chardata DISCARDS XYZ tristimulus (standardizeData drops XYZ_*); profiletool
//     KEEPS it — XYZ is a first-class colorimetry kind alongside Lab.
//   • chardata does the spectral→Lab integration in JS (SPECTRAL_WTS tables);
//     profiletool leaves spectral untouched here and integrates in WASM via the
//     iccDEV spectral class, so no weighting tables live in this file.
//
// ── Unified representation ────────────────────────────────────────────────────
// Every format collapses to a flat string table { headers, rows } with name-based
// columns, exactly like chardata:
//   • device colorant  → isDeviceColorant() (an EXCLUSION filter, not a whitelist)
//   • colorimetry Lab   → LAB_L / LAB_A / LAB_B
//   • colorimetry XYZ   → XYZ_X / XYZ_Y / XYZ_Z
//   • spectral          → NNN_NM columns (integer nanometres)
// Keeping the values as strings (never parsed to Number here) preserves the file's
// exact text for the results table / re-export; consumers parseFloat as needed.

// ── Column-name canonicalisation ──────────────────────────────────────────────
// Rename the few device aliases real files use, and fold every spectral spelling
// (nm560 / NM_560 / SPECTRAL_NM560) into the canonical NNN_NM form. Mirrors
// chardata standardizeHeaders (index.html:5297) — but note profiletool does NOT
// rename or drop XYZ here (chardata never renamed XYZ either; it dropped it later).
const DEVICE_RENAMES = { CMYK_C: 'CYAN', CMYK_M: 'MAGENTA', CMYK_Y: 'YELLOW', CMYK_K: 'BLACK' }

export function standardizeHeaders(headers) {
  return headers.map((h) => {
    const nm = h.match(/^nm(\d+)$/i) || h.match(/^NM_(\d+)$/i) || h.match(/^SPECTRAL_NM(\d+)$/i)
    if (nm) return nm[1] + '_NM'
    return DEVICE_RENAMES[h.toUpperCase()] || h
  })
}

// True when a (post-standardize) column header is a device colorant. Exclusion
// list ported verbatim from chardata isDeviceColorant (index.html:5640): anything
// that is a measurement, spectral band, metadata label, density or status channel
// is NOT a colorant; whatever survives the filter is treated as an ink/channel.
export function isDeviceColorant(col) {
  const h = col.toUpperCase()
  if (h.startsWith('LAB')) return false // LAB_L, LAB_A, LAB_B
  if (/_NM$/.test(h)) return false // spectral bands: 380_NM …
  if (h.startsWith('SAMPLE')) return false // SAMPLE_ID / _NAME / _LOC …
  if (h.startsWith('XYZ_')) return false // XYZ tristimulus (kept, but not a colorant)
  if (h.startsWith('D_')) return false // density D_RED …
  if (h.startsWith('DENSITY')) return false
  if (h.startsWith('STATUS_')) return false // densitometry status channels
  if (h === 'COLOR_NAME') return false
  if (h === 'COLOR_INDEX') return false
  return true
}

// ── Format detection ──────────────────────────────────────────────────────────
// Sniff from extension first, then content, so a mislabelled file still routes.
export function detectDataFormat(name, text) {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase()
  const head = text.slice(0, 4096)
  if (ext === 'json' || /^\s*[{[]/.test(head)) {
    // Only treat as our JSON if it parses and looks like IccConnect colorData.
    if (/^\s*[{[]/.test(head)) return 'json'
  }
  if (ext === 'cxf' || /<[a-z]*:?ColorSpecification|<[a-z]*:?Object\b|SpotInkCharacterisation/i.test(head)) {
    return 'cxf'
  }
  if (/<\?xml|<[a-z]*:?CxF\b/i.test(head)) return 'cxf'
  if (/BEGIN_DATA_FORMAT|NUMBER_OF_SETS|CGATS|ISO28178/i.test(head)) return 'cgats'
  if (ext === 'txt' || ext === 'it8') return 'cgats'
  if (ext === 'csv') return 'csv'
  // Last resort: a comma in the first line → CSV, else CGATS.
  return /,/.test(head.split(/\r\n|\r|\n/)[0] || '') ? 'csv' : 'cgats'
}

// ── CSV (naïve comma-split, quotes stripped) — chardata parseCSV (5321) ────────
export function parseCSV(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = standardizeHeaders(lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, '')))
  const rows = lines.slice(1).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
  return { headers, rows }
}

// ── CGATS / IT8 / ISO 28178 — chardata parseCGATS (5331) ──────────────────────
// Headers live between BEGIN_DATA_FORMAT / END_DATA_FORMAT; data between
// BEGIN_DATA / END_DATA. Delimiter (tab vs runs-of-whitespace) auto-detected from
// the first data line.
export function parseCGATS(text) {
  const lines = text.split(/\r\n|\r|\n/)

  const fmtStart = lines.findIndex((l) => l.trim().toUpperCase() === 'BEGIN_DATA_FORMAT')
  const fmtEnd = lines.findIndex((l) => l.trim().toUpperCase() === 'END_DATA_FORMAT')
  const rawHeaders =
    fmtStart >= 0 && fmtEnd > fmtStart
      ? lines
          .slice(fmtStart + 1, fmtEnd)
          .flatMap((l) => l.trim().split(/\s+/))
          .filter((t) => t.length > 0)
      : []
  const headers = standardizeHeaders(rawHeaders)

  const dataStart = lines.findIndex((l) => l.trim().toUpperCase() === 'BEGIN_DATA')
  const dataEnd = lines.findIndex((l) => l.trim().toUpperCase() === 'END_DATA')
  const dataLines =
    dataStart >= 0 && dataEnd > dataStart
      ? lines.slice(dataStart + 1, dataEnd).filter((l) => l.trim().length > 0)
      : []

  const firstData = dataLines[0] || ''
  const split = /\t/.test(firstData) ? (l) => l.split('\t') : (l) => l.trim().split(/\s+/)
  const rows = dataLines.map((l) => split(l).map((c) => c.trim()))
  return { headers, rows }
}

// ── CxF/X-3 + CxF/X-4 (XML) — chardata parseCxF (5377) ────────────────────────
// Parsed prefix-agnostically (getElementsByTagNameNS('*', localName)) because real
// files use the cc: namespace prefix. Device colorants are often absent
// (measurement-only). CxF/X-4 files carry a SpotInkCharacterisation resource that
// maps sample Objects to tint levels of one spot ink.
function _cxfChild(el, localName) {
  if (!el) return null
  for (const c of el.children) if (c.localName === localName) return c
  return null
}
function _cxfChildText(el, localName) {
  const c = _cxfChild(el, localName)
  return c ? c.textContent.trim() : null
}
function _cxfDesc(el, localName) {
  const list = el.getElementsByTagNameNS('*', localName)
  return list.length ? list[0] : null
}
const _CXF_CMYK = [
  ['CYAN', 'Cyan'],
  ['MAGENTA', 'Magenta'],
  ['YELLOW', 'Yellow'],
  ['BLACK', 'Black'],
]
const _CXF_RGB = [
  ['RED', 'R'],
  ['GREEN', 'G'],
  ['BLUE', 'B'],
]

export function parseCxF(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('CxF file is not well-formed XML.')
  }

  // ColorSpecification Id → spectral { start, inc } in nm (increment defaults to
  // 10). StartWL usually rides each ReflectanceSpectrum but some files declare it
  // only here on WavelengthRange.
  const wlMap = {}
  for (const sp of doc.getElementsByTagNameNS('*', 'ColorSpecification')) {
    const id = sp.getAttribute('Id')
    const wr = _cxfDesc(sp, 'WavelengthRange')
    if (id && wr) {
      const start = parseFloat(wr.getAttribute('StartWL'))
      const inc = parseFloat(wr.getAttribute('Increment'))
      wlMap[id] = { start, inc: !isNaN(inc) && inc > 0 ? inc : NaN }
    }
  }

  const coll = doc.getElementsByTagNameNS('*', 'ObjectCollection')[0]
  const objs = coll ? coll.getElementsByTagNameNS('*', 'Object') : doc.getElementsByTagNameNS('*', 'Object')

  const colorantOrder = []
  const colorantSeen = new Set()
  const nmSeen = new Set()
  let anyName = false
  let anyLab = false
  const records = []

  for (const obj of objs) {
    const rec = {
      name: obj.getAttribute('Name') || obj.getAttribute('Id') || '',
      id: obj.getAttribute('Id') || '',
      colorants: {},
      lab: {},
      spectral: {},
    }
    if (rec.name) anyName = true

    const lab = _cxfDesc(obj, 'ColorCIELab')
    if (lab) {
      const L = _cxfChildText(lab, 'L'),
        A = _cxfChildText(lab, 'A'),
        B = _cxfChildText(lab, 'B')
      if (L !== null && A !== null && B !== null) {
        rec.lab = { L, A, B }
        anyLab = true
      }
    }

    const spec = _cxfDesc(obj, 'ReflectanceSpectrum')
    if (spec) {
      const wl = wlMap[spec.getAttribute('ColorSpecification')] || {}
      let startWL = parseFloat(spec.getAttribute('StartWL'))
      if (isNaN(startWL)) startWL = wl.start
      const inc = wl.inc || 10
      const vals = spec.textContent.trim().split(/\s+/).filter((v) => v.length)
      if (!isNaN(startWL) && vals.length) {
        vals.forEach((v, i) => {
          const nm = Math.round(startWL + i * inc)
          rec.spectral[nm] = v
          nmSeen.add(nm)
        })
      }
    }

    const dev = obj.getElementsByTagNameNS('*', 'DeviceColorValues')[0]
    if (dev) {
      const cmyk = _cxfChild(dev, 'ColorCMYK') || _cxfChild(dev, 'ColorCMYKPlusN')
      const rgb = _cxfChild(dev, 'ColorRGB')
      const addColorant = (nameC, val) => {
        if (val === null || val === '') return
        rec.colorants[nameC] = val
        if (!colorantSeen.has(nameC)) {
          colorantSeen.add(nameC)
          colorantOrder.push(nameC)
        }
      }
      if (cmyk) {
        _CXF_CMYK.forEach(([std, child]) => addColorant(std, _cxfChildText(cmyk, child)))
        // ColorCMYKPlusN carries extra named-ink children beyond CMYK.
        for (const c of cmyk.children) {
          if (['Cyan', 'Magenta', 'Yellow', 'Black'].includes(c.localName)) continue
          const nm = (c.getAttribute && c.getAttribute('Name')) || c.localName
          addColorant(nm.toUpperCase(), c.textContent.trim())
        }
      } else if (rgb) {
        _CXF_RGB.forEach(([std, child]) => addColorant(std, _cxfChildText(rgb, child)))
      }
    }
    records.push(rec)
  }

  // CxF/X-4: SpotInkCharacterisation → tint levels of one spot ink over one
  // background (X-4a/b: substrate) or two (X-4: substrate + process black).
  let cxfVariant = 'CxF/X-3'
  const sic = doc.getElementsByTagNameNS('*', 'SpotInkCharacterisation')[0]
  if (sic) {
    const byId = new Map(records.map((r) => [r.id, r]))
    const sets = [...sic.getElementsByTagNameNS('*', 'MeasurementSet')]
    const bgCol = 'PROCESS_BLACK'
    let inkCol = (sic.getAttribute('SpotInkName') || '').trim().toUpperCase() || 'INK'
    // Dodge names the colorant detector rejects (LAB…, SAMPLE…) or a collision
    // with the backing column.
    if (!isDeviceColorant(inkCol) || inkCol === bgCol) inkCol = 'INK_' + inkCol
    const twoBg = sets.length > 1
    let intermediate = false
    const x4Records = []
    for (const set of sets) {
      const bgVal = /black/i.test(set.getAttribute('Background') || '') ? '100' : '0'
      for (const m of set.getElementsByTagNameNS('*', 'Measurement')) {
        const tint = parseFloat(m.getAttribute('TintLevel'))
        const rec = byId.get(m.getAttribute('ObjectRef'))
        if (!rec || isNaN(tint)) continue
        if (tint > 0 && tint < 100) intermediate = true
        const colorants = { [inkCol]: String(tint) }
        if (twoBg) colorants[bgCol] = bgVal
        x4Records.push({ ...rec, colorants })
      }
    }
    if (x4Records.length) {
      records.length = 0
      records.push(...x4Records)
      colorantOrder.length = 0
      colorantOrder.push(inkCol)
      if (twoBg) colorantOrder.push(bgCol)
      cxfVariant = twoBg ? 'CxF/X-4' : intermediate ? 'CxF/X-4a' : 'CxF/X-4b'
    }
  }

  const nmSorted = [...nmSeen].sort((a, b) => a - b)
  const headers = []
  if (anyName) headers.push('SAMPLE_NAME')
  colorantOrder.forEach((c) => headers.push(c))
  if (anyLab) headers.push('LAB_L', 'LAB_A', 'LAB_B')
  nmSorted.forEach((nm) => headers.push(nm + '_NM'))

  const rows = records.map((rec) =>
    headers.map((h) => {
      if (h === 'SAMPLE_NAME') return rec.name
      if (h === 'LAB_L') return rec.lab.L ?? ''
      if (h === 'LAB_A') return rec.lab.A ?? ''
      if (h === 'LAB_B') return rec.lab.B ?? ''
      const nm = h.match(/^(\d+)_NM$/)
      if (nm) return rec.spectral[+nm[1]] ?? ''
      return rec.colorants[h] ?? ''
    })
  )

  return { headers, rows, cxfVariant }
}

// ── IccConnect colorData JSON (schema docs/icc-connect-config.schema.json) ─────
// The one machine-format the two CLI apps (iccApplyNamedCmm / iccApplySearch)
// natively read. Shape: a top-level object with a `colorData` block
//   { srcSpace, srcEncoding, space, encoding, data: [ {v,n,sv,sn,i,l}, … ] }
// where each entry's SOURCE samples are `sv` (falling back to `v` when a file
// only carries one value array) and the name is `sn`/`n`. We synthesise column
// headers from the space signature so JSON folds into the same flat table.
const SPACE_CHANNELS = {
  'RGB ': ['RED', 'GREEN', 'BLUE'],
  'GRAY': ['GRAY'],
  'CMYK': ['CYAN', 'MAGENTA', 'YELLOW', 'BLACK'],
  'CMY ': ['CYAN', 'MAGENTA', 'YELLOW'],
  'Lab ': ['LAB_L', 'LAB_A', 'LAB_B'],
  'XYZ ': ['XYZ_X', 'XYZ_Y', 'XYZ_Z'],
}

// Column headers for a 4-char space signature. nCLR spaces (2CLR…FCLR, or a bare
// count) become 1_CLR … n_CLR device channels; unknown spaces fall back to a
// count derived from the first data row.
function channelsForSpace(sig, nFallback) {
  if (SPACE_CHANNELS[sig]) return SPACE_CHANNELS[sig].slice()
  const mclr = sig && sig.match(/^([0-9A-F])CLR$/i)
  const n = mclr ? parseInt(mclr[1], 16) : nFallback || 0
  return Array.from({ length: n }, (_, i) => i + 1 + '_CLR')
}

export function parseIccConnectJSON(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (e) {
    throw new Error('File is not valid JSON.')
  }
  const cd = obj && (obj.colorData || (Array.isArray(obj.data) ? obj : null))
  if (!cd || !Array.isArray(cd.data)) {
    throw new Error('JSON has no IccConnect "colorData" block with a "data" array.')
  }
  const entries = cd.data
  // Prefer explicit source samples (sv); fall back to destination values (v).
  const useSrc = entries.some((e) => Array.isArray(e.sv) && e.sv.length)
  const valKey = useSrc ? 'sv' : 'v'
  const nameKey = useSrc ? 'sn' : 'n'
  const nFallback = entries.reduce((m, e) => Math.max(m, (e[valKey] || []).length), 0)
  const space = (useSrc ? cd.srcSpace : cd.space) || cd.srcSpace || cd.space || ''
  const chan = channelsForSpace(space, nFallback)

  const anyName = entries.some((e) => e[nameKey] || e.l)
  const headers = []
  if (anyName) headers.push('SAMPLE_NAME')
  chan.forEach((c) => headers.push(c))

  const rows = entries.map((e) => {
    const v = e[valKey] || []
    const out = []
    if (anyName) out.push(e[nameKey] || e.l || '')
    chan.forEach((_, i) => out.push(v[i] != null ? String(v[i]) : ''))
    return out
  })
  return {
    headers,
    rows,
    json: { space, encoding: (useSrc ? cd.srcEncoding : cd.encoding) || 'value', usedSource: useSrc },
  }
}

// ── Top-level parse entry ─────────────────────────────────────────────────────
// Returns { format, headers, rows, cxfVariant?, json? }. Throws with a
// user-facing message on malformed input (callers surface it on the drop chip).
export function parseDataText(name, text) {
  const format = detectDataFormat(name, text)
  let parsed
  switch (format) {
    case 'json':
      parsed = parseIccConnectJSON(text)
      break
    case 'cxf':
      parsed = parseCxF(text)
      break
    case 'cgats':
      parsed = parseCGATS(text)
      break
    case 'csv':
    default:
      parsed = parseCSV(text)
      break
  }
  if (!parsed.headers.length) throw new Error('No columns found — is this a data file?')
  if (!parsed.rows.length) throw new Error('No data rows found.')
  return { format, ...parsed }
}

// ── Column classification ─────────────────────────────────────────────────────
// Group the unified table's columns into the four data KINDS the design cares
// about, plus the optional name column. Indices index into headers/rows.
export function classifyColumns(headers) {
  const upper = headers.map((h) => h.toUpperCase())
  const nameIdx = upper.findIndex((h) => h.startsWith('SAMPLE') || h === 'COLOR_NAME')

  const deviceIdx = []
  const device = []
  const spectral = []
  let lab = null
  let xyz = null

  headers.forEach((h, i) => {
    const u = upper[i]
    const nm = u.match(/^(\d+)_NM$/)
    if (nm) {
      spectral.push({ nm: parseInt(nm[1], 10), idx: i })
      return
    }
    if (u === 'LAB_L' || u === 'LAB_A' || u === 'LAB_B') {
      lab = lab || {}
      lab[u[4]] = i // L / A / B
      return
    }
    if (u === 'XYZ_X' || u === 'XYZ_Y' || u === 'XYZ_Z') {
      xyz = xyz || {}
      xyz[u[4]] = i // X / Y / Z
      return
    }
    if (i === nameIdx) return
    if (isDeviceColorant(h)) {
      deviceIdx.push(i)
      device.push(h)
    }
  })

  spectral.sort((a, b) => a.nm - b.nm)
  // Only report Lab/XYZ as present when the full triple exists.
  if (lab && !('L' in lab && 'A' in lab && 'B' in lab)) lab = null
  if (xyz && !('X' in xyz && 'Y' in xyz && 'Z' in xyz)) xyz = null

  return { nameIdx, device, deviceIdx, lab, xyz, spectral }
}

// ── Per-kind encoding guess ───────────────────────────────────────────────────
// Auto-detect the numeric encoding of a set of columns from the observed value
// range (design decision #4: no explicit control unless it proves necessary).
// Returns an IccConnect floatColorEncoding-ish label for display.
function columnStats(rows, idxs) {
  let min = Infinity
  let max = -Infinity
  let anyFrac = false
  let n = 0
  for (const row of rows) {
    for (const i of idxs) {
      const v = parseFloat(row[i])
      if (!isFinite(v)) continue
      n++
      if (v < min) min = v
      if (v > max) max = v
      if (!Number.isInteger(v)) anyFrac = true
    }
  }
  return { min, max, anyFrac, n }
}

function guessDeviceEncoding(rows, idxs) {
  const s = columnStats(rows, idxs)
  if (!s.n) return 'unknown'
  if (s.max <= 1.0001 && s.min >= -0.0001) return 'unitFloat' // 0..1
  if (s.max <= 100.5 && s.min >= -0.5) return 'percent' // 0..100 (tint %)
  if (s.max <= 255.5 && !s.anyFrac) return '8Bit' // 0..255 integer codes
  if (s.max <= 65535.5 && !s.anyFrac) return '16Bit'
  return 'value'
}

function guessSpectralEncoding(rows, idxs) {
  const s = columnStats(rows, idxs)
  if (!s.n) return 'unknown'
  if (s.max <= 1.5) return 'unitFloat' // 0..1 reflectance
  if (s.max <= 100.5) return 'percent' // 0..100 %R
  return 'value'
}

// ── Duplicate detection ───────────────────────────────────────────────────────
// A duplicate = two rows with identical DEVICE colorant values (exact string
// match, no tolerance — chardata's rule). When Lab is present we also report ΔE*ab
// repeatability across each duplicate group (chardata computeDupStats, 7514).
function deltaEab(L1, a1, b1, L2, a2, b2) {
  return Math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2)
}
function meanOf(vals) {
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : NaN
}
function medianOf(vals) {
  if (!vals.length) return NaN
  const s = [...vals].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function detectDuplicates(headers, rows, deviceCols, lab) {
  if (!deviceCols || !deviceCols.length) return { dupeRows: 0, groups: 0, de: null }
  const colIdx = deviceCols.map((c) => headers.indexOf(c))
  const iL = lab ? lab.L : -1
  const iA = lab ? lab.A : -1
  const iB = lab ? lab.B : -1
  const groups = new Map()
  for (const r of rows) {
    const key = colIdx.map((i) => (r[i] || '').trim()).join('\x00')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  let dupeRows = 0
  let groupsWithDupes = 0
  const des = []
  for (const g of groups.values()) {
    if (g.length < 2) continue
    groupsWithDupes++
    dupeRows += g.length - 1
    if (iL >= 0 && iA >= 0 && iB >= 0) {
      const pts = g
        .map((r) => ({ L: parseFloat(r[iL]), a: parseFloat(r[iA]), b: parseFloat(r[iB]) }))
        .filter((p) => [p.L, p.a, p.b].every(isFinite))
      if (pts.length >= 2) {
        const mL = meanOf(pts.map((p) => p.L))
        const mA = meanOf(pts.map((p) => p.a))
        const mB = meanOf(pts.map((p) => p.b))
        for (const p of pts) des.push(deltaEab(mL, mA, mB, p.L, p.a, p.b))
      }
    }
  }
  let de = null
  if (des.length) {
    de = { mean: meanOf(des), max: Math.max(...des), n: des.length }
  }
  return { dupeRows, groups: groupsWithDupes, de }
}

// Collapse duplicate device rows, aggregating measurement columns by median|mean.
// Ported from chardata deduplicateRows (5550). Device cells keep the first row's
// exact text; measurement cells become the aggregate (rounded to 4 dp).
export function deduplicateRows(headers, rows, deviceCols, method) {
  const agg = method === 'mean' ? meanOf : medianOf
  const colorantIdx = deviceCols.map((c) => headers.indexOf(c))
  const measureIdx = headers.map((_, i) => i).filter((i) => !colorantIdx.includes(i))
  const groups = new Map()
  const order = []
  for (const row of rows) {
    const key = colorantIdx.map((i) => (row[i] || '').trim()).join('\x00')
    if (!groups.has(key)) {
      groups.set(key, { deviceCells: colorantIdx.map((i) => row[i] || ''), measureVals: measureIdx.map(() => []) })
      order.push(key)
    }
    const g = groups.get(key)
    measureIdx.forEach((mi, ci) => {
      const v = parseFloat(row[mi])
      if (!isNaN(v)) g.measureVals[ci].push(v)
    })
  }
  const out = []
  for (const key of order) {
    const { deviceCells, measureVals } = groups.get(key)
    const row = new Array(headers.length).fill('')
    colorantIdx.forEach((di, i) => {
      row[di] = deviceCells[i]
    })
    measureIdx.forEach((mi, ci) => {
      const m = agg(measureVals[ci])
      if (!isNaN(m)) row[mi] = String(Math.round(m * 10000) / 10000)
    })
    out.push(row)
  }
  return out
}

// ── Dataset-properties summary (design decision #5) ───────────────────────────
// Everything the UI needs to describe an onboarded dataset: format, patch count,
// which kinds are present with their guessed encoding, spectral range, and
// duplicate status. `kinds` is ordered device → Lab → XYZ → spectral so the chip
// text reads naturally.
export function summarizeDataset(parsed) {
  const { headers, rows } = parsed
  const cls = classifyColumns(headers)
  const kinds = []
  if (cls.device.length) {
    kinds.push({
      kind: 'device',
      label: `Device (${cls.device.length}ch)`,
      channels: cls.device.slice(),
      encoding: guessDeviceEncoding(rows, cls.deviceIdx),
    })
  }
  if (cls.lab) {
    kinds.push({ kind: 'lab', label: 'Lab', channels: ['L*', 'a*', 'b*'], encoding: 'value' })
  }
  if (cls.xyz) {
    kinds.push({ kind: 'xyz', label: 'XYZ', channels: ['X', 'Y', 'Z'], encoding: 'value' })
  }
  if (cls.spectral.length) {
    const nm = cls.spectral.map((s) => s.nm)
    const step = cls.spectral.length > 1 ? cls.spectral[1].nm - cls.spectral[0].nm : 0
    kinds.push({
      kind: 'spectral',
      label: `Spectral (${cls.spectral.length} bands)`,
      channels: cls.spectral.map((s) => s.nm + 'nm'),
      encoding: guessSpectralEncoding(rows, cls.spectral.map((s) => s.idx)),
      range: { start: nm[0], end: nm[nm.length - 1], step },
    })
  }

  const dup = detectDuplicates(headers, rows, cls.device, cls.lab)

  return {
    format: parsed.format,
    cxfVariant: parsed.cxfVariant || null,
    patchCount: rows.length,
    hasName: cls.nameIdx >= 0,
    kinds,
    // Colorimetry sources present, in preference order — drives the "Prefer:" listbox.
    colorimetrySources: kinds.filter((k) => k.kind === 'lab' || k.kind === 'xyz' || k.kind === 'spectral').map((k) => k.kind),
    duplicates: dup,
    classification: cls,
  }
}

// ── Colorimetry conversions (D50 PCS white) ───────────────────────────────────
// The ICC PCS is D50-referenced, so Lab↔XYZ here use the D50 white point. XYZ is
// carried in "value" units (Y of the perfect white = 1.0), matching icEncodeValue
// for the 'XYZ ' space. These handle the Prefer-listbox cross-conversions when the
// dataset's colorimetry kind differs from what the chain's PCS input wants; the
// spectral→colorimetry path is canonical iccDEV (WASM), not done here.
const D50 = { Xn: 0.96422, Yn: 1.0, Zn: 0.82521 }
export function xyzToLab(X, Y, Z) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(X / D50.Xn),
    fy = f(Y / D50.Yn),
    fz = f(Z / D50.Zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}
export function labToXyz(L, a, b) {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const inv = (ft) => (ft ** 3 > 0.008856 ? ft ** 3 : (ft - 16 / 116) / 7.787)
  return [D50.Xn * inv(fx), D50.Yn * inv(fy), D50.Zn * inv(fz)]
}

// The chain-source "kind" a dataset must satisfy, from the CMM source-space sig.
export function spaceKind(sig) {
  const s = (sig || '').trim()
  if (s === 'Lab') return 'lab'
  if (s === 'XYZ') return 'xyz'
  return 'device' // RGB / CMYK / GRAY / CMY / nCLR — anything the CMM takes as device
}

// Normalise a dataset's XYZ columns to value units (Y white = 1.0), auto-scaling
// from the observed range: 0..~100 → percent (÷100); already ≤~2 → as-is.
function xyzScale(rows, xyz) {
  let max = 0
  for (const r of rows) {
    const y = parseFloat(r[xyz.Y])
    if (isFinite(y) && y > max) max = y
  }
  return max > 3 ? 0.01 : 1 // >3 ⇒ percentage-scaled measurements
}

/**
 * Build the Float32 source-sample buffer that feeds the chain HEAD for Transform
 * Data, plus the source encoding to declare to the WASM. Enforces head/tail-aware
 * validation: throws a user-facing message when the dataset can't supply what the
 * chain's input space needs.
 *
 * @param {object} parsed   parseDataText result ({headers, rows, …})
 * @param {object} need      { kind:'device'|'lab'|'xyz', nSrc } from the chain (spaceKind)
 * @param {string} prefer    colorimetry source to use when PCS input: 'lab'|'xyz'|'spectral'
 * @param {number[][]} [spectralXYZRows] precomputed [X,Y,Z] (value units) per row —
 *        the spectral→colorimetry result from the WASM engine (computed async by the
 *        caller BEFORE calling this). Required only when prefer==='spectral'.
 * @returns {{ samples: Float32Array, nSrc: number, srcEncoding: string,
 *            sourceCells: string[][], sourceHeaders: string[] }}
 */
export function buildTransformInput(parsed, need, prefer, spectralXYZRows) {
  const { headers, rows } = parsed
  const cls = classifyColumns(headers)

  if (need.kind === 'device') {
    if (!cls.device.length) throw new Error('This dataset has no device colorant values, but the chain starts in a device space.')
    if (cls.deviceIdx.length !== need.nSrc) {
      throw new Error(`The chain starts in a ${need.nSrc}-channel device space, but the dataset has ${cls.deviceIdx.length} device channel(s) (${cls.device.join(', ')}).`)
    }
    const enc = guessDeviceEncoding(rows, cls.deviceIdx)
    const samples = new Float32Array(rows.length * need.nSrc)
    rows.forEach((row, r) => {
      cls.deviceIdx.forEach((ci, c) => {
        samples[r * need.nSrc + c] = parseFloat(row[ci]) || 0
      })
    })
    return {
      samples,
      nSrc: need.nSrc,
      srcEncoding: enc === 'unknown' ? 'unitFloat' : enc,
      sourceHeaders: cls.device.slice(),
      sourceCells: rows.map((row) => cls.deviceIdx.map((ci) => row[ci] ?? '')),
    }
  }

  // PCS input (Lab or XYZ): produce colorimetry in VALUE units from the chosen
  // source, converting kinds as needed. Always declared as icEncodeValue.
  const wantLab = need.kind === 'lab'
  const out = [] // rows of [c0,c1,c2] in value units for the target PCS
  let sourceHeaders

  if (prefer === 'spectral') {
    if (!cls.spectral.length) throw new Error('“Prefer: Spectral” is selected, but the dataset has no spectral columns.')
    if (!Array.isArray(spectralXYZRows) || spectralXYZRows.length !== rows.length) {
      throw new Error('Spectral→colorimetry result is missing or the wrong length.')
    }
    spectralXYZRows.forEach(([X, Y, Z]) => out.push(wantLab ? xyzToLab(X, Y, Z) : [X, Y, Z]))
    sourceHeaders = wantLab ? ['LAB_L', 'LAB_A', 'LAB_B'] : ['XYZ_X', 'XYZ_Y', 'XYZ_Z']
  } else if (prefer === 'xyz' || (prefer !== 'lab' && cls.xyz && !cls.lab)) {
    if (!cls.xyz) throw new Error('“Prefer: XYZ” is selected, but the dataset has no XYZ columns.')
    const k = xyzScale(rows, cls.xyz)
    rows.forEach((row) => {
      const X = (parseFloat(row[cls.xyz.X]) || 0) * k
      const Y = (parseFloat(row[cls.xyz.Y]) || 0) * k
      const Z = (parseFloat(row[cls.xyz.Z]) || 0) * k
      out.push(wantLab ? xyzToLab(X, Y, Z) : [X, Y, Z])
    })
    sourceHeaders = wantLab ? ['LAB_L', 'LAB_A', 'LAB_B'] : ['XYZ_X', 'XYZ_Y', 'XYZ_Z']
  } else {
    if (!cls.lab) throw new Error('The chain needs colorimetric input, but the dataset has no Lab/XYZ/spectral colorimetry.')
    rows.forEach((row) => {
      const L = parseFloat(row[cls.lab.L]) || 0
      const a = parseFloat(row[cls.lab.A]) || 0
      const b = parseFloat(row[cls.lab.B]) || 0
      out.push(wantLab ? [L, a, b] : labToXyz(L, a, b))
    })
    sourceHeaders = wantLab ? ['LAB_L', 'LAB_A', 'LAB_B'] : ['XYZ_X', 'XYZ_Y', 'XYZ_Z']
  }

  if (need.nSrc !== 3) throw new Error(`The chain expects ${need.nSrc} input channels, but colorimetry supplies 3.`)
  const samples = new Float32Array(out.length * 3)
  out.forEach((v, r) => {
    samples[r * 3] = v[0]
    samples[r * 3 + 1] = v[1]
    samples[r * 3 + 2] = v[2]
  })
  return {
    samples,
    nSrc: 3,
    srcEncoding: 'value',
    sourceHeaders,
    sourceCells: out.map((v) => v.map((x) => (Math.round(x * 1e4) / 1e4).toString())),
  }
}

// Output-side headers for a destination space signature (mirror of channelsForSpace
// but keyed on the CMM's dest-space sig, so the results table labels output columns).
export function destHeaders(sig, nDst) {
  const clean = (sig || '').trim()
  const key = clean.length === 3 ? clean + ' ' : clean
  if (SPACE_CHANNELS[key]) return SPACE_CHANNELS[key].slice()
  return channelsForSpace(key, nDst)
}
