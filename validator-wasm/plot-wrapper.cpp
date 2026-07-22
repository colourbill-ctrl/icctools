// (c) 2026 William Li
/**
 * iccplot WASM wrapper — the data-first visualization module.
 *
 * Exposes IccVizModel (validator-wasm/IccVizModel.cpp) to the browser:
 *   enumerate(bytes)            → JSON array of {kind,id,title,output}
 *   renderGraph(bytes, id)      → JSON IccVizGraph (points + labels + axes)
 *   renderRaster(bytes, id)     → { …geometry, samples: Uint8Array }
 *
 * Graphs cross the boundary as JSON (compact: geometry as a flat [x,y,…]
 * array, labels listed sparsely). Rasters return their ICC-normalized samples
 * as a Uint8Array — no MEMFS, no PDF/TIFF. A single-slot parse cache keyed on
 * FNV-1a64(bytes) means enumerate + many per-graph renders of one profile parse
 * the profile only once (the UI makes many small calls).
 *
 * IccVizModel itself depends only on IccProfLib + spectralLocus.hpp, so it can
 * be lifted into iccDEV unchanged once approved; this wrapper stays here.
 */

#include "IccVizModel.hpp"
#include "IccProfile.h"
#include "IccCmm.h"
#include "IccUtil.h"
#include "IccTag.h"        // CIccTagSignature (PRMG "specified gamut" tag check)
#include "IccTagLut.h"
#include "IccPrmg.h"
#include "roundtrip-eval.hpp"

#include <nlohmann/json.hpp>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cmath>
#include <cstdint>
#include <exception>
#include <string>

using json = nlohmann::json;

namespace {

constexpr std::size_t kMaxIccBytes = 256ULL * 1024 * 1024;

// Library/browser usage: suppress IccVizModel's default stderr echo of
// diagnostics (they'd land in the JS console). The structured `diagnostics` on
// each result still flow through to the UI. Runs once at module load — the
// natural "setup step" before any profile is supplied.
const bool g_iccvizSilenced = (iccviz::SetSilent(true), true);

// ── single-slot parse cache ──────────────────────────────────────────────────
std::uint64_t fnv1a64(const std::string& s) {
  std::uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : s) { h ^= c; h *= 1099511628211ULL; }
  return h;
}

CIccProfile* g_cached = nullptr;
std::uint64_t g_cachedHash = 0;
std::size_t g_cachedLen = 0;

CIccProfile* parseCached(const std::string& bytes) {
  std::uint64_t h = fnv1a64(bytes);
  if (g_cached && h == g_cachedHash && bytes.size() == g_cachedLen)
    return g_cached;
  if (g_cached) { delete g_cached; g_cached = nullptr; }
  // ValidateIccProfile is the memory parser the validator wrapper uses; it fully
  // reads the profile (no lazy-IO dependency, so the source buffer needn't
  // outlive it). ReadIccProfile(mem) is unsuitable here.
  std::string report;
  icValidateStatus status;
  g_cached = ValidateIccProfile(
      reinterpret_cast<const icUInt8Number*>(bytes.data()),
      static_cast<icUInt32Number>(bytes.size()), report, status);
  g_cachedHash = h;
  g_cachedLen = bytes.size();
  return g_cached;
}

// ── tag / signature helpers ──────────────────────────────────────────────────
// 4-char signature string, matching wrapper.cpp's sigToStr (so tagSig lines up
// with the tag.id the validator emits). Empty for the 0 (whole-profile) sig.
std::string sig4(unsigned int s) {
  if (!s) return "";
  char b[4] = { char((s >> 24) & 0xff), char((s >> 16) & 0xff),
                char((s >> 8) & 0xff), char(s & 0xff) };
  return std::string(b, 4);
}

bool isPcsSpace(icColorSpaceSignature s) {
  return s == icSigLabData || s == icSigXYZData;
}

// AToB-family tags map device→PCS ("input" side); BToA-family map PCS→device.
// gamut/preview tags are BToA-style (PCS in) per ICC.
bool isAToBSig(icTagSignature sig) {
  switch (sig) {
    case icSigAToB0Tag: case icSigAToB1Tag:
    case icSigAToB2Tag: case icSigAToB3Tag:
      return true;
    default:
      return false;
  }
}

// Rendering intent is implicit once a specific LUT tag is chosen (…0 perceptual,
// …1 relative colorimetric, …2 saturation; gamut/preview default to relative).
icRenderingIntent intentForSig(icTagSignature sig) {
  switch (sig) {
    case icSigAToB0Tag: case icSigBToA0Tag: return icPerceptual;
    case icSigAToB2Tag: case icSigBToA2Tag: return icSaturation;
    default:                                return icRelativeColorimetric;
  }
}

std::string channelLabel(icColorSpaceSignature space, int index, int nCh) {
  char buf[128];
  icColorIndexName(buf, sizeof(buf), space, index, nCh, "Ch");
  return std::string(buf);
}

// Build a single-tag transform from the cached profile. Caller must delete the
// returned xform; ShareProfile() keeps it from freeing g_cached. Returns null on
// any failure (tag missing / not a transform / Begin failed).
CIccXform* buildTagXform(CIccProfile* pIcc, icTagSignature sig) {
  CIccTag* pTag = pIcc->FindTag(sig);
  if (!pTag) return nullptr;
  CIccXform* x = CIccXform::Create(pIcc, pTag, isAToBSig(sig),
                                   intentForSig(sig), icInterpLinear);
  if (!x) return nullptr;
  x->ShareProfile();                 // do NOT take ownership of g_cached
  if (x->Begin() != icCmmStatOk) { delete x; return nullptr; }
  return x;
}

const char* outputStr(iccviz::Output o) {
  return o == iccviz::Output::Raster ? "raster" : "graph";
}
const char* roleStr(iccviz::Role r) {
  return r == iccviz::Role::Hint ? "hint" : "primary";
}
const char* shapeStr(iccviz::Shape s) {
  switch (s) {
    case iccviz::Shape::ClosedPath: return "closedPath";
    case iccviz::Shape::Scatter:    return "scatter";
    default:                        return "polyline";
  }
}

json seriesToJson(const iccviz::Series& s) {
  json js;
  js["id"] = s.id;
  js["name"] = s.name;
  js["role"] = roleStr(s.role);
  js["shape"] = shapeStr(s.shape);
  js["colorHint"] = s.colorHint;
  js["auxKind"] = s.auxKind;
  // Series carrying a different physical quantity than the primary y axis (e.g.
  // ΔE*ab beside colorant %) must be drawn against Graph.y2Axis, not yAxis.
  js["useY2"] = s.useY2;

  json pts = json::array();
  pts.get_ptr<json::array_t*>()->reserve(s.verts.size() * 2);
  for (const auto& v : s.verts) { pts.push_back(v.x); pts.push_back(v.y); }
  js["points"] = std::move(pts);

  json labels = json::array();
  for (std::size_t i = 0; i < s.verts.size(); ++i) {
    const auto& v = s.verts[i];
    if (v.label.empty() && std::isnan(v.aux)) continue;
    json l;
    l["i"] = static_cast<std::uint32_t>(i);
    if (!v.label.empty()) l["t"] = v.label;
    if (!std::isnan(v.aux)) l["a"] = v.aux;
    labels.push_back(std::move(l));
  }
  js["labels"] = std::move(labels);
  return js;
}

json axisToJson(const iccviz::Axis& a) {
  return json{{"label", a.label}, {"min", a.minHint}, {"max", a.maxHint},
              {"equalAspect", a.equalAspect}};
}

json graphToJson(const iccviz::Graph& g) {
  json jg;
  jg["title"] = g.title;
  jg["description"] = g.description;
  jg["xAxis"] = axisToJson(g.xAxis);
  jg["yAxis"] = axisToJson(g.yAxis);
  jg["hasY2"] = g.hasY2;
  if (g.hasY2) jg["y2Axis"] = axisToJson(g.y2Axis);
  json series = json::array();
  for (const auto& s : g.series) series.push_back(seriesToJson(s));
  jg["series"] = std::move(series);
  return jg;
}

emscripten::val makeUint8Array(const std::uint8_t* data, std::size_t size) {
  emscripten::val u8 = emscripten::val::global("Uint8Array").new_(size);
  u8.call<void>("set", emscripten::val(emscripten::typed_memory_view(size, data)));
  return u8;
}

// Same copy-off-the-heap pattern for the gamut-mesh geometry: a Float32Array of
// vertices (L*,a*,b* interleaved) and an Int32Array of triangle indices. Copying
// (not returning a live view) keeps the arrays valid after the C++ vector frees.
emscripten::val makeFloat32Array(const float* data, std::size_t size) {
  emscripten::val f32 = emscripten::val::global("Float32Array").new_(size);
  if (size) f32.call<void>("set", emscripten::val(emscripten::typed_memory_view(size, data)));
  return f32;
}
emscripten::val makeInt32Array(const std::int32_t* data, std::size_t size) {
  emscripten::val i32 = emscripten::val::global("Int32Array").new_(size);
  if (size) i32.call<void>("set", emscripten::val(emscripten::typed_memory_view(size, data)));
  return i32;
}

// Non-fatal warnings (tile-count overflow, an out-of-range sqrt, …) raised while
// a render still succeeded — IccVizModel carries them as DATA; we forward the
// Warning-severity ones so the UI can show them alongside the plot. (Fatal
// reasons already travel through `error`.)
json warningsToJson(const std::vector<iccviz::Diagnostic>& diags) {
  json arr = json::array();
  for (const auto& d : diags)
    if (d.severity == iccviz::Severity::Warning) arr.push_back(d.message);
  return arr;
}

// ── render implementations ───────────────────────────────────────────────────
// These do the work; the exception-safe boundary wrappers further down (the
// names embind actually binds) catch any unexpected throw and turn it into an
// {"error": …} response.
std::string enumerateProfileImpl(const std::string& bytes) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();

  json arr = json::array();
  for (const auto& d : iccviz::Enumerate(pIcc)) {
    arr.push_back(json{{"kind", static_cast<unsigned>(d.kind)},
                       {"id", d.id}, {"title", d.title},
                       {"output", outputStr(d.output)},
                       {"tagSig", sig4(static_cast<unsigned>(d.tag))},
                       {"grp", d.grp ? std::string(1, d.grp) : std::string()},
                       {"idx", d.idx}});
  }
  return arr.dump();
}

std::string renderGraphImpl(const std::string& bytes, const std::string& id) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  auto res = iccviz::RenderGraph(pIcc, id);
  if (!res.ok) return json{{"error", res.error}}.dump();
  json jg = graphToJson(res.graph);
  json w = warningsToJson(res.diagnostics);
  if (!w.empty()) jg["warnings"] = std::move(w);
  return jg.dump();
}

emscripten::val renderRasterImpl(const std::string& bytes, const std::string& id) {
  emscripten::val obj = emscripten::val::object();
  if (bytes.size() > kMaxIccBytes) { obj.set("error", "Profile exceeds size limit"); return obj; }
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) { obj.set("error", "Failed to parse ICC profile"); return obj; }
  auto res = iccviz::RenderRaster(pIcc, id);
  if (!res.ok) { obj.set("error", res.error); return obj; }
  const auto& r = res.raster;
  obj.set("width", r.width);
  obj.set("height", r.height);
  obj.set("channels", r.channels);
  obj.set("bitsPerChannel", r.bitsPerChannel);
  obj.set("photometric", r.photometric);
  obj.set("normalizedICC", r.normalizedICC);
  obj.set("samples", makeUint8Array(r.samples.data(), r.samples.size()));
  // Colour-managed preview: photometric 0 is the N-ink grayscale fallback (a device
  // output with no cheap RGB/CMYK preview — 5/6/7-colour, …). Map it through the
  // forward A2B to CIELAB so the main image shows real colour; the raw device `samples`
  // above still drive the per-ink separations. Absent for CMYK/RGB (their decode already
  // renders colour) and whenever no usable A2B exists.
  if (r.photometric == 0) {
    iccviz::Raster lab;
    if (iccviz::ColorizeDeviceRaster(pIcc, r, lab)) {
      obj.set("colorSamples", makeUint8Array(lab.samples.data(), lab.samples.size()));
      obj.set("colorChannels", lab.channels);
      obj.set("colorPhotometric", lab.photometric);
    }
  }
  // additive: non-fatal warnings raised during a successful flatten.
  json w = warningsToJson(res.diagnostics);
  if (!w.empty()) {
    emscripten::val warns = emscripten::val::array();
    for (const auto& m : w) warns.call<void>("push", emscripten::val(m.get<std::string>()));
    obj.set("warnings", warns);
  }
  return obj;
}

// ── single-point evaluator (IccProfLib, no lcms2) ────────────────────────────

// Describe a LUT tag's transform so the UI can lay out the right inputs:
// source/destination spaces, channel counts + labels, and CLUT grid dims.
std::string tagEvalInfoImpl(const std::string& bytes, const std::string& tagSigStr) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (tagSigStr.size() != 4) return json{{"error", "Bad tag signature"}}.dump();

  icTagSignature sig = static_cast<icTagSignature>(
      (icUInt8Number(tagSigStr[0]) << 24) | (icUInt8Number(tagSigStr[1]) << 16) |
      (icUInt8Number(tagSigStr[2]) << 8)  |  icUInt8Number(tagSigStr[3]));

  CIccXform* x = buildTagXform(pIcc, sig);
  if (!x) return json{{"error", "Tag is not an evaluable transform"}}.dump();

  icColorSpaceSignature srcSp = x->GetSrcSpace();
  icColorSpaceSignature dstSp = x->GetDstSpace();
  int srcCh = x->GetNumSrcSamples();
  int dstCh = x->GetNumDstSamples();

  CIccInfo info;
  json j;
  j["srcSpace"] = info.GetColorSpaceSigName(srcSp);
  j["dstSpace"] = info.GetColorSpaceSigName(dstSp);
  j["srcChannels"] = srcCh;
  j["dstChannels"] = dstCh;
  j["srcIsPcs"] = isPcsSpace(srcSp);
  j["dstIsPcs"] = isPcsSpace(dstSp);
  j["srcSpaceSig"] = sig4(static_cast<unsigned>(srcSp));
  j["dstSpaceSig"] = sig4(static_cast<unsigned>(dstSp));

  json sl = json::array(), dl = json::array();
  for (int i = 0; i < srcCh; ++i) sl.push_back(channelLabel(srcSp, i, srcCh));
  for (int i = 0; i < dstCh; ++i) dl.push_back(channelLabel(dstSp, i, dstCh));
  j["srcLabels"] = std::move(sl);
  j["dstLabels"] = std::move(dl);

  // CLUT grid dims (per source-channel node counts), if the tag carries a CLUT.
  json grid = json::array();
  if (auto* mbb = dynamic_cast<CIccMBB*>(pIcc->FindTag(sig))) {
    if (CIccCLUT* clut = mbb->GetCLUT()) {
      for (int i = 0; i < srcCh; ++i) grid.push_back(clut->GridPoint(i));
    }
  }
  j["gridPoints"] = std::move(grid);

  delete x;
  return j.dump();
}

// Apply the selected tag's transform to one input point. `inputJson` is a JSON
// array in the source space's *human* units (device 0..1; PCS as Lab L*/a*/b*
// or XYZ) — unless `inputIsNormalized` is set, in which case the values are taken
// as already in the internal normalized encoding (used by grid-point input, where
// each value is a CLUT node position idx/(n-1)). Returns the destination point in
// both normalized and human units.
std::string evaluateTagImpl(const std::string& bytes, const std::string& tagSigStr,
                            const std::string& inputJson, bool inputIsNormalized) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (tagSigStr.size() != 4) return json{{"error", "Bad tag signature"}}.dump();

  icTagSignature sig = static_cast<icTagSignature>(
      (icUInt8Number(tagSigStr[0]) << 24) | (icUInt8Number(tagSigStr[1]) << 16) |
      (icUInt8Number(tagSigStr[2]) << 8)  |  icUInt8Number(tagSigStr[3]));

  json in;
  try { in = json::parse(inputJson); }
  catch (...) { return json{{"error", "Bad input JSON"}}.dump(); }
  if (!in.is_array()) return json{{"error", "Input must be an array"}}.dump();

  CIccXform* x = buildTagXform(pIcc, sig);
  if (!x) return json{{"error", "Tag is not an evaluable transform"}}.dump();

  icColorSpaceSignature srcSp = x->GetSrcSpace();
  icColorSpaceSignature dstSp = x->GetDstSpace();
  int srcCh = x->GetNumSrcSamples();
  int dstCh = x->GetNumDstSamples();
  if (static_cast<int>(in.size()) != srcCh) {
    delete x;
    return json{{"error", "Input channel count mismatch"}}.dump();
  }

  std::vector<icFloatNumber> src(srcCh), dst(dstCh, 0.0f);
  for (int i = 0; i < srcCh; ++i) {
    // Guard every element: in[i].get<icFloatNumber>() on a non-number (a null
    // from a stringified NaN/Infinity, or a wrong-typed value from any caller)
    // throws nlohmann::type_error. Reject with a readable message instead of
    // relying on the outer wrapper to catch it. (Same hazard json-wrapper.cpp
    // documents for ParseJson's raw .get<T>() calls.)
    if (!in[i].is_number()) { delete x; return json{{"error", "Input values must be numbers"}}.dump(); }
    src[i] = in[i].get<icFloatNumber>();
  }
  // Human → internal PCS encoding when the source side is the PCS (skipped when
  // the caller already supplies normalized values, e.g. grid-point input).
  if (!inputIsNormalized) {
    if (srcSp == icSigLabData) icLabToPcs(src.data());
    else if (srcSp == icSigXYZData) icXyzToPcs(src.data());
  }

  icStatusCMM st = icCmmStatOk;
  CIccApplyXform* a = x->GetNewApply(st);
  if (!a || st != icCmmStatOk) { delete a; delete x; return json{{"error", "Begin/apply failed"}}.dump(); }
  x->Apply(a, dst.data(), src.data());

  json outNorm = json::array(), outHuman = json::array();
  for (int i = 0; i < dstCh; ++i) outNorm.push_back(dst[i]);
  // Internal PCS encoding → human Lab/XYZ when the destination side is the PCS.
  std::vector<icFloatNumber> human(dst.begin(), dst.end());
  if (dstSp == icSigLabData) icLabFromPcs(human.data());
  else if (dstSp == icSigXYZData) icXyzFromPcs(human.data());
  for (int i = 0; i < dstCh; ++i) outHuman.push_back(human[i]);

  delete a;
  delete x;
  return json{{"outNorm", std::move(outNorm)}, {"outHuman", std::move(outHuman)},
              {"dstSpace", CIccInfo().GetColorSpaceSigName(dstSp)},
              {"dstIsPcs", isPcsSpace(dstSp)}}.dump();
}

// Gamut volume (ΔE*ab³) for one device→PCS (AToB) tag at a rendering intent.
// intent: 0 perceptual, 1 relative-colorimetric, 2 saturation, 3 absolute — the
// ICC intent values, cast straight to icRenderingIntent. Typical (tag,intent)
// pairs: AToB0/0, AToB1/1, AToB2/2, AToB1/3 (absolute). See iccviz::GamutVolume.
std::string gamutVolumeImpl(const std::string& bytes, const std::string& tagSigStr, int intent) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (tagSigStr.size() != 4) return json{{"error", "Bad tag signature"}}.dump();

  icTagSignature sig = static_cast<icTagSignature>(
      (icUInt8Number(tagSigStr[0]) << 24) | (icUInt8Number(tagSigStr[1]) << 16) |
      (icUInt8Number(tagSigStr[2]) << 8)  |  icUInt8Number(tagSigStr[3]));
  if (intent < 0 || intent > 3) intent = 1;   // default: relative colorimetric

  iccviz::GamutVolumeResult v =
      iccviz::GamutVolume(pIcc, sig, static_cast<icRenderingIntent>(intent));
  if (!v.ok) return json{{"error", v.error}}.dump();
  return json{{"volume", v.volume}, {"voxels", v.voxels},
              {"samplesPerAxis", v.samplesPerAxis}, {"voxelSize", v.voxelSize},
              {"nColorants", v.nColorants}, {"degenerate", v.degenerate}}.dump();
}

// ── Round-trip ΔE by quantized lightness (iccviz::RoundTripByLightness) ──────
// Returns the individual points, because the reference figure's whole content is the
// within-band structure (ΔE falling from the gamut boundary to the neutral axis) —
// any summary erases it. ~8k points at the default sampling, which is well within
// what a JSON round trip and an SVG scatter handle.
std::string roundTripByLightnessImpl(const std::string& bytes, int intent) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (intent < 0 || intent > 3) intent = 1;

  iccviz::RoundTripLightnessResult v =
      iccviz::RoundTripByLightness(pIcc, static_cast<icRenderingIntent>(intent));
  if (!v.ok) return json{{"error", v.error}}.dump();

  return json{{"n", v.n}, {"levels", v.levels}, {"perHue", v.perHue},
              {"loL", v.loL}, {"hiL", v.hiL},
              {"mean", v.meanDE}, {"p90", v.p90DE}, {"max", v.maxDE},
              {"levelL", v.levelL}, {"x", v.x}, {"de", v.de}}.dump();
}

// ── Extrema colorimetry: white/black points + TAC (see iccviz::WhiteBlackPoints) ──
// Tag-driven, because the black point is whatever inking the chosen B2A table picks
// for PCS black — it genuinely differs between perceptual, relative and saturation.
std::string whiteBlackPointsImpl(const std::string& bytes, const std::string& tagSigStr) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (tagSigStr.size() != 4) return json{{"error", "Bad tag signature"}}.dump();

  icTagSignature sig = static_cast<icTagSignature>(
      (icUInt8Number(tagSigStr[0]) << 24) | (icUInt8Number(tagSigStr[1]) << 16) |
      (icUInt8Number(tagSigStr[2]) << 8)  |  icUInt8Number(tagSigStr[3]));

  iccviz::WhiteBlackResult w = iccviz::WhiteBlackPoints(pIcc, sig);
  if (!w.ok) return json{{"error", w.error}}.dump();

  auto lab3 = [](const double v[3]) { return json::array({v[0], v[1], v[2]}); };
  json j;
  j["nColorants"]  = w.nColorants;
  j["hasAbsolute"] = w.hasAbsolute;
  j["whiteLabRel"] = lab3(w.whiteLabRel);
  j["blackLabRel"] = lab3(w.blackLabRel);
  if (w.hasAbsolute) {
    j["whiteLabAbs"] = lab3(w.whiteLabAbs);
    j["blackLabAbs"] = lab3(w.blackLabAbs);
  }
  j["blackInk"] = w.blackInk;
  j["tac"]      = w.tac;
  return j.dump();
}

// ── Extrema colorimetry: per-hue full-tone vs max chroma (iccviz::HueExtrema) ──
// Intent-independent (always measured through A2B1 relative), so no tag argument.
std::string hueExtremaImpl(const std::string& bytes) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();

  iccviz::HueExtremaResult h = iccviz::HueExtrema(pIcc);
  if (!h.ok) return json{{"error", h.error}}.dump();

  auto v3 = [](const double v[3]) { return json::array({v[0], v[1], v[2]}); };
  json entries = json::array();
  for (const auto& e : h.entries) {
    json je;
    je["name"]          = e.name;
    je["fullToneLab"]   = v3(e.fullToneLab);
    je["fullToneHCL"]   = v3(e.fullToneHCL);
    je["maxChromaLab"]  = v3(e.maxChromaLab);
    je["maxChromaHCL"]  = v3(e.maxChromaHCL);
    je["maxChromaInk"]  = e.maxChromaInk;
    je["rampFraction"]  = e.rampFraction;
    entries.push_back(std::move(je));
  }
  return json{{"nColorants", h.nColorants}, {"entries", std::move(entries)}}.dump();
}

// ── Ink usage in the shadows (iccviz::ShadowInkPaths) ────────────────────────
// Returns four ready-to-plot Graphs (0/45/90/135°) plus the constant-L* plane that
// was used and whether black-point compensation was applied to reach it.
std::string shadowInkPathsImpl(const std::string& bytes, const std::string& tagSigStr) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (tagSigStr.size() != 4) return json{{"error", "Bad tag signature"}}.dump();

  icTagSignature sig = static_cast<icTagSignature>(
      (icUInt8Number(tagSigStr[0]) << 24) | (icUInt8Number(tagSigStr[1]) << 16) |
      (icUInt8Number(tagSigStr[2]) << 8)  |  icUInt8Number(tagSigStr[3]));

  iccviz::ShadowInkResult s = iccviz::ShadowInkPaths(pIcc, sig);
  if (!s.ok) return json{{"error", s.error}}.dump();

  json graphs = json::array();
  for (const auto& g : s.graphs) graphs.push_back(graphToJson(g));
  return json{{"nColorants", s.nColorants}, {"lStar", s.lStar}, {"lStarRaw", s.lStarRaw},
              {"bpcApplied", s.bpcApplied}, {"graphs", std::move(graphs)}}.dump();
}

// ── Primary-inking paths through neutral (iccviz::PrimaryInkingPaths) ─────────
// Returns three ready-to-plot Graphs (Cyan→Red, Magenta→Green, Yellow→Blue), each an
// in-gamut path pivoting on the neutral axis, plus whether BPC was applied.
std::string primaryInkingPathsImpl(const std::string& bytes, const std::string& tagSigStr) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (tagSigStr.size() != 4) return json{{"error", "Bad tag signature"}}.dump();

  icTagSignature sig = static_cast<icTagSignature>(
      (icUInt8Number(tagSigStr[0]) << 24) | (icUInt8Number(tagSigStr[1]) << 16) |
      (icUInt8Number(tagSigStr[2]) << 8)  |  icUInt8Number(tagSigStr[3]));

  iccviz::PrimaryInkResult s = iccviz::PrimaryInkingPaths(pIcc, sig);
  if (!s.ok) return json{{"error", s.error}}.dump();

  json graphs = json::array();
  for (const auto& g : s.graphs) graphs.push_back(graphToJson(g));
  return json{{"nColorants", s.nColorants}, {"bpcApplied", s.bpcApplied},
              {"graphs", std::move(graphs)}}.dump();
}

// ── exception-safe boundary wrappers ─────────────────────────────────────────
// The names embind binds. Every entry point converts an unexpected C++ throw
// (std::bad_alloc on a crafted huge LUT, an nlohmann type_error, an IccProfLib
// internal, …) into a readable {"error": …} response, so no profile can leave
// the module raising an opaque embind exception at the JS boundary. Mirrors the
// convention in wrapper.cpp / json-wrapper.cpp / xml-wrapper.cpp.
std::string enumerateProfile(const std::string& bytes) {
  try { return enumerateProfileImpl(bytes); }
  catch (const std::exception& e) { return json{{"error", std::string("enumerate threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "enumerate threw an unknown exception"}}.dump(); }
}

std::string renderGraph(const std::string& bytes, const std::string& id) {
  try { return renderGraphImpl(bytes, id); }
  catch (const std::exception& e) { return json{{"error", std::string("renderGraph threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "renderGraph threw an unknown exception"}}.dump(); }
}

emscripten::val renderRaster(const std::string& bytes, const std::string& id) {
  try { return renderRasterImpl(bytes, id); }
  catch (const std::exception& e) {
    emscripten::val obj = emscripten::val::object();
    obj.set("error", std::string("renderRaster threw: ") + e.what());
    return obj;
  } catch (...) {
    emscripten::val obj = emscripten::val::object();
    obj.set("error", "renderRaster threw an unknown exception");
    return obj;
  }
}

std::string tagEvalInfo(const std::string& bytes, const std::string& tagSigStr) {
  try { return tagEvalInfoImpl(bytes, tagSigStr); }
  catch (const std::exception& e) { return json{{"error", std::string("tagEvalInfo threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "tagEvalInfo threw an unknown exception"}}.dump(); }
}

std::string evaluateTag(const std::string& bytes, const std::string& tagSigStr,
                        const std::string& inputJson, bool inputIsNormalized) {
  try { return evaluateTagImpl(bytes, tagSigStr, inputJson, inputIsNormalized); }
  catch (const std::exception& e) { return json{{"error", std::string("evaluateTag threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "evaluateTag threw an unknown exception"}}.dump(); }
}

std::string gamutVolume(const std::string& bytes, const std::string& tagSigStr, int intent) {
  try { return gamutVolumeImpl(bytes, tagSigStr, intent); }
  catch (const std::exception& e) { return json{{"error", std::string("gamutVolume threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "gamutVolume threw an unknown exception"}}.dump(); }
}

std::string roundTripByLightness(const std::string& bytes, int intent) {
  try { return roundTripByLightnessImpl(bytes, intent); }
  catch (const std::exception& e) { return json{{"error", std::string("roundTripByLightness threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "roundTripByLightness threw an unknown exception"}}.dump(); }
}

std::string whiteBlackPoints(const std::string& bytes, const std::string& tagSigStr) {
  try { return whiteBlackPointsImpl(bytes, tagSigStr); }
  catch (const std::exception& e) { return json{{"error", std::string("whiteBlackPoints threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "whiteBlackPoints threw an unknown exception"}}.dump(); }
}

std::string hueExtrema(const std::string& bytes) {
  try { return hueExtremaImpl(bytes); }
  catch (const std::exception& e) { return json{{"error", std::string("hueExtrema threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "hueExtrema threw an unknown exception"}}.dump(); }
}

std::string shadowInkPaths(const std::string& bytes, const std::string& tagSigStr) {
  try { return shadowInkPathsImpl(bytes, tagSigStr); }
  catch (const std::exception& e) { return json{{"error", std::string("shadowInkPaths threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "shadowInkPaths threw an unknown exception"}}.dump(); }
}

std::string primaryInkingPaths(const std::string& bytes, const std::string& tagSigStr) {
  try { return primaryInkingPathsImpl(bytes, tagSigStr); }
  catch (const std::exception& e) { return json{{"error", std::string("primaryInkingPaths threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "primaryInkingPaths threw an unknown exception"}}.dump(); }
}

// Gamut boundary MESH for the profile's device→PCS transform at a rendering intent —
// the drawable surface for the Compare-tab 3-D gamut / 2-D slice (see
// iccviz::GamutBoundaryMesh). Built from the PROFILE (LUT or matrix/TRC), so it is
// intent-driven, NOT tag-driven — matrix display profiles (AdobeRGB) render too.
// Returns an embind object with two typed arrays (vertices Float32, triangles Int32)
// rather than JSON: the mesh is thousands of numbers, so the typed-array path avoids a
// large JSON stringify+parse. `steps` ≤0 → auto-pick the grid density.
emscripten::val gamutMeshImpl(const std::string& bytes, int intent, int steps) {
  emscripten::val obj = emscripten::val::object();
  if (bytes.size() > kMaxIccBytes) { obj.set("error", "Profile exceeds size limit"); return obj; }
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) { obj.set("error", "Failed to parse ICC profile"); return obj; }
  if (intent < 0 || intent > 3) intent = 1;   // default: relative colorimetric

  iccviz::GamutMeshResult m =
      iccviz::GamutBoundaryMesh(pIcc, static_cast<icRenderingIntent>(intent), steps);
  if (!m.ok) { obj.set("error", m.error); return obj; }

  obj.set("nColorants", m.nColorants);
  obj.set("samplesPerAxis", m.samplesPerAxis);
  obj.set("vertices", makeFloat32Array(m.vertices.data(), m.vertices.size()));
  // std::vector<int> is 32-bit on wasm32, so it aliases the Int32Array element type.
  obj.set("triangles", makeInt32Array(reinterpret_cast<const std::int32_t*>(m.triangles.data()),
                                      m.triangles.size()));
  return obj;
}

emscripten::val gamutMesh(const std::string& bytes, int intent, int steps) {
  try { return gamutMeshImpl(bytes, intent, steps); }
  catch (const std::exception& e) {
    emscripten::val obj = emscripten::val::object();
    obj.set("error", std::string("gamutMesh threw: ") + e.what());
    return obj;
  } catch (...) {
    emscripten::val obj = emscripten::val::object();
    obj.set("error", "gamutMesh threw an unknown exception");
    return obj;
  }
}

// B2A round-trip accuracy (ΔE*ab of Lab → device → Lab) at a rendering intent.
// intent: 0 perceptual, 1 relative, 2 saturation, 3 absolute (ICC values).
std::string roundTripDEImpl(const std::string& bytes, int intent) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (intent < 0 || intent > 3) intent = 1;

  iccviz::RoundTripResult v = iccviz::RoundTripDE(pIcc, static_cast<icRenderingIntent>(intent));
  if (!v.ok) return json{{"error", v.error}}.dump();
  return json{{"n", v.n}, {"meanDE", v.meanDE}, {"p90DE", v.p90DE},
              {"maxDE", v.maxDE}, {"stdDE", v.stdDE}, {"nColorants", v.nColorants}}.dump();
}

std::string roundTripDE(const std::string& bytes, int intent) {
  try { return roundTripDEImpl(bytes, intent); }
  catch (const std::exception& e) { return json{{"error", std::string("roundTripDE threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "roundTripDE threw an unknown exception"}}.dump(); }
}

// ── round-trip statistics: one uniform shape for every "type" ────────────────
// The Analysis-tab Profile-Statistics table presents FOUR round-trip metrics
// through one control (design doc DL-A1). They come from three different engines
// but are serialized identically here so the UI renders any of them the same way
// (min / mean / P90 / max + a cumulative ≤1/2/3/5/10 histogram + a worst-error
// colour). Per the project principle, the iccDEV CLI/WASM output is NOT the
// authority — these in-app representations of the same underlying colour math are
// the parity target the user signed off on.
//
//   RT0  = iccviz::RoundTripDE     — in-gamut overview (device grid → PCS →
//                                    device → PCS, ΔE between the two PCS passes).
//   RT1  = ΔE(deviceLab, round1)   — device-cube inversion + gamut error.
//   RT2  = ΔE(round1, round2)      — device-cube reproducibility (PCS stability).
//   PRMG = Perceptual Reference Medium Gamut interoperability (one Lab→device→Lab
//          trip over the PRMG-interior PCS colours).

// Serialize a DeStats (RT1/RT2/PRMG) to the uniform per-type shape. Taken by ref
// because p90() reorders the sample buffer (harmless once we're done reading it).
json deStatsToJson(DeStats& s) {
  json j;
  j["ok"] = true;
  j["n"] = s.count();
  j["total"] = s.count();
  j["min"]  = s.minDE;
  j["mean"] = s.mean();
  j["std"]  = s.stddev();
  j["p90"]  = s.p90();
  j["max"]  = s.maxDE;
  // Coarse cumulative counts at ΔE ≤ 1/2/3/5/10 — retained for the smoketest's A/B
  // against CIccPRMG (the UI no longer tables these; it plots `hist` instead).
  j["buckets"] = { s.nLE1, s.nLE2, s.nLE3, s.nLE5, s.nLE10 };
  // Fine (0.1-ΔE) histogram for the relative-/cumulative-frequency plot; the UI
  // re-aggregates it to integer or auto bins. `histBinW` is its bin width.
  j["hist"] = s.fineHist();
  j["histBinW"] = DeStats::kHistBinW;
  if (s.any)   // no worst colour on an empty distribution — omit rather than emit 0,0,0
    j["worstLab"] = { s.worstLab[0], s.worstLab[1], s.worstLab[2] };
  return j;
}

// Serialize the iccviz overview result (RT0) into the SAME shape as deStatsToJson.
json rt0ToJson(const iccviz::RoundTripResult& v) {
  if (!v.ok) return json{{"ok", false}, {"message", v.error}};
  json j;
  j["ok"] = true;
  j["n"] = v.n;
  j["total"] = v.n;
  j["min"]  = v.minDE;
  j["mean"] = v.meanDE;
  j["std"]  = v.stdDE;
  j["p90"]  = v.p90DE;
  j["max"]  = v.maxDE;
  j["buckets"] = { v.nLE1, v.nLE2, v.nLE3, v.nLE5, v.nLE10 };
  j["hist"] = v.hist;                    // fine 0.1-ΔE bins (see IccVizModel RoundTripDE)
  j["histBinW"] = DeStats::kHistBinW;    // same base width as the DeStats path
  if (v.hasWorst)
    j["worstLab"] = { v.worstLab[0], v.worstLab[1], v.worstLab[2] };
  return j;
}

// PRMG interoperability, computed IN-APP. Replicates CIccPRMG::EvaluateProfile
// (IccPrmg.cpp) — sweep the PCS cube 0..1 step 0.01, keep points inside the
// Perceptual Reference Medium Gamut (CIccPRMG::InGamut reads the spec chroma
// table), measure ΔE of ONE Lab→device→Lab round trip — but accumulate a full
// DeStats (min/mean/P90/max + worst-Lab) instead of only the CLI's cumulative
// buckets, so PRMG presents like the other types. The bucket counts are identical
// to CIccPRMG by construction: the sweep loop below is byte-for-byte the reference
// loop (same icFloatNumber step accumulation, same InGamut test, same icDeltaE),
// and the smoketest asserts our buckets == CIccPRMG's for a reference profile.
json prmgStatsToJson(CIccProfile* pIcc, icRenderingIntent nIntent, bool useMpe) {
  // Same profile-class guard CIccPRMG applies before evaluating (IccPrmg.cpp:214).
  const icProfileClassSignature cls = pIcc->m_Header.deviceClass;
  if (cls != icSigInputClass && cls != icSigDisplayClass &&
      cls != icSigOutputClass && cls != icSigColorSpaceClass)
    return json{{"ok", false}, {"message", "Profile class cannot be round-tripped"}};

  // "Specified Gamut" declaration: only perceptual/saturation intents can declare
  // PRMG (via the rendering-intent-gamut tag). Replicates IccPrmg.cpp:222-233 so we
  // needn't run CIccPRMG's own (second, full) walk just to read this one flag.
  bool implied = false;
  if (nIntent == icPerceptual || nIntent == icSaturation) {
    icTagSignature rigSig = static_cast<icTagSignature>(
        icSigPerceptualRenderingIntentGamutTag + (static_cast<icUInt32Number>(nIntent) % 4));
    CIccTag* pSigTag = pIcc->FindTag(rigSig);
    if (pSigTag && pSigTag->GetType() == icSigSignatureType) {
      CIccTagSignature* pSig = static_cast<CIccTagSignature*>(pSigTag);
      if (pSig->GetValue() == icSigPerceptualReferenceMediumGamut)
        implied = true;
    }
  }

  // Build the Lab→device→Lab CMM (two AddXform legs at nIntent) exactly as
  // CIccPRMG does. A profile lacking the needed device↔PCS transforms fails here.
  CIccCmm Lab2Dev2Lab(icSigLabData, icSigLabData, false);
  icXformLutType nLutType = useMpe ? icXformLutColor : icXformLutColorimetric;
  if (Lab2Dev2Lab.AddXform(*pIcc, nIntent, icInterpLinear, NULL, nLutType, useMpe) != icCmmStatOk ||
      Lab2Dev2Lab.AddXform(*pIcc, nIntent, icInterpLinear, NULL, nLutType, useMpe) != icCmmStatOk ||
      Lab2Dev2Lab.Begin() != icCmmStatOk)
    return json{{"ok", false}, {"message", "Profile lacks the transforms PRMG needs"}};

  CIccPRMG prmg;   // used only for InGamut() (reads the static PRMG chroma table)
  DeStats st;
  icFloatNumber pcs[3], Lab1[3], Lab2[3];
  // Verbatim replica of CIccPRMG's sweep — same icFloatNumber accumulation so the
  // per-axis step count (and thus which boundary samples are included) matches the
  // reference exactly. Do NOT "clean this up" to an integer counter: that changes
  // the float rounding at the 1.0 boundary and would drift the bucket counts.
  for (pcs[0] = 0.0; pcs[0] <= 1.0; pcs[0] += (icFloatNumber)0.01) {
    for (pcs[1] = 0.0; pcs[1] <= 1.0; pcs[1] += (icFloatNumber)0.01) {
      for (pcs[2] = 0.0; pcs[2] <= 1.0; pcs[2] += (icFloatNumber)0.01) {
        std::memcpy(Lab1, pcs, 3 * sizeof(icFloatNumber));
        icLabFromPcs(Lab1);
        if (prmg.InGamut(Lab1)) {
          Lab2Dev2Lab.Apply(Lab2, pcs);
          icLabFromPcs(Lab2);
          st.add(icDeltaE(Lab1, Lab2), Lab1);
        }
      }
    }
  }

  json j = deStatsToJson(st);
  j["implied"] = implied;
  return j;
}

// Compute all four round-trip types for ONE rendering intent. Returns a bundle so
// the UI's *type* selector switches instantly (no recompute); only changing the
// intent or use-MPE toggle triggers a fresh call (memoized JS-side per
// (profile,intent,useMpe)). intent: 0 perceptual / 1 relative / 2 saturation /
// 3 absolute; useMpe: false = colorimetric (lut) tags, true = MPE/color tags
// (applies to RT1/RT2/PRMG; RT0's iccviz engine ignores it).
std::string roundTripStatsImpl(const std::string& bytes, int intent, bool useMpe) {
  if (bytes.size() > kMaxIccBytes)
    return json{{"error", "Profile exceeds size limit"}}.dump();
  CIccProfile* pIcc = parseCached(bytes);
  if (!pIcc) return json{{"error", "Failed to parse ICC profile"}}.dump();
  if (intent < 0 || intent > 3) intent = 1;   // default: relative colorimetric
  icRenderingIntent nIntent = static_cast<icRenderingIntent>(intent);

  json types = json::object();

  // RT1 / RT2 — one device-cube walk (CIccMinMaxEval) yields both directions.
  {
    CIccMinMaxEval eval;
    icStatusCMM stat = eval.EvaluateProfile(pIcc, 0, nIntent, icInterpLinear, useMpe);
    if (stat == icCmmStatOk) {
      types["RT1"] = deStatsToJson(eval.rt1);
      types["RT2"] = deStatsToJson(eval.rt2);
    } else {
      // The #1405 wide-device-space guard is a *skip*, not an error — give it its
      // own status so the UI says "not evaluated" rather than "error".
      json note = (stat == icCmmStatTooManySamples)
        ? json{{"ok", false}, {"status", "tooManySamples"}, {"message", CIccCmm::GetStatusText(stat)}}
        : json{{"ok", false}, {"message", std::string("Round trip failed: ") + CIccCmm::GetStatusText(stat)}};
      types["RT1"] = note;
      types["RT2"] = note;
    }
  }

  // RT0 — iccviz in-gamut overview (its own engine; does not take useMpe).
  types["RT0"] = rt0ToJson(iccviz::RoundTripDE(pIcc, nIntent));

  // PRMG — in-app interoperability walk.
  types["PRMG"] = prmgStatsToJson(pIcc, nIntent, useMpe);

  return json{{"intent", intent}, {"useMpe", useMpe}, {"types", std::move(types)}}.dump();
}

std::string roundTripStats(const std::string& bytes, int intent, bool useMpe) {
  try { return roundTripStatsImpl(bytes, intent, useMpe); }
  catch (const std::exception& e) { return json{{"error", std::string("roundTripStats threw: ") + e.what()}}.dump(); }
  catch (...) { return json{{"error", "roundTripStats threw an unknown exception"}}.dump(); }
}

} // namespace

EMSCRIPTEN_BINDINGS(iccplot) {
  emscripten::function("enumerate", &enumerateProfile);
  emscripten::function("renderGraph", &renderGraph);
  emscripten::function("renderRaster", &renderRaster);
  emscripten::function("tagEvalInfo", &tagEvalInfo);
  emscripten::function("evaluateTag", &evaluateTag);
  emscripten::function("gamutVolume", &gamutVolume);
  emscripten::function("roundTripByLightness", &roundTripByLightness);
  emscripten::function("whiteBlackPoints", &whiteBlackPoints);
  emscripten::function("hueExtrema", &hueExtrema);
  emscripten::function("shadowInkPaths", &shadowInkPaths);
  emscripten::function("primaryInkingPaths", &primaryInkingPaths);
  emscripten::function("gamutMesh", &gamutMesh);
  emscripten::function("roundTripDE", &roundTripDE);
  emscripten::function("roundTripStats", &roundTripStats);
}
