/**
 * Byte-level tag diff between the originally-loaded profile and the current
 * (possibly round-tripped) one.
 *
 * Matches tags by signature (`id`), not offset, because offsets shift when a
 * profile is re-serialised. A tag is marked "changed" when any of:
 *   - its bytes at [offset, offset+size) differ
 *   - its size differs
 *   - it's missing from the current profile (deleted)
 *
 * Returns a Set of tag id strings (e.g. "desc", "wtpt"). Falsy `null` input
 * means we have nothing to compare against — callers treat that as "show
 * everything normally".
 */
export function computeChangedTagIds(origBytes, origParsed, curBytes, curParsed) {
  if (!origParsed || !curParsed) return new Set()
  const changed = new Set()
  const origById = new Map(origParsed.tags.map(t => [t.id, t]))
  const curById  = new Map(curParsed.tags.map(t  => [t.id, t]))

  for (const cur of curParsed.tags) {
    const orig = origById.get(cur.id)
    if (!orig || orig.size !== cur.size) { changed.add(cur.id); continue }
    const a = origBytes.subarray(orig.offset, orig.offset + orig.size)
    const b = curBytes .subarray(cur .offset, cur .offset + cur .size)
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) { changed.add(cur.id); break }
    }
  }

  // Surface removed tags too (UI shows them only as "missing" today — this is
  // here for correctness if a future "compare" view wants the full diff).
  for (const orig of origParsed.tags) {
    if (!curById.has(orig.id)) changed.add(orig.id)
  }

  return changed
}
