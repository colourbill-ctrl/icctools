// (c) 2026 William Li
//
// Helpers for the 2.x Profile Pool (session-ephemeral, filesystem-backed store).
// A pool entry is the same per-profile object App has always kept (bytes + parsed
// + XML/JSON round-trip state) plus a stable `id` and derived `meta` for the list
// row. Nothing here persists — the pool lives in React state for the session only.

// A profile's stable identity for dedup-on-load. The ICC header carries an MD5
// `profileId`; prefer it when present and non-zero. Otherwise fall back to a
// sampled FNV-1a over the bytes (+ length), which is ample for "is this the same
// file I already loaded?" without hashing a possibly-256 MB buffer end to end.
export function entryId(bytes, parsed) {
  const pid = parsed && typeof parsed.profileId === 'string' ? parsed.profileId.trim() : ''
  if (pid && !/^0+$/.test(pid)) return `pid:${pid.toLowerCase()}`
  return `h:${bytes.length.toString(16)}:${sampledFnv1a(bytes)}`
}

// FNV-1a 32-bit over up to ~64 KB sampled evenly across the buffer, mixed with
// length. Collisions are irrelevant here (worst case: two distinct profiles read
// as "the same" in the pool — vanishingly unlikely at this sample size).
function sampledFnv1a(bytes) {
  const n = bytes.length
  const MAX = 65536
  const step = n > MAX ? Math.floor(n / MAX) : 1
  let h = 0x811c9dc5
  for (let i = 0; i < n; i += step) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// Compact facts for the pool-list row, pulled from the validated header. Every
// field is best-effort (a partial/best-effort parse may omit some) — the row
// renders whatever is present. Keys match wrapper.cpp's header JSON.
export function deriveMeta(parsed) {
  const h = (parsed && parsed.header) || {}
  return {
    profileClass: h['Profile Class'] || '',
    colorSpace:   h['Data Color Space'] || '',
    pcs:          h['PCS Color Space'] || '',
    version:      h['Version'] || '',
    sizeBytes:    typeof parsed?.sizeBytes === 'number' ? parsed.sizeBytes : (parsed?.sizeBytes || 0),
    partial:      !!parsed?.partial,
  }
}

// Human-readable byte size for the row (e.g. "1.2 MB", "488 B").
export function formatSize(n) {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
