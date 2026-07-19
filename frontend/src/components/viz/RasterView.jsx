// (c) 2026 William Li
//
// Loads one raster visualization (a CLUT lattice image, or the gamut in/out map)
// and draws it via RasterCanvas (native-pixel canvas + zoom / pan / reset /
// corner-resize). Shared by the Analysis-tab "CLUT Image" / "Gamut Image" sections.
// `gamut` switches the decode to the in/out-of-gamut colour ramp and shows the
// gamut legend.
import { renderRaster } from '../../lib/vizPlot.js'
import { decodeRaster } from '../../lib/rasterDecode.js'
import { useT } from '../../i18n.jsx'
import { useAsync } from './useAsync.js'
import VizWarnings from './VizWarnings.jsx'
import RasterCanvas from './RasterCanvas.jsx'
import styles from './vizShared.module.css'

// Swatch colours mirror decodeGamut() in lib/rasterDecode.js: in-gamut neutral and
// the deep end of the out-of-gamut red ramp.
const GAMUT_NEUTRAL = '#e8ebef'
const GAMUT_RED = 'rgb(155,12,12)'
function swatch(color) {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, borderRadius: 2,
      background: color, border: '1px solid rgba(0,0,0,.25)',
      verticalAlign: 'middle', marginRight: 4,
    }} />
  )
}

// Localized "Neutral = in gamut · red = out of gamut" caption with a colour swatch
// before each half (split on the ' · ' separator used in every locale's string).
function GamutLegend({ t }) {
  const parts = t('viz_gamut_legend').split('·')
  const left = (parts[0] || '').trim()
  const right = (parts[1] || '').trim()
  return (
    <span>
      {swatch(GAMUT_NEUTRAL)}{left}
      {right && <>{'  ·  '}{swatch(GAMUT_RED)}{right}</>}
    </span>
  )
}

export default function RasterView({ bytes, id, gamut = false }) {
  const t = useT()
  const state = useAsync(
    () => renderRaster(bytes, id).then((r) => ({ raster: decodeRaster(r, { gamut }), warnings: r.warnings })),
    [bytes, id, gamut],
  )
  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>
  return (
    <>
      <VizWarnings items={state.data.warnings} />
      <RasterCanvas raster={state.data.raster} caption={gamut ? <GamutLegend t={t} /> : undefined} />
    </>
  )
}
