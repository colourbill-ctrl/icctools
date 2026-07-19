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
#include "IccTag.h"
#include "IccTagMPE.h"
#include "IccTagLut.h"
#include "IccMpeBasic.h"
#include "IccMpeSpectral.h"
#include "IccUtil.h"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
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

} // namespace

EMSCRIPTEN_BINDINGS(iccconstruct) {
  emscripten::function("fromCube", &fromCube);
  emscripten::function("v5DspObsToV4", &v5DspObsToV4);
}
