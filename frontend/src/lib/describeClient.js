// (c) 2026 William Li
//
// Worker-backed describeTag with a transparent main-thread fallback. Same
// signature as validator.js::describeTag — (bytes, tagSig) => Promise<string> — so
// callers are unchanged.
//
// Running the (potentially heavy) per-tag dump in a worker keeps the main thread
// responsive while the WASM churns. If the worker can't be created (old browser,
// blocked) or dies during init, we fall back to computing the dump on the main
// thread so the Data panel still fills in — just without the off-thread benefit.
import { describeTag as describeTagMain } from './validator.js'

let worker = null
let workerBroken = false
let reqSeq = 0
const pending = new Map()   // reqId -> { resolve, reject }

function getWorker() {
  if (worker || workerBroken) return worker
  try {
    worker = new Worker(new URL('./describeWorker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (e) => {
      const { reqId, text, error } = e.data || {}
      const p = pending.get(reqId)
      if (!p) return
      pending.delete(reqId)
      if (error) p.reject(new Error(error)); else p.resolve(text)
    }
    worker.onerror = () => {
      // Worker died (e.g. failed WASM init). Fail everything in flight; future
      // calls (and the .catch below) fall back to the main thread.
      workerBroken = true
      for (const [, p] of pending) p.reject(new Error('describe worker error'))
      pending.clear()
      try { worker.terminate() } catch { /* ignore */ }
      worker = null
    }
  } catch {
    workerBroken = true
    worker = null
  }
  return worker
}

export function describeTag(bytes, tagSig) {
  const w = getWorker()
  if (!w) return describeTagMain(bytes, tagSig)   // no worker available → main thread
  const reqId = ++reqSeq
  // NOTE: postMessage structured-clones `bytes` (we do NOT transfer — the main
  // thread keeps its buffer). Fine for real profiles (well under a few MB); the
  // WASM's own parse cache means repeated tag dumps of one profile don't re-parse.
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    try {
      w.postMessage({ reqId, bytes, tagSig })
    } catch (err) {
      pending.delete(reqId)
      reject(err)
    }
  }).catch((err) => {
    // If the worker path failed (e.g. onerror rejected this), retry once on the
    // main thread so the dump still appears.
    if (workerBroken) return describeTagMain(bytes, tagSig)
    throw err
  })
}
