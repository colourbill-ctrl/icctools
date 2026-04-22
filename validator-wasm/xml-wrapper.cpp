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

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

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

static std::string iccToXml(emscripten::val bytes) {
  ensureFactoriesPushed();
  auto vec = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytes);

  const char* srcPath = "/tmp/icctools_in.icc";
  if (!writeFile(srcPath, vec.data(), vec.size())) {
    throw std::runtime_error("failed to write MEMFS input");
  }

  CIccFileIO srcIO;
  if (!srcIO.Open(srcPath, "r")) {
    std::remove(srcPath);
    throw std::runtime_error("failed to open profile bytes");
  }

  CIccProfileXml profile;
  if (!profile.Read(&srcIO)) {
    srcIO.Close();
    std::remove(srcPath);
    throw std::runtime_error("failed to parse ICC profile");
  }
  srcIO.Close();
  std::remove(srcPath);

  std::string xml;
  xml.reserve(1 << 20);
  if (!profile.ToXml(xml)) {
    throw std::runtime_error("failed to convert profile to XML");
  }
  return xml;
}

static emscripten::val xmlToIcc(const std::string& xml) {
  ensureFactoriesPushed();

  const char* srcPath = "/tmp/icctools_in.xml";
  const char* dstPath = "/tmp/icctools_out.icc";

  if (!writeFile(srcPath, xml.data(), xml.size())) {
    throw std::runtime_error("failed to write MEMFS XML input");
  }

  CIccProfileXml profile;
  std::string reason;
  // Empty RelaxNG path → skip schema validation (matches iccFromXml without -v).
  if (!profile.LoadXml(srcPath, "", &reason)) {
    std::remove(srcPath);
    std::string msg = "XML parse failed";
    if (!reason.empty()) { msg += ": "; msg += reason; }
    throw std::runtime_error(msg);
  }
  std::remove(srcPath);

  // Mirror iccFromXml's save behaviour: always save, even if Validate() flags
  // issues. The UI re-runs the validator on the returned bytes anyway and
  // surfaces the resulting messages through the existing Validation panel.
  int i;
  for (i = 0; i < 16; ++i) {
    if (profile.m_Header.profileID.ID8[i]) break;
  }
  icProfileIDSaveMethod saveMethod =
      (i < 16) ? icAlwaysWriteID : icVersionBasedID;

  if (!SaveIccProfile(dstPath, &profile, saveMethod)) {
    throw std::runtime_error("failed to write ICC profile");
  }

  std::vector<std::uint8_t> bytes;
  bool ok = readFile(dstPath, bytes);
  std::remove(dstPath);
  if (!ok) {
    throw std::runtime_error("failed to read back saved profile");
  }
  return makeUint8Array(bytes.data(), bytes.size());
}

EMSCRIPTEN_BINDINGS(icctools_xml) {
  emscripten::function("iccToXml", &iccToXml);
  emscripten::function("xmlToIcc", &xmlToIcc);
}
