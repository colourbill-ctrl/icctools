# Single-profile QC analysis gaps

**Sources:** `doQCpfA.m` (1533 lines, MATLAB, R2022a) and its published output
`QC_Gracol2013_PF.pdf` (31 pp, run against `GRACoL2013_CRPC6.icc`, `inksetID = CMYK`).

**Target:** profiletool's **Analysis** tab (single profile) — and, where an analysis is
inherently two-profile, the **Compare** tab.

This is a *gap list*. Task #86.

> **Status, 2026-07-20.** Q1, Q2, Q3 and Q5 are **BUILT** — see the per-item notes.
> Q4 is covered by the existing Tags-tab lattice view. The remaining gaps are Q6–Q17.
>
> New iccviz engine API: `WhiteBlackPoints()`, `HueExtrema()`, `ShadowInkPaths()`,
> plus tone/ΔE series on the existing neutral-axis graph and a `Series::useY2` /
> `Graph::y2Axis` secondary-axis concept. New WASM exports: `whiteBlackPoints`,
> `hueExtrema`, `shadowInkPaths`. New Analysis sections: **Extrema Colorimetry**
> (Q2+Q3) and **Ink Usage in Shadows** (Q5). Smoketest: `validator-wasm/qc-smoketest.mjs`.
> All Analysis sections now start collapsed — each costs a WASM pass.

---

## What the QC script actually is

`doQCpfA.m` is a printer-profile QC harness. It builds a forward model of one profile
(`pfA`) in relative colorimetry, then interrogates the **B2A tables at all three
rendering intents** (B2A0 perceptual / B2A1 relative / B2A2 saturation) and the forward
A2B1/A2B3 tables, producing ~30 pages of plots plus a handful of scalar readouts.

Three structural properties matter for us:

1. **It is B2A-centric.** Almost every plot asks "what inks does this profile lay down
   for *this* PCS colour?" profiletool's existing analyses are mostly A2B-centric
   (gamut volume, gamut mesh) with one B2A analysis (neutral-axis inking).
2. **It leans on a reference RGB gamut** — Adobe RGB by default, `sRGB`/`ProPhoto`
   selectable via a workspace variable. Roughly a third of the script (§6-§9 below)
   cannot run without one.
3. **It leans on a second reference *printer* profile** — it hardcodes
   `profileQC('GRACoL2013_CRPC6.icc')` for the cusp cross-check (§8).
4. **It applies BPC manually** (`mapBlackPoints`) before feeding colours to the
   perceptual and saturation B2A tables, because those tables expect black at PCS
   L*=0. We would need the same convention to reproduce its numbers.

---

## Current profiletool capability (baseline)

Confirmed by reading `iccviz/IccVizModel.hpp`, `validator-wasm/plot-wrapper.cpp`
(9 embind exports), `frontend/src/lib/vizPlot.js`, and `AnalysisPanel.jsx`.

| Capability | Where | Notes |
|---|---|---|
| **Gamut volume** | `GamutVolume()` → Analysis / Profile Statistics | Voxel estimate from ONE A2B tag at one intent. Reports `degenerate` flag. |
| **Round-trip ΔE** | `RoundTripDE()` (RT0) + PRMG (RT1/RT2) → Analysis | min/mean/p90/max/std, cumulative ≤1/2/3/5/10 buckets, integer histogram, worst Lab. |
| **Neutral-axis inking** | `Kind::NeutralAxisInking` → Analysis | Ink % vs L* for **each** of B2A0/B2A1/B2A2. Per-channel Lab colour hints from A2B1. |
| **Gamut boundary mesh** | `GamutBoundaryMesh()` → Compare (3-D shell) | Profile-derived (LUT **or** matrix/TRC). Non-manifold union of 2-faces. |
| **Const-L\* gamut slice** | `sliceHull()` in `gamutGeom.js` → Compare (2-D) | Slices the mesh; overlays 1..N profiles. |
| **CLUT image / gamut-tag image** | `Kind::ClutImage` → Analysis | Raster views. |
| **1-D curves, chromaticity, named colours** | Tags tab | Not QC-relevant. |

**Explicitly absent** *(as of the original audit — Q1/Q2/Q3/Q5 have since closed the
first three)*: any per-hue colorimetry readout, any ink-usage statistic, any
tone-transfer curve, any cusp analysis, any reference-gamut comparison, any CLUT
smoothness metric, and any bundled reference profile.

Added since (2026-07-20): `WhiteBlackPoints`, `HueExtrema`, `ShadowInkPaths`, neutral
tone + ΔE curves, and a secondary-axis concept in the graph model. Still absent: cusp
analysis, reference-gamut comparison, CLUT smoothness, B2A-direction gamut volumes, and
any bundled reference profile.

---

## Gap list

Numbered `Q1…Q16` in doQCpfA order. Status is one of **MISSING**, **PARTIAL**
(something related exists but does not answer the QC question), **HAVE**.

### Q1 — Tone transfer curve + ΔEab on the neutral axis · **BUILT**

Both series now come out of `buildNeutralAxisGraph` (`tone`, `neutrality`), the latter
on a new secondary y-axis.

**The second curve is Δa\*b\*, not ΔE\*ab — established empirically.** Probing
GRACoL2013_CRPC6 down the neutral axis:

| L\* in | full ΔE\*ab | Δa\*b\* (lightness excluded) |
|---:|---:|---:|
| 15 | 0.138 | 0.127 |
| 10.8 | 0.346 | **0.283** |
| 8 | 2.808 | 0.225 |
| 0 | **10.801** | 0.225 |

The published plot's dotted curve peaks at **≈0.28 just above the black point and then
falls**; it never rises off a 0–1 axis. That is the Δa\*b\* column, not the ΔE column.
Below the media black point the profile can only clamp, so a lightness-inclusive error
grows without bound purely because the request was unreachable — an artefact that would
dominate the secondary axis and bury the real 0–0.3 signal. The lightness story is
already told exactly by the tone curve's plateau, so including it twice costs the plot
its usable scale. Our curve now reports max 0.267 on this profile.

Cross-check: the tone curve's floor and `WhiteBlackPoints`' black L\* agree to the digit
(10.799 / 10.798) via two independent code paths. The original analysis is kept below.



*Script:* §1, `plotNeutral(pfA, 'B2A1'|'B2A0'|'B2A2')`, one subplot per intent.

*Us:* the ink curves exist for all three intents, and our x-axis already runs
L\*=100 left → 0 right (`IccVizModel.cpp:1058`), matching the report. **Two data series
are missing**, both verified against the rendered figure on p.2 of the PDF:

1. **Tone transfer curve** (dash-dot). L\*-out vs L\*-in, i.e. the neutral round trip
   Lab(L,0,0) → B2A → device → A2B1 → L\*-out, normalised 0–1 onto the ink axis.
   Two features carry the diagnosis: it **sags below the identity diagonal** through the
   midtones (≈0.47 at L\*=50 — greys render darker than asked), and it **flattens at
   ≈0.105 below L\*≈10**, which is the media black point (`BP LabREL L* = 10.80`)
   clamping. That plateau *is* the black point, readable off the plot.
2. **ΔEab** (fine dotted). Round-trip error between the requested neutral and what comes
   back. Because a\*=b\*=0 going in, this is largely a **neutrality** measure — it shows
   where the profile injects a colour cast into greys. Raw ΔE units: 0.02–0.05 through
   the midtones, ≈0.2 near paper white, spiking ≈0.28 just above the black point.

Also in the same figure, and cheap to add alongside: a **vertical black-point marker**
(blue line at L\*=10), and **BP(rel) / WP(abs) values in the subplot title** — the
perceptual and saturation subplots differ in black-point a\*b\* (`0.070 0.199` vs
`0.297 0.141`), so Q2's black point is **per-intent**, not a single profile-wide value.

> **Not a curve:** the black dash-dot tracking the yellow trace in every subplot is a
> legibility outline (yellow on white is invisible), not a data series. We solve the same
> problem by flooring L\* at 55 in `neutralTraceColor`.

*Cost:* small. Extend `buildNeutralAxisGraph` with two `Role::Hint` series — the A2B1
return leg is already built there for the per-colorant colour hints. No new WASM export.

**One scaling wrinkle:** their y-axis is ink *fraction* (0–1), so a raw ΔE of 0.3 renders
at 30 % height. Ours is ink *percent* (0–100, `v = dst[c] * 100.0f`), where the same ΔE
would be invisible on the bottom axis. ΔEab needs a **secondary right-hand axis** — the
pattern exists in `RtHistogram` (bars left, cumulative line right). The tone curve needs
no special handling: L\*-out plots directly on a 0–100 axis.

### Q2 — White point / black point in relative **and** absolute colorimetry, plus TAC · **BUILT**

`iccviz::WhiteBlackPoints(pIcc, b2aTag)` → the **Extrema Colorimetry** section.
Worth recording two things settled during the build:

- **A bare `CIccXform` does apply the absolute adjustment.** The media-white scaling is
  set up in `CIccXform::Begin()` and applied by `CheckDstAbs()`, gated on
  `m_bAdjustPCS && m_bInput` — no `CIccCmm` required. Confirmed against
  `IccProfLib/IccCmm.cpp:1568-1596`.
- **Absolute == relative is legitimate, not a bug.** `m_bAdjustPCS` is only set when the
  media white differs from the illuminant, so a profile whose `wtpt` is exactly D50
  reports identical rows. A missing `wtpt` makes `Begin()` fail, which is how the
  optional absolute leg reports "unavailable" (`hasAbsolute: false`).



*Script:* §1 tail, `getBlackWhitePts(pfA,'B2A0')`. Reports:

```
White Pt: LabREL = 100.0   0.000   0.000     LabABS = 95.02  0.980  -4.02
Black Pt: LabREL =  10.80  0.070   0.199     LabABS =  9.65  0.293  -0.734
Inking at BP     = 0.845 0.751 0.603 1.000 | TAC = 3.20
```

*Us:* nothing. This is the single highest value-per-line item in the whole gap list —
four scalars a print QC operator reads first, and we have the transforms already.

Note the script derives BP by pushing PCS black through **B2A0** and reading the
resulting inking back through A2B1/A2B3. TAC is just the sum of that inking (here 320%).

**The black point is per-intent.** The p.2 subplot titles show BP(rel) a\*b\* of
`0.070 0.199` for perceptual but `0.297 0.141` for saturation (L\* = 10.80 in both). So
this readout belongs next to the intent selector, not as a single profile-wide row — and
it pairs naturally with Q1, which is where the plot already shows it.

*Cost:* small. One new WASM export (`whiteBlackPoints`), a table in Analysis.

### Q3 — Per-hue CMYRGB colorimetry and max-chroma inking · **BUILT**

`iccviz::HueExtrema(pIcc)` → the same **Extrema Colorimetry** section, below the
white/black table and explicitly labelled intent-independent (it measures through A2B1
only, so the section's intent selector does not apply to it).

The inkset question was resolved by **refusing to guess**: the CMYRGB corners are only
emitted for `icSigCmykData` and `icSigCmyData`, where the colour space fixes the channel
order. An nCLR space names its channels through `colorantTable` in any order, so
"channel 0 is cyan" would be a guess that silently mislabels every row — those profiles
get an explicit N/A instead. The UI flags any corner whose max chroma arrives before
full tone (`rampFraction < 1`) with a ⚠, since that is the over-inking diagnosis.



*Script:* §2. For each of C, M, Y, R, G, B: full-tone `<H*, C*, L*>` via A2B1, then a
1024-step ramp from paper white to full tone to find **max C\***, reporting the H/C/L
and the inking at that maximum.

*Us:* nothing. We have no cylindrical (LCh) conversion surfaced anywhere.

This is a genuinely useful QC readout — for a well-behaved profile max-C\* sits at full
tone (as it does in the GRACoL reference output, where the two rows are identical); a
*divergence* between the full-tone row and the max-C\* row is the diagnostic.

*Cost:* small-to-medium. Needs an N-ink → CMYRGB corner mapping (`getNinkCMYRGB`
equivalent) which is inkset-dependent — trivial for CMYK, a design question for 5/6/7-ink.

### Q4 — Lattice / separation plots · **COVERED** (Tags tab)

The Tags-tab LUT view already renders the lattice/separation plots (user, 2026-07-20).
Not carried forward as a gap. The one thing the reference script does that the tag view
does not is the **K-separation-only 3-up across all three intents** — a small,
optional addition if it is ever wanted, not a missing capability.

*Original analysis retained for reference:*



*Script:* §3, `plotNseps(pfA, xform)` for all three intents, plus a 3-up comparison of
the **K separation only** across RelCol / Percep / Satn.

This is the classic separation lattice: a grid of PCS colours pushed through B2A, each
channel's response plotted as a surface/lattice. The K-only comparison is the
money plot — it shows GCR strategy differing by intent.

*Us:* nothing.

*Cost:* medium. Needs a new `Kind` (the reserved `SmoothnessLattice = 6` slot is
adjacent but not the same thing) and a lattice renderer. Plotly `surface` would need the
gl path (→ CSP `unsafe-eval`, already permitted for the 3-D gamut) or SVG contours.

### Q5 — Ink usage in shadows: const-L\* radial paths · **BUILT**

`iccviz::ShadowInkPaths(pIcc, b2aTag)` → the **Ink Usage in Shadows** section, with a
rendering-intent selector. Returns four ready-to-plot `Graph`s (0/45/90/135°).

Black-point compensation follows the reference script exactly: the L\* is stretched from
the media black point to PCS black before the perceptual and saturation tables, and the
black point always comes from **B2A0** (not the selected tag) so the three intents stay
comparable. The UI reports both the compensated plane and the raw one. The constant-L\*
plane is derived from the CMYRGB corners, so this inherits Q3's CMYK/CMY restriction.



*Script:* §4. At `L* = (L_blue + min(L_CMYRG))/2`, four straight lines across the a\*b\*
plane at 0° / 45° / 90° / 135°, 256 points each, pushed through B2A1, then through
B2A0 and B2A2 **after manual BPC**. Nine plots total.

Purpose: reveal how the profile transitions from out-of-gamut to in-gamut in the
shadows — where gamut-mapping artefacts (ink jumps, banding) live.

*Us:* nothing.

*Cost:* medium. Straightforward sampling; needs the BPC convention and an intent-aware
"prepare PCS for perceptual table" helper.

### Q6 — Reference-RGB girdle inkings · **MISSING** (blocked)

*Script:* §5, `plotRGBCMY(pfA, 0, xform, 0, RGBprofile)` — takes the **girdle** (the
maximum-chroma ring) of Adobe RGB, converts to Lab, pushes through the printer's
B2A1 (with BPC) / B2A0 / B2A2, and plots the resulting inkings.

*Us:* nothing, **and structurally blocked**: no reference RGB profile ships with
profiletool. See *Blocking dependency* below.

### Q7 — Reference-RGB cusp colours in the a\*b\* plane · **MISSING** (blocked)

*Script:* §6. `getCuspInkColors(pfA, xform)` for all three intents; overlays the
profile's own A2B1 cusp (rendered in true colour) against the three B2A cusps in a\*b\*.

*Us:* nothing. **No cusp extraction exists at all** — this is a distinct piece of
geometry from the gamut mesh (the cusp is the max-chroma ridge line, i.e. per-hue
argmax of C\*). Blocked on the same reference profile.

### Q8 — Cross-profile cusp check against a reference printer profile · **MISSING** (blocked, 2-profile)

*Script:* §7. Hardcodes `GRACoL2013_CRPC6.icc`, takes its CMYK cusp inks → A2B1 → Lab,
pushes those Lab through `pfA`'s B2A1 → inks → A2B1, and overlays.

*Us:* nothing. This is inherently **two-profile**, so it belongs in **Compare**, not
Analysis. It also needs the user to nominate a reference from the pool.

### Q9 — Reference-RGB hue ramps as L\*/Chroma gamut views · **MISSING** (blocked)

*Script:* §8. Six hues (R G B C M Y). For each: the Adobe RGB hue ramp through B2A1 and
B2A2, plotted both as a gamut boundary and as an L\* vs Chroma curve, with the
corresponding inkings underneath.

*Us:* nothing.

### Q10 — Primary-inking paths through neutral · **MISSING**

*Script:* §9. Three paths — Cyan→Red, Magenta→Green, Yellow→Blue — each routed
**through the neutral axis** at the L\* midpoint of its two endpoints. All points are
in-gamut by construction. Pushed through B2A1, then B2A0 and B2A2 after BPC.

*Us:* nothing. **Not blocked** — uses only the profile's own primaries.

Purpose: in-gamut smoothness probe. Any kink here is a CLUT defect, not a gamut-mapping
artefact, because every sample is inside the gamut.

*Cost:* small-medium. Same machinery as Q5.

### Q11 — Multi-transform gamut volumes and their divergence · **PARTIAL**

*Script:* §10. Builds **four** gamut classes and reports volumes plus % differences:

```
A2B1 RelCol (max-K):  430881.5
B2A1 RelCol:          423175.4     Δ vs A2B1 = 1.79%
B2A0 Percep:          391913.9     Δ vs A2B1 = 9.04%
B2A2 Satn:            412806.8     Δ vs A2B1 = 4.19%
A2B3 AbsCol:          386606.7
```

*Us:* `GamutVolume()` handles the **A2B** direction only, one tag at a time, and the UI
surfaces one number. The **B2A-derived** gamut volumes are missing entirely — and those
are the interesting ones, because A2B1-vs-B2Ax divergence *is* the gamut-mapping
loss measurement.

Also note the script clips the integration to `[BP+1, WP-1]` L\* to avoid endpoint noise;
we should check what our voxel integration does at the extremes before comparing numbers.

*Cost:* medium. A B2A-direction boundary needs a different construction than our
device-cube-face mesh — the script builds it by walking the B2A table.

### Q12 — B2A1 round-trip accuracy with GBD-eroded seeding · **PARTIAL**

*Script:* §11. Seeds **32 L\* levels**, each with 64 gamut-boundary points, then
**erodes toward neutral at chroma × 0.8 / 0.5 / 0.2**, last point forced to neutral.
~8300 points. Round-trips Lab → B2A1 → inks → A2B1 → Lab. Reports
`<dEmean dEstdDev dEmax> = 0.343 0.411 2.76`, histogram ΔE @ 90% = 0.947, and plots ΔE
against quantised L\* so you can *see which L\* band fails*.

*Us:* RT0 does the same round trip and reports a **superset** of the scalars
(min/mean/p90/max/std + cumulative buckets + integer histogram + worst Lab). Two real
differences:

- **Seeding.** We sample the device cube interior on a regular grid. The script samples
  the *gamut boundary* then erodes inward. Ours is arguably better distributed in device
  space; theirs deliberately over-weights the boundary, where B2A inversion is hardest.
  **The numbers are not comparable.**
- **Presentation.** We show a histogram; the script also shows ΔE vs L\* band. The
  latter is diagnostic (it localises the failure), the former is not.

*Cost:* small for the ΔE-vs-L\* plot (we already compute per-point ΔE, we just discard
it). Medium for an alternative boundary-eroded seeding mode.

### Q13 — Ink usage statistics · **MISSING**

*Script:* §12. Two tables of per-channel ink sums and percentages:

```
          C       M       Y       K   => Neutral Axis { 100 samples }
Abs:    47.75   40.48   37.97   32.63 | Sum: 158.8
  %:    30.06   25.49   23.91   20.54

          C        M        Y        K   => ON & IN gamut pts { 10350 samples }
Abs:   3922.9   3755.9   4373.0   1963.4 | Sum: 14015.3
  %:    27.99    26.80    31.20    14.01
```

*Us:* nothing. Cheap and genuinely useful — it is the ink-consumption signature of the
separation, and the neutral-axis one falls straight out of data Q1 already computes.

*Cost:* small (neutral axis) / medium (on+in-gamut, which needs the gamut boundary set).

### Q14 — Cusp inking round-trip · **MISSING** (depends on Q7 cusp extraction)

*Script:* §13. The profile's own A2B1 cusp, round-tripped through B2A1 / B2A0 / B2A2,
overlaid in a\*b\* with the inkings below.

*Us:* nothing. **Not blocked on a reference profile** (unlike Q7) — it uses only `pfA`'s
own cusp. But it does need cusp extraction to exist.

### Q15 — Const-L\* a\*b\* gamut slices, multi-transform, with inkings · **PARTIAL**

*Script:* §14. Ten L\* levels from Yellow's L\* down to BP+3. Each slice overlays
**three** gamuts (A2B1 max-K, B2A1, B2A2), marks the **pivot point**, and plots the
inkings for each gamut at that slice.

*Us:* Compare's 2-D slice does const-L\* a\*b\* slices and overlays N profiles — but the
N are **different profiles**, not different transforms of the same profile, and there
are no inkings and no pivot point.

**And a correctness gap:** `gamutGeom.sliceHull()` takes the **convex hull** (Andrew
monotone chain) of the mesh/plane crossings. A CMYK printer gamut slice is *not* convex
— the characteristic lobes and the concavity between primaries are exactly what the QC
slice is meant to show. Our slice is currently a convex over-estimate. Reusing it for QC
would misreport gamut shape, so this needs a concave boundary (radial max-chroma per hue
angle, or an ordered edge walk) before it can serve Q15.

*Cost:* the renderer largely exists. The gap is (a) a non-convex slice boundary,
(b) B2A-derived gamuts to slice (→ Q11), and (c) making the overlay axis "transform"
rather than "profile".

### Q16 — 3-D gamut views with hue ramps, cusp and GMA vectors · **PARTIAL**

*Script:* §15-16. 3-D gamut shell + true-colour hue ramps + K=1 cusp + a\*b\*-plane
projection of the cusp, for the A2B1 max-K gamut, the B2A1 gamut and the B2A0
perceptual gamut. Plus **gamut-mapping vectors**: for each of 6 hues, line segments
connecting the Adobe RGB source colour to where it lands, with and without BPC.

*Us:* Compare's 3-D shell renders the boundary mesh. Missing: hue ramps, cusp line,
a\*b\* projection, B2A-derived shells, and the GMA vectors.

The **GMA vectors are the standout** — they visualise the gamut mapping itself, which no
current profiletool view does. Blocked on a reference RGB profile.

### Q17 — CLUT smoothness · **MISSING**

*Script header:* "analyzes a profile with respect to gamut size, neutral axis, **3D CLUT
smoothness** and Adobe RGB hue ramps". The published PDF does not contain a dedicated
smoothness metric — smoothness is assessed *visually* from the lattice plots (Q4) and
the in-gamut paths (Q10).

*Us:* `Kind::SmoothnessLattice = 6` is **reserved and deferred** in `IccVizModel.hpp`;
`InkReversalL = 7` was built and then **retired** (removed 2026-07-15).

Worth deciding deliberately whether to build a *numeric* smoothness metric (2nd
derivative over the CLUT lattice) rather than only the visual proxies the script uses.

---

## Blocking dependency: reference profiles

Q6, Q7, Q8, Q9 and the GMA-vector half of Q16 — **five of seventeen items, and the most
visually distinctive ones** — require reference profiles that profiletool does not have:

- a reference **RGB** gamut (Adobe RGB default; sRGB and ProPhoto selectable), and
- a reference **printer** profile (the script hardcodes GRACoL2013_CRPC6).

Three ways out, in ascending order of effort:

1. **Nominate from the pool.** The user already loads profiles into the Profile Pool.
   Add a "reference profile" selector to the Analysis tab. Zero bytes shipped, no
   licensing question, but the analysis silently unavailable until the user supplies one.
2. **Synthesise the RGB reference.** Adobe RGB / sRGB / ProPhoto are matrix-TRC profiles
   fully specified by published primaries, white point and gamma. We already have
   `v4display.js` and a V4 Display Maker that constructs profiles. Generating a
   matrix/TRC reference at runtime is very likely feasible and ships no third-party bytes.
   **This looks like the right answer for the RGB half.**
3. **Bundle a profile.** Needs a licence check per profile. GRACoL/IDEAlliance
   redistribution terms would need reading before we ship `GRACoL2013_CRPC6.icc`.

Note (2) does **not** solve the printer-reference half (Q8) — a CMYK characterisation
cannot be synthesised. Q8 realistically means option (1), which is fine because Q8 is
inherently a two-profile Compare-tab analysis anyway.

---

## Cross-cutting prerequisites

Things multiple gaps need, which do not exist yet:

| Prerequisite | Needed by | Status |
|---|---|---|
| **LCh (cylindrical) conversion** | Q3, Q9, Q12, Q13 | ✅ `labToHCL()` in IccVizModel.cpp. |
| **BPC helper** (`mapBlackPoints`) | Q5, Q6, Q9, Q10, Q14, Q16 | ✅ inline in `ShadowInkPaths` (linear L\* stretch, B2A0-sourced black point). Factor it out when a second caller appears. |
| **Inkset → CMYRGB corner map** | Q3, Q10 | ✅ `cmyrgbCorners()` — CMYK/CMY only, by design; n-colour spaces refuse rather than guess. |
| **Multi-series ink plot** | Q4, Q5, Q6, Q9, Q10, Q14, Q15 | ✅ per-angle `Graph` + shared `inkColorHints()`; PlotlyGraph renders it. |
| **Cusp extraction** | Q7, Q8, Q14, Q16 | ❌ Per-hue argmax C\* over the gamut boundary. Distinct from the gamut mesh — and note Q3's `HueExtrema` is *not* this: it walks the ink ramps, not the boundary. |
| **B2A-direction gamut boundary** | Q11, Q15, Q16 | ❌ Our mesh is built from device-cube faces (A2B). A B2A gamut is a different construction. The largest remaining engine piece. |
| **Non-convex slice boundary** | Q15 | ❌ `sliceHull()` is a convex hull; printer gamut slices are not convex. See Q15. |

### Things that are already compatible

Worth recording, because they remove risk:

- **ΔE metric matches.** The script's `vabs`/`err_rpt` is Euclidean Lab distance =
  **CIE76 ΔE\*ab**, which is what iccviz (`deltaEab`) and the wrapper (`icDeltaE`) use
  throughout. No ΔE2000/ΔE94 anywhere on either side, so scalars are directly comparable
  once seeding matches.
- **Absolute colorimetric convention matches.** The script uses A2B3/`pfRelAbs = 3`;
  we reuse A2B1/B2A1 with the intent flag. Same ICC semantics.

### Placement constraint

Compare deliberately carries **no numeric readout** — no volume or status table (user
decision, 2026-07-18, `parity-roadmap.md:301`). Q11's volume/divergence table therefore
belongs in **Analysis**, even though it is conceptually about comparing transforms. Only
Q8 (which needs a *second profile*) genuinely belongs in Compare.

### Upstreaming note

`iccviz/iccProfilePlot.cpp` (the CLI) exposes only `Enumerate` / `RenderGraph` /
`RenderRaster` — it has no volume, mesh or round-trip command. Anything built here that
should reach iccDEV needs a CLI surface designed alongside it, per the standing
upstream-contribution directive.

---

## Rough shape, if this gets built

Grouped by what unlocks what, **not** a schedule.

**Tier A — DONE.** Q2 (WP/BP/TAC) and Q1 (tone curve + ΔE trace) are built. Still open
in this tier: Q13-neutral (ink usage on the neutral axis) and Q12-plot (ΔE vs L\* band),
both still cheap — the data is already computed and discarded.

**Tier B — mostly done.** Q5 (shadow paths) and Q3 (per-hue max chroma) are built, and
the shared ink-plot primitive now exists as `ShadowInkPaths`' per-angle `Graph` plus the
reusable `inkColorHints()`. Q10 (in-gamut primary paths through neutral) remains and is
now nearly free: same machinery, different path geometry.

**Tier C — needs B2A gamut construction.** Q11 (multi-transform volumes + divergence),
Q15 (multi-transform slices), Q13-gamut. This is the largest single engine piece and it
unlocks the most.

**Tier D — needs cusp extraction.** Q7-own-profile, Q14, Q16-cusp.

**Tier E — needs reference profiles.** Q6, Q9, Q16-GMA-vectors (synthesised RGB), and Q8
(pool-nominated printer reference, Compare tab).

**Undecided.** Q4 (lattice — needs a renderer decision) and Q17 (smoothness — needs a
*metric* decision first).
