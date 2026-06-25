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
#include "IccTagLut.h"

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

} // namespace

EMSCRIPTEN_BINDINGS(iccplot) {
  emscripten::function("enumerate", &enumerateProfile);
  emscripten::function("renderGraph", &renderGraph);
  emscripten::function("renderRaster", &renderRaster);
  emscripten::function("tagEvalInfo", &tagEvalInfo);
  emscripten::function("evaluateTag", &evaluateTag);
}
