// (c) 2026 William Li
import { renderGraph, tagEvalInfo } from '../lib/vizPlot.js'
import { useT } from '../i18n.jsx'
import Collapsible from './viz/Collapsible.jsx'
import PlotlyGraph from './viz/PlotlyGraph.jsx'
import TagEvaluator from './TagEvaluator.jsx'
import { channelColor } from './viz/colors.js'
import { useAsync } from './viz/useAsync.js'
import VizWarnings from './viz/VizWarnings.jsx'
import styles from './TagVisuals.module.css'

// IccVizModel Kind enum (kept in sync with IccVizModel.hpp).
const KIND = { Curve1D: 1, ChromaticityXY: 2, NamedColorsAB: 3, NamedColorsXY: 4, ClutImage: 5 }
const COLORANT_HL = { rXYZ: 'R', gXYZ: 'G', bXYZ: 'B' }
const TRC_TAGS = new Set(['rTRC', 'gTRC', 'bTRC', 'kTRC'])
const ATOB_TAGS = new Set(['A2B0', 'A2B1', 'A2B2', 'A2B3'])

const LAB_PRETTY = { L: 'L*', a: 'a*', b: 'b*' }
const pretty = (label) => { const tail = String(label).split('_').pop(); return LAB_PRETTY[tail] || tail }

/**
 * Inline per-tag visualizations rendered inside the Tags-tab expanded detail.
 * Branches on tag type; for each it lays out the relevant graphs/rasters and the
 * evaluator above the raw Describe() dump (`dataNode`), wrapping that dump in a
 * collapsible (or leaving it always-visible) per the tag type.
 */
export default function TagVisuals({ tag, bytes, descriptors = [], chromaDesc, dataNode }) {
  const t = useT()
  const isLut = descriptors.some((d) => d.kind === KIND.ClutImage || d.grp)

  if (isLut) {
    return <LutVisuals tag={tag} bytes={bytes} descriptors={descriptors} dataNode={dataNode} t={t} />
  }

  if (tag.id === 'wtpt' && chromaDesc) {
    return (
      <>
        <Collapsible title={t('viz_chromaticity')} defaultOpen>
          <GraphView bytes={bytes} id={chromaDesc.id} highlight="white" />
        </Collapsible>
        {dataNode}
      </>
    )
  }

  if (COLORANT_HL[tag.id] && chromaDesc) {
    return (
      <>
        <Collapsible title={t('viz_chromaticity')} defaultOpen>
          <GraphView bytes={bytes} id={chromaDesc.id} highlight={COLORANT_HL[tag.id]} />
        </Collapsible>
        {dataNode}
      </>
    )
  }

  if (TRC_TAGS.has(tag.id)) {
    const trc = descriptors.find((d) => d.kind === KIND.Curve1D)
    return (
      <>
        {trc && (
          <Collapsible title={t('viz_trc')} defaultOpen>
            <GraphView bytes={bytes} id={trc.id} toneOption />
          </Collapsible>
        )}
        <Collapsible title={t('viz_curve_table')} defaultOpen={false}>{dataNode}</Collapsible>
      </>
    )
  }

  const ab = descriptors.find((d) => d.kind === KIND.NamedColorsAB)
  const xy = descriptors.find((d) => d.kind === KIND.NamedColorsXY)
  if (ab || xy) {
    return (
      <>
        <Collapsible title={t('viz_scatter')} defaultOpen>
          {ab && <GraphView bytes={bytes} id={ab.id} />}
          {xy && <GraphView bytes={bytes} id={xy.id} />}
        </Collapsible>
        <Collapsible title={t('viz_tables')} defaultOpen={false}>{dataNode}</Collapsible>
      </>
    )
  }

  // No visualization for this tag — render the dump as before.
  return dataNode
}

// ── LUT tags (AToB / BToA / gamut / preview) ─────────────────────────────────
// The CLUT lattice image and the gamut in/out map are NOT rendered here anymore —
// they live in the Analysis tab's "CLUT Image" / "Gamut Image" sections (each with
// its own rendering-intent selector + zoom/pan). This view keeps the per-tag
// curves, the point evaluator, and the raw dump.
function LutVisuals({ tag, bytes, descriptors, dataNode, t }) {
  const info = useAsync(() => tagEvalInfo(bytes, tag.id), [bytes, tag.id])
  // The gamut tag exposes no evaluable transform (single in/out channel), so no
  // evaluator; it also has no curves, so it falls through to just the raw dump.
  const isGamut = tag.id === 'gamt'
  const isAToB = ATOB_TAGS.has(tag.id)
  const inputGrps = isAToB ? ['A'] : ['B', 'M']
  const outputGrps = isAToB ? ['B', 'M'] : ['A']
  const inputCurves = descriptors.filter((d) => d.kind === KIND.Curve1D && inputGrps.includes(d.grp))
  const outputCurves = descriptors.filter((d) => d.kind === KIND.Curve1D && outputGrps.includes(d.grp))

  return (
    <>
      {(inputCurves.length > 0 || outputCurves.length > 0) && (
        <Collapsible title={t('viz_curves')} defaultOpen={!isGamut}>
          {inputCurves.length > 0 && (
            <>
              <div className={styles.subHead}>{t('viz_input_curves')}</div>
              <CombinedCurves bytes={bytes} curves={inputCurves}
                spaceSig={info.data?.srcSpaceSig} labels={info.data?.srcLabels} />
            </>
          )}
          {outputCurves.length > 0 && (
            <>
              <div className={styles.subHead}>{t('viz_output_curves')}</div>
              <CombinedCurves bytes={bytes} curves={outputCurves}
                spaceSig={info.data?.dstSpaceSig} labels={info.data?.dstLabels} />
            </>
          )}
        </Collapsible>
      )}

      {!isGamut && (
        <Collapsible title={t('viz_evaluate')} defaultOpen>
          <TagEvaluator tag={tag} bytes={bytes} />
        </Collapsible>
      )}

      <Collapsible title={t('viz_data')} defaultOpen={false}>{dataNode}</Collapsible>
    </>
  )
}

// Overlay several 1-D curves (one CLUT group) into a single colour-coded graph.
function CombinedCurves({ bytes, curves, spaceSig, labels }) {
  const t = useT()
  const state = useAsync(
    () => Promise.all(curves.map((c) => renderGraph(bytes, c.id).then((g) => ({ c, g })))),
    [bytes, curves.map((c) => c.id).join(',')],
  )
  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>

  const merged = mergeCurveGraphs(state.data, spaceSig, labels)
  if (!merged) return null
  const warnings = state.data.flatMap(({ g }) => g.warnings || [])
  return <><VizWarnings items={warnings} /><PlotlyGraph graph={merged} legend toneOption storageKey="profiletool.tagCurveHeight" defaultH={300} /></>
}

function mergeCurveGraphs(items, spaceSig, labels) {
  if (!items.length) return null
  const base = items[0].g
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity
  const series = items.map(({ c, g }) => {
    const prim = g.series.find((s) => s.role !== 'hint') || g.series[0]
    for (let i = 0; i < prim.points.length; i += 2) {
      xmin = Math.min(xmin, prim.points[i]); xmax = Math.max(xmax, prim.points[i])
      ymin = Math.min(ymin, prim.points[i + 1]); ymax = Math.max(ymax, prim.points[i + 1])
    }
    const name = (labels && labels[c.idx] ? pretty(labels[c.idx]) : `Ch${c.idx}`) + (c.grp ? ` (${c.grp})` : '')
    return { ...prim, id: c.id, name, color: channelColor(spaceSig, c.idx, items.length), role: 'primary' }
  })
  return {
    title: base.title,
    description: '',
    xAxis: { label: base.xAxis.label, min: isFinite(xmin) ? xmin : 0, max: isFinite(xmax) ? xmax : 1 },
    yAxis: { label: base.yAxis.label, min: isFinite(ymin) ? ymin : 0, max: isFinite(ymax) ? ymax : 1 },
    series,
  }
}

// ── single graph loader ──────────────────────────────────────────────────────
// `toneOption` enables the X–Y / Tone-increase toggle (curves only, e.g. TRC).
function GraphView({ bytes, id, highlight, toneOption = false }) {
  const t = useT()
  const state = useAsync(() => renderGraph(bytes, id), [bytes, id])
  if (state.loading) return <div className={styles.loading}>{t('viz_loading') || 'Loading…'}</div>
  if (state.error) return <div className={styles.itemError}>{state.error}</div>
  return <><VizWarnings items={state.data.warnings} /><PlotlyGraph graph={state.data} highlight={highlight} toneOption={toneOption} storageKey="profiletool.tagGraphHeight" defaultH={320} /></>
}
