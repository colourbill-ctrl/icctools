/**
 * IccVizModel implementation — see IccVizModel.hpp.
 *
 * The producers below compute the profile's chromaticity, tone-curve, named-
 * colour and CLUT visualizations and return them as data structures (point
 * series, axis hints, raster samples) rather than as PDF/TIFF drawing commands.
 */

#include "IccVizModel.hpp"
#include "IccVizMath.hpp"     // shared XYZ→xy + planckian math

#include "IccProfile.h"
#include "IccTag.h"
#include "IccTagBasic.h"
#include "IccTagLut.h"
#include "IccTagComposite.h"   // CIccTagArray / CIccTagStruct (v5 named-colour arrays)
#include "IccCmm.h"            // CIccXform / CIccApplyXform — device→PCS sampling for InkReversalL
#include "IccUtil.h"

#include "spectralLocus.hpp"   // const spectralLocus2degree (internal linkage)

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>

namespace iccviz {
namespace {

const float chromaticityChartScale = 0.85f;
const float abChartScale = 2 * 130.0f;
const float kNaN = std::numeric_limits<float>::quiet_NaN();

// ── diagnostic output state (see SetSilent / SetDiagnosticContext) ────────────
// Defaults reproduce iccProfileVisualize's top-level call: NOT silent, no prefix.
bool g_silent = false;
std::string g_diagContext;

bool effectiveSilent(Verbosity v) {
  switch (v) {
    case Verbosity::Stderr: return false;
    case Verbosity::Silent: return true;
    default:                return g_silent;   // Verbosity::Default
  }
}

// Echo a result's diagnostics to stderr unless silenced. The message text already
// carries the exact upstream wording (Skipping … / WARNING - … / ERROR - …); the
// optional context reproduces iccProfileVisualize's leading "<filename>: ".
void emitDiagnostics(const std::vector<Diagnostic>& diags, Verbosity v) {
  if (effectiveSilent(v)) return;
  for (const Diagnostic& d : diags) {
    if (g_diagContext.empty())
      std::fprintf(stderr, "%s\n", d.message.c_str());
    else
      std::fprintf(stderr, "%s: %s\n", g_diagContext.c_str(), d.message.c_str());
  }
}

std::string sigStr(icTagSignature sig) {
  char buf[64];
  return std::string(icGetSigStr(buf, sizeof buf, static_cast<icUInt32Number>(sig)));
}

// ── colour helpers — single-sourced in IccVizMath.hpp so the XYZ→xy +
//    planckian math lives in exactly one place.
using iccvizmath::XY;
using iccvizmath::xyFromICCXYZ;
using iccvizmath::xyFromXYZFloat;
using iccvizmath::approxPlanck;

/*
label points for spectrum in nm
sorta, kinda evenly spaced, plus endpoints
 */
const std::vector<int> locusLabelWavelengths =
{
  360,
  460, 450,
  470, 475, 480, 485, 490, 495, 500, 505, 510, 515,
  520, 530, 540, 550, 560, 570, 580, 590, 600, 610, 620,
  640,
  700
};

std::string channelName(int index, bool useInput, icColorSpaceSignature inSpace,
                        icColorSpaceSignature outSpace, int inCh, int outCh) {
  char buf[128];
  icColorIndexName(buf, 128, useInput ? inSpace : outSpace, index,
                   useInput ? inCh : outCh, useInput ? "In" : "Out");
  return std::string(buf);
}

unsigned char clipU8(icFloatNumber v) {
  if (std::isnan(v)) return 0;
  if (std::isinf(v)) return 255;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return static_cast<unsigned char>(v);
}
unsigned short clipU16(icFloatNumber v) {
  if (std::isnan(v)) return 0;
  if (std::isinf(v)) return 65535;
  if (v < 0) return 0;
  if (v > 65535) return 65535;
  return static_cast<unsigned short>(v);
}

int photometricFromSpace(icColorSpaceSignature s) {
  switch (s) {
    case icSigRgbData: case icSigCmyData: case icSigXYZData: case icSigLuvData:
    case icSigYCbCrData: case icSigYxyData: case icSigHsvData: case icSigHlsData:
      return 2;  // RGB
    case icSigCmykData: return 5;            // CMYK
    case icSigLabData:  return 8;            // CIELAB
    case icSigGrayData: case icSigGamutData: return 1;  // BlackIsZero
    default: return 0;                        // WhiteIsZero (N-ink fallback)
  }
}

// ── curve description + validation gate ──────────────────────────────────────

// Validate a curve, returning the report text by reference. A status
// > icValidateWarning means the curve is malformed (e.g. gamma 0, bad LUT
// size). Callers no longer DROP failing curves: they enumerate them anyway and
// surface this report as a diagnostic, so a malformed curve shows its reason
// instead of the graph silently vanishing.
icValidateStatus curveValidate(CIccCurve* curve, const std::string& sigDesc,
                               std::string& report) {
  return curve->Validate(":" + sigDesc, report, nullptr);
}

std::string describeCurve(CIccCurve* curve) {
  if (auto* tc = dynamic_cast<CIccTagCurve*>(curve)) {
    auto size = tc->GetSize();
    if (size == 0) {
      return "Y = X";
    } else if (size == 1) {
      icFloatNumber value0 = (*tc)[0];
      icFloatNumber dGamma = (icFloatNumber)(value0 * 256.0f);
      return "Y = X ^ " + std::to_string(dGamma);
    } else {
      return "LookupTable[" + std::to_string(size) + "]";
    }
  }
  // Other curve types are formatted by Describe(), which walks the curve's data.
  // Run the curve's own Validate() first — the same validate-before-describe gate
  // the rest of this module uses (see curveValidate) — so the formatter is never
  // the first thing to touch unvalidated, possibly-malformed data (CWE-476). Per
  // this module's design we do NOT drop a bad curve: the status is advisory and
  // we still return its description.
  std::string report;
  curve->Validate(":curve", report, nullptr);
  std::string desc;
  curve->Describe(desc, 100);
  return desc;
}

// ── producers ────────────────────────────────────────────────────────────────

Graph buildCurveGraph(CIccCurve* curve, const std::string& title) {
  Graph g;
  g.title = title;
  g.description = describeCurve(curve);
  g.xAxis = Axis{"Input", 0.0f, 1.0f, false};
  g.yAxis = Axis{"Output", 0.0f, 1.0f, false};

  // Number of samples used to trace the curve. Default to a smooth 1000; for a
  // sampled LUT curve use at least its own point count so we never under-sample
  // it, and drop to the 2 endpoints when the curve is a pure identity.
  int steps = 1000;
  if (auto* tc = dynamic_cast<CIccTagCurve*>(curve))
    steps = std::max(1000, static_cast<int>(tc->GetSize()));
  if (curve->IsIdentity()) steps = 2;
  // Defensive floor: steps drives the divisor below, so guarantee it is at least
  // 1 even if the logic above is ever changed to allow a smaller value (avoids a
  // divide-by-zero on i / (float)steps). Written as <= 0 so the non-zero
  // invariant on the denominator is explicit (steps is int).
  if (steps <= 0) steps = 1;

  Series data;
  data.id = "curve"; data.name = title; data.role = Role::Primary;
  data.shape = Shape::Polyline; data.colorHint = "neutral";
  data.verts.reserve(steps + 1);
  for (int i = 0; i <= steps; ++i) {
    float in = i / static_cast<float>(steps);
    float out = curve->Apply(in);
    if (std::isnan(out)) out = 0.0f;
    if (std::isinf(out)) out = 1.0f;
    out = std::min(1.0f, std::max(0.0f, out));
    data.verts.push_back(Vertex{in, out, "", kNaN});
  }
  g.series.push_back(std::move(data));

  Series ident;
  ident.id = "identity"; ident.name = "Identity"; ident.role = Role::Hint;
  ident.shape = Shape::Polyline; ident.colorHint = "neutral";
  ident.verts = {Vertex{0, 0, "", kNaN}, Vertex{1, 1, "", kNaN}};
  g.series.push_back(std::move(ident));
  return g;
}

void addPrimaryPoint(Graph& g, Series& s, CIccTag* tag, const char* label,
                     const char* colorHint) {
  auto* xyzTag = dynamic_cast<CIccTagXYZ*>(tag);
  if (!xyzTag) return;
  const icXYZNumber* xyz = xyzTag->GetXYZ(0);
  if (!xyz) return;
  XY p = xyFromICCXYZ(xyz);
  s.verts.push_back(Vertex{p.x, p.y, label, kNaN});
  (void)g;
}

Graph buildChromaticityGraph(CIccProfile* pIcc) {
  Graph g;
  g.title = "Chromaticity xy";
  g.xAxis = Axis{"x (CIE 1931)", 0.0f, chromaticityChartScale, true};
  g.yAxis = Axis{"y (CIE 1931)", 0.0f, chromaticityChartScale, true};

  // spectral locus (Hint, closed horseshoe).
  Series locus;
  locus.id = "locus"; locus.name = "Spectral locus"; locus.role = Role::Hint;
  locus.shape = Shape::ClosedPath; locus.colorHint = "locus";
  locus.verts.reserve(spectralLocus2degree.size());
  for (const auto& p : spectralLocus2degree)
    locus.verts.push_back(Vertex{static_cast<float>(p.x), static_cast<float>(p.y), "", kNaN});
  g.series.push_back(std::move(locus));

  // labels for spectral locus (Hint).
  Series labels;
  labels.id = "locusLabels"; labels.name = "Wavelengths"; labels.role = Role::Hint;
  labels.shape = Shape::Scatter; labels.auxKind = "nm"; labels.colorHint = "locus";
  const int wavelengthOffset = spectralLocus2degree[0].wavelength;
  for (auto& nm : locusLabelWavelengths) {
    size_t index = static_cast<size_t>(nm - wavelengthOffset);
    if (index >= spectralLocus2degree.size()) continue;
    const auto& p = spectralLocus2degree[index];
    labels.verts.push_back(Vertex{static_cast<float>(p.x), static_cast<float>(p.y),
                                  std::to_string(nm), static_cast<float>(nm)});
  }
  g.series.push_back(std::move(labels));

  // plankian white curve (Hint).
  Series planck;
  planck.id = "planckian"; planck.name = "Planckian locus"; planck.role = Role::Hint;
  planck.shape = Shape::Polyline; planck.auxKind = "kelvin"; planck.colorHint = "neutral";
  const float start_temp = 1500.0f;   // degrees Kelvin
  const float end_temp = 20000.0f;
  const float temp_step = 200.0f;
  for (float temp = start_temp; temp <= end_temp; temp += temp_step) {
    XY p = approxPlanck(temp);
    planck.verts.push_back(Vertex{p.x, p.y, "", temp});
  }
  g.series.push_back(std::move(planck));

  // Primaries + white (Primary).
  Series prim;
  prim.id = "primaries"; prim.name = "Primaries"; prim.role = Role::Primary;
  prim.shape = Shape::Scatter;
  CIccTag* w = pIcc->FindTag(icSigMediaWhitePointTag);
  if (w) addPrimaryPoint(g, prim, w, "White", "white");
  CIccTag* r = pIcc->FindTag(icSigRedColorantTag);
  CIccTag* gr = pIcc->FindTag(icSigGreenColorantTag);
  CIccTag* b = pIcc->FindTag(icSigBlueColorantTag);
  Series gamut;
  gamut.id = "gamut"; gamut.name = "Gamut"; gamut.role = Role::Primary;
  gamut.shape = Shape::ClosedPath; gamut.colorHint = "neutral";
  if (r && gr && b) {
    size_t base = prim.verts.size();
    addPrimaryPoint(g, prim, r, "R", "R");
    addPrimaryPoint(g, prim, gr, "G", "G");
    addPrimaryPoint(g, prim, b, "B", "B");
    for (size_t i = base; i < prim.verts.size(); ++i)
      gamut.verts.push_back(Vertex{prim.verts[i].x, prim.verts[i].y, "", kNaN});
  }
  g.series.push_back(std::move(prim));
  if (!gamut.verts.empty()) g.series.push_back(std::move(gamut));
  return g;
}

struct NamedLab { std::string name; float L, a, b; };

// Collect named/colorant colours as Lab + name. `diag` (when supplied) carries
// the granular skip reasons — including the IccProfLib validation `report`
// string, which the data-first path would otherwise discard. Enumerate() probes
// with diag==nullptr (silent skip); RenderGraph() pulls the reasons through.
bool collectNamedColors(CIccProfile* pIcc, CIccTag* tag, const std::string& sigDesc,
                        std::vector<NamedLab>& out, std::string& title,
                        std::vector<Diagnostic>* diag = nullptr) {
  auto record = [&](Severity sev, const std::string& msg) -> bool {
    if (diag) diag->push_back({sev, msg});
    return false;
  };

  icTagTypeSignature type = tag->GetType();
  icFloatNumber illum[3];
  pIcc->getNormIlluminantXYZ(illum);

  // PCS basis for the colour conversion is the profile header PCS — matching
  // iccProfileVisualize, which reads pIcc->m_Header.pcs (not the table's own PCS)
  // and uses it for every named-colour type. Anything that isn't XYZ/Lab can't be
  // plotted: icSigNoColorData (spectral / iccMAX) skips silently, while any other
  // space records a warning.
  icColorSpaceSignature pcs = pIcc->m_Header.pcs;
  if (pcs != icSigXYZData && pcs != icSigLabData) {
    if (pcs != icSigNoColorData)
      return record(Severity::Warning,
                    "WARNING - unknown pcs for colors: " + sigStr(static_cast<icTagSignature>(pcs)));
    return false;
  }

  if (type == icSigColorantTableType) {
    auto* table = dynamic_cast<CIccTagColorantTable*>(tag);
    if (!table)
      return record(Severity::Error, "Skipping " + sigDesc + ": unable to convert colorantTable");
    std::string path = ":colorantTable", report;
    if (table->Validate(path, report, nullptr) > icValidateWarning)
      return record(Severity::Warning, "WARNING - colorantTable failed validation:\n" + report);
    // CIccTagColorantTable carries no PCS of its own; assume the profile PCS
    // (already validated as XYZ/Lab above).
    icUInt32Number n = table->GetSize();
    for (icUInt32Number i = 0; i < n; ++i) {
      icColorantTableEntry* e = table->GetEntry(i);
      icFloatNumber lab[3];
      if (pcs == icSigXYZData) {
        icFloatNumber xyz[3] = {icU16toF(e->data[0]), icU16toF(e->data[1]), icU16toF(e->data[2])};
        icXYZtoLab(lab, xyz, illum);
      } else {
        lab[0]=icU16toF(e->data[0]); lab[1]=icU16toF(e->data[1]); lab[2]=icU16toF(e->data[2]);
        icLabFromPcs(lab);
      }
      // strnlen-bound: e->name is a fixed-size profile field; a non-NUL-terminated
      // one would over-read adjacent heap if passed to std::string(const char*).
      out.push_back(NamedLab{std::to_string(i+1) + " " +
          std::string(e->name, strnlen(e->name, sizeof e->name)), lab[0], lab[1], lab[2]});
    }
    title = "Colorant Table";
    return !out.empty();
  }

  if (type == icSigNamedColor2Type) {
    auto* table = dynamic_cast<CIccTagNamedColor2*>(tag);
    if (!table)
      return record(Severity::Error, "Skipping " + sigDesc + ": unable to convert namedColorTable");
    std::string path = ":namedColor2", report;
    if (table->Validate(path, report, nullptr) > icValidateWarning)
      return record(Severity::Warning, "WARNING - namedColorTable failed validation:\n" + report);
    if (pcs != table->GetPCS())
      return record(Severity::Warning,
                    "WARNING - bad pcs for namedColorTable: " + sigStr(static_cast<icTagSignature>(pcs)));
    icUInt32Number n = table->GetSize();
    std::string prefix = table->GetPrefix(), suffix = table->GetSufix();
    for (icUInt32Number i = 0; i < n; ++i) {
      SIccNamedColorEntry* e = table->GetEntry(i);
      icFloatNumber lab[3];
      if (pcs == icSigXYZData) {
        icXYZtoLab(lab, e->pcsCoords, illum);
      } else {
        icFloatNumber lab2[3] = {e->pcsCoords[0], e->pcsCoords[1], e->pcsCoords[2]};
        table->Lab2ToLab4(lab, lab2);
        icLabFromPcs(lab);
      }
      // strnlen-bound (see Colorant Table above): rootName is a fixed-size field.
      out.push_back(NamedLab{prefix +
          std::string(e->rootName, strnlen(e->rootName, sizeof e->rootName)) + suffix,
          lab[0], lab[1], lab[2]});
    }
    title = "Named Color Table";
    return !out.empty();
  }

  if (type == icSigTagArrayType) {   // v5 named-colour / colorant-info array
    auto* array = dynamic_cast<CIccTagArray*>(tag);
    if (!array)
      return record(Severity::Error, "Skipping " + sigDesc + ": unable to convert named color array");
    icArraySignature arrayType = array->GetTagArrayType();
    if (arrayType != icSigColorantInfoArray && arrayType != icSigNamedColorArray)
      return record(Severity::Warning,
                    "WARNING - unknown color array type: " +
                    sigStr(static_cast<icTagSignature>(arrayType)) + " for tag " + sigDesc);
    std::string path = ":" + sigDesc, report;
    if (array->Validate(path, report, nullptr) > icValidateWarning)
      return record(Severity::Warning, "WARNING - named color array failed validation:\n" + report);

    icUInt32Number items = array->GetSize();
    for (icUInt32Number i = 0; i < items; ++i) {
      CIccTag* thisItem = array->GetIndex(i);
      if (!thisItem) continue;

      icStructSignature structType = thisItem->GetTagStructType();
      if (structType != icSigColorantInfoStruct &&
          structType != icSigTintZeroStruct &&
          structType != icSigNamedColorStruct) {
        record(Severity::Warning, "Unknown named color struct " +
               sigStr(static_cast<icTagSignature>(structType)) + " for tag " + sigDesc);
        continue;
      }
      auto* structPtr = dynamic_cast<CIccTagStruct*>(thisItem);
      if (!structPtr) continue;

      // PCS data member — Float16/32/64 array of (L*a*b* or XYZ) triples.
      CIccTag* pcsElem = structPtr->FindElem(icSigCinfPcsDataMbr);
      if (!pcsElem) continue;
      icTagTypeSignature pcsDataType = pcsElem->GetType();
      if (pcsDataType != icSigFloat64ArrayType && pcsDataType != icSigFloat32ArrayType &&
          pcsDataType != icSigFloat16ArrayType) {
        record(Severity::Warning, "Unknown named color struct data type " +
               sigStr(static_cast<icTagSignature>(pcsDataType)) + " for tag " + sigDesc);
        continue;
      }
      auto* flt = dynamic_cast<CIccTagNumArray*>(pcsElem);
      if (!flt) continue;

      // TODO - can we easily convert spectra to PCS? Probably not without
      //        specifying viewing conditions. (carried over from iccProfileVisualize)
      std::vector<NamedLab> tempColors;
      icUInt32Number colorCount = flt->GetNumValues() / 3;   // ignore any partial triple
      for (icUInt32Number k = 0; k < colorCount; ++k) {
        icFloatNumber v[3], lab[3];
        flt->GetValues(v, k * 3, 3);
        if (pcs == icSigXYZData) {
          icXYZtoLab(lab, v, illum);
        } else {
          lab[0] = v[0]; lab[1] = v[1]; lab[2] = v[2];   // Lab directly coded as float
        }
        tempColors.push_back(NamedLab{"", lab[0], lab[1], lab[2]});
      }

      // Name member (optional): CinfName, falling back to CinfLocalizedName.
      CIccTag* nameElem = structPtr->FindElem(icSigCinfNameMbr);
      if (!nameElem)
        nameElem = structPtr->FindElem(icSigCinfLocalizedNameMbr);
      if (nameElem) {
        std::string nameString;
        switch (nameElem->GetType()) {
          case icSigUtf8TextType:
            if (auto* t = dynamic_cast<CIccTagUtf8Text*>(nameElem))
              nameString = std::string((char*)t->GetText());
            break;
          case icSigUtf16TextType:
            if (auto* t = dynamic_cast<CIccTagUtf16Text*>(nameElem)) {
              std::string buffer;
              nameString = std::string((char*)t->GetText(buffer));   // GetText converts to UTF8
            }
            break;
          case icSigTextType:
            if (auto* t = dynamic_cast<CIccTagText*>(nameElem))
              nameString = std::string((char*)t->GetText());
            break;
          case icSigDictType:                       // sometimes used where MLU expected
          case icSigMultiLocalizedUnicodeType:
            if (auto* t = dynamic_cast<CIccTagMultiLocalizedUnicode*>(nameElem)) {
              CIccLocalizedUnicode* u = t->Find(icLanguageCodeEnglish, icCountryCodeUSA);
              if (u) u->GetText(nameString);
            }
            break;
          default:
            record(Severity::Warning, "Unknown named color struct name type " +
                   sigStr(static_cast<icTagSignature>(nameElem->GetType())) + " for tag " + sigDesc);
            break;
        }
        if (!nameString.empty())
          for (auto& c : tempColors) c.name = nameString;
      }

      // Tint member (optional): per-colour tint % appended to the name.
      CIccTag* tintElem = structPtr->FindElem(icSigNmclTintMbr);
      if (tintElem) {
        icTagTypeSignature tintType = tintElem->GetType();
        if (tintType == icSigFloat64ArrayType || tintType == icSigFloat32ArrayType ||
            tintType == icSigFloat16ArrayType) {
          if (auto* tflt = dynamic_cast<CIccTagNumArray*>(tintElem)) {
            icUInt32Number dataCount = tflt->GetNumValues();
            if (dataCount <= tempColors.size()) {
              for (icUInt32Number k = 0; k < dataCount; ++k) {
                icFloatNumber tv;
                tflt->GetValues(&tv, k, 1);
                int percent = static_cast<int>(std::lround(tv * 100.0f));
                tempColors[k].name += "(" + std::to_string(percent) + "%)";
              }
            }
          }
        } else {
          record(Severity::Warning, "Unknown named color tint data type " +
                 sigStr(static_cast<icTagSignature>(tintType)) + " for tag " + sigDesc);
        }
      }

      out.insert(out.end(), tempColors.begin(), tempColors.end());
    }

    // Match iccProfileVisualize's "Color Array: <sig>" page label.
    title = "Color Array";
    return !out.empty();
  }

  return false;  // unknown / unsupported named-colour tag type
}

Graph buildNamedAB(const std::vector<NamedLab>& colors, const std::string& title) {
  Graph g;
  g.title = title + " — a*b*";
  g.xAxis = Axis{"a*", -abChartScale / 2, abChartScale / 2, true};
  g.yAxis = Axis{"b*", -abChartScale / 2, abChartScale / 2, true};

  // Constant-chroma circles (Hint).
  for (float radius = 30.0f; radius <= 150.0f; radius += 30.0f) {
    Series circ;
    circ.id = "chroma" + std::to_string(static_cast<int>(radius));
    circ.name = "C* = " + std::to_string(static_cast<int>(radius));
    circ.role = Role::Hint; circ.shape = Shape::ClosedPath; circ.colorHint = "neutral";
    for (int k = 0; k < 72; ++k) {
      float th = static_cast<float>(k) / 72.0f * 6.28318530718f;
      circ.verts.push_back(Vertex{radius * std::cos(th), radius * std::sin(th), "", kNaN});
    }
    g.series.push_back(std::move(circ));
  }
  // Quadrant labels (Hint) — match the PDF's +a Magenta / -a Green / etc.
  Series ax;
  ax.id = "axisLabels"; ax.name = "Axes"; ax.role = Role::Hint; ax.shape = Shape::Scatter;
  ax.colorHint = "neutral";
  ax.verts = {
    Vertex{ abChartScale / 2, 0, "+a Magenta", kNaN}, Vertex{-abChartScale / 2, 0, "-a Green", kNaN},
    Vertex{0,  abChartScale / 2, "+b Yellow", kNaN},  Vertex{0, -abChartScale / 2, "-b Blue", kNaN},
  };
  g.series.push_back(std::move(ax));

  Series data;
  data.id = "colors"; data.name = title; data.role = Role::Primary;
  data.shape = Shape::Scatter; data.auxKind = "Lstar";
  for (const auto& c : colors)
    data.verts.push_back(Vertex{c.a, c.b, c.name, c.L});
  g.series.push_back(std::move(data));
  return g;
}

Graph buildNamedXY(CIccProfile* pIcc, const std::vector<NamedLab>& colors,
                   const std::string& title) {
  Graph g;
  g.title = title + " — xy";
  g.xAxis = Axis{"x (CIE 1931)", 0.0f, chromaticityChartScale, true};
  g.yAxis = Axis{"y (CIE 1931)", 0.0f, chromaticityChartScale, true};

  // Reuse the locus + planckian reference geometry.
  Graph chrom = buildChromaticityGraph(pIcc);
  for (auto& s : chrom.series)
    if (s.role == Role::Hint) g.series.push_back(std::move(s));

  icFloatNumber illum[3];
  pIcc->getNormIlluminantXYZ(illum);
  Series data;
  data.id = "colors"; data.name = title; data.role = Role::Primary;
  data.shape = Shape::Scatter; data.auxKind = "Lstar";
  for (const auto& c : colors) {
    icFloatNumber lab[3] = {c.L, c.a, c.b}, xyz[3];
    icLabtoXYZ(xyz, lab, illum);
    XY p = xyFromXYZFloat(xyz);
    data.verts.push_back(Vertex{p.x, p.y, c.name, c.L});
  }
  g.series.push_back(std::move(data));
  return g;
}

// CLUT lattice → raster. The nD CLUT is flattened to a 2-D image: the first two
// input dimensions form each tile, and the remaining dimensions are laid out as
// a grid of tiles arranged toward a square.
//
// On failure returns false and — when `diag` is supplied — records the granular
// skip/warn reason. Enumerate() probes with diag==nullptr, so a tag that simply
// carries no CLUT skips silently; only an actual RenderRaster() pulls the reasons
// through. Non-fatal conditions (tile-count overflow, an out-of-range sqrt)
// record a Warning and recover, leaving the raster geometry intact.
bool buildClutRaster(CIccTag* tag, const std::string& sigDesc, Raster& out,
                     std::vector<Diagnostic>* diag = nullptr) {
  // Granular diagnostics carrying the EXACT iccProfileVisualize wording, so a
  // stderr-echoing caller (and the structured `error`) read identically.
  auto skip = [&](const std::string& why) -> bool {
    if (diag) diag->push_back({Severity::Error, "Skipping " + sigDesc + ": " + why});
    return false;
  };
  auto record = [&](Severity sev, const std::string& msg) {
    if (diag) diag->push_back({sev, msg});
  };

  // these are all subclases of CIccMBB, and can share most of the code
  auto* lut = dynamic_cast<CIccMBB*>(tag);
  if (!lut)
    return skip("unable to convert LUT");

  int bytes = lut->GetPrecision();    // currently only 1 or 2
  int inputChannels = lut->InputChannels();
  int outputChannels = lut->OutputChannels();
  if (inputChannels <= 0 || outputChannels <= 0)
    return skip("invalid channel count");

  // write nD Data to TIFF
  icTagTypeSignature typeSig = tag->GetType();
  CIccCLUT* clut = lut->GetCLUT();
  if (!clut) {
    // clut is optional in mAB and mBA tags - only report if it isn't one of those
    if ( !(typeSig == icSigLutAtoBType || typeSig == icSigLutBtoAType) ) {
      char b[64];
      std::string typeDesc = icGetSigStr(b, sizeof b, static_cast<icUInt32Number>(typeSig));
      record(Severity::Error, "ERROR - clut data could not be read for tag '" +
                              sigDesc + "' of type '" + typeDesc + "'");
    }
    return false;
  }

  // validate is called back before the Describe call
  clut->Begin();  // initialize some grid information

  int gridPoints = clut->GridPoints(); // gridSize[0]
  if (gridPoints <= 0)
    return skip("invalid CLUT grid");

  int tiles = gridPoints;
  int tileWidth = 1;
  int tileHeight = 1;

  if (inputChannels >= 2) {
    tileWidth = clut->GridPoint(1);
    if (tileWidth <= 0)
      return skip("invalid CLUT width");
  }

  if (inputChannels >= 3) {
    tileHeight = clut->GridPoint(2);
    if (tileHeight <= 0)
      return skip("invalid CLUT height");
  }

  if (inputChannels > 3) {
    // Accumulate in 64-bit and bail on overflow: tiles is profile-derived and an
    // int multiply here could wrap to a small positive value that escapes the
    // <=0 guards below and drives a too-small image buffer (heap overflow).
    std::uint64_t tiles64 = static_cast<std::uint64_t>(tiles);
    for (int i = 3; i < inputChannels; ++i) {
      int extraGridPoints = clut->GridPoint(i);
      if (extraGridPoints <= 0)
        return skip("invalid CLUT tile count");
      tiles64 *= static_cast<std::uint64_t>(extraGridPoints);
      if (tiles64 > static_cast<std::uint64_t>(std::numeric_limits<int>::max()))
        return skip("CLUT tile count overflow");
    }
    tiles = static_cast<int>(tiles64);
  }

  // special case for single dimensional LUT
  if (inputChannels == 1) {
    tileWidth = tiles;
    tiles = 1;
    tileHeight = 1;
  }

  // special case for 2 dimensional LUT
  if (inputChannels == 2) {
    tileHeight = tiles;
    tiles = 1;
  }

  // find tile arrangement closest to a square
  if (tiles <= 0) {
    record(Severity::Warning, "WARNING - tile count overflow.");
    tiles = 1;
  }

  double tempResult = std::sqrt(static_cast<double>(tiles));
  if (tempResult > std::numeric_limits<int>::max()) {
    record(Severity::Warning, "ERROR - sqrt bad result!");
    tempResult = tiles / 2.0;
  }
  int tilesWide = static_cast<int>(tempResult);
  if (tilesWide <= 0) tilesWide = 1;   // guards the tilesHigh divide below

  // some odd counts need a tweak to align and look more sane
  if (inputChannels > 3 && (inputChannels & 1)) {
    int oldValue = tilesWide;
    // round down to a multiple of the grid size to better align rows.
    // Guard the divisor: gridPoints*tileWidth could overflow int to 0 and trap.
    int alignTo = gridPoints * tileWidth;
    if (alignTo > 0) {
      tilesWide -= (tilesWide % alignTo);
      if (tilesWide == 0) {
        // this does happen -- should I round up in some cases?
        tilesWide = oldValue;
      }
    }
  }

  int tilesHigh = (tiles + (tilesWide - 1)) / tilesWide;

  // multiply out by tile size
  int imageWidth = tilesWide * tileWidth;
  int imageHeight = tilesHigh * tileHeight;
  if (imageWidth <= 0 || imageHeight <= 0 || bytes <= 0)
    return skip("invalid image geometry");

  // Compute in 64-bit and enforce a hard ceiling before allocating: every
  // factor here is profile-derived and a size_t multiply on wasm32 (32-bit
  // size_t) could wrap to a small value, under-sizing the buffer the sample
  // loop then writes past. 256 MB is far above any legitimate CLUT raster.
  static const std::uint64_t kMaxRasterBytes = 256ull * 1024 * 1024;
  std::uint64_t bufferSize64 = static_cast<std::uint64_t>(imageWidth) *
                               static_cast<std::uint64_t>(imageHeight) *
                               static_cast<std::uint64_t>(outputChannels) *
                               static_cast<std::uint64_t>(bytes);
  if (!bufferSize64)
    return skip("empty image buffer");
  if (bufferSize64 > kMaxRasterBytes)
    return skip("CLUT raster too large");

  size_t bufferSize = static_cast<size_t>(bufferSize64);
  // NOTE that bufferSize will usually be greater than clutSize
  out.samples.assign(bufferSize, 0);
  unsigned char* buf = out.samples.data();
  unsigned short* buf16 = reinterpret_cast<unsigned short*>(buf);
  float* buf32 = reinterpret_cast<float*>(buf);
  icFloatNumber* clutData = clut->GetData(0);
  if (!clutData)
    return skip("CLUT data unavailable");

  // Defense-in-depth bound for the input read below. The stride fix below makes
  // the index correct for well-formed CLUTs (square and non-square), but the
  // packing geometry is still derived from grid metadata rather than the actual
  // sample array, so a malformed profile with inconsistent grid/channel counts
  // could still compute an in-range-looking index past the data. Bound every read
  // against the true element count — NumPoints() grid nodes x outputChannels
  // samples per node — and treat any out-of-range node as 0 (the buffer is
  // pre-zeroed) instead of reading out of bounds (CWE-125; issue #1548).
  const size_t clutSampleCount =
      static_cast<size_t>(clut->NumPoints()) * static_cast<size_t>(outputChannels);

  // CLUT input strides. n010 is the per-row (x dimension) stride and MUST be
  // tileHeight*outputChannels: x indexes the tileWidth dimension, and advancing
  // one x-step skips a full column of tileHeight samples. Using tileWidth here
  // (as an earlier revision did) only coincides for square CLUTs (tileWidth ==
  // tileHeight); for a non-square CLUT it over-strides and walks the input index
  // off the end of clutData — the root cause of the #1548 heap-overflow read.
  // (Matches the reference iccProfileVisualize layout.)
  size_t n001 = static_cast<size_t>(tileWidth) * tileHeight * outputChannels;
  size_t n010 = static_cast<size_t>(tileHeight) * outputChannels;
  size_t n100 = static_cast<size_t>(outputChannels);
  if (inputChannels < 2) std::swap(n010, n100);
  size_t outTileStepV = static_cast<size_t>(imageWidth) * tileHeight * outputChannels;
  size_t outTileStepH = static_cast<size_t>(tileWidth) * outputChannels;
  size_t outColStep = static_cast<size_t>(outputChannels);
  size_t outRowStep = static_cast<size_t>(imageWidth) * outputChannels;

  for (int z = 0; z < tiles; ++z) {
    int z2 = z % tilesWide, z3 = z / tilesWide;
    for (int x = 0; x < tileWidth; ++x)
      for (int y = 0; y < tileHeight; ++y) {
        size_t in = z * n001 + x * n010 + (tileHeight - 1 - y) * n100;
        size_t o = z3 * outTileStepV + z2 * outTileStepH + y * outRowStep + x * outColStep;
        // Skip nodes the packing geometry addresses beyond the real CLUT array;
        // leaves the pre-zeroed output sample intact rather than over-reading (#1548).
        if (in + static_cast<size_t>(outputChannels) > clutSampleCount)
          continue;
        if (bytes == 4 || bytes == 8)
          for (int c = 0; c < outputChannels; ++c) buf32[o + c] = clutData[in + c];
        else if (bytes == 2)
          for (int c = 0; c < outputChannels; ++c) buf16[o + c] = clipU16(clutData[in + c] * 65535.0f);
        else
          for (int c = 0; c < outputChannels; ++c) buf[o + c] = clipU8(clutData[in + c] * 255.0f);
      }
  }

  out.width = imageWidth; out.height = imageHeight;
  out.channels = outputChannels; out.bitsPerChannel = 8 * bytes;
  out.photometric = photometricFromSpace(lut->GetCsOutput());
  out.normalizedICC = true;
  return true;
}

// Append LUT sub-curve descriptors in the A→B→M order output3DLUT uses.
void enumerateLutCurves(CIccProfile* pIcc, icTagSignature sig, CIccMBB* lut,
                        std::vector<Descriptor>& out) {
  std::string base = sigStr(sig);
  int inCh = lut->InputChannels(), outCh = lut->OutputChannels();
  icColorSpaceSignature inSp = lut->GetCsInput(), outSp = lut->GetCsOutput();
  bool inMtx = lut->IsInputMatrix();
  struct Grp { char g; CIccCurve** arr; int count; bool useInput; };
  Grp groups[] = {
    {'A', lut->GetCurvesA(), inMtx ? outCh : inCh, !inMtx},
    {'B', lut->GetCurvesB(), inMtx ? inCh : outCh, inMtx},
    {'M', lut->GetCurvesM(), inMtx ? inCh : outCh, inMtx},
  };
  // Upper bound on curve channels we will ever enumerate. ICC colour spaces top
  // out at 15 device channels (nCLR) plus PCS, so 256 is comfortably generous
  // while still capping a malformed LUT that reports a bogus channel count —
  // preventing an unbounded loop / DoS (CWE-400/CWE-834).
  const int kMaxVizChannels = 256;
  for (const Grp& grp : groups) {
    if (!grp.arr) continue;
    // grp.count comes straight from the profile's LUT channel count; clamp it
    // before driving the loop so untrusted data cannot dictate the iteration
    // count. The curve arrays are sized by the same channel count, so clamping
    // down can never read past the array.
    const int count = std::min(grp.count, kMaxVizChannels);
    for (int i = 0; i < count; ++i) {
      CIccCurve* c = grp.arr[i];
      if (!c) continue;
      std::string ch = channelName(i, grp.useInput, inSp, outSp, inCh, outCh);
      std::string label = base + ": curve" + grp.g + "[ " + ch + " ]";
      // Enumerate every present curve, even a malformed one; RenderGraph
      // validates and surfaces the reason rather than dropping it silently.
      Descriptor d;
      d.kind = Kind::Curve1D; d.output = Output::Graph;
      d.id = "curve:" + base + ":" + grp.g + ":" + std::to_string(i);
      d.title = label; d.tag = sig; d.grp = grp.g; d.idx = i;
      out.push_back(std::move(d));
    }
  }
  (void)pIcc;
}

CIccCurve* lutCurveFor(CIccMBB* lut, char grp, int idx) {
  CIccCurve** arr = grp == 'A' ? lut->GetCurvesA()
                  : grp == 'B' ? lut->GetCurvesB()
                  : grp == 'M' ? lut->GetCurvesM() : nullptr;
  return arr ? arr[idx] : nullptr;
}

// ─────────────────────────────────────────────────────────────────────────────
// L* tone-reversal analysis  (Kind::InkReversalL)
//
// ALGORITHM — originally due to Harold Boll; reimplemented here independently
// (no code copied).
//
// Premise: a well-behaved colour device gets DARKER as you add more of any one
// ink. Hold every channel but one fixed, raise the remaining ("varying") channel
// from low to high, and the resulting L* should never RISE. When a higher ink
// level comes back LIGHTER than a lower one, the device/profile has an "L*
// reversal" — a non-monotonic tone response that flags a measurement error, an
// ink-limit / trapping artefact, a mislabelled patch, or a badly-built CLUT.
//
// The profile's own device→PCS LUT (an AToB tag) stands in for measured
// characterization data: sampled on a regular device lattice it yields
// (ink vector → L*) just like a chart of printed patches. For a chosen varying
// channel `vary`, over every fixed combination of the OTHER channels' lattice
// nodes (a "context"):
//
//     evaluate the ramp  L[0..m-1]  along `vary` (device 0→1), then
//     compare ALL PAIRS  (a < b):  if L[b] > L[a] the ramp reversed,
//     and emit the segment (x[a],L[a]) → (x[b],L[b]) carrying ΔL* = L[b]−L[a].
//
// ALL PAIRS (not just adjacent nodes) is deliberate — a gradual drift that only
// surfaces across several steps is still a reversal, and one anomalous node is
// caught against every cleaner node on either side. The per-channel ΔL* threshold
// ("epsilon" in the original) is NOT applied here: every upward pair is emitted
// with its ΔL* in Vertex.aux, and the CALLER filters by epsilon (and ranks the
// worst offenders) at draw time. That keeps this a pure data producer and makes
// the UI's epsilon control instant. One graph is produced per varying channel.
//
// DATA-INGESTION GUARDS — every value below is profile-controlled and therefore
// untrusted; each is bounded before it drives a loop or an allocation, in the
// same defensive spirit as buildClutRaster():
//   · tag present, a CIccMBB, carries a CLUT, device input + Lab/XYZ PCS output;
//   · input/output channel counts in (0, kMaxInkChannels]; `vary` in range;
//   · every axis grid count clamped to [2, kMaxAxisSamples];
//   · the lattice-node product accumulated in 64-bit and rejected on overflow or
//     above kMaxLatticeNodes (a malformed grid cannot drive an unbounded
//     evaluation — CWE-400 / CWE-834);
//   · the transform build / Begin / apply are each checked; a non-finite L* is
//     dropped rather than allowed to poison the comparisons;
//   · the emitted-segment count is capped (largest ΔL* kept), so even a
//     pathologically reversed profile yields bounded output.
// ─────────────────────────────────────────────────────────────────────────────

// Bounds for the untrusted profile geometry (see guards above).
const int kMaxInkChannels            = 15;        // ICC device spaces top out at 15 (nCLR)
const int kMaxAxisSamples            = 64;        // per-channel lattice resolution clamp
const std::uint64_t kMaxLatticeNodes = 2000000;   // total device-lattice node ceiling
const int kMaxReversalSegments       = 512;       // emitted reversals per channel (largest ΔL*)
const float kReversalFloor           = 1e-4f;     // ignore sub-noise upticks (real filter = caller epsilon)

bool isPcsSpace(icColorSpaceSignature s) {
  return s == icSigLabData || s == icSigXYZData;
}

// AToB rendering intent is implicit in the tag (…0 perceptual, …2 saturation,
// else relative colorimetric) — mirrors the choice the CLUT-image / evaluator
// paths make, so the sampled colours match what that table actually renders.
icRenderingIntent reversalIntentForSig(icTagSignature sig) {
  switch (sig) {
    case icSigAToB0Tag: return icPerceptual;
    case icSigAToB2Tag: return icSaturation;
    default:            return icRelativeColorimetric;
  }
}

// One transform output (internal PCS encoding) → human L*. Returns NaN for an
// unsupported PCS or a non-finite result, which the scan then drops (guarding the
// pairwise comparison from NaN poisoning).
float pcsToLstar(const icFloatNumber* dst, int outCh, icColorSpaceSignature pcs) {
  if (outCh < 3) return kNaN;
  icFloatNumber v[3] = { dst[0], dst[1], dst[2] };
  if (pcs == icSigLabData) {
    icLabFromPcs(v);                  // PCS-encoded Lab → human L*a*b*
    return std::isfinite(v[0]) ? static_cast<float>(v[0]) : kNaN;
  }
  if (pcs == icSigXYZData) {
    icXyzFromPcs(v);                  // PCS-encoded XYZ → human XYZ (D50)
    icFloatNumber lab[3] = { 0, 0, 0 };
    icXYZtoLab(lab, v, nullptr);      // nullptr white → D50 default
    return std::isfinite(lab[0]) ? static_cast<float>(lab[0]) : kNaN;
  }
  return kNaN;
}

// Format a full device ink vector (node indices → device 0..1) as "c0,c1,…" with
// 3 decimals. Carried on each segment's low vertex so the caller can rebuild the
// reversal table (ink vector / L* / ΔL*) without re-sampling the profile.
std::string encodeInkVector(const int* idx, const int* n, int inCh) {
  std::string s;
  char buf[32];
  for (int c = 0; c < inCh; ++c) {
    float v = (n[c] > 1) ? static_cast<float>(idx[c]) / static_cast<float>(n[c] - 1) : 0.0f;
    std::snprintf(buf, sizeof buf, "%.3f", v);
    if (c) s += ',';
    s += buf;
  }
  return s;
}

// Clamped analysis-lattice node count for a CLUT, using the SAME per-axis
// clamping buildReversalGraph applies. Returns false if any grid axis is invalid
// or the product would exceed kMaxLatticeNodes — i.e. the tag is not analysable.
// Enumerate() uses this so it never advertises a reversal graph RenderGraph would
// then refuse (the UI degrades to "not applicable" rather than erroring).
bool reversalLatticeFits(CIccCLUT* clut, int inCh) {
  std::uint64_t nodes = 1;
  for (int i = 0; i < inCh; ++i) {
    int g = clut->GridPoint(i);
    if (g <= 0) return false;
    if (g < 2) g = 2;
    if (g > kMaxAxisSamples) g = kMaxAxisSamples;
    nodes *= static_cast<std::uint64_t>(g);
    if (nodes > kMaxLatticeNodes) return false;
  }
  return true;
}

// Build the L* reversal graph for one varying channel of one device→PCS LUT tag.
// Returns false (with a diagnostic) on any hard guard failure; true otherwise
// (possibly with a Warning when the reversal count was capped).
bool buildReversalGraph(CIccProfile* pIcc, icTagSignature sig, int vary,
                        Graph& out, std::vector<Diagnostic>* diag) {
  const std::string sigDesc = sigStr(sig);
  auto skip = [&](const std::string& why) -> bool {
    if (diag) diag->push_back({Severity::Error, "Skipping " + sigDesc + " L* reversal: " + why});
    return false;
  };

  // ── guard: a CLUT-bearing device→PCS LUT ──
  CIccTag* tag = pIcc ? pIcc->FindTag(sig) : nullptr;
  auto* lut = dynamic_cast<CIccMBB*>(tag);
  if (!lut)  return skip("tag is not a LUT");
  CIccCLUT* clut = lut->GetCLUT();
  if (!clut) return skip("LUT carries no CLUT lattice");
  clut->Begin();                                  // initialise grid metadata

  const int inCh  = lut->InputChannels();
  const int outCh = lut->OutputChannels();
  if (inCh <= 0 || outCh <= 0)   return skip("invalid channel count");
  if (inCh > kMaxInkChannels)    return skip("too many input channels");
  if (vary < 0 || vary >= inCh)  return skip("varying channel out of range");

  const icColorSpaceSignature inSp  = lut->GetCsInput();
  const icColorSpaceSignature outSp = lut->GetCsOutput();
  if (isPcsSpace(inSp))                                 return skip("LUT input is not a device space");
  if (outSp != icSigLabData && outSp != icSigXYZData)  return skip("LUT output is not a PCS");

  // ── guard: per-axis sample counts + total lattice size ──
  // GridPoint(i) is a uint8 (≤255) but still profile-controlled: clamp every axis
  // to [2, kMaxAxisSamples] and accumulate the product in 64-bit, rejecting an
  // overflow or oversized lattice before evaluating a single node.
  int n[16] = { 0 };
  std::uint64_t totalNodes = 1;
  for (int i = 0; i < inCh; ++i) {
    int g = clut->GridPoint(i);
    if (g <= 0) return skip("invalid CLUT grid");
    if (g < 2)  g = 2;                              // need ≥2 nodes to form a ramp
    if (g > kMaxAxisSamples) g = kMaxAxisSamples;
    n[i] = g;
    totalNodes *= static_cast<std::uint64_t>(g);
    if (totalNodes > kMaxLatticeNodes) return skip("device lattice too large to analyse");
  }

  // ── build the device→PCS transform once; reuse the apply for every node ──
  CIccXform* xform = CIccXform::Create(pIcc, tag, /*bInput=*/true,
                                       reversalIntentForSig(sig), icInterpLinear);
  if (!xform) return skip("could not build device→PCS transform");
  xform->ShareProfile();                           // we do NOT own pIcc
  if (xform->Begin() != icCmmStatOk) { delete xform; return skip("transform Begin failed"); }
  icStatusCMM st = icCmmStatOk;
  CIccApplyXform* apply = xform->GetNewApply(st);
  if (!apply || st != icCmmStatOk) { delete apply; delete xform; return skip("transform apply init failed"); }

  std::vector<icFloatNumber> src(inCh, 0.0f), dst(outCh, 0.0f);
  int idx[16] = { 0 };
  // Evaluate L* at the current context with `vary` set to node varyIdx.
  auto evalLstar = [&](int varyIdx) -> float {
    idx[vary] = varyIdx;
    for (int c = 0; c < inCh; ++c) {
      float v = (n[c] > 1) ? static_cast<float>(idx[c]) / static_cast<float>(n[c] - 1) : 0.0f;
      src[c] = static_cast<icFloatNumber>(v < 0 ? 0 : (v > 1 ? 1 : v));   // clamp — defensive
    }
    xform->Apply(apply, dst.data(), src.data());
    return pcsToLstar(dst.data(), outCh, outSp);
  };

  // Collected reversals, bounded to the largest kMaxReversalSegments by ΔL*. Each
  // stores its context as a linear index (decoded back to ink values at emit
  // time) plus the low/high node indices along `vary`.
  struct Rev { std::uint32_t ctx; int a, b; float Llo, Lhi, dL; };
  auto byDLdesc = [](const Rev& x, const Rev& y) { return x.dL > y.dL; };
  std::vector<Rev> revs;
  std::uint64_t totalRevs = 0;

  std::vector<float> ramp(n[vary]);
  for (int c = 0; c < inCh; ++c) idx[c] = 0;
  std::uint32_t ctx = 0;

  // Odometer over the inCh−1 context dims (every channel except `vary`); the
  // lowest such channel advances fastest, which is the radix order the ctx→ink
  // decode below relies on. `ctx` counts completed contexts and therefore equals
  // the mixed-radix encoding of the current odometer position.
  for (;;) {
    for (int j = 0; j < n[vary]; ++j) ramp[j] = evalLstar(j);
    idx[vary] = 0;

    // ALL-PAIRS reversal test on this ramp (skip pairs touching a non-finite L*).
    for (int a = 0; a < n[vary]; ++a) {
      if (!std::isfinite(ramp[a])) continue;
      for (int b = a + 1; b < n[vary]; ++b) {
        if (!std::isfinite(ramp[b])) continue;
        float dL = ramp[b] - ramp[a];
        if (dL <= kReversalFloor) continue;        // monotone / sub-noise → fine
        ++totalRevs;
        revs.push_back({ ctx, a, b, ramp[a], ramp[b], dL });
        if (revs.size() >= static_cast<size_t>(2 * kMaxReversalSegments)) {
          // Bound memory: keep only the largest ΔL* so far, then continue.
          std::nth_element(revs.begin(), revs.begin() + kMaxReversalSegments, revs.end(), byDLdesc);
          revs.resize(kMaxReversalSegments);
        }
      }
    }

    // Advance the odometer over the context dims (skipping `vary`); stop once
    // every context dim has wrapped back to 0.
    int c = 0;
    for (; c < inCh; ++c) {
      if (c == vary) continue;
      if (++idx[c] < n[c]) break;
      idx[c] = 0;
    }
    if (c >= inCh) break;
    ++ctx;
  }

  delete apply;
  delete xform;

  std::sort(revs.begin(), revs.end(), byDLdesc);
  if (revs.size() > static_cast<size_t>(kMaxReversalSegments))
    revs.resize(kMaxReversalSegments);

  // ── assemble the graph: each reversal is a 2-vertex polyline (low→high), the
  // low vertex labelled with the full ink vector and the high vertex carrying
  // ΔL* as aux, so the caller can both plot the segments and rebuild the table. ──
  const std::string chName = channelName(vary, /*useInput=*/true, inSp, outSp, inCh, outCh);
  out = Graph{};
  out.title = sigDesc + " — L* reversal vs " + chName;
  out.description = (outSp == icSigLabData) ? std::string() : std::string("L* via XYZ→Lab (D50)");
  out.xAxis.label = chName + " (device 0–1)"; out.xAxis.minHint = 0.0f; out.xAxis.maxHint = 1.0f;
  out.yAxis.label = "L*";                     out.yAxis.minHint = 0.0f; out.yAxis.maxHint = 100.0f;

  int work[16];
  int segId = 0;
  for (const Rev& r : revs) {
    // Decode the context linear index back to per-channel nodes (same radix order
    // as the odometer), then place `vary` at its low node to recover the full ink
    // vector at the segment's low end.
    std::uint64_t t = r.ctx;
    for (int c = 0; c < inCh; ++c) {
      if (c == vary) continue;
      work[c] = static_cast<int>(t % static_cast<std::uint64_t>(n[c]));
      t /= static_cast<std::uint64_t>(n[c]);
    }
    work[vary] = r.a;
    const float xLo = static_cast<float>(r.a) / static_cast<float>(n[vary] - 1);
    const float xHi = static_cast<float>(r.b) / static_cast<float>(n[vary] - 1);

    Series s;
    s.id = "rev" + std::to_string(segId++);
    s.role = Role::Primary;
    s.shape = Shape::Polyline;
    s.auxKind = "dLstar";
    Vertex v0; v0.x = xLo; v0.y = r.Llo; v0.label = encodeInkVector(work, n, inCh);
    Vertex v1; v1.x = xHi; v1.y = r.Lhi; v1.aux = r.dL;
    s.verts.push_back(std::move(v0));
    s.verts.push_back(std::move(v1));
    out.series.push_back(std::move(s));
  }

  // Non-fatal: report when the reversal count was capped. Emitted as a
  // locale-agnostic structured marker — "reversal:capped:<total>:<shown>" — that
  // the receiver parses and renders through its own i18n, instead of a fixed
  // English sentence the UI couldn't translate.
  if (diag && totalRevs > revs.size()) {
    char msg[64];
    std::snprintf(msg, sizeof msg, "reversal:capped:%llu:%zu",
                  static_cast<unsigned long long>(totalRevs), revs.size());
    diag->push_back({Severity::Warning, std::string(msg)});
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Neutral Axis Inking  (Kind::NeutralAxisInking)
//
// Sweeps the neutral axis (a*=b*=0) from white (L*=100) to black (L*=0) through a
// B2A table (PCS→device) and records how much of each device colorant the profile
// lays down — the classic GCR / neutral-build curve. One graph, one polyline per
// device channel: x = L* (100→0), y = colorant % (0–100). The receiver styles and
// plots it (and restricts the analysis to output profiles).
// ─────────────────────────────────────────────────────────────────────────────
const int kNeutralSamples = 101;

// The rendering intent a B2A tag embodies (…0 perceptual, …2 saturation, else
// relative colorimetric) — used only as the Create() hint; the specific tag wins.
icRenderingIntent neutralIntentForSig(icTagSignature sig) {
  switch (sig) {
    case icSigBToA0Tag: return icPerceptual;
    case icSigBToA2Tag: return icSaturation;
    default:            return icRelativeColorimetric;
  }
}

// Neutral CIELAB (L*,0,0) → the B2A source-space input, written into src[] in the
// internal PCS encoding the xform expects (Lab directly, or D50 XYZ for XYZ PCS).
void neutralSrc(float L, icColorSpaceSignature pcs, icFloatNumber* src) {
  if (pcs == icSigXYZData) {
    float f = (L + 16.0f) / 116.0f;
    float g = (f * f * f > 0.008856f) ? f * f * f : (f - 16.0f / 116.0f) / 7.787f;
    src[0] = 0.9642f * g; src[1] = 1.0f * g; src[2] = 0.8249f * g;   // D50 human XYZ
    icXyzToPcs(src);
  } else {
    src[0] = L; src[1] = 0.0f; src[2] = 0.0f;                        // human L*a*b*
    icLabToPcs(src);
  }
}

bool buildNeutralAxisGraph(CIccProfile* pIcc, icTagSignature sig, Graph& out,
                           std::vector<Diagnostic>* diag) {
  const std::string sigDesc = sigStr(sig);
  auto skip = [&](const std::string& why) -> bool {
    if (diag) diag->push_back({Severity::Error, "Skipping " + sigDesc + " neutral inking: " + why});
    return false;
  };

  // ── guard: a CLUT-bearing PCS→device LUT ──
  CIccTag* tag = pIcc ? pIcc->FindTag(sig) : nullptr;
  auto* lut = dynamic_cast<CIccMBB*>(tag);
  if (!lut)  return skip("tag is not a LUT");
  if (!lut->GetCLUT()) return skip("LUT carries no CLUT lattice");

  const icColorSpaceSignature inSp  = lut->GetCsInput();
  const icColorSpaceSignature outSp = lut->GetCsOutput();
  if (!isPcsSpace(inSp)) return skip("LUT input is not a PCS");        // B2A: PCS in
  if (isPcsSpace(outSp)) return skip("LUT output is not a device space");
  const int inCh  = lut->InputChannels();    // 3 (PCS)
  const int outCh = lut->OutputChannels();   // N device colorants
  if (inCh < 3 || outCh <= 0 || outCh > kMaxInkChannels) return skip("invalid channel count");

  CIccXform* xform = CIccXform::Create(pIcc, tag, /*bInput=*/false,
                                       neutralIntentForSig(sig), icInterpLinear);
  if (!xform) return skip("could not build PCS→device transform");
  xform->ShareProfile();
  if (xform->Begin() != icCmmStatOk) { delete xform; return skip("transform Begin failed"); }
  icStatusCMM st = icCmmStatOk;
  CIccApplyXform* apply = xform->GetNewApply(st);
  if (!apply || st != icCmmStatOk) { delete apply; delete xform; return skip("transform apply init failed"); }

  // One series per device colorant; sample L* from 100 (white) down to 0 (black).
  std::vector<Series> series(outCh);
  for (int c = 0; c < outCh; ++c) {
    series[c].id = "ch" + std::to_string(c);
    series[c].name = channelName(c, /*useInput=*/false, inSp, outSp, inCh, outCh);
    series[c].role = Role::Primary;
    series[c].shape = Shape::Polyline;
    series[c].verts.reserve(kNeutralSamples);
  }

  std::vector<icFloatNumber> src(inCh, 0.0f), dst(outCh, 0.0f);
  for (int i = 0; i < kNeutralSamples; ++i) {
    float L = 100.0f * (1.0f - static_cast<float>(i) / static_cast<float>(kNeutralSamples - 1));
    neutralSrc(L, inSp, src.data());
    xform->Apply(apply, dst.data(), src.data());
    for (int c = 0; c < outCh; ++c) {
      float v = static_cast<float>(dst[c]) * 100.0f;                  // device 0..1 → %
      if (!std::isfinite(v)) v = 0.0f;
      Vertex vert; vert.x = L; vert.y = v;
      series[c].verts.push_back(vert);
    }
  }

  delete apply;
  delete xform;

  // Per-colorant display hint: the Lab of 100% of each ink alone, obtained from
  // the forward A2B1 (relative-colorimetric) table. Carried in series.colorHint as
  // a "L,a,b" string — DATA only; the receiver does the Lab→sRGB display mapping
  // (this model never produces display colours). Absent/odd A2B1 → no hint, and the
  // receiver falls back to its channel palette.
  if (CIccTag* fwdTag = pIcc->FindTag(icSigAToB1Tag)) {
    if (CIccXform* fwd = CIccXform::Create(pIcc, fwdTag, /*bInput=*/true,
                                           icRelativeColorimetric, icInterpLinear)) {
      fwd->ShareProfile();
      icStatusCMM fst = icCmmStatOk;
      CIccApplyXform* fapply = (fwd->Begin() == icCmmStatOk) ? fwd->GetNewApply(fst) : nullptr;
      if (fapply && fst == icCmmStatOk &&
          fwd->GetNumSrcSamples() == outCh && fwd->GetNumDstSamples() >= 3) {
        const icColorSpaceSignature fOut = fwd->GetDstSpace();
        std::vector<icFloatNumber> usrc(outCh, 0.0f), udst(fwd->GetNumDstSamples(), 0.0f);
        for (int c = 0; c < outCh; ++c) {
          for (int k = 0; k < outCh; ++k) usrc[k] = (k == c) ? 1.0f : 0.0f;   // 100% of ink c
          fwd->Apply(fapply, udst.data(), usrc.data());
          icFloatNumber lab[3] = { udst[0], udst[1], udst[2] };
          if (fOut == icSigLabData) {
            icLabFromPcs(lab);
          } else if (fOut == icSigXYZData) {
            icXyzFromPcs(lab);
            icFloatNumber l2[3] = { 0, 0, 0 };
            icXYZtoLab(l2, lab, nullptr);
            lab[0] = l2[0]; lab[1] = l2[1]; lab[2] = l2[2];
          } else {
            continue;
          }
          if (!std::isfinite(lab[0])) continue;
          char buf[48];
          std::snprintf(buf, sizeof buf, "%.1f,%.1f,%.1f",
                        static_cast<double>(lab[0]), static_cast<double>(lab[1]), static_cast<double>(lab[2]));
          series[c].colorHint = buf;
        }
      }
      delete fapply;
      delete fwd;
    }
  }

  out = Graph{};
  out.title = sigDesc + " — neutral axis inking";
  out.xAxis.label = "L*";    out.xAxis.minHint = 100.0f; out.xAxis.maxHint = 0.0f;  // 100 left → 0 right
  out.yAxis.label = "% ink"; out.yAxis.minHint = 0.0f;   out.yAxis.maxHint = 100.0f;
  for (auto& s : series) out.series.push_back(std::move(s));
  return true;
}

} // namespace

// ── public API ───────────────────────────────────────────────────────────────

std::vector<Descriptor> Enumerate(CIccProfile* pIcc) {
  std::vector<Descriptor> out;
  if (!pIcc) return out;

  // NOTE: we deliberately do NOT iterate pIcc->m_Tags here. m_Tags is a
  // std::list owned by the IccProfLib translation unit; iterating it from this
  // TU walks off the end into the circular list (cross-TU std::list iterator
  // mismatch). CIccProfile::FindTag (which lives in IccProfLib) is safe, so we
  // probe a fixed, canonically-ordered signature list instead. This also gives
  // deterministic ordering, close to the profile's tag-table order.

  // Chromaticity first. Enumerated whenever the profile carries a media white
  // point OR the full RGB colorant set: buildChromaticityGraph plots the white
  // point on its own and only adds the primaries/gamut polygon when all three
  // colorants exist, so output/CMYK profiles (white point but no colorants)
  // still get a meaningful white-point-on-the-locus chart for wtpt.
  if (pIcc->FindTag(icSigMediaWhitePointTag) ||
      (pIcc->FindTag(icSigRedColorantTag) && pIcc->FindTag(icSigGreenColorantTag) &&
       pIcc->FindTag(icSigBlueColorantTag))) {
    Descriptor d;
    d.kind = Kind::ChromaticityXY; d.output = Output::Graph;
    d.id = "chroma:xy"; d.title = "Chromaticity xy";
    out.push_back(std::move(d));
  }

  static const icTagSignature kTrcSigs[] = {
    icSigRedTRCTag, icSigGreenTRCTag, icSigBlueTRCTag, icSigGrayTRCTag };
  for (icTagSignature sig : kTrcSigs) {
    auto* c = dynamic_cast<CIccCurve*>(pIcc->FindTag(sig));
    if (!c) continue;   // present-but-malformed curves are kept; see RenderGraph
    Descriptor d;
    d.kind = Kind::Curve1D; d.output = Output::Graph;
    d.id = "curve:" + sigStr(sig); d.title = sigStr(sig); d.tag = sig;
    out.push_back(std::move(d));
  }

  static const icTagSignature kLutSigs[] = {
    icSigAToB0Tag, icSigAToB1Tag, icSigAToB2Tag, icSigAToB3Tag,
    icSigBToA0Tag, icSigBToA1Tag, icSigBToA2Tag, icSigBToA3Tag,
    icSigGamutTag, icSigPreview0Tag, icSigPreview1Tag, icSigPreview2Tag };
  for (icTagSignature sig : kLutSigs) {
    CIccTag* t = pIcc->FindTag(sig);
    auto* lut = dynamic_cast<CIccMBB*>(t);
    if (!lut) continue;
    enumerateLutCurves(pIcc, sig, lut, out);
    Raster probe;
    // Probe only — diag==nullptr, so tags that legitimately carry no CLUT
    // (matrix/curve-only mAB/mBA) skip silently; a real RenderRaster() surfaces
    // any failure reason.
    if (buildClutRaster(t, sigStr(sig), probe)) {
      Descriptor d;
      d.kind = Kind::ClutImage; d.output = Output::Raster;
      d.id = "clut:" + sigStr(sig); d.title = sigStr(sig) + " CLUT"; d.tag = sig;
      out.push_back(std::move(d));
    }
  }

  // L* tone-reversal scans (Kind::InkReversalL) — one graph per device-input
  // channel of each device→PCS AToB LUT that carries a CLUT. BToA/gamut/preview
  // are PCS-input, so "increase one ink" is undefined and they are excluded here.
  static const icTagSignature kReversalSigs[] = {
    icSigAToB0Tag, icSigAToB1Tag, icSigAToB2Tag };
  for (icTagSignature sig : kReversalSigs) {
    auto* lut = dynamic_cast<CIccMBB*>(pIcc->FindTag(sig));
    if (!lut) continue;
    CIccCLUT* clut = lut->GetCLUT();
    if (!clut) continue;                                            // need a lattice
    clut->Begin();                                                  // init grid metadata
    const icColorSpaceSignature inSp  = lut->GetCsInput();
    const icColorSpaceSignature outSp = lut->GetCsOutput();
    if (isPcsSpace(inSp)) continue;                                 // device input only
    if (outSp != icSigLabData && outSp != icSigXYZData) continue;   // PCS output only
    const int inCh  = lut->InputChannels();
    const int outCh = lut->OutputChannels();
    if (inCh <= 0 || inCh > kMaxInkChannels) continue;
    // Don't advertise a reversal graph RenderGraph couldn't build: skip the tag if
    // its device lattice would exceed the node cap. Over-cap profiles then show
    // "not applicable" gracefully instead of erroring when the tab renders.
    if (!reversalLatticeFits(clut, inCh)) continue;
    for (int ch = 0; ch < inCh; ++ch) {
      Descriptor d;
      d.kind = Kind::InkReversalL; d.output = Output::Graph;
      d.id = "reversal:" + sigStr(sig) + ":" + std::to_string(ch);
      d.title = sigStr(sig) + " L* reversal: " +
                channelName(ch, /*useInput=*/true, inSp, outSp, inCh, outCh);
      d.tag = sig; d.idx = ch;
      out.push_back(std::move(d));
    }
  }

  // Neutral-axis inking (Kind::NeutralAxisInking) — one graph per B2A table that
  // maps PCS→device. (The receiver restricts these to output profiles and adds the
  // rendering-intent labels; structurally we just need a PCS-in / device-out CLUT.)
  static const icTagSignature kNeutralSigs[] = {
    icSigBToA0Tag, icSigBToA1Tag, icSigBToA2Tag };
  for (icTagSignature sig : kNeutralSigs) {
    auto* lut = dynamic_cast<CIccMBB*>(pIcc->FindTag(sig));
    if (!lut || !lut->GetCLUT()) continue;
    const icColorSpaceSignature inSp  = lut->GetCsInput();
    const icColorSpaceSignature outSp = lut->GetCsOutput();
    if (!isPcsSpace(inSp)) continue;                                 // PCS input
    if (isPcsSpace(outSp)) continue;                                 // device output
    const int outCh = lut->OutputChannels();
    if (outCh <= 0 || outCh > kMaxInkChannels) continue;
    Descriptor d;
    d.kind = Kind::NeutralAxisInking; d.output = Output::Graph;
    d.id = "neutral:" + sigStr(sig); d.title = sigStr(sig) + " neutral axis inking"; d.tag = sig;
    out.push_back(std::move(d));
  }

  static const icTagSignature kNamedSigs[] = {
    icSigNamedColorTag, icSigNamedColor2Tag, icSigColorantTableTag, icSigColorantTableOutTag,
    icSigColorantInfoTag, icSigColorantInfoOutTag };   // last two are v5 tagArray
  for (icTagSignature sig : kNamedSigs) {
    CIccTag* t = pIcc->FindTag(sig);
    if (!t) continue;
    std::vector<NamedLab> colors; std::string title;
    if (!collectNamedColors(pIcc, t, sigStr(sig), colors, title)) continue;   // probe: diag==nullptr
    Descriptor ab;
    ab.kind = Kind::NamedColorsAB; ab.output = Output::Graph;
    ab.id = "named:ab:" + sigStr(sig); ab.title = title + " — a*b* (" + sigStr(sig) + ")";
    ab.tag = sig; out.push_back(std::move(ab));
    Descriptor xy;
    xy.kind = Kind::NamedColorsXY; xy.output = Output::Graph;
    xy.id = "named:xy:" + sigStr(sig); xy.title = title + " — xy (" + sigStr(sig) + ")";
    xy.tag = sig; out.push_back(std::move(xy));
  }
  return out;
}

GraphResult RenderGraph(CIccProfile* pIcc, const std::string& id, Verbosity v) {
  GraphResult res;
  if (!pIcc) { res.error = "null profile"; return res; }
  for (const Descriptor& d : Enumerate(pIcc)) {
    if (d.id != id) continue;
    if (d.output != Output::Graph) { res.error = "descriptor is not a graph"; return res; }
    if (d.kind == Kind::ChromaticityXY) {
      res.graph = buildChromaticityGraph(pIcc); res.ok = true; return res;
    }
    if (d.kind == Kind::Curve1D) {
      CIccTag* t = pIcc->FindTag(d.tag);
      CIccCurve* c = nullptr;
      if (d.grp) { auto* lut = dynamic_cast<CIccMBB*>(t); if (lut) c = lutCurveFor(lut, d.grp, d.idx); }
      else c = dynamic_cast<CIccCurve*>(t);
      if (!c) { res.error = "curve not found"; return res; }
      // A malformed curve (e.g. gamma 0) is no longer dropped at enumerate; we
      // render its (degenerate) shape but carry the validation reason as a
      // diagnostic so the UI can show it instead of a blank/absent graph.
      std::string report;
      if (curveValidate(c, d.title, report) > icValidateWarning)
        res.diagnostics.push_back({Severity::Warning, "WARNING - curve failed validation:\n" + report});
      res.graph = buildCurveGraph(c, d.title); res.ok = true;
      emitDiagnostics(res.diagnostics, v);
      return res;
    }
    if (d.kind == Kind::NamedColorsAB || d.kind == Kind::NamedColorsXY) {
      CIccTag* t = pIcc->FindTag(d.tag);
      std::vector<NamedLab> colors; std::string title;
      if (t && collectNamedColors(pIcc, t, sigStr(d.tag), colors, title, &res.diagnostics)) {
        res.graph = (d.kind == Kind::NamedColorsAB) ? buildNamedAB(colors, title)
                                                    : buildNamedXY(pIcc, colors, title);
        res.ok = true;
      } else {
        // Surface the specific reason (validation report, bad pcs, …) rather
        // than a generic string — restoring outputNamedColors' diagnostics.
        res.error = res.diagnostics.empty() ? "no colours" : res.diagnostics.back().message;
      }
      emitDiagnostics(res.diagnostics, v);
      return res;
    }
    if (d.kind == Kind::InkReversalL) {
      if (buildReversalGraph(pIcc, d.tag, d.idx, res.graph, &res.diagnostics))
        res.ok = true;
      else
        res.error = res.diagnostics.empty() ? "no reversal data"
                                            : res.diagnostics.back().message;
      emitDiagnostics(res.diagnostics, v);
      return res;
    }
    if (d.kind == Kind::NeutralAxisInking) {
      if (buildNeutralAxisGraph(pIcc, d.tag, res.graph, &res.diagnostics))
        res.ok = true;
      else
        res.error = res.diagnostics.empty() ? "no neutral data"
                                            : res.diagnostics.back().message;
      emitDiagnostics(res.diagnostics, v);
      return res;
    }
    res.error = "unsupported graph kind"; return res;
  }
  res.error = "unknown visualization id: " + id;
  return res;
}

RasterResult RenderRaster(CIccProfile* pIcc, const std::string& id, Verbosity v) {
  RasterResult res;
  if (!pIcc) { res.error = "null profile"; return res; }
  for (const Descriptor& d : Enumerate(pIcc)) {
    if (d.id != id) continue;
    if (d.output != Output::Raster) { res.error = "descriptor is not a raster"; return res; }
    CIccTag* t = pIcc->FindTag(d.tag);
    if (t && buildClutRaster(t, sigStr(d.tag), res.raster, &res.diagnostics)) {
      res.ok = true;
    } else {
      // Specific reason (invalid CLUT width/height/grid, empty buffer, …).
      res.error = res.diagnostics.empty() ? "could not build raster"
                                          : res.diagnostics.back().message;
    }
    emitDiagnostics(res.diagnostics, v);
    return res;
  }
  res.error = "unknown visualization id: " + id;
  return res;
}

// ── diagnostic output policy (see IccVizModel.hpp) ────────────────────────────
void SetSilent(bool silent) { g_silent = silent; }
bool GetSilent() { return g_silent; }
void SetDiagnosticContext(const std::string& name) { g_diagContext = name; }

} // namespace iccviz
