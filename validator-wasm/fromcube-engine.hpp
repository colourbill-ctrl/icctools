// (c) 2026 William Li
//
// fromcube-engine.hpp — the .cube → ICC DeviceLink construction engine.
//
// This is a lift of iccDEV's `Tools/CmdLine/IccFromCube/iccFromCube.cpp` (the
// `CubeFile` parser + the profile-building sequence from its `main()`), so the
// logic can run inside a WASM module with no `main()` and no host filesystem.
// Promoting a reusable, side-effect-free version of this back into IccProfLib /
// the iccDEV tool is the Group-B upstream contribution (see parity-roadmap.md).
//
// Two deliberate, minimal differences from the upstream source; everything else
// (every parse rule, bound, and tag-construction step) is carried verbatim:
//   1. The parser's diagnostics are routed to a capturable `m_error` string
//      instead of `printf`. In a browser there is no console the user reads, so
//      the wrapper surfaces the *specific* reason a cube was rejected ("LUT too
//      large to process", "1DLUTs are not supported", …) in the returned error.
//      Each assignment reproduces the upstream printf message verbatim.
//   2. `icSanitizeTagText` (an inline helper from Tools/CmdLine/IccCmdLineUtil.h,
//      not part of IccProfLib) is copied in below so the engine is self-contained
//      and doesn't pull a CmdLine header (and its argv utilities) into the build.
//
// The `.cube` text is staged into Emscripten MEMFS by the wrapper, so CubeFile's
// existing fopen/fgetc-based reader works unchanged — the single filesystem seam
// (fopen at CubeFile::open) is satisfied by MEMFS. See construct-wrapper.cpp.
//
// Upstream provenance / license (iccFromCube.cpp is ICC-licensed; this port
// preserves the notice):
//   The ICC Software License, Version 0.2
//   Copyright (c) 2003-2023 The International Color Consortium. All rights reserved.
//   Initial implementation by Max Derhak 3-09-2023.
//   Full license text: /home/colour/code/iccdev/Tools/CmdLine/IccFromCube/iccFromCube.cpp
#ifndef PROFILETOOL_FROMCUBE_ENGINE_HPP
#define PROFILETOOL_FROMCUBE_ENGINE_HPP

#include <cstdio>
#include <string>
#include <climits>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <cctype>
#include <cfloat>
#include <cstdint>

#include "IccProfile.h"
#include "IccTagBasic.h"
#include "IccTagMPE.h"
#include "IccMpeBasic.h"
#include "IccUtil.h"

namespace iccconstruct {

// Copied verbatim from Tools/CmdLine/IccCmdLineUtil.h:123 (see header note #2).
// Preserves CRLF and tab but hex-escapes other control / high bytes, so cube
// TITLE/comment text can't inject terminal escapes or malformed bytes into a
// profile's description/copyright tags.
inline std::string icSanitizeTagText(const char* szText)
{
  static const char hex[] = "0123456789ABCDEF";
  std::string result;

  if (!szText)
    return result;

  for (const unsigned char *p = (const unsigned char*)szText; *p; p++) {
    unsigned char ch = *p;

    switch (ch) {
    case '\n':
    case '\r':
    case '\t':
      result += (char)ch;
      break;
    default:
      if (ch < 0x20 || ch >= 0x7f) {  // && <= 0xFF implied by data type
        result += "\\x";
        result += hex[(ch >> 4) & 0xf];
        result += hex[ch & 0xf];
      }
      else {
        result += (char)ch;
      }
      break;
    }
  }

  return result;
}

inline std::string icSanitizeTagText(const std::string& text)
{
  return icSanitizeTagText(text.c_str());
}

// ── CubeFile ─────────────────────────────────────────────────────────────────
// Ported from iccFromCube.cpp:88-454. Parses an Adobe/Resolve `.cube` 3D-LUT
// text file into an in-memory description (grid size, input domain, title,
// comments) and, on demand, fills a caller-supplied float buffer with the LUT
// table. Reads through a FILE* (MEMFS-backed under WASM). All numeric parsing is
// range-checked; see the individual guards below — they are the security-
// relevant bounds and are carried over unchanged.
class CubeFile
{
public:
  CubeFile(const char* szFilename)
  {
    m_sFilename = szFilename;
  }
  ~CubeFile() { close(); }

  void close()
  {
    if (m_f)
      fclose(m_f);
    m_f = nullptr;
  }

  // Reason the last parse call failed, in the upstream tool's own wording
  // (empty when no failure). Routed here instead of printf so the wrapper can
  // return it to the browser.
  const std::string& error() const { return m_error; }

  bool parseHeader()
  {
    if (!open()) {
      m_error = "Unable to open cube data";
      return false;
    }

    m_title.clear();
    m_comments.clear();
    m_sizeLut3D = 0;
    m_fMinInput[0] = m_fMinInput[1] = m_fMinInput[2] = 0.0f;
    m_fMaxInput[0] = m_fMaxInput[1] = m_fMaxInput[2] = 1.0f;

    bool bAddBlankLine = false;
    while (!isEOF()) {
      long pos = ftell(m_f);
      if (pos < 0) {
        m_error = "header parsing error";
        return false;
      }
      std::string line = getNextLine();

      if (line.empty()) {
        if (m_comments.size()) {
          bAddBlankLine = true;
        }
      }
      else if (line[0] == '-' || line[0] == '.' || (line[0] >= '0' && line[0] <= '9')) {
        //undo getNextLine so it can be 3D table can be parsed
        int result = fseek(m_f, pos, SEEK_SET);
        if (result < 0) {
          m_error = "header parsing error";
          return false;
        }
        break;
      }
      else if (line.substr(0, 6) == "TITLE ") {
        if (m_title.size()) {
          m_title += "\n";
        }
        m_title += getTitle(line.c_str() + 6);
      }
      else if (line[0] == '#') {
        if (bAddBlankLine) {
          m_comments += "\n";
        }
        if (line[1]==' ')
          m_comments += line.c_str() + 2;
        else
          m_comments += line.c_str() + 1;
        m_comments += '\n';

        bAddBlankLine = false;
      }
      else if (line.substr(0, 12) == "LUT_1D_SIZE ") {
        m_error = "1DLUTs are not supported";
        return false;
      }
      else if (line.substr(0, 12) == "LUT_3D_SIZE ") {
        int64_t temp;
        if (!parseInteger(line.c_str() + 12, temp)) {
          m_error = "Invalid LUT_3D_SIZE value";
          return false;
        }
        // Bound [2,255] (iccFromCube.cpp:166-173): a size < 2 can't interpolate,
        // and > 255 would let the CLUT allocation (size^3 * 3 * 4 bytes; 255 =>
        // ~190 MB) run away against the WASM heap. Both re-checked in parse3DTable.
        if (temp < 2) {
            m_error = "LUT too small to process";
            return false;
        }
        if (temp > 255) {
            m_error = "LUT too large to process";
            return false;
        }
        m_sizeLut3D = (int)temp;
      }
      else if (line.substr(0, 19) == "LUT_3D_INPUT_RANGE ") {
        const char* cursor = line.c_str() + 19;
        icFloatNumber minVal, maxVal;
        if (!parseNextFloat(cursor, minVal)) {
          m_error = "Invalid LUT_3D_INPUT_RANGE value";
          return false;
        }
        m_fMinInput[0] = m_fMinInput[1] = m_fMinInput[2] = minVal;
        if (parseNextFloat(cursor, maxVal))
          m_fMaxInput[0] = m_fMaxInput[1] = m_fMaxInput[2] = maxVal;
        if (hasTrailingData(cursor)) {
          m_error = "Invalid LUT_3D_INPUT_RANGE value";
          return false;
        }
      }
      else if (line.substr(0, 11) == "DOMAIN_MIN ") {
        const char* cursor = line.c_str() + 11;
        if (!parseNextFloat(cursor, m_fMinInput[0])) {
          m_error = "Invalid DOMAIN_MIN value";
          return false;
        }
        if (!parseNextFloat(cursor, m_fMinInput[1])) {
          m_fMinInput[1] = m_fMinInput[2] = m_fMinInput[0];
        }
        else if (!parseNextFloat(cursor, m_fMinInput[2])) {
          m_fMinInput[2] = m_fMinInput[1];
        }
        if (hasTrailingData(cursor)) {
          m_error = "Invalid DOMAIN_MIN value";
          return false;
        }
      }
      else if (line.substr(0, 11) == "DOMAIN_MAX ") {
        const char* cursor = line.c_str() + 11;
        if (!parseNextFloat(cursor, m_fMaxInput[0])) {
          m_error = "Invalid DOMAIN_MAX value";
          return false;
        }
        if (!parseNextFloat(cursor, m_fMaxInput[1])) {
          m_fMaxInput[1] = m_fMaxInput[2] = m_fMaxInput[0];
        }
        else if (!parseNextFloat(cursor, m_fMaxInput[2])) {
          m_fMaxInput[2] = m_fMaxInput[1];
        }
        if (hasTrailingData(cursor)) {
          m_error = "Invalid DOMAIN_MAX value";
          return false;
        }
      }
      else if (line.substr(0, 18) == "LUT_IN_VIDEO_RANGE")
        m_bLutInVideoRange = true;
      else if (line.substr(0, 19) == "LUT_OUT_VIDEO_RANGE")
        m_bLutOutVideoRange = true;
      else {
        m_error = "Unknown keyword '" + line + "'";
        return false;
      }
    }

    // A header that ran to EOF without a numeric table start is malformed.
    if (isEOF()) {
      m_error = "No 3DLUT table found after header";
      return false;
    }
    return true;
  }

  std::string getDescription() { return m_title; }
  std::string getCopyright() { return m_comments; }

  icFloatNumber* getMinInput() { return m_fMinInput; }
  icFloatNumber* getMaxInput() { return m_fMaxInput; }

  bool isCustomInputRange()
  {
    if (!icIsNear(m_fMinInput[0], 0.0) || !icIsNear(m_fMinInput[1], 0.0) || !icIsNear(m_fMinInput[2], 0.0) ||
        !icIsNear(m_fMaxInput[0], 1.0) || !icIsNear(m_fMaxInput[1], 1.0) || !icIsNear(m_fMaxInput[2], 1.0))
      return true;
    return false;
  }

  int sizeLut3D() { return m_sizeLut3D; }

  // Fills `toLut` (caller-owned, must hold exactly nSizeLut = size^3 * 3 floats)
  // from the cube's 3D table rows. Re-validates the size bound and the exact
  // entry count so it can't over/under-run the buffer even if called directly.
  bool parse3DTable(icFloatNumber* toLut, icUInt32Number nSizeLut)
  {
    if (m_sizeLut3D < 2 || nSizeLut <= 0)
        return false;

    if (m_sizeLut3D > 255)
        return false;

    // size^3 in 64-bit, rejected if it overflows 32-bit — guards the point count
    // and, transitively, the *3 float count below.
    uint64_t temp = (uint64_t)m_sizeLut3D * (uint64_t)m_sizeLut3D * (uint64_t)m_sizeLut3D;
    if (temp > UINT_MAX)
        return false;
    icUInt32Number num = (icUInt32Number)temp;

    // The caller's buffer must be exactly size^3 * 3 floats — refuse a mismatch
    // rather than trust the count (prevents a short-buffer overrun).
    if ((uint64_t)nSizeLut != temp*3)
      return false;

    icUInt32Number n = 0;
    for (; n < num && !isEOF();) {
      std::string line = getNextLine();

      //Skip empty and commented lines
      if (line.empty() || line[0] == '#')
        continue;
      const char* cursor = line.c_str();
      if (!parseNextFloat(cursor, *toLut++)) {
        m_error = "Invalid 3DLUT entry";
        return false;
      }
      if (!parseNextFloat(cursor, *toLut++)) {
        m_error = "Invalid 3DLUT entry";
        return false;
      }
      if (!parseNextFloat(cursor, *toLut++)) {
        m_error = "Invalid 3DLUT entry";
        return false;
      }
      if (hasTrailingData(cursor)) {
        m_error = "Invalid 3DLUT entry";
        return false;
      }

      n++;
    }
    if (n != num) {
      m_error = "Incomplete 3DLUT table";
      return false;
    }

    while (!isEOF()) {
      std::string line = getNextLine();
      if (!line.empty() && line[0] != '#') {
        m_error = "Too many 3DLUT entries";
        return false;
      }
    }

    return true;
  }

protected:
  std::string m_sFilename;
  std::string m_error;

  static bool isSpace(char c)
  {
    return std::isspace(static_cast<unsigned char>(c)) != 0;
  }

  bool parseNextFloat(const char*& str, icFloatNumber& value)
  {
    while (*str && isSpace(*str))
      str++;

    if (!*str || *str == '#')
      return false;

    errno = 0;
    char* end = nullptr;
    double temp = std::strtod(str, &end);
    // Reject non-numeric, out-of-range, non-finite (NaN/Inf), and beyond-float
    // magnitudes — a LUT sample must be a finite float.
    if (end == str || errno == ERANGE || !std::isfinite(temp) || temp < -FLT_MAX || temp > FLT_MAX)
      return false;

    const char* tokenEnd = end;
    if (*tokenEnd && !isSpace(*tokenEnd) && *tokenEnd != '#')
      return false;

    value = (icFloatNumber)temp;
    str = end;
    return true;
  }

  bool parseInteger(const char* str, int64_t& value)
  {
    while (*str && isSpace(*str))
      str++;

    if (!*str || *str == '#')
      return false;

    errno = 0;
    char* end = nullptr;
    long long temp = std::strtoll(str, &end, 10);
    if (end == str || errno == ERANGE)
      return false;

    if (*end && !isSpace(*end) && *end != '#')
      return false;
    if (hasTrailingData(end))
      return false;

    value = (int64_t)temp;
    return true;
  }

  bool hasTrailingData(const char* str)
  {
    while (*str && isSpace(*str))
      str++;

    return *str && *str != '#';
  }

  bool open()
  {
    if (!m_f) {
      m_f = fopen(m_sFilename.c_str(), "rb");
    }
    else {
      int result = fseek(m_f, 0, SEEK_SET);
      if (result < 0)
        return false;
    }
    return m_f != nullptr;
  }

  std::string getTitle(const char* str)
  {
    std::string rv;
    bool bNeedQuote = false;
    if (*str == '\"') {
      bNeedQuote = true;
      str++;
    }
    while (*str && (!bNeedQuote || *str != '\"')) {
      rv += *str++;
    }

    return rv;
  }

  bool isEOF() { return m_f ? feof(m_f)!=0 : true; }

#define PROFILETOOL_CUBE_MAX_LINE_LEN 255

  std::string getNextLine()
  {
    std::string rv;
    for (int n=0; n<PROFILETOOL_CUBE_MAX_LINE_LEN && !isEOF(); n++) {
      int c = fgetc(m_f);

      if (c == EOF || c == '\n')
        break;

      if (c == '\r') //skip unsupported carriage returns
        continue;

      rv += static_cast<char>(static_cast<unsigned char>(c));
    }

    return rv;
  }

  FILE* m_f=nullptr;

  int m_sizeLut3D = 0;
  icFloatNumber m_fMinInput[3] = { 0.0f, 0.0f, 0.0f };
  icFloatNumber m_fMaxInput[3] = { 1.0f, 1.0f, 1.0f };

  std::string m_title;
  std::string m_comments;

  bool m_bLutInVideoRange = false;
  bool m_bLutOutVideoRange = false;
};

// ── buildDeviceLinkFromCube ──────────────────────────────────────────────────
// Ported from iccFromCube.cpp main():477-600. Builds a V5 RGB→RGB DeviceLink
// CIccProfile from an already-header-parsed CubeFile: an A2B0 MultiProcessElement
// tag (optional input CurveSet for a custom domain + a CLUT MPE), plus the
// required description / copyright / profileSequenceDesc tags.
//
// `srcLabel` stands in for the CLI's argv[1] (the source filename) in the two
// "Device link created from <x>" default texts. On success `profile` owns every
// attached tag. On failure returns false with `err` set and no leaks (the early
// exits delete the not-yet-attached tags, exactly as the CLI does).
inline bool buildDeviceLinkFromCube(CubeFile& cube, CIccProfile& profile,
                                    const std::string& srcLabel, std::string& err)
{
  //Initialize profile header
  profile.InitHeader();
  profile.m_Header.version = icVersionNumberV5;
  profile.m_Header.colorSpace = icSigRgbData;
  profile.m_Header.pcs = icSigRgbData;
  profile.m_Header.deviceClass = icSigLinkClass;

  //Create A2B0 Tag with LUT
  CIccTagMultiProcessElement* pTag = new CIccTagMultiProcessElement(3, 3);
  if (cube.isCustomInputRange()) {
    icFloatNumber* minVal = cube.getMinInput();
    icFloatNumber* maxVal = cube.getMaxInput();
    CIccMpeCurveSet* pCurves = new CIccMpeCurveSet(3);
    CIccSingleSampledCurve* pCurve0 = new CIccSingleSampledCurve(minVal[0], maxVal[0]);

    pCurve0->SetSize(2);
    pCurve0->GetSamples()[0] = 0;
    pCurve0->GetSamples()[1] = 1;

    pCurves->SetCurve(0, pCurve0);

    // Channels 1 and 2 reuse an earlier curve when their [min,max] matches, so
    // an identical-domain cube produces one shared curve (as upstream does).
    CIccSingleSampledCurve* pCurve1 = pCurve0;
    if (minVal[1] != minVal[0] || maxVal[1] != maxVal[0]) {
      pCurve1 = new CIccSingleSampledCurve(minVal[1], maxVal[1]);

      pCurve1->SetSize(2);
      pCurve1->GetSamples()[0] = 0;
      pCurve1->GetSamples()[1] = 1;
    }

    pCurves->SetCurve(1, pCurve1);

    CIccSingleSampledCurve* pCurve2 = pCurve0;

    if (minVal[2] != minVal[0] || maxVal[2] != maxVal[0]) {
      if (minVal[2] == minVal[1] && maxVal[2] == maxVal[1])
        pCurve2 = pCurve1;
      else {
        pCurve2 = new CIccSingleSampledCurve(minVal[2], maxVal[2]);

        pCurve2->SetSize(2);
        pCurve2->GetSamples()[0] = 0;
        pCurve2->GetSamples()[1] = 1;
      }
    }

    pCurves->SetCurve(2, pCurve2);

    pTag->Attach(pCurves);
  }

  CIccMpeCLUT* pMpeCLUT = new CIccMpeCLUT();
  CIccCLUT* pCLUT = new CIccCLUT(3, 3);

  if (!pCLUT->Init(cube.sizeLut3D()) ) {
    err = "Unable to allocate the LUT grid";
    delete pCLUT;
    delete pMpeCLUT;
    delete pTag;
    return false;
  }

  // Fill the CLUT directly from the cube's table rows (size^3 * 3 floats).
  bool bSuccess = cube.parse3DTable(pCLUT->GetData(0), pCLUT->NumPoints()*3);
  if (!bSuccess) {
    err = cube.error().empty() ? "Unable to parse LUT table" : cube.error();
    delete pCLUT;
    delete pMpeCLUT;
    delete pTag;
    return false;
  }

  pMpeCLUT->SetCLUT(pCLUT);
  pTag->Attach(pMpeCLUT);

  profile.AttachTag(icSigAToB0Tag, pTag);

  cube.close();

  //Add description Tag (from the cube TITLE, sanitized; else a default).
  CIccTagMultiLocalizedUnicode* pTextTag = new CIccTagMultiLocalizedUnicode();
  std::string desc = cube.getDescription();
  if (desc.size()) {
    std::string cleanText = icSanitizeTagText(desc);
    pTextTag->SetText(cleanText.c_str());
  }
  else {
    pTextTag->SetText((std::string("Device link created from ") + srcLabel).c_str());
  }
  profile.AttachTag(icSigProfileDescriptionTag, pTextTag);

  //Add copyright Tag -- required in every profile (ICC.2). Emitted
  //unconditionally, from the cube comments when present, else a default (#1379).
  pTextTag = new CIccTagMultiLocalizedUnicode();
  std::string copyright = cube.getCopyright();
  if (copyright.size()) {
    std::string cleanText = icSanitizeTagText(copyright);
    pTextTag->SetText(cleanText.c_str());
  }
  else
    pTextTag->SetText("Copyright ICC");
  profile.AttachTag(icSigCopyrightTag, pTextTag);

  //Add profileSequenceDescTag -- required in a DeviceLink (ICC.2, #1379).
  CIccTagProfileSeqDesc* pSeqTag = new CIccTagProfileSeqDesc();
  CIccProfileDescStruct seqDesc;
  seqDesc.m_deviceMfg = 0;
  seqDesc.m_deviceModel = 0;
  seqDesc.m_attributes = 0;
  seqDesc.m_technology = (icTechnologySignature)0;
  seqDesc.m_deviceMfgDesc.SetType(icSigMultiLocalizedUnicodeType);
  ((CIccTagMultiLocalizedUnicode*)seqDesc.m_deviceMfgDesc.GetTag())->SetText("International Color Consortium");
  seqDesc.m_deviceModelDesc.SetType(icSigMultiLocalizedUnicodeType);
  ((CIccTagMultiLocalizedUnicode*)seqDesc.m_deviceModelDesc.GetTag())->SetText(
    (std::string("Device link created from ") + srcLabel).c_str());
  pSeqTag->m_Descriptions->push_back(seqDesc);
  profile.AttachTag(icSigProfileSequenceDescTag, pSeqTag);

  return true;
}

} // namespace iccconstruct

#endif // PROFILETOOL_FROMCUBE_ENGINE_HPP
