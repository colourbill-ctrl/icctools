import { useEffect, useRef } from 'react'
import styles from './RasterCanvas.module.css'

/**
 * Draws a decoded raster (the CLUT lattice / gamut image) to a canvas.
 * `raster` is the output of decodeRaster(): { width, height, rgba, photometric }.
 * `caption` is an optional extra line (e.g. the gamut colour legend).
 */
export default function RasterCanvas({ raster, caption }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = raster.width
    canvas.height = raster.height
    canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0)
  }, [raster])
  return (
    <div className={styles.rasterWrap}>
      <canvas ref={ref} className={styles.raster} />
      <div className={styles.rasterMeta}>{raster.width}×{raster.height} · {raster.photometric}</div>
      {caption && <div className={styles.rasterMeta}>{caption}</div>}
    </div>
  )
}
