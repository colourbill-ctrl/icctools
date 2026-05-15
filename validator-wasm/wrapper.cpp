/**
 * iccprofiledump WASM wrapper.
 *
 * Exposes a single `validateProfile(Uint8Array)` function via embind that
 * returns the same JSON shape the native iccprofiledump binary produces.
 *
 * Built with Emscripten; ships as an ES module (iccprofiledump.mjs + .wasm).
 */

#include "IccProfile.h"
#include "IccTag.h"
#include "IccUtil.h"
#include "IccProfLibVer.h"
#include "icProfileHeader.h"

#include <nlohmann/json.hpp>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

// ── Helpers (mirror validator-tool/main.cpp) ─────────────────────────────────

static std::string sigToStr(icUInt32Number sig) {
  if (sig == 0) return "NULL";
  char buf[5];
  buf[0] = static_cast<char>((sig >> 24) & 0xFF);
  buf[1] = static_cast<char>((sig >> 16) & 0xFF);
  buf[2] = static_cast<char>((sig >>  8) & 0xFF);
  buf[3] = static_cast<char>( sig        & 0xFF);
  buf[4] = '\0';
  for (int i = 0; i < 4; ++i)
    if (buf[i] < 0x20 || buf[i] > 0x7E) buf[i] = '?';
  return std::string(buf);
}

static std::string formatSpectralRange(const icSpectralRange& r) {
  if (r.start == 0 && r.end == 0 && r.steps == 0) return "Not Defined";
  char buf[64];
  snprintf(buf, sizeof(buf), "start=%.1fnm, end=%.1fnm, steps=%u",
           static_cast<double>(icF16toF(r.start)),
           static_cast<double>(icF16toF(r.end)),
           static_cast<unsigned>(r.steps));
  return std::string(buf);
}

// ── Parsed-profile cache ─────────────────────────────────────────────────────
// A single-slot cache so describeTag() doesn't re-parse the entire profile on
// every tag-detail open — for a multi-MB nCLR profile that meant tens of full
// parses per browsing session, a trivial DoS vector for a hostile postMessage
// opener that hands us a borderline-huge profile. The cache key is FNV-1a64
// over the byte buffer plus its length; collisions would require an attacker
// to craft two distinct profiles that hash-collide AND both validate, neither
// of which is plausible. The cache owns the parsed CIccProfile* and replaces
// it on every miss; peak memory is bounded by one parsed profile.
namespace {

std::uint64_t fnv1a64(const std::uint8_t* data, std::size_t len) {
  std::uint64_t h = 0xCBF29CE484222325ULL;
  for (std::size_t i = 0; i < len; ++i) {
    h ^= data[i];
    h *= 0x100000001B3ULL;
  }
  return h;
}

struct ParseCache {
  std::uint64_t hash = 0;
  std::size_t   len  = 0;
  CIccProfile*  profile = nullptr;
  std::string   report;
  icValidateStatus status = icValidateOK;
};

ParseCache& parseCache() { static ParseCache c; return c; }

// Returns a cached parsed profile if (hash, len) match; otherwise parses
// fresh, replaces the cache slot, and returns the new profile (or nullptr on
// parse failure). On nullptr return, the cache is cleared. `outReport` and
// `outStatus` always reflect the parse that produced the returned profile
// (cached or fresh) so callers can build validation messages.
CIccProfile* getOrParse(const std::uint8_t* data, std::size_t len,
                        std::string& outReport, icValidateStatus& outStatus) {
  ParseCache& c = parseCache();
  std::uint64_t h = fnv1a64(data, len);
  if (c.profile && c.hash == h && c.len == len) {
    outReport = c.report;
    outStatus = c.status;
    return c.profile;
  }
  if (c.profile) { delete c.profile; c.profile = nullptr; c.report.clear(); c.len = 0; c.hash = 0; }
  std::string report;
  icValidateStatus status = icValidateOK;
  CIccProfile* p = ValidateIccProfile(data, static_cast<icUInt32Number>(len), report, status);
  if (p) {
    c.profile = p;
    c.report  = report;
    c.status  = status;
    c.hash    = h;
    c.len     = len;
  }
  outReport = report;
  outStatus = status;
  return p;
}

} // namespace

// ── Core validator ───────────────────────────────────────────────────────────

static std::string validateBytes(const std::uint8_t* data, std::size_t len) {
  std::string sReport;
  icValidateStatus nStatus = icValidateOK;
  CIccProfile* pProfile = getOrParse(data, len, sReport, nStatus);

  if (!pProfile) {
    json err = {{"error", "Failed to parse ICC profile"}};
    return err.dump();
  }

  json result;
  result["libraryVersion"] = ICCPROFLIBVER;

  // ── Header ────────────────────────────────────────────────────────────────
  const icHeader& hdr = pProfile->m_Header;
  char idHex[33];
  for (int i = 0; i < 16; ++i)
    snprintf(idHex + i * 2, 3, "%02x", hdr.profileID.ID8[i]);
  result["profileId"]    = std::string(idHex);
  result["sizeBytes"]    = static_cast<int>(hdr.size);
  char hexBuf[16];
  snprintf(hexBuf, sizeof(hexBuf), "%x", hdr.size);
  result["sizeBytesHex"] = std::string(hexBuf);

  CIccInfo info;
  json header;

  header["Attributes"]          = std::string(info.GetDeviceAttrName(hdr.attributes));
  header["Cmm"]                 = std::string(info.GetCmmSigName(static_cast<icCmmSignature>(hdr.cmmId)));
  {
    char dateBuf[64];
    snprintf(dateBuf, sizeof(dateBuf), "%d/%d/%d (M/D/Y)  %02d:%02d:%02d",
             static_cast<int>(hdr.date.month), static_cast<int>(hdr.date.day),
             static_cast<int>(hdr.date.year),
             static_cast<int>(hdr.date.hours), static_cast<int>(hdr.date.minutes),
             static_cast<int>(hdr.date.seconds));
    header["Creation Date"] = std::string(dateBuf);
  }
  header["Creator"]             = sigToStr(hdr.creator);
  header["Device Manufacturer"] = sigToStr(hdr.manufacturer);
  header["Data Color Space"]    = std::string(info.GetColorSpaceSigName(hdr.colorSpace));
  header["Flags"]               = std::string(info.GetProfileFlagsName(hdr.flags));
  header["PCS Color Space"]     = std::string(info.GetColorSpaceSigName(hdr.pcs));
  header["Platform"]            = std::string(info.GetPlatformSigName(hdr.platform));
  header["Rendering Intent"]    = std::string(info.GetRenderingIntentName(
                                     static_cast<icRenderingIntent>(hdr.renderingIntent)));
  header["Profile Class"]       = std::string(info.GetProfileClassSigName(hdr.deviceClass));
  header["Profile SubClass"]    = (hdr.deviceSubClass != 0)
                                    ? sigToStr(hdr.deviceSubClass)
                                    : "Not Defined";
  header["Version"]             = std::string(info.GetVersionName(hdr.version));
  {
    char illumBuf[64];
    snprintf(illumBuf, sizeof(illumBuf), "X=%.4f, Y=%.4f, Z=%.4f",
             static_cast<double>(icFtoD(hdr.illuminant.X)),
             static_cast<double>(icFtoD(hdr.illuminant.Y)),
             static_cast<double>(icFtoD(hdr.illuminant.Z)));
    header["Illuminant"] = std::string(illumBuf);
  }
  header["Spectral PCS"]        = (hdr.spectralPCS != icSigNoSpectralData)
                                    ? std::string(info.GetSpectralColorSigName(
                                        static_cast<icColorSpaceSignature>(hdr.spectralPCS)))
                                    : "NoSpectralData";
  header["Spectral PCS Range"]  = formatSpectralRange(hdr.spectralRange);
  header["BiSpectral Range"]    = formatSpectralRange(hdr.biSpectralRange);
  header["MCS Color Space"]     = (hdr.mcs != 0) ? sigToStr(hdr.mcs) : "Not Defined";

  result["header"] = header;

  // ── Tags ──────────────────────────────────────────────────────────────────
  struct TagRow {
    std::string name;
    std::string id;
    std::string type;
    std::string description;
    bool isArrayType = false;
    icUInt32Number offset;
    icUInt32Number size;
  };

  std::vector<TagRow> rows;
  rows.reserve(pProfile->m_Tags.size());

  for (const auto& entry : pProfile->m_Tags) {
    TagRow r;
    r.name   = std::string(info.GetTagSigName(entry.TagInfo.sig));
    r.id     = sigToStr(static_cast<icUInt32Number>(entry.TagInfo.sig));
    r.offset = entry.TagInfo.offset;
    r.size   = entry.TagInfo.size;
    if (entry.pTag) {
      r.type = std::string(info.GetTagTypeSigName(entry.pTag->GetType()));
      r.isArrayType = entry.pTag->IsArrayType();
      // Verbosity 75 sits just under the > 75 gates in IccTagLut.cpp /
      // IccTagBasic.cpp that dump every CLUT cell and every curve point.
      // The tag detail modal calls describeTag() for verbosity 100 on demand;
      // doing that for every tag upfront blows the WASM heap on profiles with
      // large LUTs (any nCLR profile, plus large CMYK ones like OakPrinting).
      entry.pTag->Describe(r.description, 75);
    } else {
      r.description = "Tag not found in profile.";
    }
    rows.push_back(std::move(r));
  }

  std::stable_sort(rows.begin(), rows.end(),
    [](const TagRow& a, const TagRow& b){ return a.offset < b.offset; });

  json tags = json::array();
  for (std::size_t i = 0; i < rows.size(); ++i) {
    json t;
    t["name"]        = rows[i].name;
    t["id"]          = rows[i].id;
    t["type"]        = rows[i].type;
    t["isArrayType"] = rows[i].isArrayType;
    t["description"] = rows[i].description;
    t["offset"]      = static_cast<int>(rows[i].offset);
    t["size"]        = static_cast<int>(rows[i].size);
    int pad;
    if (i + 1 < rows.size()) {
      pad = static_cast<int>(rows[i + 1].offset)
          - static_cast<int>(rows[i].offset + rows[i].size);
    } else {
      pad = static_cast<int>(hdr.size)
          - static_cast<int>(rows[i].offset + rows[i].size);
    }
    t["pad"] = pad;
    tags.push_back(std::move(t));
  }
  result["tags"] = tags;

  // ── Validation ────────────────────────────────────────────────────────────
  json validation;
  std::string level, statusStr;
  switch (nStatus) {
    case icValidateOK:            level = "valid";   statusStr = "Profile is valid"; break;
    case icValidateWarning:       level = "warning"; statusStr = "Profile has warning(s)"; break;
    case icValidateNonCompliant:  level = "error";   statusStr = "Profile is non-compliant"; break;
    case icValidateCriticalError: level = "error";   statusStr = "Critical validation error"; break;
    default:                      level = "unknown"; statusStr = "Unknown validation status";
  }
  validation["level"]  = level;
  validation["status"] = statusStr;

  json messages = json::array();
  {
    std::istringstream ss(sReport);
    std::string line;
    while (std::getline(ss, line)) {
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t'))
        line.pop_back();
      if (!line.empty()) messages.push_back(line);
    }
  }
  validation["messages"] = messages;
  result["validation"]   = validation;

  // pProfile is owned by parseCache(); do not delete here.

  // Replace invalid UTF-8 (from Describe() hex dumps on malformed tags) with
  // the U+FFFD replacement character so dump() doesn't throw.
  return result.dump(2, ' ', false, json::error_handler_t::replace);
}

// ── Embind binding ───────────────────────────────────────────────────────────
// Accepts a Uint8Array from JS, returns a JSON string.
//
// Anything thrown out of IccProfLib (most likely std::bad_alloc on
// Describe-explosion for huge nCLR LUTs, but also any other parser exception)
// is converted to a JSON {"error": ...} response so the browser surfaces a
// readable message instead of an opaque CppException.

static std::string validateProfile(emscripten::val bytes) {
  try {
    auto vec = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytes);
    return validateBytes(vec.data(), vec.size());
  } catch (const std::exception& e) {
    json err = {{"error", std::string("validator threw: ") + e.what()}};
    return err.dump();
  } catch (...) {
    json err = {{"error", "validator threw an unknown exception"}};
    return err.dump();
  }
}

// On-demand full-verbosity (100) Describe for a single tag. The upfront
// validateProfile() pass uses verbosity 50 to keep peak memory bounded; the
// tag detail modal calls this when opened to get the wxProfileDump-equivalent
// dump for one tag (which fits even for 7CLR LUTs once isolated).
//
// `tagSig` is a 4-character ICC signature like "A2B0" or "desc". Tags with
// the same signature appearing more than once resolve to the first match
// (matches CIccProfile::FindTag behaviour). Always returns a JSON envelope:
// {"description": "..."} on success, {"error": "..."} on failure.

static std::string describeTagBytes(const std::uint8_t* data, std::size_t len,
                                    const std::string& tagSig) {
  if (tagSig.size() != 4) {
    return json{{"error", "tagSig must be a 4-character ICC signature"}}.dump();
  }
  icUInt32Number sig =
      (static_cast<icUInt32Number>(static_cast<unsigned char>(tagSig[0])) << 24) |
      (static_cast<icUInt32Number>(static_cast<unsigned char>(tagSig[1])) << 16) |
      (static_cast<icUInt32Number>(static_cast<unsigned char>(tagSig[2])) <<  8) |
      (static_cast<icUInt32Number>(static_cast<unsigned char>(tagSig[3])));

  std::string sReport;
  icValidateStatus nStatus = icValidateOK;
  CIccProfile* pProfile = getOrParse(data, len, sReport, nStatus);
  if (!pProfile) {
    return json{{"error", "Failed to parse ICC profile"}}.dump();
  }

  CIccTag* pTag = pProfile->FindTag(static_cast<icSignature>(sig));
  if (!pTag) {
    return json{{"error", "Tag not found: " + tagSig}}.dump();
  }

  std::string description;
  pTag->Describe(description, 100);
  return json{{"description", description}}.dump(
      -1, ' ', false, json::error_handler_t::replace);
}

static std::string describeTag(emscripten::val bytes, std::string tagSig) {
  try {
    auto vec = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytes);
    return describeTagBytes(vec.data(), vec.size(), tagSig);
  } catch (const std::exception& e) {
    return json{{"error", std::string("describeTag threw: ") + e.what()}}.dump();
  } catch (...) {
    return json{{"error", "describeTag threw an unknown exception"}}.dump();
  }
}

EMSCRIPTEN_BINDINGS(iccprofiledump) {
  emscripten::function("validateProfile", &validateProfile);
  emscripten::function("describeTag", &describeTag);
}
