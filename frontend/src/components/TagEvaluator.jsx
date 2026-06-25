// (c) 2026 William Li
import { useEffect, useMemo, useState } from 'react'
import { tagEvalInfo, evaluateTag } from '../lib/vizPlot.js'
import { useT } from '../i18n.jsx'
import styles from './TagEvaluator.module.css'

// Strip the space prefix IccProfLib adds to channel labels ("RGB_R" → "R",
// "Lab_L" → "L*"). Keeps a readable short label for the rows.
const LAB_PRETTY = { L: 'L*', a: 'a*', b: 'b*' }
function pretty(label) {
  const tail = String(label).split('_').pop()
  return LAB_PRETTY[tail] || tail
}

// Human-unit range + default for one source channel.
function channelRange(spaceSig, isPcs, idx) {
  if (!isPcs) return { min: 0, max: 1, step: 0.001, def: 1 }
  if ((spaceSig || '').trim() === 'Lab') {
    return idx === 0
      ? { min: 0, max: 100, step: 0.5, def: 50 }
      : { min: -128, max: 127, step: 1, def: 0 }
  }
  return { min: 0, max: 1.2, step: 0.005, def: idx === 1 ? 1 : 0.9 } // XYZ
}

/**
 * Single-point evaluator for a LUT tag (AToB/BToA/gamut/preview). Applies the
 * tag's transform via IccProfLib (no lcms2) and shows the output in both
 * normalized and human units. Input can be supplied as floating-point human
 * values or as CLUT grid-node indices. Rendering intent is implicit — the tag is
 * already chosen.
 */
export default function TagEvaluator({ tag, bytes }) {
  const t = useT()
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState(null)
  const [mode, setMode] = useState('float')            // 'float' | 'grid'
  const [floatIn, setFloatIn] = useState(null)         // human units
  const [gridIn, setGridIn] = useState(null)           // integer node indices
  const [out, setOut] = useState(null)
  const [evalError, setEvalError] = useState(null)

  // Load transform shape once per tag/profile.
  useEffect(() => {
    let cancelled = false
    setInfo(null); setInfoError(null); setOut(null)
    tagEvalInfo(bytes, tag.id)
      .then((i) => {
        if (cancelled) return
        setInfo(i)
        setFloatIn(Array.from({ length: i.srcChannels },
          (_, k) => channelRange(i.srcSpaceSig, i.srcIsPcs, k).def))
        setGridIn(Array.from({ length: i.srcChannels }, () => 0))
      })
      .catch((e) => { if (!cancelled) setInfoError(e.message) })
    return () => { cancelled = true }
  }, [bytes, tag.id])

  const hasGrid = !!info && Array.isArray(info.gridPoints) &&
    info.gridPoints.length === info.srcChannels && info.gridPoints.every((n) => n > 1)

  // Compute the source array (+ normalized flag) for the active mode.
  const evalArgs = useMemo(() => {
    if (!info) return null
    if (mode === 'grid' && hasGrid && gridIn) {
      const norm = gridIn.map((idx, k) => idx / (info.gridPoints[k] - 1))
      return { input: norm, normalized: true }
    }
    if (floatIn) return { input: floatIn, normalized: false }
    return null
  }, [info, mode, hasGrid, gridIn, floatIn])

  // Re-evaluate on any input change (WASM parse cache makes this cheap).
  useEffect(() => {
    if (!evalArgs) return
    let cancelled = false
    setEvalError(null)
    evaluateTag(bytes, tag.id, evalArgs.input, evalArgs.normalized)
      .then((r) => { if (!cancelled) setOut(r) })
      .catch((e) => { if (!cancelled) { setOut(null); setEvalError(e.message) } })
    return () => { cancelled = true }
  }, [bytes, tag.id, evalArgs])

  if (infoError) return <div className={styles.error}>{infoError}</div>
  if (!info || !floatIn) return <div className={styles.loading}>{t('eval_loading') || 'Loading…'}</div>

  const dirKey = info.srcIsPcs ? 'eval_dir_pcs2dev' : 'eval_dir_dev2pcs'

  return (
    <div className={styles.evaluator}>
      <div className={styles.topRow}>
        <span className={styles.direction}>{t(dirKey)}</span>
        <div className={styles.modeToggle} role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'float'}
            className={`${styles.modeBtn} ${mode === 'float' ? styles.modeOn : ''}`}
            onClick={() => setMode('float')}>{t('eval_mode_float')}</button>
          <button type="button" role="tab" aria-selected={mode === 'grid'}
            disabled={!hasGrid}
            title={hasGrid ? undefined : (t('eval_no_grid') || 'No CLUT grid')}
            className={`${styles.modeBtn} ${mode === 'grid' ? styles.modeOn : ''}`}
            onClick={() => hasGrid && setMode('grid')}>{t('eval_mode_grid')}</button>
        </div>
      </div>

      <div className={styles.cols}>
        <div className={styles.col}>
          <div className={styles.colHead}>{t('eval_input')} · {info.srcSpace}</div>
          {info.srcLabels.map((label, k) => {
            if (mode === 'grid' && hasGrid) {
              const n = info.gridPoints[k]
              return (
                <div className={styles.row} key={k}>
                  <span className={styles.chLabel}>{pretty(label)}</span>
                  <input type="range" min={0} max={n - 1} step={1} value={gridIn[k]}
                    className={styles.slider}
                    onChange={(e) => setGridIn((v) => v.map((x, j) => j === k ? +e.target.value : x))} />
                  <span className={styles.nodeIdx}>{gridIn[k]}/{n - 1}</span>
                </div>
              )
            }
            const rg = channelRange(info.srcSpaceSig, info.srcIsPcs, k)
            return (
              <div className={styles.row} key={k}>
                <span className={styles.chLabel}>{pretty(label)}</span>
                <input type="range" min={rg.min} max={rg.max} step={rg.step} value={floatIn[k]}
                  className={styles.slider}
                  onChange={(e) => setFloatIn((v) => v.map((x, j) => j === k ? +e.target.value : x))} />
                <input type="number" min={rg.min} max={rg.max} step={rg.step} value={floatIn[k]}
                  className={styles.num}
                  onChange={(e) => setFloatIn((v) => v.map((x, j) => j === k ? +e.target.value : x))} />
              </div>
            )
          })}
        </div>

        <div className={styles.col}>
          <div className={styles.colHead}>{t('eval_output')} · {info.dstSpace}</div>
          <div className={styles.outHeadRow}>
            <span className={styles.chLabel} />
            <span className={styles.outCol}>{t('eval_human')}</span>
            <span className={styles.outCol}>{t('eval_normalized')}</span>
          </div>
          {info.dstLabels.map((label, k) => (
            <div className={styles.outRow} key={k}>
              <span className={styles.chLabel}>{pretty(label)}</span>
              <span className={styles.outCol}>{out ? fmt(out.outHuman[k], 3) : '—'}</span>
              <span className={styles.outCol}>{out ? fmt(out.outNorm[k], 4) : '—'}</span>
            </div>
          ))}
          {evalError && <div className={styles.error}>{evalError}</div>}
        </div>
      </div>
    </div>
  )
}

function fmt(v, d) {
  return (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : '—'
}
