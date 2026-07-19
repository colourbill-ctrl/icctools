// (c) 2026 William Li
//
// V4 Display Maker engine boundary + role classification (Link-tab maker, DL-LINK1,
// phase-1 item 5 — iccV5DspObsToV4Dsp). Combines a V5 RGB *display* profile and a
// V5 *observer* (ColorSpace-class PCC) profile into a V4 RGB matrix/TRC display.
//
// classifyV5Role() is the light, UI-side drop-router: it reads the raw ICC header
// SIGNATURES straight out of the profile bytes (every pool entry already holds
// them) rather than the localized human strings, so routing is language- and
// format-stable. It intentionally keys on device CLASS (+ RGB for the display),
// NOT on version — a real V5 display can carry a v4.x-encoded version field, so
// the version gate belongs to the engine, which is authoritative and rejects any
// off-contract input with a specific message.

// ICC header signature offsets (big-endian 4-char ASCII):
//   12..15 device class ('mntr' display / 'spac' ColorSpace) · 16..19 data color space.
function sigAt(bytes, off) {
  if (!bytes || bytes.length < off + 4) return ''
  return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
}

/**
 * Which V4-maker slot a profile fits, from its header signatures.
 * @returns {'display'|'observer'|null}
 */
export function classifyV5Role(bytes) {
  const klass = sigAt(bytes, 12)
  const space = sigAt(bytes, 16)
  // Require the ICC V5 encoding (major version byte @8 ≥ 5). iccV5DspObsToV4Dsp is
  // FUNDAMENTALLY a V5-only conversion: it re-integrates the display's SPECTRAL
  // EMISSION (the AToB1 EmissionMatrix) under a different observer — data only ICC v5/
  // iccMAX profiles carry. A v2/v4 display (e.g. AdobeRGB1998) holds only colorimetric
  // XYZ colorants (already integrated under one fixed observer), so it cannot be
  // observer-changed. The tool itself hard-rejects `version < icVersionNumberV5`, so we
  // don't route sub-V5 profiles into a slot. (The engine still does the precise
  // spectral-emission-AToB1 check and rejects any off-contract V5 input with a reason.)
  const major = bytes && bytes.length > 8 ? bytes[8] : 0
  if (major < 5) return null
  if (klass === 'mntr' && space === 'RGB ') return 'display'   // V5 RGB display
  if (klass === 'spac') return 'observer'                      // ColorSpace-class PCC (observer)
  return null                                                  // not a V4-maker input
}

/**
 * Build a V4 RGB matrix/TRC display profile from a V5 display + V5 observer.
 * Runs the WASM engine (a wrapper replicating iccV5DspObsToV4Dsp's construction
 * via CIccMemIO). Throws with the engine's specific rejection reason on invalid
 * input, so the maker card can surface it inline.
 * @param {Uint8Array} displayBytes  V5 RGB display profile
 * @param {Uint8Array} observerBytes V5 observer (ColorSpace-class PCC) profile
 * @returns {Promise<Uint8Array>} the V4 display profile
 */
export async function makeV4Display(displayBytes, observerBytes) {
  const { v5DspObsToV4 } = await import('./v5tov4Engine.js')
  return v5DspObsToV4(displayBytes, observerBytes)
}
