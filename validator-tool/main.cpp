/**
 * iccprofiledump — ICC profile validator/dumper for icctools.
 *
 * Uses IccProfLib directly to produce a JSON report equivalent to what
 * iccDumpProfile + parser.js previously produced.  Outputs to stdout;
 * exits 0 for OK/Warning, 1 for NonCompliant/CriticalError or bad input.
 *
 * Usage: iccprofiledump <profile.icc>
 */

#include "IccProfile.h"
#include "IccTag.h"
#include "IccUtil.h"
#include "IccProfLibVer.h"
#include "icProfileHeader.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Convert a 4-byte ICC signature to a printable string (e.g. 0x64657363 → "desc").
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

// Format an icSpectralRange as "start=XXXnm, end=XXXnm, steps=N", or
// "Not Defined" when all fields are zero.
static std::string formatSpectralRange(const icSpectralRange& r) {
  if (r.start == 0 && r.end == 0 && r.steps == 0) return "Not Defined";
  char buf[64];
  snprintf(buf, sizeof(buf), "start=%.1fnm, end=%.1fnm, steps=%u",
           static_cast<double>(icF16toF(r.start)),
           static_cast<double>(icF16toF(r.end)),
           static_cast<unsigned>(r.steps));
  return std::string(buf);
}

// ── Main ─────────────────────────────────────────────────────────────────────

int main(int argc, char* argv[]) {
  if (argc < 2) {
    json err = {{"error", "Usage: iccprofiledump <profile.icc>"}};
    std::cout << err.dump() << '\n';
    return 1;
  }
  const char* filepath = argv[1];

  // ── Load and validate ────────────────────────────────────────────────────
  std::string sReport;
  icValidateStatus nStatus;
  CIccProfile* pProfile = ValidateIccProfile(filepath, sReport, nStatus);

  if (!pProfile) {
    json err = {{"error", std::string("Failed to open ICC profile: ") + filepath}};
    std::cout << err.dump() << '\n';
    return 1;
  }

  json result;
  result["libraryVersion"] = ICCPROFLIBVER;

  // ── Profile ID ──────────────────────────────────────────────────────────
  const icHeader& hdr = pProfile->m_Header;
  char idHex[33];
  for (int i = 0; i < 16; ++i)
    snprintf(idHex + i * 2, 3, "%02x", hdr.profileID.ID8[i]);
  result["profileId"]    = std::string(idHex);
  result["sizeBytes"]    = static_cast<int>(hdr.size);
  char hexBuf[16];
  snprintf(hexBuf, sizeof(hexBuf), "%x", hdr.size);
  result["sizeBytesHex"] = std::string(hexBuf);

  // ── Header ───────────────────────────────────────────────────────────────
  CIccInfo info;
  json header;

  header["Attributes"]         = std::string(info.GetDeviceAttrName(hdr.attributes));
  header["Cmm"]                = std::string(info.GetCmmSigName(static_cast<icCmmSignature>(hdr.cmmId)));

  {
    char dateBuf[64];
    snprintf(dateBuf, sizeof(dateBuf), "%d/%d/%d (M/D/Y)  %02d:%02d:%02d",
             static_cast<int>(hdr.date.month), static_cast<int>(hdr.date.day),
             static_cast<int>(hdr.date.year),
             static_cast<int>(hdr.date.hours), static_cast<int>(hdr.date.minutes),
             static_cast<int>(hdr.date.seconds));
    header["Creation Date"] = std::string(dateBuf);
  }

  header["Creator"]            = sigToStr(hdr.creator);
  header["Device Manufacturer"]= sigToStr(hdr.manufacturer);
  header["Data Color Space"]   = std::string(info.GetColorSpaceSigName(hdr.colorSpace));
  header["Flags"]              = std::string(info.GetProfileFlagsName(hdr.flags));
  header["PCS Color Space"]    = std::string(info.GetColorSpaceSigName(hdr.pcs));
  header["Platform"]           = std::string(info.GetPlatformSigName(hdr.platform));
  header["Rendering Intent"]   = std::string(info.GetRenderingIntentName(
                                   static_cast<icRenderingIntent>(hdr.renderingIntent)));
  header["Profile Class"]      = std::string(info.GetProfileClassSigName(hdr.deviceClass));
  header["Profile SubClass"]   = (hdr.deviceSubClass != 0)
                                   ? sigToStr(hdr.deviceSubClass)
                                   : "Not Defined";
  header["Version"]            = std::string(info.GetVersionName(hdr.version));

  {
    char illumBuf[64];
    snprintf(illumBuf, sizeof(illumBuf), "X=%.4f, Y=%.4f, Z=%.4f",
             static_cast<double>(icFtoD(hdr.illuminant.X)),
             static_cast<double>(icFtoD(hdr.illuminant.Y)),
             static_cast<double>(icFtoD(hdr.illuminant.Z)));
    header["Illuminant"] = std::string(illumBuf);
  }

  // V5 spectral fields
  header["Spectral PCS"] = (hdr.spectralPCS != icSigNoSpectralData)
                             ? std::string(info.GetSpectralColorSigName(
                                 static_cast<icColorSpaceSignature>(hdr.spectralPCS)))
                             : "NoSpectralData";
  header["Spectral PCS Range"] = formatSpectralRange(hdr.spectralRange);
  header["BiSpectral Range"]   = formatSpectralRange(hdr.biSpectralRange);
  header["MCS Color Space"]    = (hdr.mcs != 0)
                                   ? sigToStr(hdr.mcs)
                                   : "Not Defined";

  result["header"] = header;

  // ── Tags ─────────────────────────────────────────────────────────────────
  // Collect entries, then sort by offset for display and pad calculation.
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
      // Full verbosity, matching wxProfileDump's MyTagDialog behaviour.
      entry.pTag->Describe(r.description, 100);
    } else {
      r.type = "";
      r.description = "Tag not found in profile.";
    }
    rows.push_back(std::move(r));
  }

  std::stable_sort(rows.begin(), rows.end(),
    [](const TagRow& a, const TagRow& b){ return a.offset < b.offset; });

  json tags = json::array();
  for (size_t i = 0; i < rows.size(); ++i) {
    json t;
    t["name"]        = rows[i].name;
    t["id"]          = rows[i].id;
    t["type"]        = rows[i].type;
    t["isArrayType"] = rows[i].isArrayType;
    t["description"] = rows[i].description;
    t["offset"]      = static_cast<int>(rows[i].offset);
    t["size"]        = static_cast<int>(rows[i].size);

    // Padding = gap between end of this tag's data and start of the next.
    // Negative means overlap (non-compliant).
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

  // ── Validation ───────────────────────────────────────────────────────────
  json validation;
  std::string level, statusStr;

  switch (nStatus) {
    case icValidateOK:
      level     = "valid";
      statusStr = "Profile is valid";
      break;
    case icValidateWarning:
      level     = "warning";
      statusStr = "Profile has warning(s)";
      break;
    case icValidateNonCompliant:
      level     = "error";
      statusStr = "Profile is non-compliant";
      break;
    case icValidateCriticalError:
      level     = "error";
      statusStr = "Critical validation error";
      break;
    default:
      level     = "unknown";
      statusStr = "Unknown validation status";
  }

  validation["level"]  = level;
  validation["status"] = statusStr;

  // Split the report string into individual messages, stripping blank lines.
  json messages = json::array();
  {
    std::istringstream ss(sReport);
    std::string line;
    while (std::getline(ss, line)) {
      // Trim trailing CR/whitespace
      while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t'))
        line.pop_back();
      if (!line.empty())
        messages.push_back(line);
    }
  }
  validation["messages"] = messages;
  result["validation"]   = validation;

  delete pProfile;

  std::cout << result.dump(2, ' ', false, json::error_handler_t::replace) << '\n';
  return (nStatus == icValidateCriticalError || nStatus == icValidateNonCompliant) ? 1 : 0;
}
