// (c) 2026 William Li
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
#include <atomic>
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
  return j;
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

// Independent ICC-bytes cap, mirroring MAX_ICC_BYTES in frontend/src/App.jsx.
// kMaxJsonBytes above guards the JSON-input direction; this guards the
// ICC-input direction so neither entry point trusts the JS caller alone.
static constexpr std::size_t kMaxIccBytes = 256ULL * 1024 * 1024;

static std::string iccToJsonImpl(const std::string& bytes, int indent, bool sort) {
  ensureFactoriesPushed();

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

  CIccProfileJson profile;
  if (!profile.Read(&srcIO)) {
    throw std::runtime_error("failed to parse ICC profile");
  }

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

static emscripten::val jsonToIccImpl(const std::string& json) {
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

  const std::string dstPath = uniqueMemfsPath("out", "icc");
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

// ── exception-safe boundary wrappers ─────────────────────────────────────────
// Convert any unexpected throw (std::bad_alloc serialising a crafted profile, an
// IccLibJSON/nlohmann internal, …) into a std::runtime_error so embind surfaces
// a readable .what() instead of an opaque CppException pointer. The *Impl bodies
// already throw std::runtime_error for their handled failures — re-throw those
// as-is. Mirrors xml-wrapper.cpp's iccToXml / xmlToIcc.
static std::string iccToJson(const std::string& bytes, int indent, bool sort) {
  try { return iccToJsonImpl(bytes, indent, sort); }
  catch (const std::runtime_error&) { throw; }
  catch (const std::exception& e) {
    throw std::runtime_error(std::string("iccToJson threw: ") + e.what());
  } catch (...) {
    throw std::runtime_error("iccToJson threw an unknown exception");
  }
}

static emscripten::val jsonToIcc(const std::string& json) {
  try { return jsonToIccImpl(json); }
  catch (const std::runtime_error&) { throw; }
  catch (const std::exception& e) {
    throw std::runtime_error(std::string("jsonToIcc threw: ") + e.what());
  } catch (...) {
    throw std::runtime_error("jsonToIcc threw an unknown exception");
  }
}

EMSCRIPTEN_BINDINGS(profiletool_json) {
  emscripten::function("iccToJson", &iccToJson);
  emscripten::function("jsonToIcc", &jsonToIcc);
}
