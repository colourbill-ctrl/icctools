# iccApplyProfiles / iccApplySearch — CLI feature gap survey

Source of truth: `~/code/iccdev/Tools/CmdLine/IccApplyProfiles/iccApplyProfiles.cpp`,
`.../IccApplySearch/iccApplySearch.cpp`, and the config classes in
`IccConnect/IccLibConnect/IccCmmConfig.h` (`CIccCfgImageApply`, `CIccCfgProfile`,
`CIccCfgSearchApply`, `CIccCfgDataApply`, `CIccCfgColorData`).

profiletool surfaces: **Transform Image** (`applyToImage` / chunked
`imageApplyBegin/Chunk/End`) ≈ iccApplyProfiles; **Transform Data** (`applyValues`)
≈ iccApplyNamedCmm; **Invert Transform** (`invertValues`, new) ≈ iccApplySearch.

---

## A. iccApplyProfiles → Transform Image — GAPS

The CLI's alt-usage arg list is:
`src dst dst_sample_encoding dst_compression dst_planar dst_embed_icc interpolation {profile intent {-PCC pcc}}…`
Everything after `dst` is a knob. profiletool currently hardwires most of them.

| # | CLI knob | CLI values | profiletool today | Gap |
|---|----------|-----------|-------------------|-----|
| G1 | **dst_sample_encoding** | same-as-src / 8-bit / 16-bit / float | always re-encodes to **8-bit** (`imageCodec` bitDepth:8) | **YES** — no 16-bit / float output; lossy for >8-bit sources |
| G2 | **dst_compression** | none / LZW | libtiff default (no user choice) | YES — no LZW toggle |
| G3 | **dst_planar** | contig / separation | contig only | YES — minor |
| G4 | **dst_embed_icc** | none / embed last ICC | never embeds output profile | YES — overlaps task #70 (tag converted images) |
| G5 | **interpolation** | linear / tetrahedral (per profile) | hardwired `icInterpTetrahedral` | YES — no linear option |
| G6 | **rendering_intent flavours** | 0-3 **plus** 10-13 (no D2Bx/B2Dx), 20-23 (preview), 30/33 (gamut), 40-42 (**BPC**), 50/60/70 (BDRF), 80 (MCS), +1000 (luminance PCS adj), +10000 (V5 sub-profile) | `clampIntent` accepts **only 0-3**; everything else silently → relative | **YES — largest gap.** No BPC, no colorimetric-only, no V5-sub-profile, no D2Bx bypass |
| G7 | **-PCC path** (per profile) | connection-conditions profile override | not exposed | YES — needed for spectral/observer-specific applies |
| G8 | **-ENV:sig value** (per profile) | CMM calc env vars | not exposed | YES — niche (calculator MPE inputs) |
| G9 | **embedded-source-as-head** | empty first profile path → use image's embedded ICC | separate "Add from image" extraction step | Partial — can extract then add, but not one-shot |
| — | -threads N | worker threads | single-thread WASM (chunked) | N/A (irrelevant to WASM) |
| — | -cfg / -exportcfg JSON | config round-trip | our chain state is the config | N/A (different surface) |

**Priority for a follow-up pass:** G6 (intent flavours, esp. BPC 40-42 + V5 sub-profile
+10000 + colorimetric-only) and G1 (16-bit/float output) are the substantive ones.
G5 (interpolation) is cheap. G2/G3/G4/G7/G8 are lower value.

These gaps apply **equally to Transform Data** (`applyValues`) and the new **Invert
Transform**, since all three build the CMM the same way (`AddXform` with `clampIntent`
0-3 + fixed tetrahedral). Fixing G5/G6 in the shared chain-assembly path lifts all three
at once.

---

## B. iccApplySearch → Invert Transform (NEW) — model + scope

`iccApplySearch` inverts the **last** profile of a 2- or 3-profile sequence via a
Nelder-Mead search (`CIccCmmSearch` / `CIccMinSearch`, IccProfLib level — already in the
WASM build via `IccCmmSearch.cpp`). Model (from `CIccConnectCmm::CreateSearch` +
`iccApplySearch.cpp` main):

- Profiles `P0 … P{n-1}` (n = 2 or 3) are added **forward** (`CIccCmm::AddXform`).
- `SetDstInitProfile(P{n-1}, initIntent)` gives the search its **starting guess** for the
  inverted last profile (the `-INIT` arg).
- `Begin()` wires it: `GetSourceSpace()` = the data's required input space (P0 side),
  `GetDestSpace()` = the inverted last profile's **device** space (the output).
- Per data row: `ToInternalEncoding(srcSpace, srcEnc)` → `Apply` (runs the search) →
  `FromInternalEncoding(dstSpace, dstEnc)`.
- **`GetApplyCost`** returns the PCC-weighted residual = an **index of metamerism /
  invertibility quality** (0 = perfect match; larger = the target needs a metameric
  trade-off no single device value resolves). Optional weighted PCC list drives this.

### UX constraints (verified against CLI)
1. **2–3 transforms only.** `iccApplySearch.cpp:389` — *"Only sequences of 2 or 3
   profiles are supported"*. → **warn + refuse** if the Link chain has >3 (or <2).
2. **Directionality is fixed** (data → forward chain → invert last). The dropped dataset
   **must be in the search source space** (`GetSourceSpace()`), so we need a **direction
   selector** (which end of the chain is inverted) + a data-space check on drop.

### First-pass scope — BUILT (2026-07-19)
- WASM `invertValues` (values + per-row cost) + `searchInfo`, replicating CreateSearch
  orchestration at IccProfLib level (`CIccCmmSearch::AddXform` override + `SetDstInitProfile`
  + `Begin`). Validated in node: sRGB→sRGB search recovers identity (cost ~1e-7); sRGB→**v4**
  CMYK gives correct separations (Red→M+Y, Blue→C+M, in-gamut gray cost ~1e-6, out-of-gamut
  primaries carry high residual = the invertibility index).
- UI (`PipelineBuilder`): **Invert Transform** button + direction selector (invert first/last
  stage), 2–3 refusal, data drop + dataset controls reused from Transform Data, `DataResultModal`
  reused with an added ΔE-cost column. `initIntent` = inverted stage's forward intent.
- **Safety:** the UI gates on the SAFE forward `chainInfo` (search and forward share src/dst
  spaces), never calling `searchInfo` passively — because `CIccCmmSearch` **hard-traps under
  WASM on a v5 iccMAX CMYK profile** (native tolerates with degenerate output; see memory
  `iccdev-cmmsearch-v5-wasm-trap`). `invertValues` runs only on explicit click. Follow-up task
  #81: isolate the search in a disposable Web Worker so a trap can't kill the shared module.
- UI-drivable fixtures added: `test-corpus/data/lab-patches.csv` (Lab→sep) +
  `test-corpus/data/colorchecker-380-730-10nm.csv` (spectral→sep via the Prefer:Spectral path).
- **Deferred:** weighted multi-PCC metamerism search (G7), extended intent flavours (G6),
  IT8/legacy data output formats, worker isolation (#81).
