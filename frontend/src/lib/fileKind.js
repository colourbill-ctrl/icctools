// (c) 2026 William Li
//
// Surface classification of a loaded file by content sniffing, so every load
// path (pool pane, canvas drop, launch protocols) can reject things that aren't
// what we accept BEFORE they land in the pool — and report them together.
//
// Design note: this is deliberately a *classifier that returns a kind*, not a
// bare "is-it-an-ICC" boolean. Today we accept ICC profiles only, but the pool
// will later accept image files (TIFF/PNG/JPEG) whose EMBEDDED profile we extract
// (the Add-from-image step). When that lands, `isImage()` starts returning true
// and the loader routes IMAGE kinds to extraction instead of rejecting them — no
// change to the accept/reject *plumbing*, only to what each kind does. Keep new
// magic-number sniffing here so there's one home for "what is this file?".

export const FileKind = {
  ICC: 'icc',
  IMAGE: 'image',     // reserved — routed to embedded-profile extraction later
  UNKNOWN: 'unknown',
}

// ICC/iccMAX profiles carry the ASCII signature 'acsp' at header offset 36
// (bytes 36..39). This is the cheapest reliable "is this even a profile?" check;
// full structural validation happens downstream in validateBytes().
function isIcc(bytes) {
  return bytes.length >= 40 &&
    bytes[36] === 0x61 /* a */ && bytes[37] === 0x63 /* c */ &&
    bytes[38] === 0x73 /* s */ && bytes[39] === 0x70 /* p */
}

// Reserved for the Add-from-image step: TIFF ("II*\0" / "MM\0*"), PNG
// (\x89PNG\r\n\x1a\n), JPEG (\xFF\xD8\xFF). Returns false today so image files
// are still rejected with a clear reason — but the branch already exists so
// wiring extraction in later touches only this function + the loader's IMAGE arm.
function isImage(bytes) {
  if (bytes.length < 4) return false
  const [b0, b1, b2, b3] = bytes
  const tiffLE = b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00
  const tiffBE = b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a
  const png    = b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47
  const jpeg   = b0 === 0xff && b1 === 0xd8 && b2 === 0xff
  if (tiffLE || tiffBE || png || jpeg) return true
  return false
}

// Classify by content. `filename` is accepted for future extension-based hints
// but content sniffing is authoritative.
export function classifyFile(bytes /*, filename */) {
  if (isIcc(bytes)) return { kind: FileKind.ICC }
  if (isImage(bytes)) return { kind: FileKind.IMAGE }
  return { kind: FileKind.UNKNOWN }
}

// Kinds the loader currently admits into the pool. Extend to include IMAGE when
// embedded-profile extraction ships; the loader already branches on kind.
export const ACCEPTED_KINDS = new Set([FileKind.ICC])

// Human-readable rejection reason for a kind we don't (yet) accept.
export function rejectReason(kind) {
  if (kind === FileKind.IMAGE) return 'image file — embedded-profile extraction is not available yet'
  return 'not an ICC profile'
}
