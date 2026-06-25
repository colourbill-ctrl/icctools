// (c) 2026 William Li
/**
 * Validation-message interpreter.
 *
 * IccProfLib's validation report (`validation.messages[]` in the WASM JSON) is
 * free text — each line is a human sentence with no machine-readable pointer to
 * the tag or header field it concerns. This module turns one of those lines into
 * a structured interpretation the UI can act on: a cleaned message, a severity,
 * and a `target` describing *where* the problem lives so a dialog can show it in
 * context and highlight it.
 *
 * The report line format is `"<Status>! - <sigPath> - <text>"` where the
 * status prefixes come from IccProfLib/IccUtil.cpp:92 and the sigPath is empty
 * for header-level findings (which is why the Encoding-Class line reads
 * `"NonCompliant! -  - Encoding Class …"`) and a `"<tag>:"` path for tag-level
 * findings.
 *
 * Resolution order (interpretMessage):
 *   1. strict tag match — a `"<tagId>:" / "<tagName>:"` sig-path segment → tag
 *   2. header RULES     — deterministic header-field findings (CheckHeader)
 *   3. loose tag match  — a bare tag id/name token (odd report formats)
 * Strict-tag-first matters: it stops a header rule from stealing a tag-level
 * message that happens to share wording (e.g. "Reserved value must be zero").
 *
 * The header rules mirror CIccProfile::CheckHeader (iccDEV IccProfile.cpp). Each
 * recomputes the offending field(s) from the raw profile bytes — the formatted
 * JSON header strings are lossy (renderingIntent 0 renders as "Perceptual"), so
 * they can't drive the checks. Adding coverage = adding a row to HEADER_RULES.
 */

// Status prefixes IccProfLib prepends to each report line, longest first so the
// match is unambiguous. `sev` drives the chip colour; `label` is the source word.
const PREFIXES = [
  { str: 'NonCompliant! - ', sev: 'error',   label: 'Non-compliant' },
  { str: 'Error! - ',        sev: 'error',   label: 'Error' },
  { str: 'Warning! - ',      sev: 'warning', label: 'Warning' },
  { str: 'Information - ',   sev: 'info',    label: 'Information' },
]

/**
 * Split a raw report line into `{ severity, statusLabel, text }`. Strips the
 * IccProfLib status prefix and the leading `"- "` left behind when the sigPath
 * is empty, yielding a clean sentence. Unknown-prefix lines pass through as-is
 * with severity 'info'.
 */
export function parseMessage(raw) {
  let text = String(raw ?? '')
  let severity = 'info'
  let statusLabel = ''
  for (const p of PREFIXES) {
    if (text.startsWith(p.str)) {
      severity = p.sev
      statusLabel = p.label
      text = text.slice(p.str.length)
      break
    }
  }
  // An empty sigPath leaves a dangling "- " (the line had "<status> -  - text").
  text = text.replace(/^\s*-\s*/, '').trim()
  return { severity, statusLabel, text }
}

// ── Raw header readers ───────────────────────────────────────────────────────
// ICC headers are big-endian; DataView.getUintXX defaults to big-endian. Offsets
// follow the icHeader layout (icProfileHeader.h).

function sigStr(bytes, off) {
  let s = ''
  for (let i = 0; i < 4; i++) {
    const c = bytes[off + i]
    s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '·'
  }
  return s
}

function hexStr(bytes, off, len) {
  let s = ''
  for (let i = 0; i < len; i++) s += bytes[off + i].toString(16).padStart(2, '0')
  return s
}

function hex32(v) {
  return (v >>> 0).toString(16).padStart(8, '0')
}

function versionStr(dv) {
  const v = dv.getUint32(8)
  const major = (v >>> 24) & 0xff
  const b1 = (v >>> 16) & 0xff
  return `${major}.${(b1 >> 4) & 0xf}.${b1 & 0xf} (0x${hex32(v)})`
}

function illuminantStr(dv) {
  const f = (off) => (dv.getInt32(off) / 65536).toFixed(4)
  return `X=${f(68)}, Y=${f(72)}, Z=${f(76)}`
}

function spectralRangeStr(dv, off) {
  return `start=0x${dv.getUint16(off).toString(16)}, ` +
         `end=0x${dv.getUint16(off + 2).toString(16)}, ` +
         `steps=${dv.getUint16(off + 4)}`
}

// A 4-byte field treated as a signature (or raw u32). Zero ⇒ compliant.
function u32Field(label, off, asSig) {
  return {
    label,
    read: (dv, b) => {
      const v = dv.getUint32(off)
      return {
        zero: v === 0,
        value: asSig ? `'${sigStr(b, off)}' (0x${hex32(v)})` : `0x${hex32(v)} (${v})`,
      }
    },
  }
}

// A multi-byte field; zero ⇒ every byte zero. Value rendered as a hex dump.
function bytesField(label, off, len) {
  return {
    label,
    read: (dv, b) => {
      let zero = true
      for (let i = 0; i < len; i++) if (b[off + i] !== 0) { zero = false; break }
      return { zero, value: hexStr(b, off, len) }
    },
  }
}

/**
 * The header fields iccDEV requires to be zero for a ColorEncodingClass profile
 * (IccProfLib/IccProfile.cpp:1572). Order matches the header's field sequence.
 */
export const HEADER_ZERO_FIELDS = [
  u32Field('Preferred CMM Type', 4, true),
  u32Field('PCS (Profile Connection Space)', 20, true),
  bytesField('Creation Date/Time', 24, 12),
  u32Field('Primary Platform', 40, true),
  u32Field('Profile Flags', 44, false),
  u32Field('Device Manufacturer', 48, true),
  u32Field('Device Model', 52, true),
  bytesField('Device Attributes', 56, 8),
  u32Field('Rendering Intent', 64, false),
  bytesField('PCS Illuminant', 68, 12),
  u32Field('Profile Creator', 80, true),
  bytesField('Profile ID', 84, 16),
  u32Field('Spectral PCS', 100, true),
  bytesField('Spectral Range', 104, 6),
  bytesField('Bispectral Range', 110, 6),
]

// Named single-field readers used by the field-pointer header rules. Each
// `read(dv, bytes)` returns `{ value }` — a human display of the current value.
const FIELDS = {
  cmm:        { label: 'Preferred CMM Type', read: (dv, b) => ({ value: `'${sigStr(b, 4)}' (0x${hex32(dv.getUint32(4))})` }) },
  version:    { label: 'Profile Version',    read: (dv)    => ({ value: versionStr(dv) }) },
  class:      { label: 'Profile/Device Class', read: (dv, b) => ({ value: `'${sigStr(b, 12)}' (0x${hex32(dv.getUint32(12))})` }) },
  colorSpace: { label: 'Data Colour Space',  read: (dv, b) => ({ value: `'${sigStr(b, 16)}' (0x${hex32(dv.getUint32(16))})` }) },
  pcs:        { label: 'PCS',                read: (dv, b) => ({ value: `'${sigStr(b, 20)}' (0x${hex32(dv.getUint32(20))})` }) },
  platform:   { label: 'Primary Platform',  read: (dv, b) => ({ value: `'${sigStr(b, 40)}' (0x${hex32(dv.getUint32(40))})` }) },
  flags:      { label: 'Profile Flags',     read: (dv)    => ({ value: `0x${hex32(dv.getUint32(44))}` }) },
  attributes: { label: 'Device Attributes', read: (dv, b) => ({ value: `0x${hexStr(b, 56, 8)}` }) },
  intent:     { label: 'Rendering Intent',  read: (dv)    => ({ value: `0x${hex32(dv.getUint32(64))} (${dv.getUint32(64)})` }) },
  illuminant: { label: 'PCS Illuminant',    read: (dv)    => ({ value: illuminantStr(dv) }) },
  profileId:  { label: 'Profile ID',        read: (dv, b) => ({ value: hexStr(b, 84, 16) }) },
  spectralPCS:{ label: 'Spectral PCS',      read: (dv, b) => ({ value: `'${sigStr(b, 100)}' (0x${hex32(dv.getUint32(100))})` }) },
  spectralRange:   { label: 'Spectral Range',   read: (dv) => ({ value: spectralRangeStr(dv, 104) }) },
  biSpectralRange: { label: 'Bispectral Range', read: (dv) => ({ value: spectralRangeStr(dv, 110) }) },
  mcs:        { label: 'MCS (Material Connection Space)', read: (dv, b) => ({ value: `'${sigStr(b, 116)}' (0x${hex32(dv.getUint32(116))})` }) },
  reserved:   { label: 'Reserved header bytes (100–127)', read: (dv, b) => ({ value: hexStr(b, 100, 28) }) },
}

function headerDataView(bytes) {
  if (!bytes || bytes.length < 128) return null
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

// ── Header rules ─────────────────────────────────────────────────────────────
// A field-pointer rule highlights the named header field(s) and shows their
// current value with a `requirement` sentence (English — validation text stays
// in source form per CLAUDE.md i18n scope). `opts.trigger` adds a context field
// (e.g. the profile class) above the violations; `opts.expected` maps a field
// key to the value the spec wants (drives the modal's per-row badge).

function fieldRule(test, requirement, fieldKeys, opts = {}) {
  return {
    test,
    build: (ctx) => {
      const dv = headerDataView(ctx.bytes)
      const readOne = (k, withExpected) => {
        const f = FIELDS[k]
        const r = dv ? f.read(dv, ctx.bytes) : { value: '—' }
        const exp = withExpected && opts.expected ? opts.expected[k] : undefined
        return exp != null ? { label: f.label, value: r.value, expected: exp }
                           : { label: f.label, value: r.value }
      }
      return {
        kind: 'header',
        requirement,
        triggerField: opts.trigger ? readOne(opts.trigger, false) : null,
        violations: fieldKeys.map((k) => readOne(k, true)),
      }
    },
  }
}

// Encoding-Class zero-field rule: recomputes which of the must-be-zero fields
// are actually non-zero (so the dialog lists exactly the offenders).
const encodingClassRule = {
  test: /Encoding Class has non-zero Header data/i,
  build: (ctx) => {
    const dv = headerDataView(ctx.bytes)
    const violations = []
    if (dv) {
      for (const f of HEADER_ZERO_FIELDS) {
        const r = f.read(dv, ctx.bytes)
        if (!r.zero) violations.push({ label: f.label, value: r.value, expected: '0' })
      }
    }
    const cls = ctx.header?.['Profile Class']
    const sig = dv ? sigStr(ctx.bytes, 12) : null
    return {
      kind: 'header',
      requirement:
        'For a Colour Encoding Class profile the ICC spec requires these header ' +
        'fields to be zero. The field(s) below are non-zero.',
      triggerField: {
        label: 'Profile/Device Class',
        value: cls ? (sig ? `${cls} ('${sig}')` : cls) : (sig ? `'${sig}'` : '—'),
      },
      violations,
    }
  },
}

// Order matters only within overlapping wording; first match wins.
const HEADER_RULES = [
  encodingClassRule,

  // Profile class / version / colour-space / PCS compatibility.
  fieldRule(/not supported in Version .* profiles/i,
    'This profile/device class requires an ICC v5 (iccMAX) profile.',
    ['version'], { trigger: 'class' }),
  fieldRule(/Unknown profile class/i,
    'The profile/device class is not a recognised ICC class signature.',
    ['class']),
  fieldRule(/Unknown color space/i,
    'The data colour space is not a recognised ICC colour-space signature.',
    ['colorSpace']),
  fieldRule(/Invalid PCS designator for/i,
    'This profile class must not define a Profile Connection Space (PCS).',
    ['pcs'], { trigger: 'class' }),
  fieldRule(/(Unknown|Invalid) pcs color space/i,
    'The PCS field is not valid for this profile class (expected XYZ or Lab).',
    ['pcs']),
  fieldRule(/Both Colorimetric PCS or Spectral PCS are not defined/i,
    'A profile must define a colorimetric PCS or a spectral PCS — both are empty.',
    ['pcs', 'spectralPCS']),

  // MCS (multiplex) designator.
  fieldRule(/Invalid MCS designator/i,
    'The MCS (Material Connection Space) field is not valid for this device class.',
    ['mcs'], { trigger: 'class' }),

  // Spectral / bispectral PCS family.
  fieldRule(/Spectral PCS usage in version/i,
    'Spectral PCS is only valid in ICC v5 (iccMAX) profiles.',
    ['spectralPCS'], { trigger: 'version' }),
  fieldRule(/Spectral PCS wavelengths defined with no spectral PCS/i,
    'Spectral range fields are set but no spectral PCS is defined.',
    ['spectralPCS', 'spectralRange', 'biSpectralRange']),
  fieldRule(/Number of channels defined for spectral PCS do not match spectral range/i,
    'The spectral PCS channel count does not match the spectral range step count.',
    ['spectralPCS', 'spectralRange']),
  fieldRule(/BiDir Spectral PCS wavelength must be larger/i,
    'The bispectral end wavelength must be larger than the start wavelength.',
    ['biSpectralRange']),
  fieldRule(/Must have more 2 or more BiDir spectral wavelength steps/i,
    'The bispectral range must have at least 2 wavelength steps.',
    ['biSpectralRange']),
  fieldRule(/Spectral PCS wavelength must be larger/i,
    'The spectral end wavelength must be larger than the start wavelength.',
    ['spectralRange']),
  fieldRule(/Must have more 2 or more spectral wavelength steps/i,
    'The spectral range must have at least 2 wavelength steps.',
    ['spectralRange']),
  fieldRule(/Invalid spectral PCS color space/i,
    'The spectral PCS field is not a recognised spectral colour space.',
    ['spectralPCS']),

  // Platform / CMM / rendering intent.
  fieldRule(/Unknown platform signature/i,
    'The primary platform is not a recognised platform signature.',
    ['platform']),
  fieldRule(/Unregistered CMM signature/i,
    'The preferred CMM signature is not an ICC-registered CMM.',
    ['cmm']),
  fieldRule(/Unknown rendering intent/i,
    'Rendering intent must be Perceptual, Relative Colorimetric, Saturation, or Absolute Colorimetric.',
    ['intent']),

  // Illuminant.
  fieldRule(/Non D50 Illuminant/i,
    'Pre-v5 profiles must encode the PCS illuminant as D50.',
    ['illuminant'], { expected: { illuminant: 'X≈0.9642, Y≈1.0000, Z≈0.8249' } }),

  // Profile flags.
  fieldRule(/Reserved profile flags/i,
    'Reserved profile-flag bits must be zero.',
    ['flags']),
  fieldRule(/Vendor-specific profile flags/i,
    'Vendor-specific profile-flag bits (16–31) are set.',
    ['flags']),

  // Device attributes.
  fieldRule(/Reserved device attributes/i,
    'Reserved device-attribute bits must be zero.',
    ['attributes']),
  fieldRule(/Vendor-specific device attributes/i,
    'Vendor-specific device-attribute bits (32–63) are set.',
    ['attributes']),

  // Version field encoding.
  fieldRule(/(minor number is unexpected|Major version number)/i,
    'The profile version field uses an unexpected major/minor number.',
    ['version']),
  fieldRule(/Version number bytes 10 and 11 are reserved but non-zero/i,
    'The reserved low bytes of the version field must be zero.',
    ['version']),

  // Reserved header bytes. Case-SENSITIVE lowercase "value" — the header check
  // emits "Reserved value must be zero." while the tag check emits "Reserved
  // Value must be zero." (capital V), so this won't steal the tag message.
  fieldRule(/Reserved value must be zero/,
    'Reserved header bytes must be zero.',
    ['reserved']),
]

// ── Tag fallback ─────────────────────────────────────────────────────────────

// Build a boundary-anchored matcher for a needle (tag id or name).
function tokenRe(needle, trailingColon) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return trailingColon
    ? new RegExp(`(^|[^A-Za-z0-9])${esc}:`)
    : new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`)
}

// strict: require the sig-path "<tag>:" form (reliable tag-level signal).
// loose:  a bare "<tag>" token anywhere (covers odd report formats).
function tagTarget(text, ctx, strict) {
  const tags = Array.isArray(ctx.tags) ? ctx.tags : []
  for (const tag of tags) {
    for (const needle of [tag.id, tag.name]) {
      if (needle && tokenRe(needle, strict).test(text)) {
        return { kind: 'tag', tagId: tag.id, tagName: tag.name }
      }
    }
  }
  return null
}

/**
 * Interpret one raw report line against the profile context.
 *
 * @param {string} raw  the report line, e.g. "NonCompliant! -  - Encoding …"
 * @param {object} ctx  { header, profileId, tags, bytes } from the parsed result
 * @returns {{ raw, severity, statusLabel, text, target }} where `target` is
 *   { kind:'header', triggerField, requirement, violations[] } |
 *   { kind:'tag', tagId, tagName } | null (unresolved — shown but not clickable)
 */
export function interpretMessage(raw, ctx = {}) {
  const { severity, statusLabel, text } = parseMessage(raw)
  let target = tagTarget(text, ctx, true)
  if (!target) {
    for (const rule of HEADER_RULES) {
      if (rule.test.test(text)) { target = rule.build(ctx); break }
    }
  }
  if (!target) target = tagTarget(text, ctx, false)
  return { raw, severity, statusLabel, text, target }
}
