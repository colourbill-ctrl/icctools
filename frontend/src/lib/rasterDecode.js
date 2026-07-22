// (c) 2026 William Li
/**
 * Decode an IccVizModel raster (raw ICC-normalized samples, NOT a TIFF
 * container) to canvas-paintable RGBA.
 *
 * IccVizModel.renderRaster returns the same ICC-normalized CLUT samples that
 * iccProfileVisualize would have written into a TIFF, plus geometry. This is
 * the tiff.js per-pixel conversion (Lab(D50)→sRGB, CMYK, gray, RGB) lifted out
 * of the UTIF container path so it operates directly on those samples. Best-
 * effort preview, not a colour-managed render. tiff.js is left untouched (it
 * still backs the legacy Visualize tab).
 *
 * photometric codes match TIFF PhotometricInterpretation:
 *   0 WhiteIsZero · 1 BlackIsZero · 2 RGB · 5 CMYK · 8 CIELAB
 */

const PHOTO = { WHITE_IS_ZERO: 0, BLACK_IS_ZERO: 1, RGB: 2, CMYK: 5, CIELAB: 8 }
const PHOTO_NAME = { 0: 'Grayscale', 1: 'Grayscale', 2: 'RGB', 5: 'CMYK', 8: 'CIELAB' }

// Lab(D50) → sRGB, Bradford-adapted D50→D65. (Mirror of tiff.js.)
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const fInv = (t) => {
    const t3 = t * t * t
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
  }
  const Xn = 0.96422, Yn = 1.0, Zn = 0.82521
  const X = Xn * fInv(fx), Y = Yn * fInv(fy), Z = Zn * fInv(fz)
  const X2 =  0.9555766 * X - 0.0230393 * Y + 0.0631636 * Z
  const Y2 = -0.0282895 * X + 1.0099416 * Y + 0.0210077 * Z
  const Z2 =  0.0122982 * X - 0.0204830 * Y + 1.3299098 * Z
  const r =  3.2404542 * X2 - 1.5371385 * Y2 - 0.4985314 * Z2
  const g = -0.9692660 * X2 + 1.8760108 * Y2 + 0.0415560 * Z2
  const bl =  0.0556434 * X2 - 0.2040259 * Y2 + 1.0572252 * Z2
  const gamma = (c) => {
    c = Math.min(1, Math.max(0, c))
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  }
  return [Math.round(gamma(r) * 255), Math.round(gamma(g) * 255), Math.round(gamma(bl) * 255)]
}

/**
 * @param {{width,height,channels,bitsPerChannel,photometric,samples:Uint8Array}} ras
 * @param {{gamut?:boolean, channel?:number}} [opts] — `gamut` colour-codes a 1-channel
 *   gamut tag (0 = in gamut → neutral; >0 = out of gamut → red ramp by magnitude).
 *   `channel` renders ONE output channel as an ink-coverage grayscale (0 = no ink →
 *   white, full ink → black) — the QC "separation" view (e.g. channel 3 = K).
 * @returns {{width:number,height:number,rgba:Uint8ClampedArray,photometric:string}}
 */
export function decodeRaster(ras, opts = {}) {
  const { width, height, channels: spp, bitsPerChannel: bps, photometric, samples } = ras
  const maxVal = (1 << bps) - 1 || 65535
  // 16-bit samples are little-endian (produced by the WASM build).
  const read = bps === 16
    ? (p, s) => {
        const o = (p * spp + s) * 2
        return (samples[o] | (samples[o + 1] << 8)) / 65535
      }
    : (p, s) => samples[p * spp + s] / maxVal

  if (opts.gamut) return decodeGamut(ras, read)
  if (Number.isInteger(opts.channel)) return decodeSeparation(ras, read, opts.channel)

  const px = width * height
  const rgba = new Uint8ClampedArray(px * 4)
  for (let p = 0; p < px; p++) {
    let r, g, b
    switch (photometric) {
      case PHOTO.RGB:
        r = read(p, 0) * 255; g = read(p, 1) * 255; b = read(p, 2) * 255
        break
      case PHOTO.CMYK: {
        const c = read(p, 0), m = read(p, 1), y = read(p, 2), k = read(p, 3)
        r = 255 * (1 - c) * (1 - k); g = 255 * (1 - m) * (1 - k); b = 255 * (1 - y) * (1 - k)
        break
      }
      case PHOTO.CIELAB: {
        const L = read(p, 0) * 100
        const A = read(p, 1) * 255 - 128
        const B = read(p, 2) * 255 - 128
        ;[r, g, b] = labToRgb(L, A, B)
        break
      }
      case PHOTO.WHITE_IS_ZERO: {
        const v = (1 - read(p, 0)) * 255; r = g = b = v
        break
      }
      default: {
        const v = read(p, 0) * 255; r = g = b = v
      }
    }
    const o = p * 4
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
  }
  return { width, height, rgba, photometric: PHOTO_NAME[photometric] || `Photometric ${photometric}` }
}

// Colorant names for the per-ink separation views, keyed on the device space
// signature (photometric alone can't tell CMY from RGB — both tag as 2). Falls back to
// numbered "Ink N" when the space is unknown or its channel count doesn't match, so a
// nCLR / mismatched profile is labelled safely rather than mislabelled.
const SPACE_INKS = {
  CMYK: ['Cyan', 'Magenta', 'Yellow', 'Black'],
  RGB:  ['Red', 'Green', 'Blue'],
  CMY:  ['Cyan', 'Magenta', 'Yellow'],
  GRAY: ['Black'],
}
export function separationLabels(spaceSig, channels) {
  const named = SPACE_INKS[(spaceSig || '').trim().toUpperCase()]
  if (named && named.length === channels) return named
  return Array.from({ length: channels }, (_, i) => `Ink ${i + 1}`)
}

// Render ONE output channel of a CLUT raster as an ink-coverage grayscale: no ink
// (0) → white, full ink (1) → black, so more of the colorant reads as darker — the
// QC "separation" view (the K separation being channel 3 of a CMYK B2A table). Out-of-
// range channel indices fall back to channel 0 rather than reading past the sample row.
function decodeSeparation(ras, read, channel) {
  const px = ras.width * ras.height
  const spp = ras.channels
  const ch = channel >= 0 && channel < spp ? channel : 0
  const rgba = new Uint8ClampedArray(px * 4)
  for (let p = 0; p < px; p++) {
    const v = 255 * (1 - read(p, ch))   // ink coverage → darkness
    const o = p * 4
    rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255
  }
  return { width: ras.width, height: ras.height, rgba, photometric: 'Separation' }
}

// Colour-code a gamut tag's single-channel map. 0 means in gamut; any positive
// value means out of gamut, the magnitude being a profile-defined distance.
// In-gamut pixels render neutral; out-of-gamut pixels render on a red ramp whose
// intensity is normalized to the image's own max so both hard-binary maps (CRPC1)
// and graded distance maps (Fogra51) read clearly.
function decodeGamut(ras, read) {
  const px = ras.width * ras.height
  const eps = 1e-4
  let maxV = 0
  for (let p = 0; p < px; p++) { const v = read(p, 0); if (v > maxV) maxV = v }
  const inv = maxV > eps ? 1 / maxV : 0

  const rgba = new Uint8ClampedArray(px * 4)
  for (let p = 0; p < px; p++) {
    const v = read(p, 0)
    let r, g, b
    if (v <= eps) {
      r = 232; g = 235; b = 239            // in gamut → neutral
    } else {
      const t = inv ? Math.min(1, v * inv) : 1   // pale red → deep red
      r = 250 - 95 * t; g = 195 - 183 * t; b = 185 - 173 * t
    }
    const o = p * 4
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
  }
  return { width: ras.width, height: ras.height, rgba, photometric: 'Gamut' }
}
