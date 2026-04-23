/**
 * iccjson WASM wrapper — lazy-loaded third module (sibling of iccxml).
 *
 * Exposes two embind functions:
 *   iccToJson(Uint8Array bytes, int indent, bool sort) → string (JSON)
 *   jsonToIcc(string json)                              → Uint8Array (ICC bytes)
 *
 * Unlike the XML path this has no libxml2 dependency — IccLibJSON is pure
 * C++ on top of nlohmann::ordered_json (already present for wrapper.cpp),
 * and CIccProfileJson::ParseJson(IccJson&, string&) is public, so the JSON
 * *input* never touches MEMFS.
 *
 * The *output* side still needs MEMFS, because CIccProfile::Write(pIO, …)
 * writes placeholder bytes, seeks back to offset 0 after the tag table is
 * laid out, and patches m_Header.size in place (IccProfile.cpp:1090).
 * CIccMemIO has no grow-on-write and we don't know the size in advance, so
 * we route the write through MEMFS → fread into a std::vector. Same shape
 * as xml-wrapper.cpp.
 *
 * TO SKIP THE MEMFS HOP ON WRITE, patch IccProfLib upstream:
 *   - Add `CIccGrowMemIO` (or grow-on-write to CIccMemIO) so
 *     profile.Write(pIO, …) can target an in-RAM resizable buffer. The
 *     existing SaveIccProfile(FILE*, …) overload in IccProfile.cpp:3875
 *     already takes a CIccIO*; a CIccGrowMemIO target yields bytes
 *     without filesystem access.
 * Out of scope here — we don't modify iccDEV.
 */

#include "IccTagJsonFactory.h"
#include "IccMpeJsonFactory.h"
#include "IccProfileJson.h"
#include "IccTag.h"
#include "IccIO.h"
#include "IccUtil.h"
#include "IccLibJSONVer.h"

#include <nlohmann/json.hpp>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

// ── Input-size cap ─────────────────────────────────────────────────────────
// Mirror of the icceval/iccflow pattern. An ICC profile serialised to JSON
// never legitimately exceeds a few MB; 32 MB is generous. Gating here
// prevents a 2 GB JSON blob from chewing nlohmann::parse memory before we
// see any structure. Keep in sync with MAX_JSON_BYTES in jsonConverter.js.
static constexpr std::size_t kMaxJsonBytes = 32ULL * 1024 * 1024;

namespace {

void ensureFactoriesPushed() {
  static bool pushed = false;
  if (!pushed) {
    CIccTagCreator::PushFactory(new CIccTagJsonFactory());
    CIccMpeCreator::PushFactory(new CIccMpeJsonFactory());

    // Same iccDEV bug as xml-wrapper.cpp: CIccSpecTagFactory::GetTagNameSig
    // (IccProfLib/IccTagFactory.cpp:490) checks the sig→name map's empty()
    // flag but populates the name→sig map. If GetTagSigName() runs first
    // (as it does inside iccToJson during serialization), the name→sig map
    // stays empty and every ParseJson tag-key lookup returns icSigUnknownTag
    // → "skipped tag '<name>'" on re-import.
    //
    // Prime the name→sig map now while the bugged guard is still true. One
    // lookup is enough to populate the full table.
    CIccTagCreator::GetTagNameSig("profileDescriptionTag");

    pushed = true;
  }
}

// Recursively sort JSON object keys — mirrors IccToJson.cpp:sortJsonKeys
// so the -sort option here produces the same deterministic output as the
// upstream CLI.
nlohmann::ordered_json sortJsonKeys(const IccJson& j) {
  if (j.is_object()) {
    std::vector<std::string> keys;
    for (auto it = j.begin(); it != j.end(); ++it) keys.push_back(it.key());
    std::sort(keys.begin(), keys.end());
    nlohmann::ordered_json sorted = nlohmann::ordered_json::object();
    for (const auto& k : keys) sorted[k] = sortJsonKeys(j[k]);
    return sorted;
  }
  if (j.is_array()) {
    nlohmann::ordered_json arr = nlohmann::ordered_json::array();
    for (const auto& e : j) arr.push_back(sortJsonKeys(e));
    return arr;
  }
  return nlohmann::ordered_json::parse(j.dump());
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

static std::string iccToJson(emscripten::val bytes, int indent, bool sort) {
  ensureFactoriesPushed();
  auto vec = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytes);

  // Read path: MEMFS → CIccFileIO → CIccProfileJson::Read. We could use
  // CIccMemIO here (size is known), but matching xml-wrapper.cpp keeps the
  // two modules structurally identical for readers. If profile loads
  // dominate a future benchmark we can switch this one path.
  const char* srcPath = "/tmp/icctools_in.icc";
  if (!writeFile(srcPath, vec.data(), vec.size())) {
    throw std::runtime_error("failed to write MEMFS input");
  }

  CIccFileIO srcIO;
  if (!srcIO.Open(srcPath, "r")) {
    std::remove(srcPath);
    throw std::runtime_error("failed to open profile bytes");
  }

  CIccProfileJson profile;
  if (!profile.Read(&srcIO)) {
    srcIO.Close();
    std::remove(srcPath);
    throw std::runtime_error("failed to parse ICC profile");
  }
  srcIO.Close();
  std::remove(srcPath);

  if (sort) {
    IccJson doc;
    if (!profile.ToJson(doc)) {
      throw std::runtime_error("failed to convert profile to JSON");
    }
    IccJson wrapper;
    wrapper["IccProfile"] = doc;
    return sortJsonKeys(wrapper).dump(indent);
  }

  std::string jsonStr;
  if (!profile.ToJson(jsonStr, indent)) {
    throw std::runtime_error("failed to convert profile to JSON");
  }
  return jsonStr;
}

static emscripten::val jsonToIcc(const std::string& json) {
  ensureFactoriesPushed();

  // Size gate before nlohmann does anything expensive.
  if (json.size() > kMaxJsonBytes) {
    throw std::runtime_error(
        "JSON exceeds " + std::to_string(kMaxJsonBytes / (1024 * 1024)) + " MB limit");
  }

  // Parse JSON directly into nlohmann::ordered_json. No MEMFS hop — the
  // public ParseJson(IccJson&, string&) takes the in-memory doc.
  IccJson root;
  try {
    root = IccJson::parse(json);
  } catch (const std::exception& e) {
    std::string msg = "JSON parse failed: ";
    msg += e.what();
    throw std::runtime_error(msg);
  }

  // IccLibJSON's ParseJson does many raw .get<T>() calls without type
  // guards; a JSON value of the wrong type throws nlohmann::type_error
  // which would otherwise escape to std::terminate and kill the wasm
  // module instance for the rest of the session. Wrap defensively until
  // upstream adopts the fix (iccdev-prs #23).
  CIccProfileJson profile;
  std::string reason;
  bool parsed = false;
  try {
    parsed = profile.ParseJson(root, reason);
  } catch (const nlohmann::json::exception& e) {
    std::string msg = "JSON type/range error during parse: ";
    msg += e.what();
    throw std::runtime_error(msg);
  } catch (const std::exception& e) {
    std::string msg = "Unexpected error during JSON parse: ";
    msg += e.what();
    throw std::runtime_error(msg);
  }
  if (!parsed) {
    std::string msg = "JSON did not describe a valid profile";
    if (!reason.empty()) { msg += ": "; msg += reason; }
    throw std::runtime_error(msg);
  }

  // Write path: mirror IccFromJson.cpp — always save, even on validation
  // warnings/errors (the UI re-runs validation on the returned bytes and
  // surfaces messages through the Validation panel).
  int i;
  for (i = 0; i < 16; ++i) {
    if (profile.m_Header.profileID.ID8[i]) break;
  }
  icProfileIDSaveMethod saveMethod =
      (i < 16) ? icAlwaysWriteID : icVersionBasedID;

  const char* dstPath = "/tmp/icctools_out.icc";
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

EMSCRIPTEN_BINDINGS(icctools_json) {
  emscripten::function("iccToJson", &iccToJson);
  emscripten::function("jsonToIcc", &jsonToIcc);
}
