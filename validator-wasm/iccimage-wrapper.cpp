// (c) 2026 William Li
/**
 * iccimage WASM wrapper — canonical image codecs (libtiff + libpng + libjpeg)
 * compiled to WASM, replacing profiletool's hand-rolled JS image reader/writers
 * (lib/imageIO.js) and the JS embedded-profile parsers (lib/embeddedProfile.js).
 * Reference: ~/code/tiffview/tiff-wasm.
 *
 * Exports (embind) — TIFF/PNG/JPEG, format auto-detected by magic bytes:
 *   findProfile(Uint8Array bytes)            → Uint8Array | null   (embedded ICC, in-mem)
 *   findProfileStream(int sourceId)          → Uint8Array | null   (embedded ICC, STREAMING
 *                                              via globalThis.__imgRead — reads only the
 *                                              metadata region, never the pixels)
 *   decodeImage(Uint8Array bytes)            → { ok, width, height, channels,
 *                                                bitDepth, photometric, samples,
 *                                                profile? } | { ok:false, error }
 *   encodeImage(format, w,h,channels,bits,photometric,samplesBytes,profileBytes,quality)
 *                                            → Uint8Array   (format = "tiff"|"png"|"jpeg")
 *
 * TIFF goes through MEMFS (TIFFOpen on a temp path — simplest libtiff hook); PNG uses
 * libpng's memory read/write callbacks; JPEG uses libjpeg's jpeg_mem_src/jpeg_mem_dest.
 * All entry points are bytes-in / bytes-out and independently bound (kMaxImageBytes cap).
 */
#include <tiffio.h>
#include <png.h>
#include <csetjmp>
extern "C" {
#include <jpeglib.h>
}

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

// ── streaming ranged reads (metadata-only extraction, never the pixels) ──────
// For INSPECTION / profile EXTRACTION we must NOT load the whole image — libtiff/
// libpng/libjpeg only need the header/IFD/markers, which sit at the front (PNG/JPEG)
// or are reached by a seek (TIFF). The JS side (a Web Worker) installs a SYNCHRONOUS
// ranged reader over the source File (FileReaderSync) as globalThis.__imgRead /
// __imgSize; these EM_JS shims bridge the C read callbacks to it. Mirrors tiffview's
// __tvRead/__tvSize. (Full decode still stages the whole image via decodeImage — that
// path is only used when we actually consume pixels.)
EM_JS(int, img_js_read, (int id, double offset, int dst, int size), {
  const u8 = globalThis.__imgRead ? globalThis.__imgRead(id, offset, size) : null;
  if (!u8) return -1;
  HEAPU8.set(u8, dst);
  return u8.length;
});
EM_JS(double, img_js_size, (int id), {
  return globalThis.__imgSize ? globalThis.__imgSize(id) : -1;
});

namespace {

using std::size_t;
using Bytes = std::vector<std::uint8_t>;

// Independent input cap (mirrors kMaxIccBytes / MAX_ICC_BYTES). Images can be large,
// but a hostile buffer shouldn't blow the heap before we allocate.
constexpr size_t kMaxImageBytes = 512ULL * 1024 * 1024;

// ── val <-> C++ byte helpers ────────────────────────────────────────────────
Bytes toBytes(const emscripten::val& v) {
  return emscripten::convertJSArrayToNumberVector<std::uint8_t>(v);
}
emscripten::val makeUint8Array(const std::uint8_t* data, size_t size) {
  emscripten::val u8 = emscripten::val::global("Uint8Array").new_(size);
  u8.call<void>("set", emscripten::val(emscripten::typed_memory_view(size, data)));
  return u8;
}

// ── MEMFS temp files (TIFF I/O) ─────────────────────────────────────────────
std::string uniqueMemfsPath(const char* prefix, const char* ext) {
  static std::atomic<std::uint64_t> counter{0};
  char buf[64];
  std::snprintf(buf, sizeof(buf), "/tmp/iccimg_%s_%llu.%s", prefix,
                (unsigned long long)counter.fetch_add(1), ext);
  return std::string(buf);
}
bool writeFile(const char* path, const void* data, size_t size) {
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  bool ok = size == 0 || std::fwrite(data, 1, size, f) == size;
  std::fclose(f);
  return ok;
}
bool readFile(const char* path, Bytes& out) {
  FILE* f = std::fopen(path, "rb");
  if (!f) return false;
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  if (n < 0) { std::fclose(f); return false; }
  std::fseek(f, 0, SEEK_SET);
  out.resize((size_t)n);
  bool ok = out.empty() || std::fread(out.data(), 1, out.size(), f) == out.size();
  std::fclose(f);
  return ok;
}
struct MemfsTemp {
  std::vector<std::string> paths;
  const std::string& add(const std::string& p) { paths.push_back(p); return paths.back(); }
  ~MemfsTemp() { for (auto& p : paths) std::remove(p.c_str()); }
};

// Silence libtiff's default stderr warning/error handlers (we surface our own).
void quietTiff() {
  TIFFSetWarningHandler(nullptr);
  TIFFSetErrorHandler(nullptr);
}

// ── format detection by magic ───────────────────────────────────────────────
enum class Fmt { Unknown, Tiff, Png, Jpeg };
Fmt detectFormat(const Bytes& b) {
  if (b.size() >= 4 && ((b[0] == 'I' && b[1] == 'I' && b[2] == 42 && b[3] == 0) ||
                        (b[0] == 'M' && b[1] == 'M' && b[2] == 0 && b[3] == 42)))
    return Fmt::Tiff;
  if (b.size() >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G')
    return Fmt::Png;
  if (b.size() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF)
    return Fmt::Jpeg;
  return Fmt::Unknown;
}

// ── embedded ICC extraction, per format ─────────────────────────────────────
Bytes tiffProfile(const Bytes& b) {
  MemfsTemp tmp;
  const std::string path = tmp.add(uniqueMemfsPath("prof", "tif"));
  if (!writeFile(path.c_str(), b.data(), b.size())) return {};
  TIFF* t = TIFFOpen(path.c_str(), "r");
  if (!t) return {};
  Bytes out;
  std::uint32_t len = 0; void* data = nullptr;
  if (TIFFGetField(t, TIFFTAG_ICCPROFILE, &len, &data) && data && len)
    out.assign((std::uint8_t*)data, (std::uint8_t*)data + len);
  TIFFClose(t);
  return out;
}

struct PngMemSrc { const std::uint8_t* p; size_t len, off; };
void pngReadFn(png_structp png, png_bytep out, png_size_t n) {
  PngMemSrc* s = (PngMemSrc*)png_get_io_ptr(png);
  size_t k = (s->off + n <= s->len) ? n : (s->len - s->off);
  std::memcpy(out, s->p + s->off, k);
  s->off += k;
}
struct PngMemDst { Bytes* out; };
void pngWriteFn(png_structp png, png_bytep data, png_size_t n) {
  Bytes* o = ((PngMemDst*)png_get_io_ptr(png))->out;
  o->insert(o->end(), data, data + n);
}
void pngFlushFn(png_structp) {}
Bytes pngProfile(const Bytes& b) {
  if (b.size() < 8 || png_sig_cmp(b.data(), 0, 8)) return {};
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) return {};
  png_infop info = png_create_info_struct(png);
  if (!info) { png_destroy_read_struct(&png, nullptr, nullptr); return {}; }
  Bytes out;
  if (setjmp(png_jmpbuf(png))) { png_destroy_read_struct(&png, &info, nullptr); return out; }
  PngMemSrc src{ b.data(), b.size(), 0 };
  png_set_read_fn(png, &src, pngReadFn);
  png_read_info(png, info);
  png_charp name = nullptr; int comp = 0; png_bytep prof = nullptr; png_uint_32 plen = 0;
  if (png_get_iCCP(png, info, &name, &comp, &prof, &plen) == PNG_INFO_iCCP && prof && plen)
    out.assign(prof, prof + plen);
  png_destroy_read_struct(&png, &info, nullptr);
  return out;
}

// libjpeg error manager with longjmp (default error_exit aborts the process).
struct JpegErr { struct jpeg_error_mgr pub; std::jmp_buf jmp; };
void jpegErrorExit(j_common_ptr c) { std::longjmp(((JpegErr*)c->err)->jmp, 1); }
void jpegEmit(j_common_ptr, int) {}   // swallow warnings

// Reassemble the ICC profile from a decompressor's saved APP2 markers ("ICC_PROFILE\0"
// (12) + seqNo(1) + numMarkers(1) + chunk), in sequence order (mirrors iccjpeg.c).
// Requires jpeg_save_markers(APP2) + jpeg_read_header before calling.
Bytes reassembleJpegIcc(jpeg_decompress_struct& cinfo) {
  static const char kSig[12] = { 'I','C','C','_','P','R','O','F','I','L','E','\0' };
  Bytes out;
  int numMarkers = 0;
  Bytes chunks[256]; bool seen[256] = { false };
  for (jpeg_saved_marker_ptr m = cinfo.marker_list; m; m = m->next) {
    if (m->marker == JPEG_APP0 + 2 && m->data_length >= 14 &&
        std::memcmp(m->data, kSig, 12) == 0) {
      int seq = m->data[12], num = m->data[13];
      if (seq >= 1 && seq <= 255 && num >= 1) {
        if (numMarkers == 0) numMarkers = num;
        if (num == numMarkers && !seen[seq]) {
          seen[seq] = true;
          chunks[seq].assign(m->data + 14, m->data + m->data_length);
        }
      }
    }
  }
  if (numMarkers > 0) {
    bool complete = true;
    for (int i = 1; i <= numMarkers; ++i) if (!seen[i]) { complete = false; break; }
    if (complete) for (int i = 1; i <= numMarkers; ++i)
      out.insert(out.end(), chunks[i].begin(), chunks[i].end());
  }
  return out;
}

Bytes jpegProfile(const Bytes& b) {
  struct jpeg_decompress_struct cinfo;
  JpegErr jerr;
  cinfo.err = jpeg_std_error(&jerr.pub);
  jerr.pub.error_exit = jpegErrorExit;
  jerr.pub.emit_message = jpegEmit;
  Bytes out;
  if (setjmp(jerr.jmp)) { jpeg_destroy_decompress(&cinfo); return out; }
  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, b.data(), b.size());
  jpeg_save_markers(&cinfo, JPEG_APP0 + 2, 0xFFFF);   // APP2 = ICC
  jpeg_read_header(&cinfo, TRUE);
  out = reassembleJpegIcc(cinfo);
  jpeg_destroy_decompress(&cinfo);
  return out;
}

// Chunk an ICC profile into APP2 markers for JPEG embedding (write side of the above).
void writeIccApp2(jpeg_compress_struct& cinfo, const Bytes& icc) {
  if (icc.empty()) return;
  const size_t kMax = 65519;   // 65533 marker max − 14-byte "ICC_PROFILE\0"+seq+count
  size_t num = (icc.size() + kMax - 1) / kMax;
  if (num == 0 || num > 255) return;
  for (size_t i = 0; i < num; ++i) {
    const size_t off = i * kMax, len = std::min(kMax, icc.size() - off);
    std::vector<JOCTET> m(14 + len);
    std::memcpy(m.data(), "ICC_PROFILE\0", 12);
    m[12] = (JOCTET)(i + 1); m[13] = (JOCTET)num;
    std::memcpy(m.data() + 14, icc.data() + off, len);
    jpeg_write_marker(&cinfo, JPEG_APP0 + 2, m.data(), (unsigned)m.size());
  }
}

Bytes findProfileImpl(const Bytes& b) {
  if (b.empty() || b.size() > kMaxImageBytes) return {};
  switch (detectFormat(b)) {
    case Fmt::Tiff: return tiffProfile(b);
    case Fmt::Png:  return pngProfile(b);
    case Fmt::Jpeg: return jpegProfile(b);
    default:        return {};
  }
}

// ── STREAMING extraction — reads only the metadata region, never the pixels ──
// On-demand ranged reader over a JS-backed source (a File read via FileReaderSync in
// a worker). A small read-ahead buffer collapses the libraries' many small sequential
// reads into a few JS reads. `pos`/offsets are doubles so files > 2 GB work.
struct Reader {
  int id = 0;
  double pos = 0;
  double total = -1;
  std::vector<std::uint8_t> chunk;
  double chunkStart = 0;
  std::size_t chunkLen = 0;

  std::size_t read(void* dst, std::size_t n) {
    static const std::size_t kChunk = 256 * 1024;
    std::uint8_t* out = (std::uint8_t*)dst;
    std::size_t done = 0;
    while (n > 0) {
      const bool inBuf = chunkLen > 0 && pos >= chunkStart && pos < chunkStart + (double)chunkLen;
      if (!inBuf) {
        std::size_t want = n > kChunk ? n : kChunk;
        if (chunk.size() < want) chunk.resize(want);
        int got = img_js_read(id, pos, (int)(std::intptr_t)chunk.data(), (int)want);
        if (got <= 0) break;
        chunkStart = pos; chunkLen = (std::size_t)got;
      }
      const std::size_t off = (std::size_t)(pos - chunkStart);
      const std::size_t avail = chunkLen - off;
      const std::size_t k = n < avail ? n : avail;
      std::memcpy(out, chunk.data() + off, k);
      out += k; pos += (double)k; done += k; n -= k;
    }
    return done;
  }
  void seek(double p) { pos = p; }
  double sizeOf() { if (total < 0) total = img_js_size(id); return total; }
};

// libtiff client I/O over a Reader → TIFFGetField(ICCPROFILE) reads header+IFD+tag only.
tmsize_t rcRead(thandle_t h, void* d, tmsize_t s) { return (tmsize_t)((Reader*)h)->read(d, (std::size_t)s); }
tmsize_t rcWrite(thandle_t, void*, tmsize_t) { return 0; }
toff_t rcSeek(thandle_t h, toff_t off, int whence) {
  Reader* r = (Reader*)h;
  const double np = whence == SEEK_CUR ? r->pos + (double)off
                  : whence == SEEK_END ? r->sizeOf() + (double)off : (double)off;
  r->seek(np);
  return (toff_t)r->pos;
}
int rcClose(thandle_t) { return 0; }
toff_t rcSize(thandle_t h) { return (toff_t)((Reader*)h)->sizeOf(); }
int rcMap(thandle_t, void**, toff_t*) { return 0; }
void rcUnmap(thandle_t, void*, toff_t) {}

Bytes tiffProfileStream(Reader& r) {
  r.seek(0);
  TIFF* t = TIFFClientOpen("s", "r", (thandle_t)&r, rcRead, rcWrite, rcSeek, rcClose, rcSize, rcMap, rcUnmap);
  if (!t) return {};
  Bytes out;
  std::uint32_t len = 0; void* data = nullptr;
  if (TIFFGetField(t, TIFFTAG_ICCPROFILE, &len, &data) && data && len)
    out.assign((std::uint8_t*)data, (std::uint8_t*)data + len);
  TIFFClose(t);
  return out;
}

// PNG streaming read fn → png_read_info reads only the pre-IDAT chunks (iCCP among them).
void pngStreamRead(png_structp png, png_bytep out, png_size_t n) {
  Reader* r = (Reader*)png_get_io_ptr(png);
  if (r->read(out, n) != n) png_error(png, "short read");
}
Bytes pngProfileStream(Reader& r) {
  r.seek(0);
  std::uint8_t sig[8];
  if (r.read(sig, 8) != 8 || png_sig_cmp(sig, 0, 8)) return {};
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) return {};
  png_infop info = png_create_info_struct(png);
  if (!info) { png_destroy_read_struct(&png, nullptr, nullptr); return {}; }
  Bytes out;
  if (setjmp(png_jmpbuf(png))) { png_destroy_read_struct(&png, &info, nullptr); return out; }
  png_set_read_fn(png, &r, pngStreamRead);
  png_set_sig_bytes(png, 8);   // the 8 signature bytes were already consumed
  png_read_info(png, info);
  png_charp nm = nullptr; int cp = 0; png_bytep pr = nullptr; png_uint_32 pl = 0;
  if (png_get_iCCP(png, info, &nm, &cp, &pr, &pl) == PNG_INFO_iCCP && pr && pl)
    out.assign(pr, pr + pl);
  png_destroy_read_struct(&png, &info, nullptr);
  return out;
}

// JPEG streaming source manager → jpeg_read_header reads only up to SOS (the markers).
struct StreamSrc { struct jpeg_source_mgr pub; Reader* r; JOCTET buf[16384]; };
void jsmInit(j_decompress_ptr) {}
boolean jsmFill(j_decompress_ptr cinfo) {
  StreamSrc* s = (StreamSrc*)cinfo->src;
  std::size_t n = s->r->read(s->buf, sizeof(s->buf));
  if (n == 0) { s->buf[0] = (JOCTET)0xFF; s->buf[1] = (JOCTET)JPEG_EOI; n = 2; }   // fake EOI at EOF
  s->pub.next_input_byte = s->buf;
  s->pub.bytes_in_buffer = n;
  return TRUE;
}
void jsmSkip(j_decompress_ptr cinfo, long num) {
  if (num <= 0) return;
  StreamSrc* s = (StreamSrc*)cinfo->src;
  while (num > (long)s->pub.bytes_in_buffer) { num -= (long)s->pub.bytes_in_buffer; jsmFill(cinfo); }
  s->pub.next_input_byte += num;
  s->pub.bytes_in_buffer -= (std::size_t)num;
}
void jsmTerm(j_decompress_ptr) {}
Bytes jpegProfileStream(Reader& r) {
  r.seek(0);
  struct jpeg_decompress_struct cinfo; JpegErr jerr;
  cinfo.err = jpeg_std_error(&jerr.pub); jerr.pub.error_exit = jpegErrorExit; jerr.pub.emit_message = jpegEmit;
  Bytes out;
  StreamSrc src;
  if (setjmp(jerr.jmp)) { jpeg_destroy_decompress(&cinfo); return out; }
  jpeg_create_decompress(&cinfo);
  src.pub.init_source = jsmInit;
  src.pub.fill_input_buffer = jsmFill;
  src.pub.skip_input_data = jsmSkip;
  src.pub.resync_to_restart = jpeg_resync_to_restart;
  src.pub.term_source = jsmTerm;
  src.pub.bytes_in_buffer = 0;
  src.pub.next_input_byte = nullptr;
  src.r = &r;
  cinfo.src = (struct jpeg_source_mgr*)&src;
  jpeg_save_markers(&cinfo, JPEG_APP0 + 2, 0xFFFF);
  jpeg_read_header(&cinfo, TRUE);
  out = reassembleJpegIcc(cinfo);
  jpeg_destroy_decompress(&cinfo);
  return out;
}

Bytes findProfileStreamImpl(int id) {
  Reader r; r.id = id;
  std::uint8_t magic[8];
  r.seek(0);
  const std::size_t got = r.read(magic, sizeof(magic));
  const Bytes head(magic, magic + got);
  switch (detectFormat(head)) {
    case Fmt::Tiff: return tiffProfileStream(r);
    case Fmt::Png:  return pngProfileStream(r);
    case Fmt::Jpeg: return jpegProfileStream(r);
    default:        return {};
  }
}

// ── STREAMING probe — geometry + colour space from the HEADER only (no pixels) ──
// Validates an image and reports { ok, width, height, channels, bitDepth, photometric }
// reading only the header/IFD/SOF via the same ranged reader, so a huge image can be
// accepted/rejected (type + dimensions) without loading its raster. `channels` is the
// count decodeImage would PRODUCE (alpha stripped, palette expanded), so the caller can
// match it against the chain's source-channel count.
emscripten::val probeTiffStream(Reader& r) {
  emscripten::val res = emscripten::val::object();
  r.seek(0);
  TIFF* t = TIFFClientOpen("p", "r", (thandle_t)&r, rcRead, rcWrite, rcSeek, rcClose, rcSize, rcMap, rcUnmap);
  if (!t) { res.set("ok", false); res.set("error", std::string("Not a readable TIFF.")); return res; }
  std::uint32_t w = 0, h = 0; std::uint16_t spp = 1, bps = 8, photo = 1;
  TIFFGetField(t, TIFFTAG_IMAGEWIDTH, &w);
  TIFFGetField(t, TIFFTAG_IMAGELENGTH, &h);
  TIFFGetFieldDefaulted(t, TIFFTAG_SAMPLESPERPIXEL, &spp);
  TIFFGetFieldDefaulted(t, TIFFTAG_BITSPERSAMPLE, &bps);
  TIFFGetFieldDefaulted(t, TIFFTAG_PHOTOMETRIC, &photo);
  TIFFClose(t);
  res.set("ok", true); res.set("width", (int)w); res.set("height", (int)h);
  res.set("channels", (int)spp); res.set("bitDepth", (int)bps); res.set("photometric", (int)photo);
  return res;
}
emscripten::val probePngStream(Reader& r) {
  emscripten::val res = emscripten::val::object();
  r.seek(0);
  std::uint8_t sig[8];
  if (r.read(sig, 8) != 8 || png_sig_cmp(sig, 0, 8)) { res.set("ok", false); res.set("error", std::string("Not a PNG.")); return res; }
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) { res.set("ok", false); res.set("error", std::string("libpng init failed.")); return res; }
  png_infop info = png_create_info_struct(png);
  if (!info) { png_destroy_read_struct(&png, nullptr, nullptr); res.set("ok", false); res.set("error", std::string("libpng init failed.")); return res; }
  if (setjmp(png_jmpbuf(png))) { png_destroy_read_struct(&png, &info, nullptr); res.set("ok", false); res.set("error", std::string("PNG header read failed.")); return res; }
  png_set_read_fn(png, &r, pngStreamRead);
  png_set_sig_bytes(png, 8);
  png_read_info(png, info);
  png_uint_32 w = 0, h = 0; int bd = 8, ct = 0;
  png_get_IHDR(png, info, &w, &h, &bd, &ct, nullptr, nullptr, nullptr);
  png_destroy_read_struct(&png, &info, nullptr);
  int ch;   // channels decodePng produces (alpha stripped, palette → RGB)
  switch (ct) {
    case PNG_COLOR_TYPE_GRAY:       ch = 1; break;
    case PNG_COLOR_TYPE_GRAY_ALPHA: ch = 1; break;
    case PNG_COLOR_TYPE_PALETTE:    ch = 3; break;
    case PNG_COLOR_TYPE_RGB:        ch = 3; break;
    case PNG_COLOR_TYPE_RGB_ALPHA:  ch = 3; break;
    default:                        ch = 3; break;
  }
  res.set("ok", true); res.set("width", (int)w); res.set("height", (int)h);
  res.set("channels", ch); res.set("bitDepth", ct == PNG_COLOR_TYPE_GRAY && bd < 8 ? 8 : bd);
  res.set("photometric", ch >= 3 ? 2 : 1);
  return res;
}
emscripten::val probeJpegStream(Reader& r) {
  emscripten::val res = emscripten::val::object();
  r.seek(0);
  struct jpeg_decompress_struct cinfo; JpegErr jerr;
  cinfo.err = jpeg_std_error(&jerr.pub); jerr.pub.error_exit = jpegErrorExit; jerr.pub.emit_message = jpegEmit;
  if (setjmp(jerr.jmp)) { jpeg_destroy_decompress(&cinfo); res.set("ok", false); res.set("error", std::string("JPEG header read failed.")); return res; }
  jpeg_create_decompress(&cinfo);
  StreamSrc src;
  src.pub.init_source = jsmInit; src.pub.fill_input_buffer = jsmFill; src.pub.skip_input_data = jsmSkip;
  src.pub.resync_to_restart = jpeg_resync_to_restart; src.pub.term_source = jsmTerm;
  src.pub.bytes_in_buffer = 0; src.pub.next_input_byte = nullptr; src.r = &r;
  cinfo.src = (struct jpeg_source_mgr*)&src;
  jpeg_read_header(&cinfo, TRUE);
  const int w = cinfo.image_width, h = cinfo.image_height, ch = cinfo.num_components;
  const bool cmyk = (cinfo.jpeg_color_space == JCS_CMYK || cinfo.jpeg_color_space == JCS_YCCK);
  jpeg_destroy_decompress(&cinfo);
  res.set("ok", true); res.set("width", w); res.set("height", h);
  res.set("channels", ch); res.set("bitDepth", 8);
  res.set("photometric", cmyk ? 5 : (ch >= 3 ? 2 : 1));
  return res;
}
emscripten::val probeImageStreamImpl(int id) {
  Reader r; r.id = id;
  std::uint8_t magic[8]; r.seek(0);
  const std::size_t got = r.read(magic, sizeof(magic));
  const Bytes head(magic, magic + got);
  switch (detectFormat(head)) {
    case Fmt::Tiff: return probeTiffStream(r);
    case Fmt::Png:  return probePngStream(r);
    case Fmt::Jpeg: return probeJpegStream(r);
    default: {
      emscripten::val res = emscripten::val::object();
      res.set("ok", false); res.set("error", std::string("Unrecognised image format."));
      return res;
    }
  }
}

// ── TIFF decode → raw samples ───────────────────────────────────────────────
// Returns the image as contiguous, native-endian samples (8- or 16-bit) plus the
// embedded profile if present. Uses scanline reads; de-planarizes separate planes.
emscripten::val decodeTiff(const Bytes& b) {
  emscripten::val r = emscripten::val::object();
  MemfsTemp tmp;
  const std::string path = tmp.add(uniqueMemfsPath("dec", "tif"));
  if (!writeFile(path.c_str(), b.data(), b.size())) { r.set("ok", false); r.set("error", std::string("stage failed")); return r; }
  TIFF* t = TIFFOpen(path.c_str(), "r");
  if (!t) { r.set("ok", false); r.set("error", std::string("Not a readable TIFF.")); return r; }

  std::uint32_t w = 0, h = 0;
  std::uint16_t spp = 1, bps = 8, photo = 1, planar = PLANARCONFIG_CONTIG, fmt = SAMPLEFORMAT_UINT;
  TIFFGetField(t, TIFFTAG_IMAGEWIDTH, &w);
  TIFFGetField(t, TIFFTAG_IMAGELENGTH, &h);
  TIFFGetFieldDefaulted(t, TIFFTAG_SAMPLESPERPIXEL, &spp);
  TIFFGetFieldDefaulted(t, TIFFTAG_BITSPERSAMPLE, &bps);
  TIFFGetFieldDefaulted(t, TIFFTAG_PHOTOMETRIC, &photo);
  TIFFGetFieldDefaulted(t, TIFFTAG_PLANARCONFIG, &planar);
  TIFFGetFieldDefaulted(t, TIFFTAG_SAMPLEFORMAT, &fmt);

  if (!w || !h || !spp || (bps != 8 && bps != 16)) {
    TIFFClose(t); r.set("ok", false);
    r.set("error", std::string("Unsupported TIFF (only 8/16-bit integer supported)."));
    return r;
  }
  const size_t bytesPerSample = bps / 8;
  const size_t rowBytes = (size_t)w * spp * bytesPerSample;
  if ((std::uint64_t)h * rowBytes > kMaxImageBytes) {
    TIFFClose(t); r.set("ok", false); r.set("error", std::string("TIFF too large to decode.")); return r;
  }
  Bytes samples((size_t)h * rowBytes);
  bool ok = true;
  if (planar == PLANARCONFIG_CONTIG) {
    for (std::uint32_t row = 0; row < h && ok; ++row)
      ok = TIFFReadScanline(t, samples.data() + (size_t)row * rowBytes, row) >= 0;
  } else {
    // Separate planes → interleave into contiguous samples.
    Bytes plane((size_t)w * bytesPerSample);
    for (std::uint16_t s = 0; s < spp && ok; ++s)
      for (std::uint32_t row = 0; row < h && ok; ++row) {
        ok = TIFFReadScanline(t, plane.data(), row, s) >= 0;
        if (!ok) break;
        std::uint8_t* dst = samples.data() + (size_t)row * rowBytes + (size_t)s * bytesPerSample;
        const std::uint8_t* src = plane.data();
        for (std::uint32_t x = 0; x < w; ++x) {
          std::memcpy(dst, src, bytesPerSample);
          dst += (size_t)spp * bytesPerSample; src += bytesPerSample;
        }
      }
  }
  if (!ok) { TIFFClose(t); r.set("ok", false); r.set("error", std::string("Failed reading TIFF scanlines.")); return r; }

  std::uint32_t iccLen = 0; void* iccData = nullptr;
  Bytes profile;
  if (TIFFGetField(t, TIFFTAG_ICCPROFILE, &iccLen, &iccData) && iccData && iccLen)
    profile.assign((std::uint8_t*)iccData, (std::uint8_t*)iccData + iccLen);
  TIFFClose(t);

  r.set("ok", true);
  r.set("width", (int)w); r.set("height", (int)h);
  r.set("channels", (int)spp); r.set("bitDepth", (int)bps);
  r.set("photometric", (int)photo);
  r.set("samples", makeUint8Array(samples.data(), samples.size()));
  if (!profile.empty()) r.set("profile", makeUint8Array(profile.data(), profile.size()));
  return r;
}

// PNG decode → native-endian 8/16-bit samples. Palette expands to RGB, sub-8-bit gray
// to 8, alpha is stripped (colour channels only, matching the apply model). Preserves
// the embedded iCCP profile.
emscripten::val decodePng(const Bytes& b) {
  emscripten::val r = emscripten::val::object();
  if (b.size() < 8 || png_sig_cmp(b.data(), 0, 8)) { r.set("ok", false); r.set("error", std::string("Not a PNG.")); return r; }
  png_structp png = png_create_read_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) { r.set("ok", false); r.set("error", std::string("libpng init failed.")); return r; }
  png_infop info = png_create_info_struct(png);
  if (!info) { png_destroy_read_struct(&png, nullptr, nullptr); r.set("ok", false); r.set("error", std::string("libpng init failed.")); return r; }
  Bytes samples, profile;
  if (setjmp(png_jmpbuf(png))) { png_destroy_read_struct(&png, &info, nullptr); r.set("ok", false); r.set("error", std::string("PNG decode failed.")); return r; }
  PngMemSrc src{ b.data(), b.size(), 0 };
  png_set_read_fn(png, &src, pngReadFn);
  png_read_info(png, info);
  png_uint_32 w = 0, h = 0; int bd = 8, ct = 0;
  png_get_IHDR(png, info, &w, &h, &bd, &ct, nullptr, nullptr, nullptr);
  { png_charp nm = nullptr; int cp = 0; png_bytep pr = nullptr; png_uint_32 pl = 0;
    if (png_get_iCCP(png, info, &nm, &cp, &pr, &pl) == PNG_INFO_iCCP && pr && pl) profile.assign(pr, pr + pl); }
  if (ct == PNG_COLOR_TYPE_PALETTE) png_set_palette_to_rgb(png);
  if (ct == PNG_COLOR_TYPE_GRAY && bd < 8) png_set_expand_gray_1_2_4_to_8(png);
  png_set_strip_alpha(png);
  if (bd == 16) png_set_swap(png);   // PNG is big-endian; deliver native LE
  png_read_update_info(png, info);
  const int bits = png_get_bit_depth(png, info);
  const int channels = png_get_channels(png, info);
  const size_t rowBytes = png_get_rowbytes(png, info);
  if ((std::uint64_t)h * rowBytes > kMaxImageBytes) { png_destroy_read_struct(&png, &info, nullptr); r.set("ok", false); r.set("error", std::string("PNG too large.")); return r; }
  samples.resize((size_t)h * rowBytes);
  std::vector<png_bytep> rows(h);
  for (png_uint_32 y = 0; y < h; ++y) rows[y] = samples.data() + (size_t)y * rowBytes;
  png_read_image(png, rows.data());
  png_destroy_read_struct(&png, &info, nullptr);
  r.set("ok", true); r.set("width", (int)w); r.set("height", (int)h);
  r.set("channels", channels); r.set("bitDepth", bits);
  r.set("photometric", channels >= 3 ? 2 : 1);
  r.set("samples", makeUint8Array(samples.data(), samples.size()));
  if (!profile.empty()) r.set("profile", makeUint8Array(profile.data(), profile.size()));
  return r;
}

// JPEG decode → 8-bit samples (libjpeg is 8-bit). RGB/Gray native; CMYK/YCCK gives 4
// channels (Adobe files are inverted → un-invert). Preserves the APP2 ICC profile.
emscripten::val decodeJpeg(const Bytes& b) {
  emscripten::val r = emscripten::val::object();
  struct jpeg_decompress_struct cinfo; JpegErr jerr;
  cinfo.err = jpeg_std_error(&jerr.pub); jerr.pub.error_exit = jpegErrorExit; jerr.pub.emit_message = jpegEmit;
  Bytes samples, profile;
  if (setjmp(jerr.jmp)) { jpeg_destroy_decompress(&cinfo); r.set("ok", false); r.set("error", std::string("JPEG decode failed.")); return r; }
  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, b.data(), b.size());
  jpeg_save_markers(&cinfo, JPEG_APP0 + 2, 0xFFFF);
  jpeg_read_header(&cinfo, TRUE);
  profile = reassembleJpegIcc(cinfo);
  jpeg_start_decompress(&cinfo);
  const int W = cinfo.output_width, H = cinfo.output_height, ch = cinfo.output_components;
  const bool cmyk = (cinfo.out_color_space == JCS_CMYK || cinfo.out_color_space == JCS_YCCK);
  const bool adobeInvert = cmyk && cinfo.saw_Adobe_marker;
  const size_t rowBytes = (size_t)W * ch;
  if ((std::uint64_t)H * rowBytes > kMaxImageBytes) { jpeg_destroy_decompress(&cinfo); r.set("ok", false); r.set("error", std::string("JPEG too large.")); return r; }
  samples.resize((size_t)H * rowBytes);
  while (cinfo.output_scanline < (JDIMENSION)H) {
    JSAMPROW row = samples.data() + (size_t)cinfo.output_scanline * rowBytes;
    jpeg_read_scanlines(&cinfo, &row, 1);
  }
  if (adobeInvert) for (auto& v : samples) v = (std::uint8_t)(255 - v);
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  r.set("ok", true); r.set("width", W); r.set("height", H);
  r.set("channels", ch); r.set("bitDepth", 8);
  r.set("photometric", cmyk ? 5 : (ch >= 3 ? 2 : 1));
  r.set("samples", makeUint8Array(samples.data(), samples.size()));
  if (!profile.empty()) r.set("profile", makeUint8Array(profile.data(), profile.size()));
  return r;
}

emscripten::val decodeImageImpl(const Bytes& b) {
  if (b.empty() || b.size() > kMaxImageBytes) {
    emscripten::val r = emscripten::val::object();
    r.set("ok", false); r.set("error", std::string("Empty or oversized image."));
    return r;
  }
  switch (detectFormat(b)) {
    case Fmt::Tiff: return decodeTiff(b);
    case Fmt::Png:  return decodePng(b);
    case Fmt::Jpeg: return decodeJpeg(b);
    default: {
      emscripten::val r = emscripten::val::object();
      r.set("ok", false); r.set("error", std::string("Unrecognised image format."));
      return r;
    }
  }
}

// ── encoders (each returns the container bytes, throws on failure) ──────────
// sampleFmt: 0 = unsigned integer (bits 8/16), 1 = IEEE float (bits 32) — the
//   iccApplyProfiles "float" destination encoding (G1).
// compression: 0 = none, 1 = LZW, 2 = ZIP/Adobe-Deflate (G2). zlib is linked
//   (-sUSE_ZLIB=1 + libtiff zlib ON), so DEFLATE is available; LZW is builtin.
// planar: 0 = contiguous (chunky), 1 = separate planes (G3).
Bytes encodeTiffBytes(int width, int height, int spp, int bits,
                      int photometric, const Bytes& samples, const Bytes& profile,
                      int sampleFmt, int compression, int planar) {
  const bool isFloat = (sampleFmt == 1);
  // Float TIFF is always 32-bit IEEE; integer TIFF stays 8/16-bit.
  if (width <= 0 || height <= 0 || spp <= 0 ||
      (isFloat ? bits != 32 : (bits != 8 && bits != 16)))
    throw std::runtime_error("Invalid TIFF parameters.");
  const size_t need = (size_t)width * height * spp * (bits / 8);
  if (samples.size() < need) throw std::runtime_error("Sample buffer too small for the given geometry.");

  MemfsTemp tmp;
  const std::string path = tmp.add(uniqueMemfsPath("enc", "tif"));
  TIFF* t = TIFFOpen(path.c_str(), "w");
  if (!t) throw std::runtime_error("Could not open the output TIFF.");

  // Map the compression selector to a libtiff codec (falling back to none for an
  // unknown value rather than failing the whole encode).
  std::uint16_t comp = COMPRESSION_NONE;
  if (compression == 1) comp = COMPRESSION_LZW;
  else if (compression == 2) comp = COMPRESSION_ADOBE_DEFLATE;   // ZIP

  TIFFSetField(t, TIFFTAG_IMAGEWIDTH, (std::uint32_t)width);
  TIFFSetField(t, TIFFTAG_IMAGELENGTH, (std::uint32_t)height);
  TIFFSetField(t, TIFFTAG_SAMPLESPERPIXEL, (std::uint16_t)spp);
  TIFFSetField(t, TIFFTAG_BITSPERSAMPLE, (std::uint16_t)bits);
  TIFFSetField(t, TIFFTAG_PHOTOMETRIC, (std::uint16_t)photometric);
  TIFFSetField(t, TIFFTAG_PLANARCONFIG,
               planar == 1 ? PLANARCONFIG_SEPARATE : PLANARCONFIG_CONTIG);
  TIFFSetField(t, TIFFTAG_ORIENTATION, ORIENTATION_TOPLEFT);
  TIFFSetField(t, TIFFTAG_SAMPLEFORMAT, isFloat ? SAMPLEFORMAT_IEEEFP : SAMPLEFORMAT_UINT);
  TIFFSetField(t, TIFFTAG_COMPRESSION, comp);
  TIFFSetField(t, TIFFTAG_ROWSPERSTRIP, TIFFDefaultStripSize(t, 0));
  // Photometric 5 (separated) with >4 inks, or minisblack with >1 sample, needs the
  // spec-required extra-sample count so readers accept the multichannel layout.
  const int base = (photometric == PHOTOMETRIC_SEPARATED) ? 4 : (photometric == PHOTOMETRIC_RGB ? 3 : 1);
  if (spp > base) {
    std::vector<std::uint16_t> extra(spp - base, EXTRASAMPLE_UNSPECIFIED);
    TIFFSetField(t, TIFFTAG_EXTRASAMPLES, (std::uint16_t)(spp - base), extra.data());
  }
  if (!profile.empty())
    TIFFSetField(t, TIFFTAG_ICCPROFILE, (std::uint32_t)profile.size(), profile.data());

  const size_t sampleBytes = (size_t)(bits / 8);
  bool ok = true;
  if (planar == 1) {
    // Separate planes: one plane per sample, de-interleaving the contiguous input on
    // the fly (libtiff wants each plane's scanlines written under its sample index).
    const size_t pxCount = (size_t)width * height;
    std::vector<std::uint8_t> planeRow((size_t)width * sampleBytes);
    for (int s = 0; s < spp && ok; ++s) {
      for (int row = 0; row < height && ok; ++row) {
        for (int x = 0; x < width; ++x) {
          const size_t srcOff = (((size_t)row * width + x) * spp + s) * sampleBytes;
          std::memcpy(planeRow.data() + (size_t)x * sampleBytes,
                      samples.data() + srcOff, sampleBytes);
        }
        ok = TIFFWriteScanline(t, planeRow.data(), row, (std::uint16_t)s) >= 0;
      }
    }
    (void)pxCount;
  } else {
    const size_t rowBytes = (size_t)width * spp * sampleBytes;
    for (int row = 0; row < height && ok; ++row)
      ok = TIFFWriteScanline(t, (void*)(samples.data() + (size_t)row * rowBytes), row, 0) >= 0;
  }
  TIFFClose(t);
  if (!ok) throw std::runtime_error("Failed writing TIFF scanlines.");

  Bytes out;
  if (!readFile(path.c_str(), out)) throw std::runtime_error("Could not read back the TIFF.");
  return out;
}

Bytes encodePngBytes(int width, int height, int channels, int bits,
                     const Bytes& samples, const Bytes& profile) {
  if (width <= 0 || height <= 0 || (bits != 8 && bits != 16) ||
      channels < 1 || channels > 4)
    throw std::runtime_error("Invalid PNG parameters.");
  if (samples.size() < (size_t)width * height * channels * (bits / 8))
    throw std::runtime_error("Sample buffer too small for the given geometry.");
  png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, nullptr, nullptr, nullptr);
  if (!png) throw std::runtime_error("libpng init failed.");
  png_infop info = png_create_info_struct(png);
  if (!info) { png_destroy_write_struct(&png, nullptr); throw std::runtime_error("libpng init failed."); }
  Bytes out; PngMemDst dst{ &out };
  if (setjmp(png_jmpbuf(png))) { png_destroy_write_struct(&png, &info); throw std::runtime_error("PNG encode failed."); }
  png_set_write_fn(png, &dst, pngWriteFn, pngFlushFn);
  const int ct = channels == 1 ? PNG_COLOR_TYPE_GRAY : channels == 2 ? PNG_COLOR_TYPE_GRAY_ALPHA
               : channels == 3 ? PNG_COLOR_TYPE_RGB : PNG_COLOR_TYPE_RGB_ALPHA;
  png_set_IHDR(png, info, (png_uint_32)width, (png_uint_32)height, bits, ct,
               PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
  if (!profile.empty())
    png_set_iCCP(png, info, "icc", 0, (png_const_bytep)profile.data(), (png_uint_32)profile.size());
  png_write_info(png, info);
  if (bits == 16) png_set_swap(png);   // native LE → PNG big-endian
  const size_t rowBytes = (size_t)width * channels * (bits / 8);
  std::vector<png_bytep> rows(height);
  for (int y = 0; y < height; ++y) rows[y] = (png_bytep)(samples.data() + (size_t)y * rowBytes);
  png_write_image(png, rows.data());
  png_write_end(png, nullptr);
  png_destroy_write_struct(&png, &info);
  return out;
}

Bytes encodeJpegBytes(int width, int height, int channels,
                      const Bytes& samples, int quality, const Bytes& profile) {
  if (width <= 0 || height <= 0 || (channels != 1 && channels != 3))
    throw std::runtime_error("JPEG supports 1 (gray) or 3 (RGB) channels.");
  if (samples.size() < (size_t)width * height * channels)
    throw std::runtime_error("Sample buffer too small for the given geometry.");
  struct jpeg_compress_struct cinfo; JpegErr jerr;
  cinfo.err = jpeg_std_error(&jerr.pub); jerr.pub.error_exit = jpegErrorExit; jerr.pub.emit_message = jpegEmit;
  unsigned char* outbuf = nullptr; unsigned long outsize = 0;
  Bytes out;
  if (setjmp(jerr.jmp)) { jpeg_destroy_compress(&cinfo); if (outbuf) free(outbuf); throw std::runtime_error("JPEG encode failed."); }
  jpeg_create_compress(&cinfo);
  jpeg_mem_dest(&cinfo, &outbuf, &outsize);
  cinfo.image_width = (JDIMENSION)width; cinfo.image_height = (JDIMENSION)height;
  cinfo.input_components = channels;
  cinfo.in_color_space = channels == 1 ? JCS_GRAYSCALE : JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, quality <= 0 ? 92 : (quality > 100 ? 100 : quality), TRUE);
  jpeg_start_compress(&cinfo, TRUE);
  writeIccApp2(cinfo, profile);
  const size_t rowBytes = (size_t)width * channels;
  while (cinfo.next_scanline < (JDIMENSION)height) {
    JSAMPROW row = (JSAMPROW)(samples.data() + (size_t)cinfo.next_scanline * rowBytes);
    jpeg_write_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_compress(&cinfo);
  out.assign(outbuf, outbuf + outsize);
  if (outbuf) free(outbuf);
  jpeg_destroy_compress(&cinfo);
  return out;
}

// ── embind boundaries ───────────────────────────────────────────────────────
emscripten::val findProfile(emscripten::val bytesVal) {
  Bytes prof = findProfileImpl(toBytes(bytesVal));
  if (prof.empty()) return emscripten::val::null();
  return makeUint8Array(prof.data(), prof.size());
}
// Streaming extractor: reads byte-ranges from a JS source (globalThis.__imgRead over
// a File) — only the metadata, never the raster. `sourceId` is passed through to the
// JS reader (single source per call → 0).
emscripten::val findProfileStream(int sourceId) {
  Bytes prof = findProfileStreamImpl(sourceId);
  if (prof.empty()) return emscripten::val::null();
  return makeUint8Array(prof.data(), prof.size());
}
// Streaming probe: header-only geometry + colour space (validate an image without
// loading its pixels). Never throws — a bad image is a normal {ok:false} result.
emscripten::val probeImage(int sourceId) {
  try { return probeImageStreamImpl(sourceId); }
  catch (...) {
    emscripten::val r = emscripten::val::object();
    r.set("ok", false); r.set("error", std::string("Could not read the image header."));
    return r;
  }
}
emscripten::val decodeImage(emscripten::val bytesVal) {
  try { return decodeImageImpl(toBytes(bytesVal)); }
  catch (const std::exception& e) {
    emscripten::val r = emscripten::val::object();
    r.set("ok", false); r.set("error", std::string(e.what())); return r;
  }
}
// Unified encode: format ∈ {"tiff","png","jpeg"}. photometric applies to TIFF only;
// quality to JPEG only. sampleFmt/compression/planar apply to TIFF only (0-defaults
// reproduce the previous behaviour, save that compression 0 = none where the old code
// hardwired LZW — callers wanting LZW now pass compression=1). Returns container bytes.
emscripten::val encodeImage(std::string format, int width, int height, int channels,
                            int bits, int photometric, emscripten::val samplesVal,
                            emscripten::val profileVal, int quality,
                            int sampleFmt, int compression, int planar) {
  try {
    Bytes samples = toBytes(samplesVal);
    Bytes profile = toBytes(profileVal);
    Bytes out;
    if (format == "tiff")      out = encodeTiffBytes(width, height, channels, bits, photometric, samples, profile, sampleFmt, compression, planar);
    else if (format == "png")  out = encodePngBytes(width, height, channels, bits, samples, profile);
    else if (format == "jpeg" || format == "jpg") out = encodeJpegBytes(width, height, channels, samples, quality, profile);
    else throw std::runtime_error("Unknown image format: " + format);
    return makeUint8Array(out.data(), out.size());
  } catch (const std::runtime_error&) { throw; }
  catch (const std::exception& e) { throw std::runtime_error(std::string("Image encode failed: ") + e.what()); }
}

} // namespace

EMSCRIPTEN_BINDINGS(iccimage) {
  emscripten::function("findProfile", &findProfile);
  emscripten::function("findProfileStream", &findProfileStream);
  emscripten::function("probeImage", &probeImage);
  emscripten::function("decodeImage", &decodeImage);
  emscripten::function("encodeImage", &encodeImage);
}
