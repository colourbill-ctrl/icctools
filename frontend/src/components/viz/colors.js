// (c) 2026 William Li
// Shared colour logic for the data-first visualizations (graphs + LUT curves).

// Series colour for chromaticity / scatter / TRC plots. `role: 'hint'` series
// (spectral locus, planckian, identity line) are muted reference geometry;
// Primary series colour-code by colorHint (R/G/B/white).
export function colorFor(s) {
  if (s.role === 'hint') {
    if (s.id === 'locus' || s.colorHint === 'locus') return '#c79a00'
    if (s.id === 'planckian') return '#3a8f8f'
    return '#c4c9d2'
  }
  switch (s.colorHint) {
    case 'R': return '#d23b3b'
    case 'G': return '#2a9d3a'
    case 'B': return '#3361cc'
    case 'white': return '#7a8190'
    default: return '#4a90e2'
  }
}

// Per-channel colour for LUT curve traces, keyed on the colour space sig (the
// 4-char `srcSpaceSig`/`dstSpaceSig` from tagEvalInfo) and channel index. Device
// colorants get their natural ink/primary colour; PCS channels get neutral/
// opponent hues. Falls back to a stable rotating palette for n-channel spaces.
const PALETTE = ['#4a90e2', '#d23b3b', '#2a9d3a', '#b58a00', '#8e44ad', '#16a3a3', '#e07b39', '#777']

export function channelColor(spaceSig, index, count) {
  const sig = (spaceSig || '').trim()
  switch (sig) {
    case 'RGB': return ['#d23b3b', '#2a9d3a', '#3361cc'][index] || PALETTE[index % PALETTE.length]
    case 'CMYK': return ['#11aacc', '#cc2a8f', '#d9b800', '#333'][index] || PALETTE[index % PALETTE.length]
    case 'GRAY': return '#555'
    case 'Lab': return ['#666', '#c0392b', '#2e6fd6'][index] || PALETTE[index % PALETTE.length] // L / a* / b*
    case 'XYZ': return ['#c0392b', '#2a9d3a', '#3361cc'][index] || PALETTE[index % PALETTE.length]
    default: return PALETTE[index % PALETTE.length]
  }
}
