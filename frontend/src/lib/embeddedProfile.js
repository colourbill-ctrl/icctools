// (c) 2026 William Li
//
// Extract an EMBEDDED ICC profile from an image container (TIFF / PNG / JPEG).
// This is the JS half of the "Add from image" load path (roadmap Group C): the
// pool accepts an image, we pull the profile the image was tagged with, and that
// profile — not the image — enters the pool and gets validated like any other.
//
// STREAMING BY DESIGN. We never read the whole image into memory. In every
// format the profile lives near the front / in a small tag, so we walk container
// structure through a lazy byte-RANGE reader and pull only the bytes we actually
// need — a few KB of header/IFD/markers plus the profile blob itself — regardless
// of whether the source is a 40 KB JPEG or a 400 MB TIFF. That both bounds peak
// memory and lets us accept images far larger than the pool's own ICC size cap
// (their embedded profile is tiny even when the raster is huge).
//
// Two entry points share ONE implementation via a `reader` abstraction:
//   • extractEmbeddedProfileFromBlob(blob) — the streaming path (File/Blob),
//     reads sub-ranges with Blob.slice().arrayBuffer(). Used for user-loaded files.
//   • extractEmbeddedProfile(bytes)       — an in-memory buffer already in hand
//     (e.g. a #url= fetch), reads sub-ranges with a copying slice (never pins the
//     source buffer). Same parsers, same guards.
//
// Defensive throughout: every offset/length is bounds-checked against the source
// size before a read; loops are iteration-capped; the PNG inflate is output-capped
// (decompression-bomb guard). On anything malformed we return null (→ the loader
// reports "no embedded profile"), never throw — a bad image is a rejection, not a
// crash. The threat model is "untrusted bytes in the tab", so a hostile container
// can at most make us read bounded ranges of itself and hand back bytes that then
// fail ICC validation downstream.

// Upper bound on an extracted profile. Real ICC profiles are well under 10 MB;
// this ceiling only stops a crafted container (esp. a PNG zlib bomb) from
// materialising a huge buffer. The 'acsp' sniff + full validation still run
// downstream on whatever we hand back, so an over-cap/under-size result just fails.
const MAX_EMBEDDED_ICC_BYTES = 64 * 1024 * 1024   // 64 MB

// Loop backstop: a hostile container can't spin us forever walking chunks/markers.
// Legitimate files hit the profile (or the pixel data) within a handful of steps;
// this only bounds the pathological case before we bail to null.
const MAX_STEPS = 100000

// TIFF IFD tag carrying an embedded ICC profile (a.k.a. TIFFTAG_ICCPROFILE). Its
// value is the raw profile bytes. Note this is exactly libtiff's 34675.
const TIFF_TAG_ICC = 0x8773   // 34675

// TIFF field-type → element byte size, for the 1-byte types tag 34675 is ever
// encoded as (UNDEFINED/BYTE/SBYTE/ASCII). The `count` field is then the length.
const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 6: 1, 7: 1 }   // BYTE, ASCII, SBYTE, UNDEFINED

const EMPTY = new Uint8Array(0)

// Human-readable label for the size guard, reused by the loader's reject reason.
export const embeddedIccCapMB = MAX_EMBEDDED_ICC_BYTES / (1024 * 1024)

// --------------------------------------------------------------------------- //
// Readers — the only thing that differs between streaming and in-memory input.
// A reader is { size, read(start, end) -> Promise<Uint8Array> }, always bounded
// to [0, size] and always returning a FRESH buffer (never a view that could pin
// a large source).
// --------------------------------------------------------------------------- //

function blobReader(blob) {
  return {
    size: blob.size,
    async read(start, end) {
      const s = Math.max(0, start)
      const e = Math.min(blob.size, Math.max(s, end))
      if (e <= s) return EMPTY
      return new Uint8Array(await blob.slice(s, e).arrayBuffer())   // slice reads lazily
    },
  }
}

function bytesReader(bytes) {
  return {
    size: bytes.length,
    read(start, end) {
      const s = Math.max(0, start)
      const e = Math.min(bytes.length, Math.max(s, end))
      // .slice() COPIES — so a returned profile never keeps the whole source
      // buffer alive (the pinning trap a .subarray() view would create).
      return Promise.resolve(e <= s ? EMPTY : bytes.slice(s, e))
    },
  }
}

// --------------------------------------------------------------------------- //
// Public entry points
// --------------------------------------------------------------------------- //

/** Streaming extraction from a File/Blob — reads only the ranges it needs. */
export async function extractEmbeddedProfileFromBlob(blob) {
  if (!blob || blob.size < 4) return null
  return extractWithReader(blobReader(blob))
}

/** Extraction from an in-memory buffer already in hand (no whole-image read to save). */
export async function extractEmbeddedProfile(bytes) {
  if (!bytes || bytes.length < 4) return null
  return extractWithReader(bytesReader(bytes))
}

// Sniff the first bytes and dispatch to the right container parser.
async function extractWithReader(reader) {
  try {
    const head = await reader.read(0, 8)
    if (head.length < 4) return null
    const [b0, b1, b2, b3] = head
    // TIFF: "II\x2A\x00" (little-endian) or "MM\x00\x2A" (big-endian).
    if ((b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) ||
        (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a)) {
      return await extractFromTiff(reader, head)
    }
    // PNG: 8-byte signature \x89PNG\r\n\x1A\n.
    if (head.length >= 8 && b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47 &&
        head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
      return await extractFromPng(reader)
    }
    // JPEG: SOI = FF D8, then FF marker for the first segment.
    if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
      return await extractFromJpeg(reader)
    }
  } catch {
    return null   // any structural surprise → "no profile found", never propagate.
  }
  return null
}

// --------------------------------------------------------------------------- //
// TIFF — read header → first IFD → tag 34675's blob. Handles either endianness.
// We scan only the FIRST IFD (every real embedder puts the ICC tag there);
// chasing the IFD chain would add attack surface for no real-world gain. Note the
// IFD and the profile blob may sit anywhere in the file (TIFFs often write the IFD
// AFTER the image data) — streaming reads exactly those ranges, never the raster.
// --------------------------------------------------------------------------- //
async function extractFromTiff(reader, head) {
  const little = head[0] === 0x49   // 'I' → little-endian
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const ifdOff = hv.getUint32(4, little)
  if (ifdOff < 8 || ifdOff + 2 > reader.size) return null

  const cntBuf = await reader.read(ifdOff, ifdOff + 2)
  if (cntBuf.length < 2) return null
  const count = new DataView(cntBuf.buffer, cntBuf.byteOffset, 2).getUint16(0, little)
  if (count === 0 || count > 0xffff) return null

  const entriesLen = count * 12                       // each IFD entry is 12 bytes
  const entries = await reader.read(ifdOff + 2, ifdOff + 2 + entriesLen)
  if (entries.length < entriesLen) return null
  const ev = new DataView(entries.buffer, entries.byteOffset, entries.byteLength)

  for (let i = 0; i < count; i++) {
    const e = i * 12
    if (ev.getUint16(e, little) !== TIFF_TAG_ICC) continue
    const type = ev.getUint16(e + 2, little)
    const elemSize = TIFF_TYPE_SIZE[type]
    if (!elemSize) return null                        // unexpected field type for an ICC blob
    const len = ev.getUint32(e + 4, little) * elemSize
    if (len < 128 || len > MAX_EMBEDDED_ICC_BYTES) return null   // <128 can't hold a header
    // len ≥ 128 always exceeds the 4-byte inline value field, so it's an offset.
    const dataOff = ev.getUint32(e + 8, little)
    if (dataOff + len > reader.size) return null      // blob would run past EOF
    const prof = await reader.read(dataOff, dataOff + len)
    return prof.length === len ? prof : null
  }
  return null
}

// --------------------------------------------------------------------------- //
// PNG — walk chunks from the front until iCCP (extract) or IDAT/IEND (stop, no
// profile). Chunk layout: [uint32 len BE][4-byte type][len bytes][uint32 CRC].
// iCCP data: profile-name (1..79 bytes, NUL-terminated) + 1 byte method (0=zlib)
// + zlib-compressed profile. We read only chunk HEADERS (8 bytes) until we reach
// iCCP, then just its data — never the (large) IDAT pixel chunks.
// --------------------------------------------------------------------------- //
async function extractFromPng(reader) {
  let p = 8                                           // just past the signature
  for (let step = 0; step < MAX_STEPS && p + 8 <= reader.size; step++) {
    const hdr = await reader.read(p, p + 8)
    if (hdr.length < 8) break
    const len = new DataView(hdr.buffer, hdr.byteOffset, 8).getUint32(0)   // big-endian
    const [t0, t1, t2, t3] = [hdr[4], hdr[5], hdr[6], hdr[7]]
    const isIccp = t0 === 0x69 && t1 === 0x43 && t2 === 0x43 && t3 === 0x50   // 'iCCP'
    const isIdat = t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54   // 'IDAT'
    const isIend = t0 === 0x49 && t1 === 0x45 && t2 === 0x4e && t3 === 0x44   // 'IEND'
    if (isIccp) {
      // Cap the declared iCCP length (compressed profile + tiny name/method) so a
      // crafted header can't request an enormous read before inflation.
      if (len === 0 || len > MAX_EMBEDDED_ICC_BYTES + 1024 || p + 8 + len > reader.size) return null
      const data = await reader.read(p + 8, p + 8 + len)
      if (data.length < len) return null
      let q = 0
      const nameEnd = Math.min(data.length, 80)       // iCCP name is ≤79 bytes + NUL
      while (q < nameEnd && data[q] !== 0x00) q++
      if (q + 1 >= data.length) return null            // no NUL / no method byte
      if (data[q + 1] !== 0) return null               // only compression method 0 (zlib)
      return await inflateCapped(data.subarray(q + 2))
    }
    if (isIdat || isIend) break                        // pixel data / end — no profile
    p = p + 8 + len + 4                                // advance past data + CRC
  }
  return null
}

// Inflate a zlib stream with a hard output cap (decompression-bomb guard) using
// the platform DecompressionStream('deflate') — 'deflate' is the zlib-wrapped
// format PNG iCCP uses (NOT raw 'deflate-raw'). We abort the moment the running
// total would exceed the cap. Unavailable API (very old engine) → null.
async function inflateCapped(compressed) {
  if (typeof DecompressionStream !== 'function') return null
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  writer.write(compressed).catch(() => {})            // drained concurrently below
  writer.close().catch(() => {})
  const rdr = ds.readable.getReader()
  const parts = []
  let total = 0
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await rdr.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_EMBEDDED_ICC_BYTES) { try { await rdr.cancel() } catch { /* ignore */ } ; return null }
      parts.push(value)
    }
  } catch {
    return null                                        // corrupt/truncated deflate stream
  }
  if (total < 128) return null                         // too small for a profile header
  const out = new Uint8Array(total)
  let o = 0
  for (const part of parts) { out.set(part, o); o += part.byteLength }
  return out
}

// --------------------------------------------------------------------------- //
// JPEG — scan marker segments for APP2 (FF E2) blocks carrying "ICC_PROFILE".
// A profile larger than one marker's ~64 KB payload is split; each APP2 payload
// is "ICC_PROFILE\0" + [1-byte seq (1-based)] + [1-byte count] + chunk data, and
// we concatenate by sequence. Markers (and the ICC APP2s) precede SOS, so we walk
// only the front metadata and never read the entropy-coded scan (the bulk).
// --------------------------------------------------------------------------- //
const JPEG_ICC_ID = [0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00]  // "ICC_PROFILE\0"

async function extractFromJpeg(reader) {
  const size = reader.size
  let p = 2                                            // just past SOI (FF D8)
  const chunks = []                                    // chunks[seq] = Uint8Array
  let expectedCount = 0
  let haveCount = 0
  for (let step = 0; step < MAX_STEPS && p + 2 <= size; step++) {
    const mh = await reader.read(p, p + 4)             // marker + (maybe) length
    if (mh.length < 2) break
    if (mh[0] !== 0xff) { p++; continue }              // resync to the next marker byte
    const marker = mh[1]
    if (marker === 0xda || marker === 0xd9) break      // SOS (scan follows) / EOI
    // Standalone markers with no length payload: TEM, RSTn, padding FF.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { p += 2; continue }
    if (mh.length < 4) break
    const segLen = (mh[2] << 8) | mh[3]                // includes these 2 length bytes
    const segStart = p + 2
    if (segLen < 2 || segStart + segLen > size) break
    if (marker === 0xe2) {                             // APP2
      const payOff = segStart + 2
      const payLen = segLen - 2
      if (payLen >= JPEG_ICC_ID.length + 2) {
        const payload = await reader.read(payOff, payOff + payLen)
        if (payload.length >= JPEG_ICC_ID.length + 2 && matchAt(payload, 0, JPEG_ICC_ID)) {
          const seq = payload[12]                      // 1-based chunk index
          const cnt = payload[13]                      // total chunk count
          if (seq >= 1 && cnt >= 1 && seq <= cnt) {
            if (!expectedCount) expectedCount = cnt
            if (cnt === expectedCount && !chunks[seq]) {
              chunks[seq] = payload.subarray(14)       // view into this fresh payload buffer
              if (++haveCount === expectedCount) break // got every chunk — stop early
            }
          }
        }
      }
    }
    p = segStart + segLen                              // advance to the next marker
  }
  if (!expectedCount) return null
  // Every chunk 1..count must be present, or the profile is incomplete.
  let total = 0
  for (let s = 1; s <= expectedCount; s++) {
    if (!chunks[s]) return null
    total += chunks[s].byteLength
  }
  if (total < 128 || total > MAX_EMBEDDED_ICC_BYTES) return null
  const out = new Uint8Array(total)
  let o = 0
  for (let s = 1; s <= expectedCount; s++) { out.set(chunks[s], o); o += chunks[s].byteLength }
  return out
}

// True iff `pat` occurs in `bytes` starting exactly at `off`.
function matchAt(bytes, off, pat) {
  if (off + pat.length > bytes.length) return false
  for (let i = 0; i < pat.length; i++) if (bytes[off + i] !== pat[i]) return false
  return true
}
