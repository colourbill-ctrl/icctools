// (c) 2026 William Li
//
// Loads one raster visualization (a CLUT lattice image, or the gamut in/out map)
// and draws it via RasterCanvas (native-pixel canvas + zoom / pan / reset /
// corner-resize). Shared by the Analysis-tab "CLUT Image" / "Gamut Image" sections.
// `gamut` switches the decode to the in/out-of-gamut colour ramp and shows the
// gamut legend.
import { renderRaster, tagEvalInfo } from '../../lib/vizPlot.js'
import { decodeRaster, separationLabels } from '../../lib/rasterDecode.js'
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

// TIFF PhotometricInterpretation 8 = CIELAB (mirrors rasterDecode.js): a device→PCS
// (A2B) table's output. Everything else a CLUT here emits is a DEVICE space, whose
// channels are colorants — the only case per-ink separations make sense. Callers gate
// `separation` to B2A/preview tables anyway; this is the belt-and-suspenders check.
const PHOTO_CIELAB = 8

// Localize a colorant name through the hue_* dictionary (Cyan/Magenta/…/Black), falling
// back to the raw English name for anything without a key ("Ink 3", "Gray").
function inkName(t, name) {
  const k = 'hue_' + name.toLowerCase()
  const s = t(k)
  return s === k ? name : s
}

export default function RasterView({ bytes, id, sig, gamut = false, separation = false }) {
  const t = useT()
  const state = useAsync(
    async () => {
      const r = await renderRaster(bytes, id)
      // Main image: an N-ink device output with no cheap preview comes back with a
      // colour-managed CIELAB preview (`colorSamples`, via the forward A2B) — decode that
      // in colour instead of the first-channel grayscale the raw device raster would give.
      const main = r.colorSamples
        ? decodeRaster({ width: r.width, height: r.height, channels: r.colorChannels,
                         bitsPerChannel: 8, photometric: r.colorPhotometric, samples: r.colorSamples })
        : decodeRaster(r, { gamut })
      // Per-ink separations: one grayscale ink-coverage image per output colorant, for
      // a device-output (B2A) table. Always from the raw device `samples`. Names come
      // from the device space signature (tagEvalInfo) since photometric alone can't tell
      // CMY from RGB.
      let seps = null
      if (separation && r.photometric !== PHOTO_CIELAB && r.channels >= 1) {
        const info = await tagEvalInfo(bytes, sig).catch(() => null)
        const labels = separationLabels(info?.dstSpaceSig, r.channels)
        seps = labels.map((label, c) => ({ label, raster: decodeRaster(r, { channel: c }) }))
      }
      return { raster: main, seps, warnings: r.warnings }
    },
    [bytes, id, sig, gamut, separation],
  )
  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>
  return (
    <>
      <VizWarnings items={state.data.warnings} />
      <RasterCanvas raster={state.data.raster} caption={gamut ? <GamutLegend t={t} /> : undefined} />
      {state.data.seps && (
        <>
          <p className={styles.sepCaption}>
            {t('analysis_clut_sep_desc') || 'Ink coverage of each colorant across the same lattice (darker = more ink).'}
          </p>
          {state.data.seps.map((s, i) => (
            <div key={i}>
              <p className={styles.sepLabel}>{inkName(t, s.label)}</p>
              <RasterCanvas raster={s.raster} />
            </div>
          ))}
        </>
      )}
    </>
  )
}
