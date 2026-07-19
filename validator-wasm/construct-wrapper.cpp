// (c) 2026 William Li
/**
 * iccconstruct WASM wrapper — the "construct a profile" module (Group B).
 *
 * Exposes profile-building verbs that take text/parameters and return ICC bytes:
 *   fromCube(string cubeText, string filename)        → Uint8Array  (.cube → DeviceLink)
 *   v5DspObsToV4(string dspBytes, string obsBytes)    → Uint8Array  (V5 display+observer → V4 display)
 *
 * (ApplyToLink will join this module as Group B lands.)
 *
 * Data flow mirrors the proven json-wrapper.cpp / xml-wrapper.cpp text→ICC path:
 *   - INPUT: the .cube is text. We stage it into Emscripten MEMFS so the ported
 *     CubeFile parser (fromcube-engine.hpp) — which reads through a FILE* — works
 *     unchanged. No host filesystem is touched; MEMFS is an in-memory tmpfs.
 *   - OUTPUT: CIccProfile::Write needs a seekable, grow-on-write IO that
 *     CIccMemIO lacks, so we SaveIccProfile() to a MEMFS path and read the bytes
 *     back — the same MEMFS hop json-wrapper.cpp documents. Both temp files are
 *     unlinked before returning so repeated calls don't grow MEMFS.
 *
 * Error contract matches jsonToIcc: success returns a Uint8Array; any failure
 * throws std::runtime_error(msg), which the JS side unwraps via
 * getExceptionMessage() and shows to the user (so a bad cube reports the exact
 * reason — "LUT too large to process", "1DLUTs are not supported", …).
 */
#include "fromcube-engine.hpp"

// IccProfLib headers for the V5→V4 construction (mirrors the CLI tool's includes:
// Tools/CmdLine/IccV5DspObsToV4Dsp/IccV5DspObsToV4Dsp.cpp). All of these compile
// into the iccconstruct target via ICCPROFLIB_SOURCES (see CMakeLists.txt).
#include "IccProfile.h"
#include "IccCmm.h"
#include "IccTag.h"
#include "IccTagMPE.h"
#include "IccTagLut.h"
#include "IccMpeBasic.h"
#include "IccMpeSpectral.h"
#include "IccColorimetry.h"   // CIccColorimetricCalculator — canonical spectral→XYZ (data methods)
#include "IccUtil.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

// A .cube grid is capped at 255 by the engine (255³×3×4 ≈ 190 MB), so the *text*
// that encodes it is far smaller — but this bounds the input the browser can
// hand us before we allocate/stage anything, independent of the JS-side check.
// 32 MB matches kMaxJsonBytes / kMaxXmlBytes. Do NOT reuse the XML DTD/entity
// guard here — .cube is not XML.
constexpr std::size_t kMaxCubeBytes = 32ULL * 1024 * 1024;

// Per-call counter so concurrent/reentrant calls don't collide on a MEMFS path
// (same shape as json-wrapper.cpp::uniqueMemfsPath).
std::string uniqueMemfsPath(const char* prefix, const char* ext) {
  static std::atomic<std::uint64_t> counter{0};
  char buf[64];
  std::snprintf(buf, sizeof(buf), "/tmp/profiletool_%s_%llu.%s",
                prefix,
                static_cast<unsigned long long>(counter.fetch_add(1)),
                ext);
  return std::string(buf);
}

bool writeFile(const char* path, const void* data, std::size_t size) {
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  bool ok = size == 0 || std::fwrite(data, 1, size, f) == size;
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
  bool ok = out.empty() || std::fread(out.data(), 1, out.size(), f) == out.size();
  std::fclose(f);
  return ok;
}

emscripten::val makeUint8Array(const std::uint8_t* data, std::size_t size) {
  emscripten::val u8 = emscripten::val::global("Uint8Array").new_(size);
  u8.call<void>("set",
    emscripten::val(emscripten::typed_memory_view(size, data)));
  return u8;
}

// JS-heap copy of a float buffer, independent of the WASM heap (mirrors plot-wrapper).
emscripten::val makeFloat32Array(const float* data, std::size_t count) {
  emscripten::val f32 = emscripten::val::global("Float32Array").new_(count);
  f32.call<void>("set", emscripten::val(emscripten::typed_memory_view(count, data)));
  return f32;
}

// Best-effort cleanup so a long-lived module doesn't accumulate MEMFS temp files.
void removeQuiet(const std::string& path) { std::remove(path.c_str()); }

// Each ICC-bytes entry point independently bounds its input (mirrors kMaxIccBytes
// in wrapper.cpp / MAX_ICC_BYTES in App.jsx) — no entry trusts the JS caller to
// have capped. V5 display/observer profiles are small; this only stops a hostile
// buffer from being staged into MEMFS.
constexpr std::size_t kMaxIccBytes = 256ULL * 1024 * 1024;

// RAII cleanup for MEMFS temp files: whatever paths we register are removed on
// scope exit, including when a rejection throws mid-construction.
struct MemfsTemp {
  std::vector<std::string> paths;
  const std::string& add(const std::string& p) { paths.push_back(p); return paths.back(); }
  ~MemfsTemp() { for (const auto& p : paths) std::remove(p.c_str()); }
};

emscripten::val fromCubeImpl(const std::string& cubeText, const std::string& filename) {
  if (cubeText.size() > kMaxCubeBytes) {
    throw std::runtime_error(
      "Cube file exceeds " + std::to_string(kMaxCubeBytes / (1024 * 1024)) + " MB limit");
  }
  // A label for the "Device link created from <x>" default texts; the browser
  // has no path, so use the uploaded filename (or a generic stand-in).
  const std::string srcLabel = filename.empty() ? "cube file" : filename;

  const std::string inPath = uniqueMemfsPath("cube_in", "cube");
  const std::string outPath = uniqueMemfsPath("cube_out", "icc");

  // Stage the .cube text so the FILE*-based parser can read it.
  if (!writeFile(inPath.c_str(), cubeText.data(), cubeText.size())) {
    throw std::runtime_error("Internal error staging the cube data");
  }

  std::string err;
  std::vector<std::uint8_t> bytes;
  {
    iccconstruct::CubeFile cube(inPath.c_str());

    // parseHeader / sizeLut3D mirror the CLI's main() gate (iccFromCube.cpp:467-475).
    if (!cube.parseHeader()) {
      removeQuiet(inPath);
      throw std::runtime_error(cube.error().empty() ? "Unable to parse the cube file"
                                                    : cube.error());
    }
    if (!cube.sizeLut3D()) {
      removeQuiet(inPath);
      throw std::runtime_error("No 3DLUT (LUT_3D_SIZE) found in the cube file");
    }

    CIccProfile profile;
    if (!iccconstruct::buildDeviceLinkFromCube(cube, profile, srcLabel, err)) {
      removeQuiet(inPath);
      throw std::runtime_error(err.empty() ? "Unable to build the device link" : err);
    }

    // Serialize via MEMFS (see file header). Default save method = the CLI's
    // SaveIccProfile(path, &profile) two-arg form (icVersionBasedID).
    if (!SaveIccProfile(outPath.c_str(), &profile)) {
      removeQuiet(inPath);
      removeQuiet(outPath);
      throw std::runtime_error("Unable to serialize the generated profile");
    }
    // `profile` (and its attached tags) is freed here as it leaves scope.
  }

  if (!readFile(outPath.c_str(), bytes)) {
    removeQuiet(inPath);
    removeQuiet(outPath);
    throw std::runtime_error("Internal error reading back the generated profile");
  }
  removeQuiet(inPath);
  removeQuiet(outPath);

  return makeUint8Array(bytes.data(), bytes.size());
}

// Exception-safe boundary: rethrow our own runtime_errors verbatim (their
// message is the user-facing reason), and convert any other C++ throw into a
// readable message so no profile can raise an opaque embind exception.
emscripten::val fromCube(const std::string& cubeText, const std::string& filename) {
  try {
    return fromCubeImpl(cubeText, filename);
  } catch (const std::runtime_error&) {
    throw;  // already carries a user-facing message
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("fromCube failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("fromCube failed with an unknown error");
  }
}

// ── V5 display + V5 observer → V4 display (item 5, iccV5DspObsToV4Dsp) ────────
// A faithful in-memory replication of the CLI tool's main()
// (Tools/CmdLine/IccV5DspObsToV4Dsp/IccV5DspObsToV4Dsp.cpp). We stage the two
// input profiles to MEMFS so ReadIccProfile() — including its bUseSubProfile
// handling for the display — behaves EXACTLY as the CLI, then serialize the
// result out the same SaveIccProfile→MEMFS hop fromCube uses. Every CLI rejection
// (return -2) becomes a std::runtime_error carrying the same reason, so the maker
// card surfaces the engine's specific verdict.
//
// The construction is the tool's, verbatim: rTRC/gTRC/bTRC from the display's
// curveSet MPE; rXYZ/gXYZ/bXYZ colorants from the emission matrix pushed through
// the observer's customToStandardPcc (M applied to the RGB basis vectors); the
// media white point as M*(1,1,1) in the standard D50 PCS. Output header is v4.3
// Display / RGB / PCSXYZ (#1371/#1384 conformance fixes).
typedef std::shared_ptr<CIccProfile> V4SharedProfile;
typedef std::shared_ptr<CIccApplyTagMpe> V4ApplyMpe;

emscripten::val v5DspObsToV4Impl(const std::string& dspBytes, const std::string& obsBytes) {
  if (dspBytes.size() > kMaxIccBytes || obsBytes.size() > kMaxIccBytes)
    throw std::runtime_error("Input profile exceeds the size limit");

  MemfsTemp tmp;
  const std::string dspPath = tmp.add(uniqueMemfsPath("v5dsp", "icc"));
  const std::string obsPath = tmp.add(uniqueMemfsPath("v5obs", "icc"));
  if (!writeFile(dspPath.c_str(), dspBytes.data(), dspBytes.size()) ||
      !writeFile(obsPath.c_str(), obsBytes.data(), obsBytes.size()))
    throw std::runtime_error("Internal error staging the input profiles");

  // ---- display profile (CLI argv[1]) ----
  V4SharedProfile dspIcc(ReadIccProfile(dspPath.c_str(), true));
  if (!dspIcc)
    throw std::runtime_error("Unable to parse the display profile");
  if (dspIcc->m_Header.version < icVersionNumberV5 ||
      dspIcc->m_Header.deviceClass != icSigDisplayClass)
    throw std::runtime_error("The display profile is not a V5 display profile");
  if (dspIcc->m_Header.colorSpace != icSigRgbData)
    throw std::runtime_error("The display profile is not an RGB display profile (data colour space must be 'RGB ')");

  CIccTagMultiProcessElement* pTagIn =
    (CIccTagMultiProcessElement*)dspIcc->FindTagOfType(icSigAToB1Tag, icSigMultiProcessElementType);
  if (!pTagIn)
    throw std::runtime_error("The display profile doesn't have an AToB1Tag of multiProcessElementType");

  CIccMultiProcessElement *curveMpe, *matrixMpe;
  if (pTagIn->NumElements() != 2 ||
      pTagIn->NumInputChannels() != 3 ||
      pTagIn->NumOutputChannels() != 3 ||
      ((curveMpe = pTagIn->GetElement(0)) == nullptr) ||
        curveMpe->GetType() != icSigCurveSetElemType ||
      ((matrixMpe = pTagIn->GetElement(1)) == nullptr) ||
        matrixMpe->GetType() != icSigEmissionMatrixElemType)
    throw std::runtime_error("The display profile doesn't have a spectral emission AToB1Tag");

  // ---- observer profile (CLI argv[2]) ----
  V4SharedProfile pccIcc(ReadIccProfile(obsPath.c_str()));
  if (!pccIcc)
    throw std::runtime_error("Unable to parse the observer profile");
  if (pccIcc->m_Header.version < icVersionNumberV5 ||
      pccIcc->m_Header.deviceClass != icSigColorSpaceClass)
    throw std::runtime_error("The observer profile is not a V5 observer (ColorSpace-class PCC) profile");

  CIccTagSpectralViewingConditions* pTagSvcn =
    (CIccTagSpectralViewingConditions*)pccIcc->FindTagOfType(icSigSpectralViewingConditionsTag, icSigSpectralViewingConditionsType);
  CIccTagMultiProcessElement* pTagC2S =
    (CIccTagMultiProcessElement*)pccIcc->FindTagOfType(icSigCustomToStandardPccTag, icSigMultiProcessElementType);

  icSpectralRange obsRange;
  if (!pTagSvcn || !pTagC2S ||
      pTagC2S->NumInputChannels() != 3 || pTagC2S->NumOutputChannels() != 3 ||
      !pTagSvcn->getObserver(obsRange) || !obsRange.steps)
    throw std::runtime_error("The observer profile doesn't have Profile Connection Conditions (observer + customToStandardPcc)");

  if (!pTagIn->Begin(icElemInterpLinear, dspIcc.get(), pccIcc.get()))
    throw std::runtime_error("Bad AToB1 transform in the display profile");

  V4ApplyMpe pApplyMpe(pTagIn->GetNewApply());
  auto applyList = pApplyMpe->GetList();
  auto applyIter = applyList->begin();
  auto curveApply = applyIter->ptr;
  applyIter++;
  auto mtxApply = applyIter->ptr;

  if (!pTagC2S->Begin(icElemInterpLinear, pccIcc.get()))
    throw std::runtime_error("Bad customToStandardPcc transform in the observer profile");

  V4ApplyMpe pAppyC2S(pTagC2S->GetNewApply());

  // ---- construct the V4 RGB matrix/TRC display profile ----
  std::unique_ptr<CIccProfile> pIcc(new CIccProfile());
  pIcc->InitHeader();
  pIcc->m_Header.deviceClass = icSigDisplayClass;
  pIcc->m_Header.version = icVersionNumberV4_3;
  pIcc->m_Header.colorSpace = icSigRgbData;   // #1371: matrix/TRC display is RGB…
  pIcc->m_Header.pcs = icSigXYZData;          // …with a PCSXYZ connection space

  CIccTag* pDesc = dspIcc->FindTag(icSigProfileDescriptionTag);
  CIccTagMultiLocalizedUnicode* pDspText = new CIccTagMultiLocalizedUnicode();
  std::string text;
  if (!icGetTagText(pDesc, text))
    text = "Display profile from a V5 display and observer";
  pDspText->SetText(text.c_str());
  pIcc->AttachTag(icSigProfileDescriptionTag, pDspText);   // ownership → profile

  pDspText = new CIccTagMultiLocalizedUnicode();
  pDspText->SetText("Copyright (C) 2025 International Color Consortium");
  pIcc->AttachTag(icSigCopyrightTag, pDspText);

  CIccTagCurve* pTrcR = new CIccTagCurve(2048);
  CIccTagCurve* pTrcG = new CIccTagCurve(2048);
  CIccTagCurve* pTrcB = new CIccTagCurve(2048);
  icFloatNumber in[3], out[3];
  for (icUInt16Number i = 0; i < 2048; i++) {
    in[0] = in[1] = in[2] = (icFloatNumber)i / 2047.0f;
    curveMpe->Apply(curveApply, out, in);
    (*pTrcR)[i] = out[0];
    (*pTrcG)[i] = out[1];
    (*pTrcB)[i] = out[2];
  }
  pIcc->AttachTag(icSigRedTRCTag, pTrcR);
  pIcc->AttachTag(icSigGreenTRCTag, pTrcG);
  pIcc->AttachTag(icSigBlueTRCTag, pTrcB);

  const icFloatNumber rRGB[3] = { 1.0f, 0.0f, 0.0f };
  const icFloatNumber gRGB[3] = { 0.0f, 1.0f, 0.0f };
  const icFloatNumber bRGB[3] = { 0.0f, 0.0f, 1.0f };

  matrixMpe->Apply(mtxApply, in, rRGB);
  pTagC2S->Apply(pAppyC2S.get(), out, in);
  CIccTagXYZ* primaryXYZ = new CIccTagXYZ;   // #1371: colorants MUST be XYZType
  (*primaryXYZ)[0].X = icDtoF(out[0]); (*primaryXYZ)[0].Y = icDtoF(out[1]); (*primaryXYZ)[0].Z = icDtoF(out[2]);
  pIcc->AttachTag(icSigRedColorantTag, primaryXYZ);

  matrixMpe->Apply(mtxApply, in, gRGB);
  pTagC2S->Apply(pAppyC2S.get(), out, in);
  primaryXYZ = new CIccTagXYZ;
  (*primaryXYZ)[0].X = icDtoF(out[0]); (*primaryXYZ)[0].Y = icDtoF(out[1]); (*primaryXYZ)[0].Z = icDtoF(out[2]);
  pIcc->AttachTag(icSigGreenColorantTag, primaryXYZ);

  matrixMpe->Apply(mtxApply, in, bRGB);
  pTagC2S->Apply(pAppyC2S.get(), out, in);
  primaryXYZ = new CIccTagXYZ;
  (*primaryXYZ)[0].X = icDtoF(out[0]); (*primaryXYZ)[0].Y = icDtoF(out[1]); (*primaryXYZ)[0].Z = icDtoF(out[2]);
  pIcc->AttachTag(icSigBlueColorantTag, primaryXYZ);

  // #1371: mediaWhitePoint is DERIVED as M*(1,1,1) in the standard D50 PCS —
  // neither source white is usable (argv[1] pre-observer-integration, argv[2]
  // pre-D65→D50 adaptation).
  const icFloatNumber wRGB[3] = { 1.0f, 1.0f, 1.0f };
  matrixMpe->Apply(mtxApply, in, wRGB);
  pTagC2S->Apply(pAppyC2S.get(), out, in);
  CIccTagXYZ* whiteXYZ = new CIccTagXYZ;
  (*whiteXYZ)[0].X = icDtoF(out[0]); (*whiteXYZ)[0].Y = icDtoF(out[1]); (*whiteXYZ)[0].Z = icDtoF(out[2]);
  pIcc->AttachTag(icSigMediaWhitePointTag, whiteXYZ);

  const std::string outPath = tmp.add(uniqueMemfsPath("v4out", "icc"));
  if (!SaveIccProfile(outPath.c_str(), pIcc.get()))
    throw std::runtime_error("Unable to serialize the generated V4 profile");

  std::vector<std::uint8_t> bytes;
  if (!readFile(outPath.c_str(), bytes))
    throw std::runtime_error("Internal error reading back the generated profile");

  return makeUint8Array(bytes.data(), bytes.size());
}

// Exception-safe boundary (same shape as fromCube): our runtime_errors carry the
// user-facing reason and pass through; anything else becomes a readable message.
emscripten::val v5DspObsToV4(const std::string& dspBytes, const std::string& obsBytes) {
  try {
    return v5DspObsToV4Impl(dspBytes, obsBytes);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("V4 display build failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("V4 display build failed with an unknown error");
  }
}

// ── DeviceLink from an ordered profile chain (Pipeline builder, DL-PIPELINE1) ──
// In-memory port of iccApplyToLink's core (Tools/CmdLine/IccApplyToLink): assemble
// the N-profile chain into one CIccCmm (AddXform×N + Begin), then sample that single
// transform into a v4 lutAtoB CLUT and emit a 'link'-class profile. Inputs are read
// straight from the byte buffers (ReadIccProfile memory overload — no MEMFS needed);
// only the OUTPUT takes the SaveIccProfile→MEMFS→read-back hop the other producers
// use (CIccProfile::Write needs a grow-on-write IO CIccMemIO lacks).
//
// v1 defaults, deliberately simple (matches DL-PIPELINE1 scope): every stage uses one
// rendering intent (relative colorimetric), tetrahedral interpolation, input range
// [0,1], v4.3 16-bit lutAtoB. Per-stage intent/BPC/PCC + v5 MPE links are a later
// enrichment. The engine is authoritative on chain compatibility — a stage that does
// not connect surfaces CIccCmm::GetStatusText (e.g. icCmmStatBadSpaceLink).

// Auto CLUT grid: largest resolution whose node count (grid^nSrc) stays under a
// budget, then pin the common device counts to conventional tables so a normal RGB/
// CMYK chain gets a standard-size LUT rather than the max the budget allows.
int chooseGrid(int nSrc) {
  const double kNodeBudget = 1500000.0;
  int g = 2;
  for (int t = 3; t <= 255; ++t) {
    double p = 1.0;
    for (int k = 0; k < nSrc; ++k) p *= (double)t;
    if (p > kNodeBudget) break;
    g = t;
  }
  const int cap = (nSrc <= 1) ? 255 : (nSrc == 2) ? 128 : (nSrc == 3) ? 33 : (nSrc == 4) ? 17 : g;
  if (g > cap) g = cap;
  return g < 2 ? 2 : g;
}

// Clamp a JS intent int to a valid icRenderingIntent (default relative colorimetric).
static icRenderingIntent clampIntent(int v) {
  return (v >= (int)icPerceptual && v <= (int)icAbsoluteColorimetric)
    ? (icRenderingIntent)v : icRelativeColorimetric;
}
// Per-profile rendering intents. Accepts a JS array (one int per profile) OR a scalar
// applied to all; anything missing/out-of-range falls back to relative. The UI now
// picks an intent PER TRANSFORM (each profile contributes one xform), so the CMM must
// receive an array, not one intent for the whole chain.
static std::vector<icRenderingIntent> parseIntents(emscripten::val v, unsigned n) {
  std::vector<icRenderingIntent> out(n, icRelativeColorimetric);
  if (v.isArray()) {
    unsigned len = v["length"].as<unsigned>();
    for (unsigned i = 0; i < n; ++i)
      out[i] = clampIntent(i < len ? v[i].as<int>() : (int)icRelativeColorimetric);
  } else if (!v.isUndefined() && !v.isNull()) {
    icRenderingIntent one = clampIntent(v.as<int>());
    for (auto& e : out) e = one;
  }
  return out;
}

emscripten::val buildLinkImpl(emscripten::val chainVal, emscripten::val intentsVal,
                              bool firstInput, int gridArg) {
  const unsigned n = chainVal["length"].as<unsigned>();
  if (n == 0) throw std::runtime_error("Add at least one profile to the chain.");

  const std::vector<icRenderingIntent> intents = parseIntents(intentsVal, n);

  // Let the profiles fix the start/end spaces. bFirstInput = the HEAD transform's
  // direction: true = the first profile is used device→PCS (the chain's source);
  // false = PCS→device (head reversed). The CMM alternates from there, so this single
  // flag ripples the whole chain's directionality — matching the UI's head toggle.
  CIccCmm theCmm(icSigUnknownData, icSigUnknownData, firstInput);

  // profileSequenceDescTag is a REQUIRED tag for a DeviceLink profile (a link without
  // it fails validation: "Critical tag(s) missing"). Build one entry per stage from
  // that profile's header + technology, captured BEFORE AddXform takes ownership.
  // Held in a unique_ptr so a mid-chain throw frees it; ownership transfers to the
  // output profile via AttachTag(...release()) once the LUT is built.
  std::unique_ptr<CIccTagProfileSeqDesc> pSeq(new CIccTagProfileSeqDesc());

  for (unsigned i = 0; i < n; ++i) {
    std::vector<std::uint8_t> buf =
      emscripten::convertJSArrayToNumberVector<std::uint8_t>(chainVal[i]);
    if (buf.empty())
      throw std::runtime_error("A chained profile is empty.");
    if (buf.size() > kMaxIccBytes)
      throw std::runtime_error("A chained profile exceeds the size limit.");
    // ReadIccProfile allocates; on AddXform SUCCESS the CMM takes ownership, and on
    // FAILURE AddXform frees it (#1327) — so we never delete pXform ourselves, and
    // theCmm's destructor (stack unwind on throw) frees all accepted stages.
    CIccProfile* pXform = ReadIccProfile(buf.data(), (icUInt32Number)buf.size());
    if (!pXform)
      throw std::runtime_error("A chained profile could not be read as an ICC profile.");

    // Record provenance for the profileSequenceDesc (mirrors CDevLinkWriter::iterate).
    CIccProfileDescStruct psd;
    psd.m_deviceMfg = pXform->m_Header.manufacturer;
    psd.m_deviceModel = pXform->m_Header.model;
    psd.m_attributes = pXform->m_Header.attributes;
    psd.m_technology = (icTechnologySignature)0;
    const CIccTag* pTech = pXform->FindTagConst(icSigTechnologyTag);
    if (pTech && pTech->GetType() == icSigSignatureType)
      psd.m_technology = (icTechnologySignature)((const CIccTagSignature*)pTech)->GetValue();
    // The two desc members MUST carry a valid tag or the sequence fails to serialize
    // (a default CIccProfileDescText has a null internal tag). Give each a
    // textDescription, filled from the source profile's own mfg/model desc where
    // present, else a placeholder. CIccProfileDescStruct deep-copies on push_back.
    std::string mfgText = "Device Manufacturer", modelText = "Device Model";
    if (CIccTag* pT = pXform->FindTag(icSigDeviceMfgDescTag)) {
      std::string s; if (icGetTagText(pT, s) && !s.empty()) mfgText = s;
    }
    if (CIccTag* pT = pXform->FindTag(icSigDeviceModelDescTag)) {
      std::string s; if (icGetTagText(pT, s) && !s.empty()) modelText = s;
    }
    psd.m_deviceMfgDesc.SetType(icSigTextDescriptionType);
    if (CIccTagTextDescription* t = (CIccTagTextDescription*)psd.m_deviceMfgDesc.GetTag())
      t->SetText(mfgText.c_str());
    psd.m_deviceModelDesc.SetType(icSigTextDescriptionType);
    if (CIccTagTextDescription* t = (CIccTagTextDescription*)psd.m_deviceModelDesc.GetTag())
      t->SetText(modelText.c_str());
    pSeq->m_Descriptions->push_back(psd);

    icStatusCMM stat = theCmm.AddXform(pXform, intents[i], icInterpTetrahedral,
                                       /*pPcc=*/NULL, icXformLutColor,
                                       /*bUseD2BxB2DxTags=*/true, /*pHint=*/NULL);
    if (stat)
      throw std::runtime_error("Cannot link profile " + std::to_string(i + 1) + ": "
                               + CIccCmm::GetStatusText(stat));
  }

  icStatusCMM stat = theCmm.Begin();
  if (stat)
    throw std::runtime_error(std::string("The chain does not connect: ")
                             + CIccCmm::GetStatusText(stat));

  const icColorSpaceSignature srcSpace = theCmm.GetSourceSpace();
  const icColorSpaceSignature dstSpace = theCmm.GetDestSpace();
  const int nSrc = (int)icGetSpaceSamples(srcSpace);
  const int nDst = (int)icGetSpaceSamples(dstSpace);
  if (nSrc < 1 || nDst < 1)
    throw std::runtime_error("The chain has an unusable colour space.");
  if (nSrc > 15 || nDst > 15)
    throw std::runtime_error("Too many colour channels for a v4 DeviceLink (max 15).");

  int grid = (gridArg > 0) ? gridArg : chooseGrid(nSrc);
  if (grid < 2) grid = 2;
  if (grid > 255) grid = 255;

  // CWE-400 ceiling: nodes = grid^nSrc, guarded against 32-bit overflow + OOM.
  unsigned long long nodes = 1;
  for (int k = 0; k < nSrc; ++k) {
    nodes *= (unsigned long long)grid;
    if (nodes > 8000000ULL)
      throw std::runtime_error("The DeviceLink table would be too large — reduce the input channel count.");
  }

  std::unique_ptr<CIccProfile> pIcc(new CIccProfile());
  pIcc->InitHeader();
  pIcc->m_Header.deviceClass = icSigLinkClass;
  pIcc->m_Header.version = icVersionNumberV4_3;
  pIcc->m_Header.colorSpace = srcSpace;
  pIcc->m_Header.pcs = dstSpace;

  CIccTagMultiLocalizedUnicode* pDesc = new CIccTagMultiLocalizedUnicode();
  pDesc->SetText("DeviceLink created by profiletool");
  pIcc->AttachTag(icSigProfileDescriptionTag, pDesc);
  CIccTagMultiLocalizedUnicode* pCopy = new CIccTagMultiLocalizedUnicode();
  pCopy->SetText("Copyright ICC");
  pIcc->AttachTag(icSigCopyrightTag, pCopy);

  // v4 lutAtoB: identity A/B curves + the sampled CLUT (mirrors CDevLinkWriter's v4 path).
  CIccTagLutAtoB* pTagLut = new CIccTagLutAtoB();
  pTagLut->Init((icUInt8Number)nSrc, (icUInt8Number)nDst);
  LPIccCurve* pCurvesA = pTagLut->NewCurvesA();
  for (int i = 0; i < nSrc; ++i) pCurvesA[i] = new CIccTagCurve();   // empty curve = identity
  LPIccCurve* pCurvesB = pTagLut->NewCurvesB();
  for (int i = 0; i < nDst; ++i) pCurvesB[i] = new CIccTagCurve();
  CIccCLUT* pCLUT = pTagLut->NewCLUT((icUInt8Number)grid);
  if (!pCLUT) { delete pTagLut; throw std::runtime_error("Could not allocate the DeviceLink table."); }
  pIcc->AttachTag(icSigAToB0Tag, pTagLut);

  // Required DeviceLink tag: the profile sequence populated during chain assembly.
  pIcc->AttachTag(icSigProfileSequenceDescTag, pSeq.release());

  // Sample the CMM at every grid node (input range [0,1]); last source channel varies
  // fastest → matches CIccCLUT's row-major layout, so a sequential fill is correct.
  icFloatNumber* pLut = pCLUT->GetData(0);
  const icUInt32Number total = pCLUT->NumPoints();
  std::vector<int> idx(nSrc, 0);
  std::vector<icFloatNumber> src(nSrc, 0.0f), dst(nDst, 0.0f);
  const icFloatNumber maxLut = (icFloatNumber)(grid - 1);
  for (icUInt32Number c = 0; c < total; ++c) {
    for (int si = 0; si < nSrc; ++si) src[si] = (icFloatNumber)idx[si] / maxLut;
    theCmm.Apply(&dst[0], &src[0]);
    std::memcpy(pLut, &dst[0], (std::size_t)nDst * sizeof(icFloatNumber));
    pLut += nDst;
    for (int j = nSrc - 1; j >= 0; ) {
      if (++idx[j] >= grid) { idx[j] = 0; --j; } else break;
    }
  }

  MemfsTemp tmp;
  const std::string outPath = tmp.add(uniqueMemfsPath("link_out", "icc"));
  if (!SaveIccProfile(outPath.c_str(), pIcc.get()))
    throw std::runtime_error("Unable to serialize the DeviceLink.");
  std::vector<std::uint8_t> bytes;
  if (!readFile(outPath.c_str(), bytes))
    throw std::runtime_error("Internal error reading back the DeviceLink.");
  return makeUint8Array(bytes.data(), bytes.size());
}

// Exception-safe boundary (same shape as fromCube / v5DspObsToV4).
emscripten::val buildLink(emscripten::val chainVal, emscripten::val intents, bool firstInput, int grid) {
  try {
    return buildLinkImpl(chainVal, intents, firstInput, grid);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("DeviceLink build failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("DeviceLink build failed with an unknown error");
  }
}

// A 4-char space signature as a string ('RGB ', 'CMYK', 'Lab ', …) for the UI.
std::string sigToStr(icColorSpaceSignature sig) {
  const icUInt32Number v = (icUInt32Number)sig;
  char b[5] = {
    (char)((v >> 24) & 0xff), (char)((v >> 16) & 0xff),
    (char)((v >> 8) & 0xff),  (char)(v & 0xff), 0
  };
  return std::string(b, 4);
}

// ── chainInfo — AUTHORITATIVE, cheap chain validation for the UI ──────────────
// Runs the SAME CMM assembly buildLink does (AddXform×N + Begin) but stops there —
// no LUT sampling, no profile write — so it is cheap enough to run on every chain
// edit. Returns a plain object the Pipeline builder uses to gate outcomes + explain
// invalid combinations, NEVER throwing (a bad chain is a normal result, not an
// error): { ok, error?, failedStage?, sourceSpace?, destSpace?, sourceSamples?,
// destSamples? }. failedStage is the 1-based stage that broke, or 0 for a Begin()
// failure. This is the definitive connectivity answer — the header-signature guess
// in lib/pipeline.js cannot know true CMM space-linking.
emscripten::val chainInfoImpl(emscripten::val chainVal, emscripten::val intentsVal, bool firstInput) {
  emscripten::val r = emscripten::val::object();
  const unsigned n = chainVal["length"].as<unsigned>();
  if (n == 0) { r.set("ok", false); r.set("empty", true); return r; }

  const std::vector<icRenderingIntent> intents = parseIntents(intentsVal, n);

  CIccCmm theCmm(icSigUnknownData, icSigUnknownData, firstInput);
  for (unsigned i = 0; i < n; ++i) {
    std::vector<std::uint8_t> buf =
      emscripten::convertJSArrayToNumberVector<std::uint8_t>(chainVal[i]);
    if (buf.empty() || buf.size() > kMaxIccBytes) {
      r.set("ok", false); r.set("failedStage", (int)(i + 1));
      r.set("error", std::string("Profile ") + std::to_string(i + 1) + " is empty or too large.");
      return r;
    }
    CIccProfile* p = ReadIccProfile(buf.data(), (icUInt32Number)buf.size());
    if (!p) {
      r.set("ok", false); r.set("failedStage", (int)(i + 1));
      r.set("error", std::string("Profile ") + std::to_string(i + 1) + " is not a readable ICC profile.");
      return r;
    }
    icStatusCMM stat = theCmm.AddXform(p, intents[i], icInterpTetrahedral,
                                       NULL, icXformLutColor, true, NULL);
    if (stat) {
      r.set("ok", false); r.set("failedStage", (int)(i + 1));
      r.set("error", std::string(CIccCmm::GetStatusText(stat)));
      return r;
    }
  }
  icStatusCMM stat = theCmm.Begin();
  if (stat) {
    r.set("ok", false); r.set("failedStage", 0);
    r.set("error", std::string(CIccCmm::GetStatusText(stat)));
    return r;
  }
  const icColorSpaceSignature src = theCmm.GetSourceSpace();
  const icColorSpaceSignature dst = theCmm.GetDestSpace();
  r.set("ok", true);
  r.set("sourceSpace", sigToStr(src));
  r.set("destSpace", sigToStr(dst));
  r.set("sourceSamples", (int)icGetSpaceSamples(src));
  r.set("destSamples", (int)icGetSpaceSamples(dst));
  return r;
}

emscripten::val chainInfo(emscripten::val chainVal, emscripten::val intents, bool firstInput) {
  try {
    return chainInfoImpl(chainVal, intents, firstInput);
  } catch (...) {
    emscripten::val r = emscripten::val::object();
    r.set("ok", false);
    r.set("error", std::string("Could not analyse the chain."));
    return r;
  }
}

// ── applyImage — run a decoded raster through the chain (Pipeline "process images") ──
// The image analogue of buildLink: assemble the chain into one CMM, then push every
// pixel through it. The pixels are decoded IN THE BROWSER (no libtiff/format code in
// WASM): srcBytes is the raw bytes of a Float32Array holding nPixels × nSrcCh samples
// normalized to [0,1] in the chain's source device space, row-major. Returns the
// destination pixels as a Float32Array (nDst per pixel, [0,1]) for the browser to
// encode. Bytes-in/bytes-out only — the format layer stays in JS (lib/imageIO.js).
emscripten::val applyImageImpl(emscripten::val chainVal, std::string srcBytes,
                               int nSrcCh, emscripten::val intentsVal, bool firstInput) {
  const unsigned n = chainVal["length"].as<unsigned>();
  if (n == 0) throw std::runtime_error("Add at least one profile to the chain.");
  if (nSrcCh < 1) throw std::runtime_error("The image has no colour channels.");
  if (srcBytes.size() % (std::size_t)(nSrcCh * 4) != 0)
    throw std::runtime_error("Malformed pixel buffer.");
  const std::size_t nPixels = srcBytes.size() / (std::size_t)(nSrcCh * 4);
  if (nPixels == 0) throw std::runtime_error("The image is empty.");
  if (nPixels > 64000000ULL)
    throw std::runtime_error("The image is too large to process (over 64 megapixels).");

  const std::vector<icRenderingIntent> intents = parseIntents(intentsVal, n);

  CIccCmm theCmm(icSigUnknownData, icSigUnknownData, firstInput);
  for (unsigned i = 0; i < n; ++i) {
    std::vector<std::uint8_t> buf =
      emscripten::convertJSArrayToNumberVector<std::uint8_t>(chainVal[i]);
    if (buf.empty() || buf.size() > kMaxIccBytes)
      throw std::runtime_error("A chained profile is empty or too large.");
    CIccProfile* p = ReadIccProfile(buf.data(), (icUInt32Number)buf.size());
    if (!p) throw std::runtime_error("A chained profile could not be read.");
    icStatusCMM stat = theCmm.AddXform(p, intents[i], icInterpTetrahedral,
                                       NULL, icXformLutColor, true, NULL);
    if (stat)
      throw std::runtime_error("Cannot link profile " + std::to_string(i + 1) + ": "
                               + CIccCmm::GetStatusText(stat));
  }
  icStatusCMM stat = theCmm.Begin();
  if (stat)
    throw std::runtime_error(std::string("The chain does not connect: ")
                             + CIccCmm::GetStatusText(stat));

  const int nSrc = (int)icGetSpaceSamples(theCmm.GetSourceSpace());
  const int nDst = (int)icGetSpaceSamples(theCmm.GetDestSpace());
  if (nSrc != nSrcCh)
    throw std::runtime_error("This image has " + std::to_string(nSrcCh)
      + " channel(s) but the chain expects a " + std::to_string(nSrc) + "-channel source image.");
  if (nDst < 1) throw std::runtime_error("The chain has an unusable output space.");

  const float* src = reinterpret_cast<const float*>(srcBytes.data());
  std::vector<float> dst((std::size_t)nPixels * nDst);
  // Per-pixel apply (icFloatNumber == float in this build). Straightforward + lets a
  // later stage add progress/cancellation; the CMM is already Begin()'d.
  for (std::size_t px = 0; px < nPixels; ++px)
    theCmm.Apply(&dst[px * nDst], &src[px * nSrc]);

  emscripten::val r = emscripten::val::object();
  r.set("ok", true);
  r.set("destSamples", nDst);
  r.set("pixels", makeFloat32Array(dst.data(), dst.size()));
  return r;
}

emscripten::val applyImage(emscripten::val chainVal, std::string srcBytes, int nSrcCh,
                           emscripten::val intents, bool firstInput) {
  try {
    return applyImageImpl(chainVal, srcBytes, nSrcCh, intents, firstInput);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("Image processing failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("Image processing failed with an unknown error");
  }
}

// ── CHUNKED image apply — bounded-memory streaming for LARGE rasters ───────────
// applyImage above copies the WHOLE float image into WASM plus a full output vector,
// which std::bad_allocs on a big CMYK TIFF (a 24 MP 4-channel float image is ~384 MB
// each way — past the 32-bit heap). This session API builds the CMM ONCE and applies
// the raster in caller-sized chunks, so WASM only ever holds one chunk at a time. The
// UI streams ~1 MP chunks (see lib/pipelineEngine.js applyToImage). Single image at a
// time (profiletool's design), so one static session slot is enough.
static std::unique_ptr<CIccCmm> g_imgCmm;
static int g_imgNSrc = 0, g_imgNDst = 0;

emscripten::val imageApplyBeginImpl(emscripten::val chainVal, int nSrcCh,
                                    emscripten::val intentsVal, bool firstInput) {
  g_imgCmm.reset(); g_imgNSrc = g_imgNDst = 0;
  const unsigned n = chainVal["length"].as<unsigned>();
  if (n == 0) throw std::runtime_error("Add at least one profile to the chain.");
  if (nSrcCh < 1) throw std::runtime_error("The image has no colour channels.");

  const std::vector<icRenderingIntent> intents = parseIntents(intentsVal, n);
  std::unique_ptr<CIccCmm> cmm(new CIccCmm(icSigUnknownData, icSigUnknownData, firstInput));
  for (unsigned i = 0; i < n; ++i) {
    std::vector<std::uint8_t> buf =
      emscripten::convertJSArrayToNumberVector<std::uint8_t>(chainVal[i]);
    if (buf.empty() || buf.size() > kMaxIccBytes)
      throw std::runtime_error("A chained profile is empty or too large.");
    CIccProfile* p = ReadIccProfile(buf.data(), (icUInt32Number)buf.size());
    if (!p) throw std::runtime_error("A chained profile could not be read.");
    icStatusCMM stat = cmm->AddXform(p, intents[i], icInterpTetrahedral,
                                     NULL, icXformLutColor, true, NULL);
    if (stat)
      throw std::runtime_error("Cannot link profile " + std::to_string(i + 1) + ": "
                               + CIccCmm::GetStatusText(stat));
  }
  icStatusCMM stat = cmm->Begin();
  if (stat)
    throw std::runtime_error(std::string("The chain does not connect: ")
                             + CIccCmm::GetStatusText(stat));

  const int nSrc = (int)icGetSpaceSamples(cmm->GetSourceSpace());
  const int nDst = (int)icGetSpaceSamples(cmm->GetDestSpace());
  if (nSrc != nSrcCh)
    throw std::runtime_error("This image has " + std::to_string(nSrcCh)
      + " channel(s) but the chain expects a " + std::to_string(nSrc) + "-channel source image.");
  if (nDst < 1) throw std::runtime_error("The chain has an unusable output space.");

  g_imgCmm = std::move(cmm); g_imgNSrc = nSrc; g_imgNDst = nDst;
  emscripten::val r = emscripten::val::object();
  r.set("ok", true); r.set("nSrc", nSrc); r.set("nDst", nDst);
  return r;
}

emscripten::val imageApplyBegin(emscripten::val chainVal, int nSrcCh,
                                emscripten::val intents, bool firstInput) {
  try {
    return imageApplyBeginImpl(chainVal, nSrcCh, intents, firstInput);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("Image processing failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("Image processing failed with an unknown error");
  }
}

// Apply one chunk of pixels (raw bytes of a Float32Array, nPixels × nSrc in [0,1])
// through the active session → { pixels: Float32Array (nPixels × nDst), nDst }.
emscripten::val imageApplyChunkImpl(std::string srcBytes) {
  if (!g_imgCmm) throw std::runtime_error("No image session is active.");
  const int nSrc = g_imgNSrc, nDst = g_imgNDst;
  if (srcBytes.size() % (std::size_t)(nSrc * 4) != 0)
    throw std::runtime_error("Malformed pixel chunk.");
  const std::size_t nPix = srcBytes.size() / (std::size_t)(nSrc * 4);
  if (nPix > 8000000ULL)   // ~128 MB per side at 4ch — keep chunks well under this
    throw std::runtime_error("Image chunk too large.");
  const float* src = reinterpret_cast<const float*>(srcBytes.data());
  std::vector<float> dst(nPix * (std::size_t)nDst);
  for (std::size_t px = 0; px < nPix; ++px)
    g_imgCmm->Apply(&dst[px * nDst], &src[px * nSrc]);
  emscripten::val r = emscripten::val::object();
  r.set("pixels", makeFloat32Array(dst.data(), dst.size()));
  r.set("nDst", nDst);
  return r;
}

emscripten::val imageApplyChunk(std::string srcBytes) {
  try {
    return imageApplyChunkImpl(srcBytes);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("Image processing failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("Image processing failed with an unknown error");
  }
}

// Release the active session (frees the CMM). Safe to call with no session.
void imageApplyEnd() { g_imgCmm.reset(); g_imgNSrc = g_imgNDst = 0; }

// ── applyValues — run a colour LIST through the chain (Transform Data) ─────────
// The point-data analogue of applyImage (this is profiletool's iccApplyNamedCmm
// equivalent). Where applyImage assumes pixels are already normalized to the CMM's
// internal [0,1] device encoding, a dropped dataset carries colours in a declared
// icFloatColorEncoding (percent tints, 8-bit codes, PCS Lab in L*/a*/b* value
// units, …) and may feed a PCS source space. So this path routes every sample
// through CIccCmm::ToInternalEncoding / FromInternalEncoding — exactly as
// iccApplyNamedCmm does — so Lab/XYZ and percent/8-bit inputs are interpreted
// correctly and the output is returned in a caller-chosen encoding.
//
// srcBytes: raw bytes of a Float32Array, nSamples × nSrcCh, row-major, values in
//   `srcEncodeArg` (icFloatColorEncoding int). nSrcCh must equal the chain source
//   samples. Returns { ok, destSamples, srcSpace, dstSpace, values:Float32Array
//   (nSamples × destSamples, in `dstEncodeArg`) }.
static icFloatColorEncoding clampEncoding(int e) {
  return (e >= (int)icEncodeValue && e <= (int)icEncode16BitV2)
           ? (icFloatColorEncoding)e : icEncodeValue;
}

emscripten::val applyValuesImpl(emscripten::val chainVal, std::string srcBytes, int nSrcCh,
                                emscripten::val intentsVal, bool firstInput,
                                int srcEncodeArg, int dstEncodeArg) {
  const unsigned n = chainVal["length"].as<unsigned>();
  if (n == 0) throw std::runtime_error("Add at least one profile to the chain.");
  if (nSrcCh < 1) throw std::runtime_error("The data has no colour channels.");
  if (srcBytes.size() % (std::size_t)(nSrcCh * 4) != 0)
    throw std::runtime_error("Malformed value buffer.");
  const std::size_t nSamples = srcBytes.size() / (std::size_t)(nSrcCh * 4);
  if (nSamples == 0) throw std::runtime_error("The dataset is empty.");
  if (nSamples > 5000000ULL)
    throw std::runtime_error("The dataset is too large to process (over 5 million patches).");

  const std::vector<icRenderingIntent> intents = parseIntents(intentsVal, n);
  const icFloatColorEncoding srcEncode = clampEncoding(srcEncodeArg);
  const icFloatColorEncoding dstEncode = clampEncoding(dstEncodeArg);

  CIccCmm theCmm(icSigUnknownData, icSigUnknownData, firstInput);
  for (unsigned i = 0; i < n; ++i) {
    std::vector<std::uint8_t> buf =
      emscripten::convertJSArrayToNumberVector<std::uint8_t>(chainVal[i]);
    if (buf.empty() || buf.size() > kMaxIccBytes)
      throw std::runtime_error("A chained profile is empty or too large.");
    CIccProfile* p = ReadIccProfile(buf.data(), (icUInt32Number)buf.size());
    if (!p) throw std::runtime_error("A chained profile could not be read.");
    icStatusCMM stat = theCmm.AddXform(p, intents[i], icInterpTetrahedral,
                                       NULL, icXformLutColor, true, NULL);
    if (stat)
      throw std::runtime_error("Cannot link profile " + std::to_string(i + 1) + ": "
                               + CIccCmm::GetStatusText(stat));
  }
  icStatusCMM stat = theCmm.Begin();
  if (stat)
    throw std::runtime_error(std::string("The chain does not connect: ")
                             + CIccCmm::GetStatusText(stat));

  const icColorSpaceSignature srcSpace = theCmm.GetSourceSpace();
  const icColorSpaceSignature dstSpace = theCmm.GetDestSpace();
  const int nSrc = (int)icGetSpaceSamples(srcSpace);
  const int nDst = (int)icGetSpaceSamples(dstSpace);
  if (nSrc != nSrcCh)
    throw std::runtime_error("This data has " + std::to_string(nSrcCh)
      + " channel(s) but the chain expects a " + std::to_string(nSrc) + "-channel source.");
  if (nDst < 1) throw std::runtime_error("The chain has an unusable output space.");

  const float* src = reinterpret_cast<const float*>(srcBytes.data());
  std::vector<float> dst((std::size_t)nSamples * nDst);
  std::vector<icFloatNumber> internalSrc(nSrc), internalDst(nDst), extDst(nDst);
  for (std::size_t s = 0; s < nSamples; ++s) {
    // external (file encoding) → internal CMM encoding for the source space.
    if (CIccCmm::ToInternalEncoding(srcSpace, srcEncode, internalSrc.data(),
                                    &src[s * nSrc]))
      throw std::runtime_error("Could not encode a source colour for the chain's input space.");
    theCmm.Apply(internalDst.data(), internalSrc.data());
    // internal → external (requested output encoding) for the dest space.
    if (CIccCmm::FromInternalEncoding(dstSpace, dstEncode, extDst.data(),
                                      internalDst.data()))
      throw std::runtime_error("Could not encode an output colour from the chain.");
    for (int c = 0; c < nDst; ++c) dst[s * nDst + c] = (float)extDst[c];
  }

  emscripten::val r = emscripten::val::object();
  r.set("ok", true);
  r.set("destSamples", nDst);
  r.set("srcSpace", sigToStr(srcSpace));
  r.set("dstSpace", sigToStr(dstSpace));
  r.set("values", makeFloat32Array(dst.data(), dst.size()));
  return r;
}

emscripten::val applyValues(emscripten::val chainVal, std::string srcBytes, int nSrcCh,
                            emscripten::val intents, bool firstInput, int srcEncode, int dstEncode) {
  try {
    return applyValuesImpl(chainVal, srcBytes, nSrcCh, intents, firstInput, srcEncode, dstEncode);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("Data transform failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("Data transform failed with an unknown error");
  }
}

// ── spectralToXYZ — CANONICAL spectral reflectance → CIE XYZ (data methods) ────
// The "Prefer: Spectral" path integrates measured reflectance under a chosen
// observer + illuminant using iccDEV's purpose-built CIccColorimetricCalculator
// (IccColorimetry.h) — NOT hand-rolled weighting tables. This is why the data
// methods route spectra through WASM rather than doing the maths in JS.
//
// reflBytes: raw bytes of a Float32Array, nSamples × nBands reflectance FACTORS in
//   [0,1] (the JS side scales percent→unit before calling). The bands are equally
//   spaced from startNm to endNm (inclusive), nBands samples. Returns { ok,
//   values:Float32Array (nSamples × 3 XYZ, relative colorimetry Y=1 for a perfect
//   diffuser), white:Float32Array[3] adopted white }.
//
// observerId: 1 = CIE 1931 2°, 2 = CIE 1964 10° (icStandardObserver).
// illuminantId: icIlluminant enum — only D50(1)/D65(2)/D93(3)/A(6) have built-in
//   SPDs. mCond: 0=M0 (use chosen illuminant), 1=M1 (force D50), 2=M2 (UV-cut:
//   zero the illuminant ≤400nm), 3=M3 (polarized — no integration difference, so
//   same as M0; the polarization is a measurement-geometry effect already in the
//   reflectance).
emscripten::val spectralToXYZImpl(std::string reflBytes, int nSamples, int nBands,
                                  double startNm, double endNm,
                                  int observerId, int illuminantId, int mCond) {
  if (nBands < 2) throw std::runtime_error("Need at least two spectral bands.");
  if (nSamples < 1) throw std::runtime_error("The dataset has no spectral rows.");
  if (reflBytes.size() != (std::size_t)nSamples * nBands * 4)
    throw std::runtime_error("Malformed spectral buffer.");
  if ((std::size_t)nSamples * nBands > 60000000ULL)
    throw std::runtime_error("The spectral dataset is too large to process.");

  const icStandardObserver obs =
    (observerId == 2) ? icStdObs1964TenDegrees : icStdObs1931TwoDegrees;

  CIccColorimetricCalculator calc;
  if (!calc.SetStandardObserver(obs))
    throw std::runtime_error("The chosen observer has no built-in colour-matching data.");

  // M1 forces the D50 colorimetric illuminant, overriding the picker.
  const int effIll = (mCond == 1) ? (int)icIlluminantD50 : illuminantId;
  if (mCond == 2) {
    // M2 UV-cut: take the illuminant SPD and zero its ≤400nm samples.
    icSpectralRange ir;
    const icFloatNumber* base = icGetStandardIlluminant((icIlluminant)effIll, ir);
    if (!base) throw std::runtime_error("The chosen illuminant has no built-in SPD for the M2 condition.");
    std::vector<icFloatNumber> spd(base, base + ir.steps);
    const double s = icF16toF(ir.start), e = icF16toF(ir.end);
    const double stepNm = ir.steps > 1 ? (e - s) / (ir.steps - 1) : 0.0;
    for (int i = 0; i < (int)ir.steps; ++i)
      if (s + i * stepNm <= 400.0) spd[i] = 0;
    if (!calc.SetIlluminant(ir, spd.data()))
      throw std::runtime_error("Could not set the M2 (UV-cut) illuminant.");
  } else {
    if (!calc.SetStandardIlluminant((icIlluminant)effIll))
      throw std::runtime_error("The chosen illuminant has no built-in SPD.");
  }

  icSpectralRange measR;
  measR.start = icFtoF16((icFloat32Number)startNm);
  measR.end = icFtoF16((icFloat32Number)endNm);
  measR.steps = (icUInt16Number)nBands;
  // Reduction method matches the vetted reference (~/code/spectral): DirectSum with
  // a Sprague (CIE 167:2005) reconstruction of the observer/illuminant onto the
  // measurement grid, holding the end bands. Its FOGRA51 cross-check puts this at
  // mean ΔE ≈ 0.01 vs the published reference — the triangular Weighting method is
  // notably worse (≈0.14), so it is deliberately NOT used here.
  if (!calc.Prepare(measR, icXYZCalcDirectSum, icSpectralInterpSprague, icSpectralExtendHold))
    throw std::runtime_error("Could not prepare the colorimetry operator for this spectral range.");

  // Adopted white = perfect diffuser → its XYZ (Y≈1), for a downstream Lab white.
  std::vector<icFloatNumber> diffuser((std::size_t)nBands, (icFloatNumber)1.0);
  icFloatNumber white[3] = {0, 0, 0};
  calc.ReflectanceToXYZ(diffuser.data(), white);

  const float* refl = reinterpret_cast<const float*>(reflBytes.data());
  std::vector<float> out((std::size_t)nSamples * 3);
  std::vector<icFloatNumber> one((std::size_t)nBands);
  icFloatNumber xyz[3];
  for (int s = 0; s < nSamples; ++s) {
    for (int b = 0; b < nBands; ++b) one[b] = (icFloatNumber)refl[(std::size_t)s * nBands + b];
    calc.ReflectanceToXYZ(one.data(), xyz);
    out[(std::size_t)s * 3] = (float)xyz[0];
    out[(std::size_t)s * 3 + 1] = (float)xyz[1];
    out[(std::size_t)s * 3 + 2] = (float)xyz[2];
  }

  emscripten::val r = emscripten::val::object();
  r.set("ok", true);
  r.set("values", makeFloat32Array(out.data(), out.size()));
  float w[3] = {(float)white[0], (float)white[1], (float)white[2]};
  r.set("white", makeFloat32Array(w, 3));
  return r;
}

emscripten::val spectralToXYZ(std::string reflBytes, int nSamples, int nBands,
                              double startNm, double endNm,
                              int observerId, int illuminantId, int mCond) {
  try {
    return spectralToXYZImpl(reflBytes, nSamples, nBands, startNm, endNm,
                             observerId, illuminantId, mCond);
  } catch (const std::runtime_error&) {
    throw;
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("Spectral conversion failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("Spectral conversion failed with an unknown error");
  }
}

} // namespace

EMSCRIPTEN_BINDINGS(iccconstruct) {
  emscripten::function("fromCube", &fromCube);
  emscripten::function("v5DspObsToV4", &v5DspObsToV4);
  emscripten::function("buildLink", &buildLink);
  emscripten::function("chainInfo", &chainInfo);
  emscripten::function("applyImage", &applyImage);
  emscripten::function("imageApplyBegin", &imageApplyBegin);
  emscripten::function("imageApplyChunk", &imageApplyChunk);
  emscripten::function("imageApplyEnd", &imageApplyEnd);
  emscripten::function("applyValues", &applyValues);
  emscripten::function("spectralToXYZ", &spectralToXYZ);
}
