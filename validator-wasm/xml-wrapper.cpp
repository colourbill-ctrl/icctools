/**
 * iccxml WASM wrapper — lazy-loaded second module.
 *
 * Exposes two embind functions:
 *   iccToXml(Uint8Array bytes)   → string (XML)
 *   xmlToIcc(string xml)         → Uint8Array (ICC profile bytes)
 *
 * Throws std::runtime_error on failure (surfaces as a JS Error).
 *
 * Implementation notes: IccLibXML's LoadXml() uses libxml2's xmlReadFile(),
 * which requires a filesystem path, and SaveIccProfile(const char*) likewise.
 * We route I/O through Emscripten's MEMFS (virtual in-memory FS) to avoid
 * touching iccDEV. The round-trip is:
 *
 *   JS bytes → /tmp/in.icc  → CIccFileIO::Open / CIccProfileXml::Read
 *                           → profile.ToXml(std::string&)           → JS string
 *
 *   JS string → /tmp/in.xml → libxml2::xmlReadFile / LoadXml
 *                           → SaveIccProfile("/tmp/out.icc", ...)
 *                           → fread → JS Uint8Array
 *
 * TO SKIP THE MEMFS HOP, patch IccLibXML upstream:
 *   - Add `CIccProfileXml::LoadXmlMem(const char* buf, size_t len, …)` which
 *     calls `xmlReadMemory(buf, len, NULL, NULL, XML_PARSE_HUGE|XML_PARSE_NONET)`
 *     instead of `xmlReadFile()`. The rest of LoadXml() is unchanged — it's
 *     just the initial DOM build that takes a path.
 *   - Add a `SaveIccProfile(CIccIO*, CIccProfile*, icProfileIDSaveMethod)`
 *     overload (the filename overload in IccProfile.cpp is a thin wrapper
 *     around profile.Write(pIO)). A CIccMemIO target then yields the bytes
 *     without hitting FS.
 * Neither change is complex; both are out-of-scope here because we don't
 * modify iccDEV.
 */

#include "IccTagXmlFactory.h"
#include "IccMpeXmlFactory.h"
#include "IccProfileXml.h"
#include "IccTag.h"
#include "IccIO.h"
#include "IccUtil.h"
#include "IccLibXMLVer.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

// Mirrors kMaxJsonBytes in json-wrapper.cpp. ICC profiles serialised to XML
// don't legitimately exceed a few MB; 32 MB is generous and stops a multi-GB
// paste from copying through std::string into MEMFS before libxml2 sees it.
// Keep in sync with MAX_XML_BYTES in xmlConverter.js.
static constexpr std::size_t kMaxXmlBytes = 32ULL * 1024 * 1024;

// Independent ICC-bytes cap for the ICC→XML direction, mirroring MAX_ICC_BYTES
// in frontend/src/App.jsx so the WASM boundary doesn't trust the JS caller.
static constexpr std::size_t kMaxIccBytes = 256ULL * 1024 * 1024;

namespace {

// Strict UTF-8 validator (rejects overlongs, surrogates, > U+10FFFF, truncated
// sequences). libxml2 auto-detects the input encoding (UTF-16/32 via BOM/NUL
// pattern, EBCDIC via its 0x4C6FA794 signature, …) and then transcodes before
// it ever sees the narrow-byte guard below — so a <!DOCTYPE could ride in under
// a non-UTF-8 encoding. iccDEV emits UTF-8 only, so requiring valid UTF-8 has
// zero legitimate false positives and forces the input into the byte form the
// substring scan reliably covers. UTF-16/32 are *also* caught by the NUL check
// (ASCII-range content has embedded NULs, which are valid UTF-8 bytes), but this
// additionally closes EBCDIC, whose signature bytes (e.g. 0xA7) are lone UTF-8
// continuation bytes and so fail here. Today embind marshals the editor string
// to UTF-8 already, so this never trips on the current path; it hardens any
// future bytes-based caller.
bool isValidUtf8(const std::string& s) {
  std::size_t i = 0, n = s.size();
  while (i < n) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    std::size_t extra;
    unsigned int minCp, cp;
    if (c < 0x80)               { ++i; continue; }
    else if ((c & 0xE0) == 0xC0){ extra = 1; minCp = 0x80;    cp = c & 0x1F; }
    else if ((c & 0xF0) == 0xE0){ extra = 2; minCp = 0x800;   cp = c & 0x0F; }
    else if ((c & 0xF8) == 0xF0){ extra = 3; minCp = 0x10000; cp = c & 0x07; }
    else return false;  // lone continuation byte (0x80–0xBF) or invalid lead
    if (i + extra >= n) return false;  // truncated multi-byte sequence
    for (std::size_t k = 1; k <= extra; ++k) {
      unsigned char cc = static_cast<unsigned char>(s[i + k]);
      if ((cc & 0xC0) != 0x80) return false;  // expected continuation byte
      cp = (cp << 6) | (cc & 0x3F);
    }
    if (cp < minCp) return false;                    // overlong encoding
    if (cp > 0x10FFFF) return false;                 // out of Unicode range
    if (cp >= 0xD800 && cp <= 0xDFFF) return false;  // UTF-16 surrogate
    i += extra + 1;
  }
  return true;
}

// IccLibXML calls libxml2 with XML_PARSE_HUGE | XML_PARSE_NONET upstream
// (IccProfileXml.cpp:878). XML_PARSE_HUGE disables libxml2's
// entity-expansion / nesting-depth / name-length caps, so a small crafted
// XML can trigger billion-laughs and OOM the tab. We can't change that flag
// without modifying iccDEV. Instead, refuse any XML that declares a DTD or
// entity: ICC profile XML emitted by iccDEV doesn't use either, so a
// presence check is safe and defeats the entire entity-expansion vector
// (and XXE — XML_PARSE_NONET blocks network fetches, but entity recursion
// alone is the heap-exhaustion concern).
bool containsDoctypeOrEntity(const std::string& xml) {
  // A NUL byte means the input isn't UTF-8 — UTF-16/UTF-32 encode ASCII XML
  // with embedded NULs. The substring scan below is a narrow-byte (UTF-8)
  // search, so a UTF-16-encoded "<!DOCTYPE" would slip past it while libxml2
  // auto-detects the encoding (via BOM/heuristics) and processes the DTD under
  // XML_PARSE_HUGE. embind currently marshals the editor string to UTF-8 so
  // this isn't reachable today, but iccDEV only ever emits NUL-free UTF-8, so
  // refusing any NUL is spec-correct (XML 1.0 forbids U+0000 outright) and
  // closes the bypass for any future bytes-based caller.
  if (xml.find('\0') != std::string::npos) return true;
  return xml.find("<!DOCTYPE") != std::string::npos
      || xml.find("<!ENTITY")  != std::string::npos;
}

// Per-call counter so concurrent calls (e.g. from a future Web Worker pool or
// reentrant Promise.all) don't collide on a shared MEMFS path.
std::string uniqueMemfsPath(const char* prefix, const char* ext) {
  static std::atomic<std::uint64_t> counter{0};
  char buf[64];
  std::snprintf(buf, sizeof(buf), "/tmp/profiletool_%s_%llu.%s",
                prefix,
                static_cast<unsigned long long>(counter.fetch_add(1)),
                ext);
  return std::string(buf);
}

void ensureFactoriesPushed() {
  static bool pushed = false;
  if (!pushed) {
    CIccTagCreator::PushFactory(new CIccTagXmlFactory());
    CIccMpeCreator::PushFactory(new CIccMpeXmlFactory());

    // Workaround for an iccDEV bug in CIccSpecTagFactory::GetTagNameSig
    // (IccProfLib/IccTagFactory.cpp:490): the lazy-init guard checks the
    // sig→name map but populates the name→sig map, so if GetTagSigName()
    // ever runs first (as it does inside iccToXml), the name→sig map stays
    // empty and every subsequent LoadXml → "<profileDescriptionTag>" lookup
    // returns icSigUnknownTag → "Unable to Parse" on re-import.
    //
    // Upstream patch would be a one-liner (check the right map); since we
    // don't modify iccDEV we prime the name→sig map here while the bugged
    // guard is still true. Same pattern isn't needed for MPE or tag-type
    // lookups — those guard and populate the same map.
    CIccTagCreator::GetTagNameSig("profileDescriptionTag");

    pushed = true;
  }
}

bool writeFile(const char* path, const void* data, std::size_t size) {
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  bool ok = std::fwrite(data, 1, size, f) == size;
  std::fclose(f);
  return ok;
}

bool readFile(const char* path, std::vector<std::uint8_t>& out) {
  FILE* f = std::fopen(path, "rb");
  if (!f) return false;
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  if (n < 0) { std::fclose(f); return false; }
  std::fseek(f, 0, SEEK_SET);
  out.resize(static_cast<std::size_t>(n));
  bool ok = std::fread(out.data(), 1, out.size(), f) == out.size();
  std::fclose(f);
  return ok;
}

emscripten::val makeUint8Array(const std::uint8_t* data, std::size_t size) {
  emscripten::val u8 = emscripten::val::global("Uint8Array").new_(size);
  u8.call<void>("set",
    emscripten::val(emscripten::typed_memory_view(size, data)));
  return u8;
}

} // namespace

static std::string iccToXmlImpl(const std::string& bytes) {
  ensureFactoriesPushed();

  // Independent ICC-bytes cap (mirrors MAX_ICC_BYTES in App.jsx). kMaxXmlBytes
  // guards the XML-input direction; this guards the ICC-input direction.
  if (bytes.size() > kMaxIccBytes) {
    throw std::runtime_error(
        "Profile exceeds " + std::to_string(kMaxIccBytes / (1024 * 1024)) + " MB limit");
  }

  // Read path: CIccMemIO::Attach on the inbound buffer — no MEMFS hop, no
  // per-byte embind marshalling (embind copies the Uint8Array into `bytes`
  // as one memcpy). Attach is read-only so the const_cast is sound.
  CIccMemIO srcIO;
  if (!srcIO.Attach(
        reinterpret_cast<icUInt8Number*>(const_cast<char*>(bytes.data())),
        bytes.size(), false)) {
    throw std::runtime_error("failed to open profile bytes");
  }

  CIccProfileXml profile;
  if (!profile.Read(&srcIO)) {
    throw std::runtime_error("failed to parse ICC profile");
  }

  std::string xml;
  xml.reserve(1 << 20);
  if (!profile.ToXml(xml)) {
    throw std::runtime_error("failed to convert profile to XML");
  }
  return xml;
}

static emscripten::val xmlToIccImpl(const std::string& xml) {
  ensureFactoriesPushed();

  // Size gate before MEMFS write + libxml2 parse. Anything legitimate fits
  // well under this; multi-GB pastes are caught here.
  if (xml.size() > kMaxXmlBytes) {
    throw std::runtime_error(
        "XML exceeds " + std::to_string(kMaxXmlBytes / (1024 * 1024)) + " MB limit");
  }

  // Reject non-UTF-8 input first — closes the encoding-detection bypass (EBCDIC
  // etc.) that the narrow-byte entity guard below can't see. See isValidUtf8().
  if (!isValidUtf8(xml)) {
    throw std::runtime_error("XML must be UTF-8 encoded");
  }

  // Entity-bomb guard — see containsDoctypeOrEntity().
  if (containsDoctypeOrEntity(xml)) {
    throw std::runtime_error(
        "XML must not contain <!DOCTYPE or <!ENTITY declarations");
  }

  const std::string srcPath = uniqueMemfsPath("in", "xml");
  const std::string dstPath = uniqueMemfsPath("out", "icc");

  if (!writeFile(srcPath.c_str(), xml.data(), xml.size())) {
    throw std::runtime_error("failed to write MEMFS XML input");
  }

  CIccProfileXml profile;
  std::string reason;
  // Empty RelaxNG path → skip schema validation (matches iccFromXml without -v).
  if (!profile.LoadXml(srcPath.c_str(), "", &reason)) {
    std::remove(srcPath.c_str());
    std::string msg = "XML parse failed";
    if (!reason.empty()) { msg += ": "; msg += reason; }
    throw std::runtime_error(msg);
  }
  std::remove(srcPath.c_str());

  // Mirror iccFromXml's save behaviour: always save, even if Validate() flags
  // issues. The UI re-runs the validator on the returned bytes anyway and
  // surfaces the resulting messages through the existing Validation panel.
  int i;
  for (i = 0; i < 16; ++i) {
    if (profile.m_Header.profileID.ID8[i]) break;
  }
  icProfileIDSaveMethod saveMethod =
      (i < 16) ? icAlwaysWriteID : icVersionBasedID;

  if (!SaveIccProfile(dstPath.c_str(), &profile, saveMethod)) {
    throw std::runtime_error("failed to write ICC profile");
  }

  std::vector<std::uint8_t> bytes;
  bool ok = readFile(dstPath.c_str(), bytes);
  std::remove(dstPath.c_str());
  if (!ok) {
    throw std::runtime_error("failed to read back saved profile");
  }
  return makeUint8Array(bytes.data(), bytes.size());
}

// Outer wrappers convert any unexpected throw (libxml2/IccLibXML internal,
// std::bad_alloc on huge inputs, etc.) into a std::runtime_error so embind
// surfaces a readable .what() via getExceptionMessage instead of an opaque
// CppException pointer that would also leave the module instance in a
// terminated state for the rest of the session. Mirrors the json-wrapper.cpp
// pattern.
static std::string iccToXml(const std::string& bytes) {
  try { return iccToXmlImpl(bytes); }
  catch (const std::runtime_error&) { throw; }
  catch (const std::exception& e) {
    throw std::runtime_error(std::string("iccToXml threw: ") + e.what());
  } catch (...) {
    throw std::runtime_error("iccToXml threw an unknown exception");
  }
}

static emscripten::val xmlToIcc(const std::string& xml) {
  try { return xmlToIccImpl(xml); }
  catch (const std::runtime_error&) { throw; }
  catch (const std::exception& e) {
    throw std::runtime_error(std::string("xmlToIcc threw: ") + e.what());
  } catch (...) {
    throw std::runtime_error("xmlToIcc threw an unknown exception");
  }
}

EMSCRIPTEN_BINDINGS(profiletool_xml) {
  emscripten::function("iccToXml", &iccToXml);
  emscripten::function("xmlToIcc", &xmlToIcc);
}
