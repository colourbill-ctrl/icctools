// (c) 2026 William Li
//
// Shared lazy loader for Plotly (the one plotting dependency). Every plot component
// (PlotlyGraph, RtHistogram) imports loadPlotly() from here so there is a single
// memoized module promise for the whole app.
//
// preloadPlotly() warms that chunk during idle time. Plotly is ~3.5 MB; the network
// fetch is async, but EVALUATING/parsing the module is synchronous and blocks the
// main thread for a beat. If that parse happens on the click that first renders a
// plot (e.g. expanding a LUT tag's curves), the UI appears frozen with no feedback.
// Preloading on idle after a profile is open moves that cost off the interaction.

let plotlyPromise = null

export function loadPlotly() {
  if (!plotlyPromise) {
    plotlyPromise = import('plotly.js-dist-min').then((m) => m.default || m)
    plotlyPromise.catch(() => { plotlyPromise = null })   // let a failed load retry
  }
  return plotlyPromise
}

export function preloadPlotly() {
  if (plotlyPromise) return                     // already loading/loaded
  const warm = () => loadPlotly()
  // Idle callback so the preload never competes with the profile's first paint;
  // a timeout fallback covers browsers without requestIdleCallback (Safari).
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 })
  else setTimeout(warm, 1200)
}
