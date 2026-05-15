// scripts/sync-translations.mjs
// Regenerate translations/Eng-*.xlsx from the I18N dict in
// frontend/src/i18n.jsx. Each xlsx has English in column 0 and the target
// language in column 1 (or 1+2 for the Pt and Zh files, which carry both
// regional variants — matches chardata's translations/ layout exactly).
//
// Usage:
//   node scripts/sync-translations.mjs
//
// Dependencies:
//   xlsx (^0.18.5). Not pinned in package.json — matches chardata. Install
//   ad-hoc with `npm i --no-save xlsx@^0.18.5` inside frontend/, or rely on
//   the resolver below to pick up chardata's copy if you have both repos
//   side by side. Two GHSA advisories apply to xlsx 0.18.5 (prototype
//   pollution, ReDoS), but this script only ever reads our own i18n.jsx and
//   writes new xlsx files — it never parses untrusted spreadsheets, so the
//   attack surface here is nil.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')
const I18N_SRC = path.join(REPO, 'frontend', 'src', 'i18n.jsx')
const T_DIR    = path.join(REPO, 'translations')

// Resolve xlsx from any of these locations. Matches chardata's "don't pin
// xlsx in package.json" pattern; falls back to the sibling chardata install
// so the script Just Works on a machine that has both repos.
function resolveXlsx() {
  const candidates = [
    path.join(REPO, 'frontend', 'node_modules', 'xlsx'),
    path.join(REPO, 'node_modules', 'xlsx'),
    '/mnt/c/Users/colou/code/chardata/node_modules/xlsx',
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const req = createRequire(path.join(dir, 'package.json'))
      return req('./')
    }
  }
  console.error('xlsx not found in any of:')
  for (const c of candidates) console.error('  ' + c)
  console.error('Install with:  (cd frontend && npm i --no-save xlsx@^0.18.5)')
  process.exit(1)
}

const XLSX = resolveXlsx()

// ── 1. Extract I18N dict from i18n.jsx by brace-depth matching ──────────────
// The dict is a static object literal of strings — safe to eval via Function
// because the source is our own committed file. (Same approach as
// chardata/scripts/check-translations.js.)
const src = fs.readFileSync(I18N_SRC, 'utf8')
const startToken = 'export const I18N = {'
const startIdx = src.indexOf(startToken)
if (startIdx < 0) { console.error('I18N dict not found in', I18N_SRC); process.exit(1) }
const braceStart = src.indexOf('{', startIdx)
let depth = 0, end = -1
for (let i = braceStart; i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
}
if (end < 0) { console.error('Could not match closing brace of I18N dict'); process.exit(1) }
const I18N = (new Function('return ' + src.slice(braceStart, end)))()

const enKeys = Object.keys(I18N.en)
console.log(`Loaded I18N: ${Object.keys(I18N).length} languages, ${enKeys.length} keys`)

// ── 2. Write spreadsheets ───────────────────────────────────────────────────
// Mirror chardata's filename + multi-column scheme exactly so a future
// merger of both translations/ directories is trivial.
const FILES = [
  { file: 'Eng-De.xlsx', langs: [['de', 'German']] },
  { file: 'Eng-Es.xlsx', langs: [['es', 'Spanish']] },
  { file: 'Eng-Fr.xlsx', langs: [['fr', 'French']] },
  { file: 'Eng-It.xlsx', langs: [['it', 'Italian']] },
  { file: 'Eng-Ja.xlsx', langs: [['ja', 'Japanese']] },
  { file: 'Eng-Ko.xlsx', langs: [['ko', 'Korean']] },
  { file: 'Eng-Pt.xlsx', langs: [['pt-PT', 'Portuguese (PT)'], ['pt-BR', 'Portuguese (BR)']] },
  { file: 'Eng-Sv.xlsx', langs: [['sv', 'Swedish']] },
  { file: 'Eng-Zh.xlsx', langs: [['zh-CN', 'Chinese Simplified'], ['zh-TW', 'Chinese Traditional']] },
]

fs.mkdirSync(T_DIR, { recursive: true })

for (const { file, langs } of FILES) {
  const header = ['English', ...langs.map(([, label]) => label)]
  const rows = [header]
  for (const key of enKeys) {
    const en = I18N.en[key]
    const cols = langs.map(([code]) => (I18N[code] && I18N[code][key]) || '')
    rows.push([en, ...cols])
  }
  // Column widths sized to roughly fit typical content so the file opens
  // legibly in Excel / LibreOffice without a manual resize.
  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 50 }, ...langs.map(() => ({ wch: 50 }))]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet')
  const outPath = path.join(T_DIR, file)
  XLSX.writeFile(wb, outPath)
  console.log(`wrote ${file}  (${rows.length - 1} rows × ${header.length} cols)`)
}
