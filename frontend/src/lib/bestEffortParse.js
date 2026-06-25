// (c) William Li 2026
/**
 * Best-effort structural parse of an ICC profile the WASM validator could not
 * fully load.
 *
 * When `ValidateIccProfile` hits a critical error (e.g. a tag whose data runs
 * past end-of-file — a classic payload-injection shape) it returns NULL and the
 * UI otherwise shows nothing but "Failed to parse". iccDEV deliberately keeps
 * that critical/reject behaviour, so instead of changing the validator we parse
 * what we safely can *in the browser* — the 128-byte header and the tag
 * directory — purely so the user can INSPECT the profile. The result is clearly
 * flagged `partial` and must never be treated as a usable profile.
 *
 * This reads only the header + the 12-byte directory entries (and a 4-byte type
 * signature per tag when in-bounds); it never trusts a tag's offset/size to
 * index into the buffer beyond an explicit bounds check, so a hostile profile
 * cannot drive an out-of-bounds read here.
 */

const ICC_MAGIC = 0x61637370 // 'acsp' at offset 36

// A small map of common tag signatures → human names, so the Tags table reads
// like the normal view. Anything not listed falls back to the raw signature.
const TAG_NAMES = {
  desc: 'profileDescriptionTag', cprt: 'copyrightTag', wtpt: 'mediaWhitePointTag',
  bkpt: 'mediaBlackPointTag', rTRC: 'redTRCTag', gTRC: 'greenTRCTag', bTRC: 'blueTRCTag',
  rXYZ: 'redColorantTag', gXYZ: 'greenColorantTag', bXYZ: 'blueColorantTag',
  kTRC: 'grayTRCTag', A2B0: 'AToB0Tag', A2B1: 'AToB1Tag', A2B2: 'AToB2Tag',
  B2A0: 'BToA0Tag', B2A1: 'BToA1Tag', B2A2: 'BToA2Tag', gamt: 'gamutTag',
  chad: 'chromaticAdaptationTag', lumi: 'luminanceTag', meas: 'measurementTag',
  tech: 'technologyTag', view: 'viewingConditionsTag', vued: 'viewingCondDescTag',
  dmnd: 'deviceMfgDescTag', dmdd: 'deviceModelDescTag', targ: 'charTargetTag',
  clrt: 'colorantTableTag', clro: 'colorantOrderTag', calt: 'calibrationDateTimeTag',
}

const INTENTS = ['Perceptual', 'Relative Colorimetric', 'Saturation', 'Absolute Colorimetric']

function sig(bytes, off) {
  let s = ''
  for (let i = 0; i < 4; i++) {
    const c = bytes[off + i]
    s += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ''
  }
  return s.trim()
}

function hex(bytes, off, len) {
  let s = ''
  for (let i = 0; i < len; i++) s += bytes[off + i].toString(16).padStart(2, '0')
  return s
}

function versionStr(dv) {
  const v = dv.getUint32(8)
  return `${(v >>> 24) & 0xff}.${(v >> 20) & 0xf}.${(v >> 16) & 0xf}`
}

/**
 * @param {Uint8Array} bytes
 * @param {string} filename
 * @returns {object|null} a `parsed`-shaped object with `partial: true`, or null
 *   if the bytes aren't even plausibly an ICC profile (caller shows the error).
 */
export function bestEffortParse(bytes, filename) {
  if (!bytes || bytes.length < 132) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(36) !== ICC_MAGIC) return null // not an ICC profile — let the error stand

  const fileLen = bytes.length
  const headerSize = dv.getUint32(0)
  const messages = []

  // ── Header (raw best-effort decode) ───────────────────────────────────────
  const sigOrDash = (off) => sig(bytes, off) || '—'
  const xyz = (off) =>
    `X=${(dv.getInt32(off) / 65536).toFixed(4)}, ` +
    `Y=${(dv.getInt32(off + 4) / 65536).toFixed(4)}, ` +
    `Z=${(dv.getInt32(off + 8) / 65536).toFixed(4)}`
  const date = () => {
    const g = (o) => dv.getUint16(24 + o)
    if (!g(0) && !g(2) && !g(4) && !g(6) && !g(8) && !g(10)) return 'Not set'
    return `${g(2)}/${g(4)}/${g(0)} ${String(g(6)).padStart(2, '0')}:` +
           `${String(g(8)).padStart(2, '0')}:${String(g(10)).padStart(2, '0')} (M/D/Y)`
  }
  const intent = dv.getUint32(64)
  const header = {
    'Profile Size': `${headerSize.toLocaleString()} bytes`,
    'Preferred CMM': sigOrDash(4),
    'Version': versionStr(dv),
    'Profile Class': sigOrDash(12),
    'Data Color Space': sigOrDash(16),
    'PCS': sigOrDash(20),
    'Creation Date': date(),
    'Primary Platform': sigOrDash(40),
    'Flags': `0x${hex(bytes, 44, 4)}`,
    'Device Manufacturer': sigOrDash(48),
    'Device Model': sigOrDash(52),
    'Device Attributes': `0x${hex(bytes, 56, 8)}`,
    'Rendering Intent': INTENTS[intent] || `Unknown (${intent})`,
    'PCS Illuminant': xyz(68),
    'Profile Creator': sigOrDash(80),
  }
  const profileId = hex(bytes, 84, 16)

  // ── Tag directory ─────────────────────────────────────────────────────────
  const count = dv.getUint32(128)
  const dirEnd = 132 + count * 12
  const maxEntries = Math.max(0, Math.floor((fileLen - 132) / 12))
  const readable = Math.min(count, maxEntries)
  if (dirEnd > fileLen) {
    messages.push(`Tag table declares ${count} tags (needs ${dirEnd.toLocaleString()} bytes) ` +
      `but the file is only ${fileLen.toLocaleString()} bytes — only ${readable} entr${readable === 1 ? 'y is' : 'ies are'} present.`)
  }

  const rows = []
  for (let i = 0; i < readable; i++) {
    const o = 132 + i * 12
    const id = sig(bytes, o)
    const offset = dv.getUint32(o + 4)
    const size = dv.getUint32(o + 8)
    const end = offset + size
    // Type signature lives at the start of the tag's data — only read it if the
    // first 4 bytes are in bounds.
    const type = offset + 4 <= fileLen ? sig(bytes, offset) : null
    if (end > fileLen) {
      messages.push(`Tag '${id}' data (offset ${offset.toLocaleString()}, size ${size.toLocaleString()}) ` +
        `extends ${(end - fileLen).toLocaleString()} byte(s) beyond the end of the file — this is why the profile cannot be loaded.`)
    }
    if (offset % 4 !== 0) {
      messages.push(`Tag '${id}' offset ${offset} is not aligned on a 4-byte boundary.`)
    }
    rows.push({ name: TAG_NAMES[id] || id || '—', id, type, offset, size })
  }

  // Sort by offset and compute pad (gap to the next tag, or to EOF for the last).
  rows.sort((a, b) => a.offset - b.offset)
  const tags = rows.map((r, i) => {
    const thisEnd = r.offset + r.size
    const next = i + 1 < rows.length ? rows[i + 1].offset : fileLen
    return { ...r, isArrayType: false, description: null, pad: next - thisEnd }
  })

  if (messages.length === 0) {
    messages.push('The reference validator reported a critical error and could not fully load this profile.')
  }

  return {
    filename,
    partial: true,
    profileId,
    sizeBytes: headerSize,
    header,
    tags,
    validation: {
      level: 'error',
      status: 'Critical error — profile could not be fully parsed. Shown for inspection only; do not apply.',
      messages,
    },
  }
}
