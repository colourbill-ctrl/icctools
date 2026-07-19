// (c) 2026 William Li
/**
 * roundtrip-eval.hpp — the round-trip ΔE accumulators shared by every round-trip
 * "type" the Analysis tab presents.
 *
 * Two things live here:
 *
 *   DeStats          — a reusable ΔE-distribution accumulator: min / mean / P90 /
 *                      max, the cumulative ≤1/2/3/5/10 histogram, and the worst-
 *                      error colour. Every round-trip type (RT0 iccviz overview,
 *                      RT1/RT2 device-cube, PRMG interoperability) funnels its
 *                      per-sample ΔE through a DeStats so they ALL present in the
 *                      unified Profile-Statistics table identically. This is a
 *                      deliberate in-app presentation choice (the iccRoundTrip CLI
 *                      only prints min/mean/max for RT1/RT2 and only buckets for
 *                      PRMG) — see design doc DL-A1.
 *
 *   CIccMinMaxEval   — the device-cube walker, a port of the accumulator currently
 *                      trapped inside the CLI tool (iccRoundTrip.cpp:83-150). It
 *                      subclasses CIccEvalCompare, which walks the device cube and
 *                      hands Compare() three PCS points per seed: the device
 *                      colour's Lab (deviceLab), the once-round-tripped Lab (lab1 =
 *                      device→PCS→device→PCS) and the twice-round-tripped Lab
 *                      (lab2). We accumulate two CIE76 ΔE distributions:
 *                        Round Trip 1 = ΔE(deviceLab, lab1)  — inversion + gamut
 *                        Round Trip 2 = ΔE(lab1,     lab2)  — reproducibility
 *                      via two DeStats. No filesystem, no IccProfLib changes —
 *                      EvaluateProfile(CIccProfile*, …) already exists.
 */
#ifndef PROFILETOOL_ROUNDTRIP_EVAL_HPP
#define PROFILETOOL_ROUNDTRIP_EVAL_HPP

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>
#include "IccEval.h"
#include "IccUtil.h"

// ── DeStats ───────────────────────────────────────────────────────────────────
// One ΔE distribution. Storing each finite sample's ΔE lets us compute an EXACT
// P90 (nth_element, O(n)); the sample count is bounded upstream by the round-trip
// sampling caps (icMaxRoundTripSamples = 2,000,000 in IccEval.cpp; the PRMG PCS
// sweep is ~101³ ≈ 1.03M; the iccviz seed grid is capped at 3,000,000), so the
// vector can never grow without bound — the guard against a memory blow-up is the
// caller's own sampling cap, which we rely on and document rather than duplicate.
struct DeStats {
  double sum = 0.0;
  double minDE = 0.0, maxDE = 0.0;
  bool   any = false;                 // false until the first sample (guards min/max)
  // Cumulative interoperability counts: nLE1 ≤ nLE2 ≤ … ≤ count(). Same thresholds
  // as CIccPRMG so all round-trip types share one histogram shape in the UI.
  icUInt32Number nLE1 = 0, nLE2 = 0, nLE3 = 0, nLE5 = 0, nLE10 = 0;
  icFloatNumber worstLab[3] = {0, 0, 0};   // representative colour at the max ΔE
  std::vector<float> des;                  // every finite ΔE, for the exact P90

  // Add one sample. `labForWorst` (may be null) is the colour recorded when this
  // sample sets a new maximum, so the UI can point at the worst-error location.
  void add(double de, const icFloatNumber* labForWorst) {
    // Drop non-finite ΔE (NaN/Inf): a crafted or degenerate transform can emit a
    // non-finite PCS value; letting it into the stats would poison min/mean/P90.
    // (de != de is true only for NaN; the isfinite check also rejects ±Inf.)
    if (!std::isfinite(de)) return;
    des.push_back(static_cast<float>(de));
    sum += de;
    if (!any || de < minDE) minDE = de;
    if (!any || de > maxDE) {
      maxDE = de;
      if (labForWorst) std::memcpy(worstLab, labForWorst, sizeof(worstLab));
    }
    any = true;
    if (de <= 1.0)  ++nLE1;
    if (de <= 2.0)  ++nLE2;
    if (de <= 3.0)  ++nLE3;
    if (de <= 5.0)  ++nLE5;
    if (de <= 10.0) ++nLE10;
  }

  icUInt32Number count() const { return static_cast<icUInt32Number>(des.size()); }
  double mean() const { return des.empty() ? 0.0 : sum / static_cast<double>(des.size()); }

  // Population standard deviation of the ΔE distribution (a comparison statistic
  // shown alongside min/mean/P90/max). Two-pass for numerical stability.
  double stddev() const {
    if (des.empty()) return 0.0;
    const double m = mean();
    double v = 0.0;
    for (float d : des) { const double x = static_cast<double>(d) - m; v += x * x; }
    return std::sqrt(v / static_cast<double>(des.size()));
  }

  // Fine-resolution ΔE histogram (bin width kHistBinW = 0.1) for the relative-/
  // cumulative-frequency plot. Bin i spans ΔE ∈ [i·w, (i+1)·w); length =
  // clamp(ceil(maxDE / w), 1, kMaxHistBins). The top edge and any pathological
  // over-range ΔE fold into the last bin so every sample is counted and the
  // cumulative curve still reaches 100%.
  //
  // We bin FINELY (not at integer ΔE) so the UI can re-aggregate JS-side into
  // either integer-ΔE bins (chardata's "Integer ΔE" mode = groups of 10) or N
  // arbitrary equal-width bins ("Auto-scale" mode) — clamped so auto never asks for
  // bins finer than this base. The bin cap guards against a degenerate transform
  // emitting an enormous ΔE (which would otherwise size a huge array): 2000 bins ×
  // 0.1 covers ΔE up to 200, well past any real round-trip error.
  static constexpr double kHistBinW = 0.1;
  static constexpr int    kMaxHistBins = 2000;
  std::vector<icUInt32Number> fineHist() const {
    if (des.empty()) return {};
    int nbins = static_cast<int>(std::ceil(maxDE / kHistBinW));
    if (nbins < 1) nbins = 1;
    if (nbins > kMaxHistBins) nbins = kMaxHistBins;
    std::vector<icUInt32Number> h(nbins, 0);
    for (float d : des) {
      int bi = static_cast<int>(std::floor(d / kHistBinW));
      if (bi < 0) bi = 0;
      if (bi >= nbins) bi = nbins - 1;
      ++h[bi];
    }
    return h;
  }

  // Exact P90 via partial selection (mutates `des` order — call after any read that
  // depends on insertion order; nothing here does). Index floor(0.90*(n-1)) matches
  // iccviz::RoundTripDE so RT0 and RT1/RT2 agree on how the percentile is picked.
  double p90() {
    if (des.empty()) return 0.0;
    std::size_t k = static_cast<std::size_t>(std::floor(0.90 * (des.size() - 1)));
    std::nth_element(des.begin(), des.begin() + k, des.end());
    return des[k];
  }
};

// ── CIccMinMaxEval ────────────────────────────────────────────────────────────
class CIccMinMaxEval : public CIccEvalCompare
{
public:
  CIccMinMaxEval() : m_nTotal(0) {}

  void Compare(icFloatNumber * /*pixel*/, icFloatNumber *deviceLab,
               icFloatNumber *lab1, icFloatNumber *lab2) override
  {
    // Round Trip 1 = ΔE(deviceLab, lab1); Round Trip 2 = ΔE(lab1, lab2). The CLI
    // records `deviceLab` as the worst-error colour for BOTH directions (the seed
    // device colour that produced the worst trip), so we pass deviceLab to both.
    rt1.add(icDeltaE(deviceLab, lab1), deviceLab);
    rt2.add(icDeltaE(lab1, lab2),      deviceLab);
    m_nTotal += 1;
  }

  DeStats rt1, rt2;
  icUInt32Number m_nTotal;   // seeds walked (== rt1.count() == rt2.count())
};

#endif // PROFILETOOL_ROUNDTRIP_EVAL_HPP
