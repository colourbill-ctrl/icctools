// Stable tab identity + URL-fragment aliases.
//
// `key` is the internal identifier used throughout the UI (it is ProfileViewer's
// activeTab value). `i18n` is the label key. Two alias forms select a tab from a
// `#…&tab=` launch fragment (see MANUAL §"Launching with a URL"):
//   • `long`  — the exposed display name with whitespace removed
//               ("Profile Assessment WG" → "ProfileAssessmentWG"). Tracks the
//               UI labels for human readability.
//   • `short` — a terse code (HEADER, TAGS, VAL, …). Likely the preferred form.
// Matching also accepts `key` itself and is case-insensitive / whitespace-
// insensitive. Keep these aliases STABLE even if the display label changes —
// external links rely on them.
export const TAB_DEFS = [
  { key: 'Header',     i18n: 'tab_header',     long: 'Header',              short: 'HEADER' },
  { key: 'Tags',       i18n: 'tab_tags',       long: 'Tags',                short: 'TAGS'   },
  { key: 'Validation', i18n: 'tab_validation', long: 'Validation',          short: 'VAL'    },
  { key: 'PAWG',       i18n: 'tab_pawg',       long: 'ProfileAssessmentWG', short: 'PAWG'   },
  { key: 'Raw Output', i18n: 'tab_raw',        long: 'RawOutput',           short: 'RAW'    },
  { key: 'XML',        i18n: 'tab_xml',        long: 'XML',                 short: 'XML'    },
  { key: 'JSON',       i18n: 'tab_json',       long: 'JSON',                short: 'JSON'   },
]

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, '')

// alias (normalised) → internal key
const ALIAS_TO_KEY = (() => {
  const m = new Map()
  for (const tab of TAB_DEFS) {
    for (const alias of [tab.key, tab.long, tab.short]) {
      if (alias) m.set(norm(alias), tab.key)
    }
  }
  return m
})()

/**
 * Resolve a `tab=` fragment token to an internal tab key, or null if unknown.
 * Case- and whitespace-insensitive, so "raw output", "RawOutput" and "RAW" all
 * resolve to "Raw Output".
 * @param {string} token
 * @returns {string|null}
 */
export function resolveTabAlias(token) {
  if (!token) return null
  return ALIAS_TO_KEY.get(norm(token)) || null
}
