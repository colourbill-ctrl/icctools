/*
  File:     IccVizModel.hpp

  Contains: Data-first profile visualization model — public API (pick a Kind, supply a CIccProfile, call Enumerate/RenderGraph/RenderRaster).

  Version:  V1

  Copyright:  (c) see below
*/

/*
 * The ICC Software License, Version 0.2
 *
 *
 * Copyright (c) 2003-2026 The International Color Consortium. All rights
 * reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *  notice, this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *  notice, this list of conditions and the following disclaimer in
 *  the documentation and/or other materials provided with the
 *  distribution.
 *
 * 3. In the absence of prior written permission, the names "ICC" and "The
 *  International Color Consortium" must not be used to imply that the
 *  ICC organization endorses or promotes products derived from this
 *  software.
 *
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESSED OR IMPLIED
 * WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED.  IN NO EVENT SHALL THE INTERNATIONAL COLOR CONSORTIUM OR
 * ITS CONTRIBUTING MEMBERS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF
 * USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
 * OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 * ====================================================================
 *
 * This software consists of voluntary contributions made by many
 * individuals on behalf of the The International Color Consortium.
 *
 *
 * Membership in the ICC is encouraged when this software is used for
 * commercial purposes.
 *
 *
 * For more information on The International Color Consortium, please
 * see <http://www.color.org/>.
 *
 *
 */

/**
 * IccVizModel — data-first profile visualization model.
 *
 * Computes a profile's visualizations — tone curves, the CIE 1931 chromaticity
 * chart, named/colorant a*b* and xy scatters, and the nD CLUT lattice — and
 * *returns the underlying data* rather than finished drawings:
 *
 *   - Graph visualizations (tone curves, chromaticity, named-colour scatters)
 *     come back as Graph: 2-D point series plus axis range hints, so the caller
 *     draws/rasterizes them in its own look-and-feel. NO raster is produced for
 *     graph types.
 *   - Genuine images (the nD CLUT lattice) come back as Raster: the flattened,
 *     ICC-normalized CLUT samples plus geometry — the caller decides how to
 *     colour-manage/display them.
 *
 * Series carry a role: Primary (the profile's own data — primaries, white,
 * curve, named colours) vs Hint (reference geometry the caller may draw or
 * ignore — spectral locus, planckian curve, wavelength labels, chroma circles,
 * identity line). No ticks/grid are shipped: those are a caller-side decision;
 * only an axis range *hint* is provided.
 *
 * Design intent: this file depends ONLY on IccProfLib + spectralLocus.hpp + the
 * C++ standard library — no embind, no nlohmann, no PDF/TIFF writers — so it is
 * self-contained and portable between callers (CLI, browser/WASM, tests).
 */

#ifndef ICC_VIZ_MODEL_HPP
#define ICC_VIZ_MODEL_HPP

#include "IccDefs.h"           // icTagSignature, icColorSpaceSignature, and ICC header packing
#include <string>
#include <vector>
#include <limits>

class CIccProfile;

namespace iccviz {

// Stable identity for a visualization category. Append-only: existing values
// never change, so they are safe to use as a persistent wire identifier.
enum class Kind : unsigned int {
  Curve1D        = 1,   // 1-D tone curve (TRC, or an A/B/M curve of a LUT tag)
  ChromaticityXY = 2,   // RGB primaries + white on the CIE 1931 xy chart
  NamedColorsAB  = 3,   // named/colorant colours on a CIELAB a*b* chart
  NamedColorsXY  = 4,   // named/colorant colours on the xy chart
  ClutImage      = 5,   // nD CLUT lattice flattened to an image (raster)
  // SmoothnessLattice = 6,  // reserved — deferred to a later phase
  // InkReversalL     = 7,   // retired — per-channel L* tone-reversal scan (removed); value reserved
  NeutralAxisInking = 8,// device colorant along the neutral axis from a PCS→device LUT,
                        // plus the neutral tone response and its round-trip ΔE (graph)
};

enum class Output : unsigned char { Graph, Raster };

// What a series represents, so the caller can style data vs reference geometry.
enum class Role : unsigned char { Primary, Hint };

enum class Shape : unsigned char { Polyline, ClosedPath, Scatter };

struct Vertex {
  float x = 0.0f;
  float y = 0.0f;
  std::string label;                                  // "" when unlabelled
  float aux = std::numeric_limits<float>::quiet_NaN(); // NaN when no aux scalar
};

struct Series {
  std::string id;          // "curve","identity","locus","planckian","chroma30",…
  std::string name;        // human/legend label
  Role  role  = Role::Primary;
  Shape shape = Shape::Polyline;
  std::string auxKind;     // "", "Lstar", "nm", "kelvin" — meaning of Vertex.aux
  std::string colorHint;   // optional: "R","G","B","white","neutral","locus"
  // When true this series is measured in the units of Graph::y2Axis, not yAxis, and
  // the receiver must plot it against the secondary axis. Set it whenever a series
  // shares a chart with data of a DIFFERENT physical quantity (e.g. ΔE*ab alongside
  // colorant %) — the two would otherwise be silently drawn on one scale, which
  // either flattens one to the baseline or inflates it into nonsense.
  bool useY2 = false;
  std::vector<Vertex> verts;
};

struct Axis {
  std::string label;       // "Input", "a*", "x (CIE 1931)"
  // Suggested range only — the caller may recompute or override. minHint == maxHint
  // means "no hint": the receiver should autorange (see Graph::y2Axis, whose extent
  // is data-dependent and deliberately left to the plotting layer).
  float minHint = 0.0f;
  float maxHint = 1.0f;
  bool  equalAspect = false;  // chart wants square aspect (xy / ab plots)
};

struct Graph {
  std::string title;
  std::string description;   // e.g. curve Describe() text
  Axis xAxis, yAxis;
  // Optional right-hand axis for series carrying a second physical quantity.
  // `y2Axis` is meaningful only when `hasY2`; series opt in via Series::useY2.
  bool hasY2 = false;
  Axis y2Axis;
  std::vector<Series> series;  // mixed Primary + Hint
};

struct Raster {
  int  width = 0, height = 0, channels = 0, bitsPerChannel = 0;
  int  photometric = 1;       // TIFF-style hint: 0/1 gray, 2 RGB, 5 CMYK, 8 CIELAB
  bool normalizedICC = true;  // samples are ICC-normalized (not TIFF-standard Lab)
  std::vector<unsigned char> samples;  // row-major, channels interleaved
};

// One available visualization. `id` is stable and is what callers pass back to
// render(). Internal addressing fields (tag/group/index) let render() rebuild
// the exact source object without re-parsing the id string.
struct Descriptor {
  Kind   kind;
  Output output;
  std::string id;
  std::string title;
  icTagSignature tag = static_cast<icTagSignature>(0);  // owning tag (0 = whole profile)
  char grp = 0;          // 'A' | 'B' | 'M' for LUT sub-curves, else 0
  int  idx = -1;         // channel index within grp, else -1
};

// A diagnostic raised while building a visualization — a granular skip/warn
// reason, carried here as DATA so a library caller (browser UI, CLI, test)
// decides how to surface them (log to stderr, show inline, ignore). Additive:
// `error` still holds the single fatal reason for the simple ok/error path,
// while `diagnostics` preserves per-failure detail and adds non-fatal warnings
// (e.g. tile-count overflow) that the simple path can't represent.
enum class Severity : unsigned char { Warning, Error };
struct Diagnostic { Severity severity = Severity::Error; std::string message; };

struct GraphResult  { bool ok = false; std::string error; std::vector<Diagnostic> diagnostics; Graph  graph;  };
struct RasterResult { bool ok = false; std::string error; std::vector<Diagnostic> diagnostics; Raster raster; };

// ── diagnostic output policy ─────────────────────────────────────────────────
// Each render result ALWAYS carries its diagnostics as data (see Diagnostic). In
// ADDITION, the model echoes them to stderr — reproducing the top-level
// behaviour a command-line caller expects. A process-global switch controls
// this; it DEFAULTS to not-silent, so a caller that never touches it (and never
// passes a Verbosity) behaves exactly like the CLI.
//
// A library embedding the model where stderr is wrong (browser/WASM) calls
// SetSilent(true) once, naturally in its profile-supply / setup step. Any single
// render call can override the global by passing an explicit Verbosity.
enum class Verbosity {
  Default,   // consult the global SetSilent() switch (the polymorphic default)
  Stderr,    // force-echo this call's diagnostics to stderr
  Silent     // suppress this call's stderr, regardless of the global switch
};

void SetSilent(bool silent = true);                  // global; default state is not-silent
bool GetSilent();                                    // read that global silent switch
// Optional "<name>: " prefix prepended to each stderr line — the CLI sets the
// profile filename here so its output matches iccProfileVisualize byte-for-byte.
void SetDiagnosticContext(const std::string& name);

// List every visualization available for the profile, in a stable canonical
// order: chromaticity first, then in a fixed canonical signature order — TRC curves, then
// each LUT's A/B/M curves followed by its CLUT image, then a neutral-axis inking
// graph for each PCS→device BToA table, then named/colorant tables as a*b* then xy.
std::vector<Descriptor> Enumerate(CIccProfile* pIcc);

// RenderGraph / RenderRaster — render one graph or raster by descriptor id.
// Re-enumerates to find the descriptor (cheap; callers should cache the parsed
// profile). Diagnostics are echoed to stderr per the Verbosity (default → the
// global SetSilent() switch).
GraphResult  RenderGraph (CIccProfile* pIcc, const std::string& id, Verbosity v = Verbosity::Default);  // graph kinds
RasterResult RenderRaster(CIccProfile* pIcc, const std::string& id, Verbosity v = Verbosity::Default);  // ClutImage raster

// ── Gamut volume ─────────────────────────────────────────────────────────────
// Volume (ΔE*ab³) enclosed by a profile's gamut, measured by boundary
// voxelisation + flood-fill: sample the device-cube boundary (all facets) through
// the AToB transform → L*a*b*, voxelise, dilate to seal sampling gaps, flood-fill
// the exterior, erode the dilation back, count enclosed voxels. A scalar
// metric — not a Graph/Raster — so it sits outside the Enumerate/Render path.
//
// Adapted from chardata's gamut-wasm `gamutVolumeIcc`; here the device→PCS step uses
// IccProfLib (CIccXform on `aToBTag`, device values 0..1, PCS→Lab decoded via
// icLabFromPcs / icXyzFromPcs+icXYZtoLab). Pick (tag, intent) to select the
// gamut: perceptual = AToB0/icPerceptual, relative = AToB1/icRelativeColorimetric,
// saturation = AToB2/icSaturation, absolute = AToB1/icAbsoluteColorimetric.
//
// `volume` is a discrete-voxel estimate (resolution = voxelSize). Check
// `degenerate`: when true the boundary sampling largely failed or collapsed, so
// the number is unreliable and a caller cannot tell "genuinely tiny gamut" from
// "sampling collapsed" — surface it as N/A rather than a real measurement.
struct GamutVolumeResult {
  bool        ok             = false;
  std::string error;
  double      volume         = 0.0;  // ΔE*ab³ = enclosed voxels × voxelSize³
  long long   voxels         = 0;
  int         samplesPerAxis = 0;    // device-cube boundary steps per free axis
  double      voxelSize      = 0.0;  // Lab grid cell edge (ΔE*ab)
  int         nColorants     = 0;    // device channels
  bool        degenerate     = false;// boundary collapsed / mostly non-finite: volume unreliable
};

// Compute the gamut volume for one device→PCS (AToB) tag at `intent`. Pass 0 for
// samplesPerAxis / voxelSize / dilate to auto-pick them from the colorant count.
GamutVolumeResult GamutVolume(CIccProfile* pIcc, icTagSignature aToBTag,
                              icRenderingIntent intent,
                              int samplesPerAxis = 0, double voxelSize = 0.0,
                              int dilate = 0);

// ── Gamut boundary mesh (for the Compare-tab gamut plots) ────────────────────
// A triangulated gamut-boundary surface in human L*a*b*: the 2-skeleton of the
// device N-cube (every 2-face grid-sampled at (S+1)² points, each quad split into
// two triangles), each grid point mapped device→PCS→Lab through the profile's
// device→PCS transform at `intent`.
//
// The transform is built from the PROFILE, not a specific AToB tag: it uses the
// profile's A2B LUT when present AND falls back to the matrix/TRC model, so
// matrix/TRC display profiles (AdobeRGB, sRGB, …) get a gamut too — not only
// LUT profiles. `intent` selects the table / white handling (perceptual, relative,
// saturation, absolute) exactly as a CMM would.
//
// It is the profile-derived boundary (DL-SCOPE1): a UNION of face patches, so it can
// be non-convex and self-overlapping and is not a closed manifold — good enough to
// draw a gamut shell / slice, NOT to integrate a signed volume (use GamutVolume for
// that).
//
// `vertices` is flat, 3 floats/vertex (L*, a*, b*); a vertex whose device point mapped
// to a non-finite Lab is emitted as-is (NaN) so triangle indices stay valid — the
// caller drops any triangle touching a non-finite vertex. `triangles` is flat, 3
// int32 indices/triangle into `vertices`. `samplesPerAxis` echoes the S actually used
// (auto-picked from the colorant count when the caller passes ≤0).
struct GamutMeshResult {
  bool               ok = false;
  std::string        error;
  int                nColorants     = 0;   // device channels (N)
  int                samplesPerAxis = 0;   // grid steps per free axis on each 2-face
  std::vector<float> vertices;             // flat L*,a*,b* (3 per vertex)
  std::vector<int>   triangles;            // flat index triples (3 per triangle)
};

// Build the gamut-boundary mesh for the profile's device→PCS transform at `intent`.
// Pass 0 for samplesPerAxis to auto-pick a render-oriented grid density.
GamutMeshResult GamutBoundaryMesh(CIccProfile* pIcc, icRenderingIntent intent,
                                  int samplesPerAxis = 0);

// ── B2A round-trip accuracy ───────────────────────────────────────────────────
// Round-trip of Lab through the profile: seed in-gamut L*a*b* by sampling the
// device cube on an interior grid and pushing it through A2B, then run each
// Lab₁ → device (B2A) → Lab₂ (A2B) and report ΔE*ab(Lab₁, Lab₂). Measures how
// accurately the B2A (PCS→device) table inverts the A2B for that intent — a
// method suggested by Harold Boll. A scalar metric (outside the Enumerate/Render
// path).
//
// Why seed from the device cube rather than sampling L*a*b* directly: every seed
// is then the A2B image of a real device value, so the test points are wholly
// IN-GAMUT and the round trip measures genuine B2A/A2B agreement. A directly
// sampled L*a*b* grid would place many points outside the gamut, where B2A only
// clamps them and reports a large, meaningless ΔE. Walking the device interior on
// a regular grid also spreads the seeds reasonably evenly, in terms of spacing,
// through the interior of the in-gamut region of L*a*b* space.
//
// Needs matching AToB/BToA tags for `intent` (perceptual = A2B0/B2A0, relative &
// absolute = A2B1/B2A1, saturation = A2B2/B2A2); `intent` also drives the PCS
// white handling (relative vs absolute).
struct RoundTripResult {
  bool        ok         = false;
  std::string error;
  int         n          = 0;    // finite test points
  double      minDE      = 0.0;  // ΔE*ab — smallest round-trip error seen
  double      meanDE     = 0.0;  // ΔE*ab
  double      p90DE      = 0.0;
  double      maxDE      = 0.0;
  double      stdDE      = 0.0;
  int         nColorants = 0;    // device channels
  // Cumulative interoperability histogram — count of test points whose ΔE is at or
  // under each threshold (so nLE1 ≤ nLE2 ≤ … ≤ n). These mirror the CIccPRMG
  // ≤1/2/3/5/10 buckets so RT0 presents in the app with the SAME histogram shape as
  // RT1/RT2/PRMG (the unified Profile-Statistics round-trip table). This is an
  // in-app presentation choice — the iccRoundTrip CLI does not bucket this metric.
  unsigned int nLE1 = 0, nLE2 = 0, nLE3 = 0, nLE5 = 0, nLE10 = 0;
  // The in-gamut L*a*b* (first PCS pass) at the worst ΔE — lets the UI point at the
  // colour where the round trip fails hardest. `hasWorst` guards the empty case.
  bool        hasWorst   = false;
  double      worstLab[3] = {0.0, 0.0, 0.0};
  // Integer-ΔE histogram for the relative-/cumulative-frequency plot: bin i spans
  // ΔE ∈ [i, i+1); top edge / over-range folds into the last bin. Same binning (and
  // 200-bin cap) as the RT1/RT2/PRMG DeStats path so every type plots identically.
  std::vector<unsigned int> hist;
};

// samplesPerAxis 0 → auto-pick the device seed grid from the colorant count.
RoundTripResult RoundTripDE(CIccProfile* pIcc, icRenderingIntent intent,
                            int samplesPerAxis = 0);

// ── Round-trip ΔE by quantized lightness (the reference QC scatter) ───────────
// Reproduces the reference report's "B2A1 Roundtrip dEab by quantized L*; Pts vary
// from GBD to Neutral" figure, whose entire information content is the WITHIN-BAND
// structure — so this returns the individual points, not a summary.
//
// Seeding, which is what makes the picture readable:
//   • `levels` lightness levels spanning the gamut's usable L* range.
//   • At each level, `perHue` points on the GAMUT BOUNDARY (max chroma per hue angle).
//   • Each boundary point then eroded toward neutral at chroma ×0.8, ×0.5, ×0.2.
//   • The last point of each level is replaced by neutral itself.
// So each level contributes perHue×4 points that march from the gamut surface inward,
// and the plot shows ΔE falling from the boundary to the neutral axis. Defaults
// (32 levels × 64 hues) give 8192 points — the reference's exact count.
//
// Every seed is IN GAMUT by construction, so the ΔE measures genuine B2A/A2B
// disagreement rather than clipping of unreachable colours.
//
// `x` is a monotonic pseudo-L* coordinate: within level i the points spread linearly
// from L(i) to L(i+1), so bands sit side by side and never overlap. `levelL` holds the
// band edges for drawing separators. This differs from the interior-grid seeding used
// by RoundTripDE, so the two are NOT numerically comparable — this one deliberately
// over-weights the gamut boundary, where inversion is hardest.
struct RoundTripLightnessResult {
  bool        ok = false;
  std::string error;
  int         n         = 0;     // finite points (≤ levels × perHue × 4)
  int         levels    = 0;
  int         perHue    = 0;
  double      loL       = 0.0;   // lightness range actually sampled
  double      hiL       = 0.0;
  double      meanDE    = 0.0;
  double      p90DE     = 0.0;
  double      maxDE     = 0.0;
  std::vector<float> levelL;     // L* of each level, for the band separators
  std::vector<float> x;          // pseudo-L* coordinate, one per point
  std::vector<float> de;         // ΔE*ab, one per point
};
// levels / perHue ≤0 → 32 / 64 (the reference's sampling).
RoundTripLightnessResult RoundTripByLightness(CIccProfile* pIcc, icRenderingIntent intent,
                                              int levels = 0, int perHue = 0);

// ── Media white / black point + total area coverage ───────────────────────────
// The four numbers a print operator reads first, derived the way the reference QC
// script does it (doQCpfA.m / getBlackWhitePts):
//
//   WHITE = the colour of ZERO colorant, i.e. bare substrate. Read through the
//     forward A2B1 table at relative intent (≈ L*100,0,0 by definition) and again at
//     absolute intent (the substrate's actual colour — e.g. L*95.02 a*0.98 b*-4.02
//     for a blue-white paper).
//   BLACK = the darkest the profile will actually go: push PCS black (L*=0,a*=b*=0)
//     through the chosen B2A table to get the inking the profile *chooses* for black,
//     then read that inking back through A2B1, relative and absolute.
//   TAC = the sum of that black inking — total area coverage, the ink-limit figure
//     (returned as a fraction; ×100 gives the usual "320%").
//
// The black point is intent-dependent, because each B2A table picks its own inking
// for black — hence `b2aTag` rather than an intent enum: pass icSigBToA0Tag /
// BToA1 / BToA2 and the matching intent is used to build the transform.
//
// NOTE the substrate assumption: "white = zero colorant" holds for subtractive
// (printing) devices, which is what this analysis is for. Restrict it to output
// profiles; on an additive device zero colorant is black, and `whiteLab*` would then
// describe the wrong end of the axis.
//
// `hasAbsolute` is false when the absolute leg could not be built — a profile with no
// mediaWhitePoint tag cannot be read absolutely. It is also legitimate for the
// absolute and relative numbers to be identical: IccProfLib only applies the media
// adjustment when the media white differs from the illuminant.
struct WhiteBlackResult {
  bool        ok = false;
  std::string error;
  int         nColorants = 0;
  bool        hasAbsolute = false;
  double      whiteLabRel[3] = {0.0, 0.0, 0.0};   // L*, a*, b*
  double      whiteLabAbs[3] = {0.0, 0.0, 0.0};
  double      blackLabRel[3] = {0.0, 0.0, 0.0};
  double      blackLabAbs[3] = {0.0, 0.0, 0.0};
  std::vector<double> blackInk;                   // device values 0..1, one per colorant
  double      tac = 0.0;                          // sum(blackInk); ×100 = TAC %
};

// Compute white/black points and TAC from one B2A (PCS→device) tag plus the forward
// A2B1 table. Needs both: A2B1 alone cannot say what inking the profile picks for black.
WhiteBlackResult WhiteBlackPoints(CIccProfile* pIcc, icTagSignature b2aTag);

// ── Per-hue full-tone / maximum-chroma colorimetry ────────────────────────────
// For each chromatic corner of the inkset (C, M, Y, R, G, B, plus K) report where the
// profile puts it in L*C*h — twice:
//
//   fullTone   — the corner itself (100% of the contributing inks).
//   maxChroma  — the most chromatic point found while ramping from bare substrate to
//                that corner, together with the inking that achieved it.
//
// The DIAGNOSIS is the difference between the two. On a well-behaved profile maximum
// chroma sits at full tone and the rows are identical (as they are for GRACoL2013).
// When they diverge, the profile is over-inking: past some point more ink stops adding
// chroma and starts darkening — `rampFraction` says where that turn happened.
//
// Measured through A2B1 at relative intent, matching the reference QC script; the
// result is therefore intent-independent.
//
// Requires a device space whose channel ORDER is fixed and known — icSigCmykData or
// icSigCmyData. An n-colour (nCLR) space names its channels through colorantTable and
// they can be in any order, so the corners cannot be stated without guessing; those
// profiles return ok=false rather than a plausible-looking wrong answer.
struct HueExtremaEntry {
  std::string name;                    // "Cyan","Magenta","Yellow","Red","Green","Blue","Black"
  double fullToneLab[3]  = {0,0,0};    // L*, a*, b*
  double fullToneHCL[3]  = {0,0,0};    // hue°, C*, L*
  double maxChromaLab[3] = {0,0,0};
  double maxChromaHCL[3] = {0,0,0};
  std::vector<double> maxChromaInk;    // device values 0..1 at maximum chroma
  double rampFraction = 0.0;           // 0..1 along substrate→full tone where max C* fell
};
struct HueExtremaResult {
  bool        ok = false;
  std::string error;
  int         nColorants = 0;
  std::vector<HueExtremaEntry> entries;
};
// rampSamples 0 → 1024 (the reference script's sampling density); clamped to [16,4096].
HueExtremaResult HueExtrema(CIccProfile* pIcc, int rampSamples = 0);

// ── Ink usage in the shadows ──────────────────────────────────────────────────
// Four straight paths across the a*b* plane at ONE constant, deliberately dark L*,
// pushed through a B2A table so you can watch the separation change as the colour
// travels from far out of gamut, through the gamut, and out the other side.
//
// This is where gamut-mapping artefacts live: an abrupt step or a reversal in a
// colorant here is a visible shadow artefact in print. Because all four paths share
// one L*, any change is attributable to hue/chroma handling alone.
//
// The plane is chosen the way the reference script does: halfway between the
// profile's Blue corner and the darkest of C, M, Y, R, G — i.e. just inside the
// shadow end of the gamut. Paths run at 0° (the a* axis), 45°, 90° (the b* axis)
// and 135°, each swept across the full ±127 PCS range.
//
// BLACK POINT COMPENSATION: the perceptual and saturation tables expect PCS black at
// L*=0, so for B2A0/B2A2 the L* is first stretched from the media black point up to
// PCS black — exactly as the reference script does before those transforms. Following
// that script, the media black point always comes from B2A0 (falling back to the
// selected tag when the profile has no B2A0), so the three intents stay comparable.
// `bpcApplied` reports whether the stretch happened.
//
// Same device-space restriction as HueExtrema: the constant-L* plane is derived from
// the CMYRGB corners, so CMYK/CMY only.
struct ShadowInkResult {
  bool        ok = false;
  std::string error;
  int         nColorants = 0;
  double      lStar      = 0.0;    // the constant L* plane actually sampled (after BPC)
  double      lStarRaw   = 0.0;    // …before BPC, so the UI can show both
  bool        bpcApplied = false;
  std::vector<Graph> graphs;       // one per path angle, in 0/45/90/135° order
};
// pathSamples 0 → 256 (the reference script's density); clamped to [16,4096].
ShadowInkResult ShadowInkPaths(CIccProfile* pIcc, icTagSignature b2aTag, int pathSamples = 0);

} // namespace iccviz

#endif // ICC_VIZ_MODEL_HPP
