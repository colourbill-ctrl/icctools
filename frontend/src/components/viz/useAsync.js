// (c) 2026 William Li
import { useEffect, useState } from 'react'

// Generic cancellable async loader for the per-graph/raster WASM calls. Returns
// { loading } → { loading:false, data } | { loading:false, error }. `deps` drives
// re-runs; an in-flight call is cancelled (its result ignored) when deps change.
export function useAsync(fn, deps) {
  const [state, setState] = useState({ loading: true })
  useEffect(() => {
    let cancelled = false
    setState({ loading: true })
    Promise.resolve().then(fn).then(
      (data) => { if (!cancelled) setState({ loading: false, data }) },
      (e) => { if (!cancelled) setState({ loading: false, error: e.message }) },
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
