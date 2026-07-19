# profiletool ↔ iccDEV Tool-Parity Roadmap

> **Branch / version line:** this roadmap drives the **2.x major-release line** — the
> **Profile Pool workbench** rewrite (DL-IA1 opt 4) — on branch **`2.x`** (version
> `2.0.0-dev.x`). **`main` stays the 1.x maintenance line.** Intent: possibly
> fast-forward `main` → `2.x` once the 2.x form lands; interim 1.x fixes on `main` merge
> forward into `2.x`. (Recorded 2026-07-18.)

*Working plan. Goal: give profiletool functional parity with iccDEV's 17 CLI tools by
extracting the IccProfLib compute each CLI wraps into a typed data API — NOT by
compiling the CLI `main()`s to WASM (`callMain`/stdout scraping is explicitly out of scope).*

**Provenance:** distilled from a 5-lens adversarial multi-agent review (33/36 findings survived
independent verification) plus three user refinements. Where a claim was corrected by that review,
it's marked ✅ *verified* or ⚠ *needs grounding*.

**Related strategy doc:** `~/code/iccdev-wasm-analysis.md` (§ references below point at it).
**Migration context:** profiletool's `iccviz/` is a *temporary* staging ground for code bound
for iccDEV; once the iccviz upstream PR (iccDEV #1711) lands in main, profiletool consumes the
iccDEV version and deprecates the local copy. Author all new engines to ride that path.

---

## Architecture — the seam every capability uses (iccviz, generalized)

Three layers; only the middle one is throwaway glue:

| Layer | Example in repo | Portable? | Destiny |
|---|---|---|---|
| **Engine / data API** | `iccviz/IccVizModel.{cpp,hpp}` (CLI form: `iccviz/iccProfilePlot.cpp`) | ✅ plain C++ over IccProfLib, returns structs; no Emscripten/embind | **→ upstream to iccDEV** |
| **embind seam** | `validator-wasm/plot-wrapper.cpp` (`emscripten::val`↔JSON) | ❌ profiletool-only | stays downstream |
| **React UI** | `frontend/src/components/AnalysisPanel.jsx` | ❌ | stays downstream |

Rule for every capability: find the IccProfLib compute the CLI's `main()` drives → factor it into an
`Icc*Model`-style engine returning data → thin embind seam → UI. Engine stays **locale-neutral**
(emits signatures/enums/numbers, never display strings — localization is a downstream concern only).

Before writing any engine, run the gate: **"does IccProfLib already ship this compute?"** If yes,
wrap the canonical class; do NOT write a parallel engine (maintainers reject duplicates).

---

## Group definitions (corrected by the review)

| Group | Defining trait | Capabilities |
|---|---|---|
| **A — Evaluate** | read-only metrics over already-linked IccProfLib compute; no profile construction; no new libs | Round-trip parity |
| **B — Construct** | lift a tool `main()` that **builds/serializes a `CIccProfile`** (needs `CIccMemIO`/MEMFS refactor) | IccFromCube, IccV5DspObsToV4Dsp, IccApplyToLink |
| **C — Inspect images** | **JS** container parse + reuse existing `validateProfile`; zero new C++ | IccTiffDump, IccPngDump, IccJpegDump |
| **D — Transform chains** | Apply/CMM chains; depend on **IccLibConnect** (a 2nd library profiletool doesn't link) — dependency decision required, but **in scope** | IccApplyNamedCmm, IccApplySearch, IccApplyProfiles |
| — *(out of scope)* | almost entirely non-IccProfLib container work | IccSpecSepToTiff |

**Already covered** (no work — **all verified against tool source 2026-07-18**, see § Source audit):
IccDumpProfile(+bigstack), IccPawgReport, IccToXml/FromXml, IccToJson/FromJson, IccProfilePlot,
IccProfileVisualize/VisualizePlot. Two caveats from the audit: (1) ProfileVisualize/VisualizePlot
parity is on visualization **content** — every Cox plot maps to an iccviz `Kind` — but the **PDF/TIFF
*file* output is not reproduced** (we render in-browser); tracked as a deferred beyond-parity nicety,
not a gap. (2) **IccDescribeSinkTest is NOT a user tool** (a CTest smoke test) → removed from the
parity set; real user-module count **22 → 21**.

### Source audit (2026-07-18)

Every parity claim re-checked by reading the tool's actual `main()`/compute (not its name or
`Usage()` string). The covered claims **hold at the capability level**; corrections found:

| Claim | Correction |
|---|---|
| `iccProfilePlot` covered by iccviz | ✅ **same engine** — `Tools/CmdLine/IccProfilePlot/` is iccviz's upstream home (`IccVizModel.*` + `iccProfilePlot.cpp` JSON emitter). |
| `iccProfileVisualize` "superseded by iccviz" | ✅ **content** parity (Cox's chromaticity/curve/named-color/CLUT plots all map to iccviz `Kind`s); ✗ **PDF/TIFF file** output not reproduced (deferred nicety). |
| `iccProfileVisualizePlot` (was unresolved) | ✅ **resolved** = the Cox renderer built inside the iccviz dir (`IccProfilePlot/iccProfileVisualize.cpp`). Same content; not a distinct capability. |
| `iccDescribeSinkTest` "≈ describeTag" | ✗ **not a tool** — CTest smoke test. Removed. |
| `iccApplyToLink` "needs IccLibConnect" (Group D) | ✗ uses **`CIccCmm`, not IccLibConnect** — engine is construct-family (phase-1-capable). Stays **canvas phase for the chain-builder UX** (user-confirmed), not a library dep. The other three `Apply*` do pull IccConnect. |
| N-profile **gamut compare** = "ProfileVisualize N-overlay" parity | ✗ **NOT parity** — `ProfileVisualize` is per-profile **batch** (loop → one output each), never an overlay. Gamut compare is a **beyond-parity chardata port** (see DL-PHASE1 + §3). |

**Retraction:** the DL-PHASE1 arity survey was stamped *"verified from tool `Usage()`."* For the
gamut-compare row that stamp was **false** — it was an inference from the `input_profiles` plural,
contradicted by the tool's own `Usage` ("output … next to **each** input profile"), its loop body,
and the strategy doc (`iccdev-wasm-analysis.md:143`, "no CLI equivalents" for gamut mesh/slice).
Minor unsurfaced CLI flags (all cosmetic, capability parity intact): DumpProfile verbosity int +
`--diag`; ToJson `-indent`/`-sort`; FromXml `-noid` + RelaxNG-schema validate; FromJson `-noid`.

### Beyond-parity backlog

Capabilities we're building (or may build) that **replace no iccDEV wasm module** — tracked here so
they're never re-mistaken for parity work.

| Item | Provenance | Status |
|---|---|---|
| **N-profile gamut compare** (3D mesh / 2D slice overlay) | chardata port; iccDEV has no gamut-boundary tool (its `ProfileVisualize` TODO `:2381` is unfilled) | **P1-late** — build (DL-PHASE1 + §3) |
| **Static PDF/TIFF plot export** | the Cox `ProfileVisualize` *file* output; we render in-browser instead | **deferred** — not a gap; revisit only on demand |
| *(GamutVolume scalar, NeutralAxisInking — already shipped)* | iccviz additions over iccDEV | done |

---

## GROUP A — Round-Trip Parity  *(build-ready)*

### Parity target
Match `Tools/CmdLine/IccRoundTrip/iccRoundTrip.cpp` exactly (288 lines, ✅ read in full):
- **Round Trip 1** — `ΔE*ab(deviceLab, lab1)`: min / mean / max + worst-error `L,a,b` (`maxLab1`).
- **Round Trip 2** — `ΔE*ab(lab1, lab2)`: min / mean / max + `maxLab2`.
- **PRMG Interoperability histogram** — counts & % at ΔE ≤ 1/2/3/5/10, plus total.
- **Specified Gamut** — `CIccPRMG::m_bPrmgImplied`.
- Knobs: **rendering intent** (0–3, default 1=relative), **use_mpe** (0=colorimetric default, 1=MPE).

**Scope boundary (honors "round-trip is a family"):** Group A = *this* metric only — CIE76,
device-cube-seeded, two-direction + PRMG. Other variants (ΔE2000, PCS-seeded, per-region) are a
separate deferred round-trip-family exploration, NOT Group A.

### Architecture
- ✅ `CIccEvalCompare` (`IccProfLib/IccEval.h`) and `CIccPRMG` (`IccProfLib/IccPrmg.h`) both expose
  **`EvaluateProfile(CIccProfile*, …)`** overloads — no filesystem needed.
- ✅ `IccEval.cpp` + `IccPrmg.cpp` are **already in `ICCPROFLIB_SOURCES`** (`validator-wasm/CMakeLists.txt:25,27`)
  → **no CMake change, no new module, no new deps.** Rides the existing `iccplot` module.
- **Do NOT extend `iccviz::RoundTripDE`** — it's a *different* bespoke metric (single-direction,
  in-gamut-seeded, mean/p90/max/std). Leave it alone.
- **Only new C++** = the `CIccMinMaxEval : public CIccEvalCompare` accumulator (~40 lines), currently
  trapped in the CLI's `.cpp` (`iccRoundTrip.cpp:83–150`). Replicate it.

### Changes (file by file)
1. **`validator-wasm/roundtrip-eval.hpp`** *(new, ~50 lines)* — verbatim port of `CIccMinMaxEval`.
   Own file so it lifts cleanly upstream.
2. **`validator-wasm/plot-wrapper.cpp`** — add `roundTripImpl(bytes, intent, useMpe)` beside the
   existing `roundTripDEImpl` (~line 469): `parseCached(bytes)` → run `CIccMinMaxEval` +
   `CIccPRMG` → serialize. Bind `emscripten::function("roundTrip", &roundTrip)` in
   `EMSCRIPTEN_BINDINGS(iccplot)` (~line 490). Reuse existing `kMaxIccBytes` + try/catch pattern.
3. **`validator-wasm/CMakeLists.txt`** — **no change** (confirmed).
4. **`frontend/src/lib/vizPlot.js`** — add `roundTrip(bytes, intent, useMpe)` mirroring the existing
   `roundTripDE` loader (JSON parse, `.error` throw).
5. **`frontend/src/components/AnalysisPanel.jsx`** — new `<Collapsible title="Round-Trip (PRMG)">`
   with an intent `<select>` (reuse pattern at ~:187) + a use-MPE checkbox; render RT1/RT2
   (min/mean/max + worst-Lab) and the PRMG histogram. Existing per-tag mean/P90/max overview
   (~:75,:90–92) stays as a lightweight summary — *sub-decision: keep as overview or retire.*
6. **`frontend/src/i18n.jsx`** — new `analysis_rt_*` keys across **all 12 locales**, then
   `node scripts/sync-translations.mjs` to refresh the 9 `Eng-*.xlsx`.
7. **`MANUAL.md`** — Round-Trip subsection under Analysis; regenerate `help.html` (pre-commit hook).
8. **Build/release** — `build-wasm.sh` rebuilds `iccplot` → `SHA256SUMS` → version bump + tag
   (this IS a WASM-artifact release, not UI-only).

### JSON contract
```jsonc
{
  "intent": 1, "useMpe": false, "total": 30235,
  "roundTrip1": { "minDE": 0.02, "meanDE": 1.13, "maxDE": 8.41, "maxLab": [21.3, 44.0, -50.7] },
  "roundTrip2": { "minDE": 0.00, "meanDE": 0.31, "maxDE": 3.02, "maxLab": [96.1, -1.2, 3.4] },
  "prmg": { "ok": true, "implied": true, "de1": 21044, "de2": 27310, "de3": 29001,
            "de5": 30100, "de10": 30235, "total": 30235 },
  "status": "ok"   // | "tooManySamples" | "error"
}
```

### Security / robustness
- Reuse existing **`kMaxIccBytes`** — no new entry-point cap needed.
- ✅ **`icCmmStatTooManySamples`** (the #1405 wide-device-space guard, inside `EvaluateProfile`)
  must surface as `status:"tooManySamples"` — a *skipped, non-error* state (mirror
  `iccRoundTrip.cpp:231–233`). This is the one non-obvious status path.
- Sampling bounded by IccProfLib granularity + the too-many-samples guard → no allocation to cap.

### Definition of done
A/B against the native `iccRoundTrip <profile> 1 0` on a real CMYK profile (e.g. `APTEC_PC11`):
WASM JSON must match the CLI's min/mean/max (both directions) + the five PRMG buckets. Add a case to
`validator-wasm/*smoketest.mjs`.

### Effort
Small: ~40-line accumulator + ~30-line wrapper; no new deps/module/CMake. Dominant cost = 12-locale
i18n + xlsx regen + the WASM rebuild/SHA256/tag cycle. ~1–2 days eng + release.

### Upstream contribution (the Group A PR)
Promote `CIccMinMaxEval` out of the CLI into `IccProfLib` (beside `CIccEvalCompare`/in `IccEval`).
Small, clean, non-duplicating — fits the migration ethos.

---

## GROUP B — Construct  *(planning depth; ⚠ needs source grounding before build)*

Each lifts a tool `main()` that builds a `CIccProfile` from IccProfLib public API. ✅ The review
confirmed all three build the profile entirely in `main()`, so a clean byte-returning engine is
achievable, and lifting **is** the upstream contribution.

**Shared prerequisite — MemIO refactor:** all three persist via `SaveIccProfile(path)` (and FromCube
parses via `FILE*`), so a byte-returning engine needs a `CIccMemIO`/MEMFS shim. This is a real
sub-task per capability, not free. ⚠ Verify the exact `CIccMemIO` API before building.

### B1 — IccFromCube  *(do first in B — simplest)*
- Input: `.cube` text → build `CIccProfile` DeviceLink → ICC bytes.
- ⚠ **Preserve the `LUT_3D_SIZE ∈ [2,255]` bound** (`iccFromCube.cpp:166–173`) — it lives in tool
  `main()` and a naive engine-lift drops it (255³×3×4 ≈ 190 MB against the 256 MB heap).
- New entry-point cap: **`kMaxCubeBytes`** (~32 MB). Do NOT reuse the XML DTD/entity guard for `.cube`.
- UI: mirrors the existing XML/JSON "from" converter (text in → ICC download).
- Effort: small–moderate.

### B2 — IccV5DspObsToV4Dsp
- Input: v5 display profile + v5 observer profile → build v4 display profile → ICC bytes.
- Two ICC files in, one out. ⚠ Read `Tools/CmdLine/IccV5DspObsToV4Dsp/*.cpp` (~129–326) for the
  exact tag-construction logic. Related closed CLI patch: iccDEV #667.
- Caps: per-input `kMaxIccBytes`.
- Effort: moderate.

### B3 — IccApplyToLink
- Input: a profile chain + params → sample the transform into a CLUT → DeviceLink ICC **or** `.cube`.
- Color engine = `CIccCmm` (IccProfLib, already linked); the sampling/serialization is the tool code.
- ⚠ Heaviest of B; check whether the chain-config overlaps IccLibConnect (if so it drifts toward D).
- Caps: `lut_size ∈ [2,255]`, precision bounds, per-profile `kMaxIccBytes`.
- Effort: moderate–heavy.

### Group B common
- New embind verbs returning ICC bytes (base64 or typed array).
- i18n + MANUAL + rebuild/SHA256/tag per capability.
- Upstream: each engine lift is a candidate PR.

---

## GROUP C — Inspect images  *(planning depth; zero new C++)*

Parse the image container in **JS**, extract the embedded ICC profile, feed the **existing**
`validateProfile` → the profile flows into Header/Tags/Validation/Analysis. ✅ The review confirmed
this reaches **embedded-ICC inspection parity** (not full container-metadata dumps) with **no new
C++ and no libtiff/png/jpeg in the WASM** — which also avoids the §1.8 tool-layer overflow surface.

⚠ **Difficulty is NOT uniform** (review-confirmed):
| Sub | Container | Extraction | Effort |
|---|---|---|---|
| **C1 — TIFF** *(do first)* | IFD | single blob at tag 34675 — trivial read | small |
| **C2 — PNG** | `iCCP` chunk | **zlib-deflate → needs inflate** in JS | small–moderate |
| **C3 — JPEG** | `APP2` markers | **multi-marker reassembly** (seq/count/dupe/missing, ~60 lines) | moderate |

Notes:
- chardata already does this JS-side with UTIF (`public/lib/utif.js`) — reference, not a dependency.
- ✅ The JPEG `acsp` raw-scan fallback was **removed** upstream (#1382) — don't reimplement it.
- Scope = "drop an image, inspect its embedded profile." Container metadata dumps are a stretch goal.
- UI: extend DropZone to accept image types; on embedded-ICC found, route bytes into the normal flow.
- New JS caps: bound decompressed `iCCP` size (zip-bomb guard) before inflate.

---

## GROUP D — Transform chains  *(planning depth; heaviest; ⚠ dependency decision required)*

The Apply family. **In scope** — heaviest bucket, sequenced last, but not deferred. The review
(✅ verified) established the split: the innermost color kernel (`CIccCmm::Apply` /
`CIccNamedColorCmm`) is in IccProfLib and **already linked**, but the chain-**building** machinery the
CLIs actually drive — `CIccConnectCmm::CreateStandard/CreateSearch/CreateNamed` + the config classes
(`CIccCfgProfileSequence`/`CIccCfgDataApply`/`CIccCfgSearchApply`/`CIccCfgImageApply`) — lives in
**IccLibConnect** (`IccConnect/IccLibConnect/{IccConnect.cpp,IccCmmConfig.h}`), which profiletool does
NOT link today (`grep IccConnect validator-wasm/` is empty).

### The dependency decision (blocks D; make before starting)
- **(a) Scope down** — build the facade over plain `CIccCmm`/`CIccNamedColorCmm` chain-building only
  (those `.cpp` are already in `ICCPROFLIB_SOURCES`); declare the `-ENV`/`-PCC`/`-INIT` + IT8/CGATS/JSON
  config surface a **non-goal**. Cheapest; loses config fidelity.
- **(b) Add IccLibConnect** — add `IccCmmConfig.cpp`, `IccConnect.cpp`, `IccJsonUtil.cpp` (+ nlohmann-json
  config parsing + MEMFS data staging) to the mirrored source manifest. Full fidelity; this is exactly
  the hand-mirrored-source fragility §2.5 warns about.

### D1 — IccApplyNamedCmm / D2 — IccApplySearch
- Input: profile-chain config + text color values (encoding per the CLI's text-data table:
  0 Lab/XYZ, 1 %, 2 unit-float, 3 raw-float, 4 8-bit, 5 16-bit, 6 16-bit v2) → transformed values out.
- Search variant = inverse (`CreateSearch` / `CIccCmmSearch`, `IccCmmSearch.cpp` already in manifest).
- UI: a **chain-builder** (N profiles, per-profile intent) + a color-input surface. This UI is the big lift.

### D3 — IccApplyProfiles
- Apply a chain to a **TIFF image**. Per the Group C philosophy: color kernel = engine (D1-style);
  TIFF decode/encode = **JS** (do NOT pull `TiffImg.cpp`/libtiff into wasm — that's the §1.8 overflow surface).
- ⚠ Must port the tool-layer checked helpers `GetFloatRowByteCount`/`AddPixelBufSlack`
  (`iccApplyProfiles.cpp:98,131`) into the engine — they're Class-C "already hardened" but live in
  CmdLine, so a JS-container split does not carry them into wasm.

### Group D common
- New entry-point caps: per-member `kMaxIccBytes`, chain-length cap, **checked-multiply on
  `points × channels`** before allocating outputs.
- ⚠ Needs source grounding: read `Tools/CmdLine/IccApplyNamedCmm|IccApplySearch|IccApplyProfiles/*.cpp`
  and the IccLibConnect config classes before building. Related closed research: iccDEV #1323, #1000.
- Effort: **heavy** (color kernel is proven; cost is the dependency decision + the chain-builder UI + config surface).

## Cross-cutting checklist (every capability with new chrome)

- [ ] Engine stays locale-neutral (signatures/enums/numbers only).
- [ ] New WASM entry point → its own byte cap (mirror `kMaxIccBytes`); new text parser → its own guard.
- [ ] Ported tool-layer checked-arithmetic helpers where data crosses JS→wasm (B/C).
- [ ] i18n keys across **12 locales** + `sync-translations.mjs` (9 xlsx).
- [ ] `MANUAL.md` update → regenerate `help.html`.
- [ ] Any `*-wrapper.cpp`/engine change = full WASM rebuild → `SHA256SUMS` → version bump → tag release.
- [ ] A/B verify vs the native CLI on a real profile/image; add a smoketest case.
- [ ] Upstream: is the engine a PR candidate? (Group A/B yes; Group C is JS, downstream-only.)

## Sequencing

Review recommendation (lowest integration-tax first): **C1 TIFF → C2/C3 → Group A → Group B → Group D**,
because even a minimal Group A "widen the return" crosses the C++/wasm/SHA256/tag boundary and drags
12-locale strings, whereas C1 is truly zero-new-C++. Group D is last (heaviest) but **in scope**.
*User directive: produce/deliver plans starting with Group A.* (Delivery order ≠ mandated build order —
reconcile before starting implementation.)

## Decision Log

*Every planning decision, tracked by stable ID. `RESOLVED` entries carry the call +
date; `OPEN` entries carry the options so input can be dropped in by ID. IDs are
referenced from the group sections above. Categories: **IA** app-identity/nav ·
**A/B/C/D-UX** per-group user-experience · **ARCH** build/dependency.*

### DL-UPSTREAM1 — Upstream-contribution posture (project weak directive) · 🎯 STANDING 2026-07-18
**Weak directive (a project goal, not a hard rule):** one of profiletool's goals is to
**look for opportunities — as we did with iccviz — to increase iccDEV's functionality by
naturally generating API-based modules that slot cleanly into the iccDEV corpus**, either
**inside `IccProfLib`** (and similar foundational-level libraries) **or one layer up** (a
sibling optional library, the way `IccXML` / `IccJSON` / `IccConnect` sit beside the core).

**Why "weak":** it's an opportunistic lens applied while building profiletool features, not
a mandate to refactor iccDEV on a schedule. profiletool ships its feature *now* (usually a
JS or local implementation); the upstream module is a **parallel track** that profiletool
later migrates onto — the same pattern as [[iccviz-upstream-migration-plan]] (temporary
in-app impl → author the clean engine for the upstream path → migrate + deprecate local).

**What makes a good candidate** (the shape that keeps recurring):
- The capability is **generally useful to the ICC ecosystem**, not profiletool-specific.
- It fills a **real gap or wart** upstream — no reusable API today, or logic duplicated /
  buried inside CLI tools (e.g. embedded-profile extraction, whose structure-parsing is
  copy-pasted across `IccJpegDump`/`IccPngDump`/`IccTiffDump` and once shipped bug #1382).
- It can be shaped **dependency-light** so it compiles into profiletool's WASM without
  dragging heavy libs — prefer a *locator/producer* that returns data + hands the heavy or
  platform-specific step (inflate, file I/O, async) back to the caller via injection, over
  an API that pulls libpng/libtiff/zlib into the core.
- profiletool's local impl doubles as the **executable spec + A/B oracle** for the C++ API.

**Consequences / guardrails:**
- Follow the iccDEV change policy for any actual contribution: moderator approval on the API
  shape *before* writing much; ssh/gpg-signed commits, **no** Claude trailer; prefer an
  upstream branch over a fork PR; bundle related changes into one noted PR
  ([[iccdev-change-policy]], [[iccdev-commit-signing-no-claude-trailer]]).
- Strongest-parity payoff: once profiletool consumes the shared C++ source (compiled into
  validator-wasm), the in-app representation *is* the reference implementation — no drift.
- **First declared candidate → PHASE 2 work item:** `icFindEmbeddedIccProfile` — a
  dependency-free container locator (TIFF tag 34675 / PNG `iCCP` / JPEG `APP2`) returning
  offset+length+compression, caller owns inflate; iccDEV's `IccJpegDump`/`IccPngDump`/
  `IccTiffDump` refactor onto it (dedups their copy-pasted structural parsing; the JPEG one
  once shipped bug #1382). **Phase-1 status (done 2026-07-18):** profiletool ships the
  **streaming JS** implementation `frontend/src/lib/embeddedProfile.js` — a lazy byte-range
  reader that extracts the profile touching only header/IFD/markers + the blob (verified:
  a 50 MB container is resolved reading ~1–3 KB, ~0.005% of the file; never loads the
  raster). That JS is the **executable spec + A/B oracle** (byte-exact vs libpng/libtiff/
  libjpeg output) for the Phase-2 C++ locator. **Phase 2:** propose + (on moderator sign-off)
  land `icFindEmbeddedIccProfile` in iccDEV, then migrate profiletool's WASM onto it while
  keeping JS inflate for PNG. See § below (Group C) and [[upstream-api-contribution-directive]].

### DL-PHASE1 — Phase-1 scope & selection UX (base wasm set, no canvas) · ✅ RESOLVED 2026-07-18
**Q:** Phase 1 covers the existing iccDEV **wasm CLI-tool collection** (`iccdev/wasm/`,
22 modules) WITHOUT the node graph (DL-CANVAS1 = later phase). Does the data-store
selection UX need more than **profile-pair** selection?
**Arity survey** *(⚠ originally stamped "verified from `Usage()`" — **corrected 2026-07-18**: the
gamut-compare row below was an inference from the `input_profiles` plural, NOT verified. See § Source audit.)*:
| Arity | Tools | Phase 1 |
|---|---|---|
| 0 prof — text/file → profile | FromCube, FromXml, FromJson | ✅ ingest |
| 0 prof — image → extract/dump | TiffDump, PngDump, JpegDump | ✅ ingest (Group C) |
| 1 prof | DumpProfile(+bigstack), ToJson, ToXml, RoundTrip, ProfilePlot, PawgReport | ✅ single |
| ~~test harness~~ | ~~DescribeSinkTest~~ — **not a user tool** (CTest smoke test); removed 2026-07-18 | — |
| 1 prof + image seq | SpecSepToTiff | ✅ single + image |
| 2 prof, **role-typed** | V5DspObsToV4Dsp (display + observer) | ✅ role-pair |
| **N prof, unordered** (compare) | ~~ProfileVisualize (gamut overlay)~~ — **CORRECTED 2026-07-18: no such iccDEV tool.** ProfileVisualize is per-profile **batch** (loop → one output each), never an overlay. Gamut compare is a **beyond-parity chardata port** | **beyond parity → P1-late** |
| **N prof, ordered + intent + PCC + data** | ApplyNamedCmm, ApplyProfiles, ApplySearch, ApplyToLink | ⛔ **defer → DL-CANVAS1** |
**Decision:** pair is *almost* enough — three caveats: (1) `ProfileVisualize` wants
**unordered multi-select (N)**; (2) the one pair (`V5→V4`) is **role-typed** (2 slots,
not symmetric 2-select); (3) a separate **companion-data axis** (text/file producers,
image drop) that profile-selection doesn't cover. The **only** tools needing
ordered-N + PCC + per-profile intent + data-file are the 4 `Apply*`/`ToLink` — i.e.
exactly the node-graph set → cleanly deferred to DL-CANVAS1.
**Phase-1 data-store UX:** pool with **N-multi-select (unordered)** — N=1 → single
tools, N≥2 → **gamut compare** *(beyond parity — chardata port, P1-late)*, **role-slots** for the `V5→V4` pair; **two
ingest affordances** (create-from-text/file → new pooled profile; image drop → extract
embedded into pool); **defer** ordered-chain/PCC/data apply-link. Net: multi-select
unordered + role-slots for one pair — a hair beyond "pair," far short of the graph.
**Sub-call RESOLVED (user 2026-07-18): a multi-select gamut-compare verb.** It
fits a **"multi-select from list + verb (Plot Gamut)"** frame — adopted as the **general
phase-1 interaction model**. *(Correction 2026-07-18: "Plot Gamut" is a **beyond-parity
chardata port**, NOT `ProfileVisualize` parity — that attribution was wrong; see § Source audit.
The multi-select+verb model stands on its own; only the gamut engine's provenance changed.)*:
- **Interaction = pool list + multi-select + verb bar** (file-manager / chardata
  select→action convention; node-graph-free). Verbs enable by selection arity:
  - **0 selected** → *ingest* verbs only: New from .cube / XML / JSON; Add from image
    (extract embedded → pool).
  - **1 selected** → Inspect · Dump · To JSON · To XML · Round-Trip · Profile Plot ·
    PAWG · **Plot Gamut**.
  - **2 selected** → **Plot Gamut** (compare) · **Make V4 Display** (`V5→V4`).
  - **N>2 selected** → **Plot Gamut** (compare overlay).
- **Role-pair (`V5→V4`) needs no manual role UI:** the tool's contract distinguishes the
  two by class — `argv[1]` = V5 **RGB display** (`mntr`), `argv[2]` = V5 **observer**
  (`spac` ColorSpace-class PCC). Roles are **auto-inferred** from the selected pair
  (confirm; error on ambiguous, e.g. two displays). The one asymmetric case collapses
  back into plain multi-select + verb.
**Input:**

### DL-A1 — Round-trip surfacing & controls · ✅ RESOLVED 2026-07-17
**Q:** Where does the canonical `iccRoundTrip` (PRMG) metric live, and how does it
relate to the existing bespoke `roundTripDE` overview? *(orig open-decision #1)*
**Decision:** Integrate into the **existing Profile Statistics table** (Analysis tab)
— **not** a separate PRMG card. Rendering intent stays the row axis (one row per
intent, unchanged). The two round-trip metrics become selectable **methods** behind a
single **"Round-trip method" listbox**; the *existing 3 round-trip columns are reused
and re-skinned* per method (no new column):
- **In-gamut ΔE (iccviz `roundTripDE`)** — columns `mean | P90 | max` (today's behavior)
- **PRMG (`iccRoundTrip`)** — columns `RT1 | RT2 | ≤ΔE1 %`; a per-row `›` **expander**
  reveals the full `ΔE≤1/2/3/5/10` histogram + worst-Lab + specified-gamut flag
- **use-MPE** checkbox (PRMG method only)
- **Recompute:** live on control change; memoize per `(profile, method, use-MPE)`.
- Listbox is built to grow (future ΔE2000 / PCS-seeded "family" styles).
**Rationale:** avoids two unreconciled "round-trip" numbers; the metric's rich part
(histogram/worst-Lab) hides behind the expander so the table width is unchanged. The
user's refinement — *"we already have 3 columns, so we really just need the method
control"* — means the **only new chrome is the method listbox + use-MPE checkbox**.
**Supersedes:** GROUP A → *Changes* item 5 (the "new Collapsible / intent select"
plan) — there is no new collapsible and no intent `<select>` (intent = row axis).
Build target = extend `ProfileStatsSection` in `AnalysisPanel.jsx`. Folds in the
former A-2 (controls) and A-3 (PRMG presentation).
**Update (P1-b, 2026-07-18):** in the 2.x shell the Profile-Statistics table **splits by
tab** — **gamut-volume → the `Compare` tab** (with the 3D/2D gamut plots); **round-trip
stays in `Profile`** as its own per-intent table carrying this method listbox. Gamut and
round-trip are no longer co-tabled.

**Update (P1-c, 2026-07-18) — IMPLEMENTED. Supersedes the earlier "6f6e337 separate
`Round-Trip (PRMG)` Collapsible" build**, which mistakenly followed the *superseded* GROUP-A
item-5 plan rather than THIS decision. Round-trip is folded back into the **Profile
Statistics** table (with gamut volume alongside), driven by **two listboxes** and a use-MPE
checkbox:
- **Rendering intent** is now its OWN listbox (no longer the row axis) — perceptual / relative
  / saturation / absolute. The table shows the single selected intent.
- **Round-trip type** listbox with **four** types, each an in-app representation of the same
  colour math (NOT the CLI's console layout — the user is the judge of parity):
  - **RT0** — `iccviz::RoundTripDE` in-gamut overview (device grid → PCS → device → PCS).
  - **RT1** — device-cube `ΔE(deviceLab, round1)` (inversion + gamut).
  - **RT2** — device-cube `ΔE(round1, round2)` (reproducibility).
  - **PRMG** — Perceptual Reference Medium Gamut interoperability (in-app walk replicating
    `CIccPRMG`; buckets identical by construction, plus min/mean/P90/max + worst-Lab).
- **Uniform presentation for every type:** one table row `gamut volume | min | mean | P90 |
  max`, then the **cumulative ΔE histogram (≤1/2/3/5/10, count + share)** *below the table*
  (no per-row expander), a **worst-Lab** line, and (PRMG only) the specified-gamut line.
- A **short, code-grounded description updates with the type selection**, shown beside the
  selector.
- **WASM:** single new entry `roundTripStats(bytes, intent, useMpe)` (plot-wrapper.cpp) returns
  all four types for one intent → the type selector switches instantly; only intent/use-MPE
  recompute (memoized JS-side). Engines extended: `DeStats` accumulator + refactored
  `CIccMinMaxEval` (roundtrip-eval.hpp); `iccviz::RoundTripDE` gains min + buckets + worst-Lab.
  The old `roundTrip`/`roundTripImpl` are removed. NOTE this **reverses** the GROUP-A rule "do
  NOT extend `iccviz::RoundTripDE`" — today's uniform-histogram requirement supersedes it.
- **i18n:** new `analysis_rt_type_*` / `analysis_rt_desc_*` / `analysis_stats_intro2` keys added
  to `en`; all `t()` calls carry inline EN fallbacks so other locales render correctly. Full
  12-locale fill deferred to task #31.

**Update (P1-d, 2026-07-18):** the histogram is a **graph, not a table** — user directive:
"don't implement histogram in table … look to chardata Comparison Statistics for the pattern."
- The cumulative-frequency TABLE is removed; in its place a **Plotly** chart ported ~verbatim
  from chardata's `renderCmpHist`: **relative-frequency bars (left axis) + cumulative-frequency
  line (right axis)**, integer-ΔE bins. New component `components/viz/RtHistogram.jsx`.
- **`std` (std-dev)** added as a comparison statistic (table column between Mean and P90).
- **WASM** now also emits `std` + an integer-ΔE `hist[]` per type (`DeStats::stddev/integerHist`;
  `iccviz::RoundTripResult.hist`); the coarse `buckets[]` are kept ONLY for the smoketest A/B.
- **Plotly introduced** (`plotly.js-dist-min@2.27.0`, matching chardata), lazy-loaded as its own
  code-split chunk (main bundle unchanged; ~3.5 MB Plotly loads on first histogram render). This
  is deliberate groundwork for the **late-P1 gamut 3D/2D plots**, which are Plotly-heavy in
  chardata. **CSP finding:** the histogram uses Plotly SVG traces only → **no CSP change** needed
  (my earlier "CSP blocks Plotly" was wrong; `script-src 'self'` loads it, `style-src
  'unsafe-inline'` covers its styles, SVG needs no `'unsafe-eval'`). Re-verify the eval question
  when the WebGL 3D gamut plots land (chardata runs those with no `'unsafe-eval'`, so likely fine).

### DL-IA1 — App identity: inspector vs generator/transformer · ✅ RESOLVED 2026-07-18 (Option 4, staged)
**Q:** profiletool is inspect-only today (drop profile → Header/Tags/Validation/
Analysis). Group A fits (Analysis card) and Group C fits (image → embedded profile →
same flow), but **Groups B (emit ICC) & D (interactive transform) change what the app
is**. How do they fit? *(gates all B/D-UX decisions)*
**Options:** (1) keep inspect-only — A+C land here, B+D declared out of scope;
(2) add a second top-level "Tools"/"Convert" area for B (and later D), inspector stays
default; (3) full IA restructure into Inspect/Construct/Transform peers; **(4) Profile
Pool / workbench** *(user-proposed 2026-07-18)* — top level becomes a *collection* of
ICC profiles (auto-classified by class/colorspace/version/PCS — free from existing
header output — + user classifications TBD), backed by an in-browser profile **data
store**. Select **one** → today's tabbed single-profile view + single-profile
near-future (extract-from-image, apply-to-image). Select **≥2** → link production &
other multi-profile activity; the selection *is* the chain input. B/C/D stop being
homing problems: C *adds to* the pool, B *produces into* it, B2/D *operate on
selections* — so **DL-B2 "close the loop" becomes automatic** and **DL-D1's
chain-builder collapses into** pool multi-selection + per-profile order/intent.
Heaviest + most capable; a superset of (3) organized around a collection/selection
rather than verb-areas. Introduces three new axes → **DL-STORE1** (persistence),
**DL-IMG1** (images transient), **DL-SCOPE1** (characterization boundary).
**DECISION (user 2026-07-18): Option 4, staged.**
- **Phase 1** — Profile Pool + single-profile inspect + **multi-select-from-list + verb**
  over the base wasm CLI-tool set (DL-PHASE1); **no node graph**; store =
  filesystem-ephemeral (DL-STORE1).
- **Canvas phase** — connectivity node graph (DL-CANVAS1) for linking / ICS / the 4
  `Apply*`·`ToLink` chain tools; same filesystem-ephemeral store (workflows = saved
  `.json`).
Options 1–3 (mine) were superseded; Option 4 is the user's Profile Pool proposal.
**Input:** RESOLVED — Option 4, staged.

### DL-STORE1 — Data store model · ✅ RESOLVED 2026-07-18
**Decision (user):** **ephemeral session pool; the local filesystem IS the store**
(chardata model). The app **persists nothing** between sessions → strong
*data-doesn't-leave* AND no local linger. **No IndexedDB — ever, including the canvas
phase.** (Supersedes the earlier "IndexedDB deferred to canvas" option.)
- **Durability is delegated to the user's own folder** — encourage "keep all your
  profiles in one place"; the pool is a *loaded working set*, not an app-managed library.
  Reload clears the pool; re-browse to reload (source of truth = their folder on disk).
- **Population — phase 1 = chardata parity:** multi-file `<input multiple>` + drag-drop
  (`dataTransfer.files` → `addFileToList`), matching chardata `public/index.html`.
  **DEFERRED to POST-phase-1** (user-proposed 2026-07-18, NOT in chardata today; *don't
  forget*): **folder + folder-and-subfolder (recursive) load** — `showDirectoryPicker`
  (Chromium) recursive walk of the dir handle's `.values()`, `<input webkitdirectory>`
  fallback. chardata uses `showDirectoryPicker` only for export/readwrite, not recursive
  profile loading → genuinely new.
- **Pool internals:** in-memory list of loaded entries (bytes + derived metadata),
  chardata "file-card" style; key on `profileId`/content hash → dedup free;
  auto-classification (class/colour space/version/PCS) free from `validateProfile` output.
- **Produce/save verbs** (FromCube/Xml/Json, Make-V4, later link production) =
  user-initiated **file download/save to disk**, not app persistence.
- **Privacy/quota concerns evaporate** — no IndexedDB ⇒ no on-disk linger, no clear-all
  obligation, no quota/eviction handling. The only "store" is the user's own filesystem.
**Workflow entity (canvas phase) persists the SAME way** (per DL-ICS1/DL-CANVAS1): a
saved workflow = a `.json` file the user saves to their folder and loads back via browse
— **not** a DB. Bundled demos (e.g. `Testing/ICS`) ship as loadable `.json`. The store
never holds a workflow between sessions.
**Input:**

### DL-IMG1 — Image ops are transactional; store holds profiles only · ✅ RESOLVED 2026-07-18
**Decision (user):** the pool holds **profiles only**. Extract-from-image *adds a
profile* to the pool; apply-to-image is a **stateless transaction** (image in → image
out via user download, neither persisted). Consistent with DL-STORE1 (app persists
nothing; produced files are user downloads).
**Input:** RESOLVED — profiles-only, images transient.

### DL-SCOPE1 — Characterization data as a primitive: avoid (weak principle) · ✅ RESOLVED 2026-07-18
**Q:** *Weak* principle (deliberate lean, not absolute): avoid characterization datasets
(CGATS/IT8/.ti3, spectral/CxF) as a **data primitive** / a
profile-*creation-from-measurement* workflow — that's profile-vendor + **chardata**
territory. Keep profiletool in **iccDEV territory** (profiles in → profiles/transforms
out) as a free open tool. **Nuance:** we *already* ingest CGATS for the PAWG report, so
the line is **not** "never read measurement data" — it's "don't build
profile-*fitting/creation-from-measurement* as a core primitive"; bounded tool-specific
measurement inputs (PAWG's CGATS, a `.cube` LUT) are fine as iccDEV-tool inputs. The one
candidate exception raised (profile absolute-colorimetry → data fit) is **chardata's
today** → stays out. Task: pin the precise line + the bounded-exception list.
**Input:** RESOLVED (user 2026-07-18) — adopt the boundary as stated: stay in iccDEV
territory (profiles in → profiles/transforms out); bounded tool-specific measurement
inputs OK (PAWG CGATS, `.cube` LUT); no profile-creation-from-measurement primitive.

### DL-ICS1 — iccMAX ICS / multi-part interchange workflows · 🔲 OPEN *(requirement, verified 2026-07-18)*
**Requirement:** the architecture must hold iccMAX **ICS (Interchange Color Space) demo
workflows** (`iccdev/Testing/ICS/`) and, by extension, the wider `Testing/` iccMAX
families (Calc, Display, Encoding, Named, PCC, SpecRef, HDR, mcs, Overprint, hybrid).
**Verified:** an ICS workflow *is* a multi-part profile chain — `spac`/`mntr` profiles,
`Part1→Part2[→Part3]`, connecting through an interchange PCS (Lab/XYZ/spectral) under a
stated illuminant/observer (e.g. `Lab_float-D65_2deg-Part1` → `-IllumA_2deg-Part2` =
D65→Illuminant-A adaptation; `Rec2100HlgFull-Part1/2/3` = 3-part HDR + EOTF companion).
→ It is an **instance of the pool's "select ≥2 → apply-chain / link production"**
activity (Group D), so **DL-IA1 opt 4 holds it as a framing arc** (single-vs-group axis
covers the whole family). **Build bonus:** the full iccMAX apply stack is already linked
(see DL-ARCH2 update) — executing MPE/spectral/calc/PCC chains is a *binding* problem,
not a new engine.
**Gaps (architecture must satisfy):**
1. **Order + typed roles** in the "select ≥2" model (source / interchange-PCC /
   destination), not a flat set. → refines **DL-D1**.
2. **ICS-aware chain semantics + connection validation** — surface interchange space +
   viewing conditions; validate Part1 output space/conditions match Part2 input. *New
   layer*, not covered by generic chain-apply.
3. **Bound apply/link entry point** — the only real code gap (kernel already linked). →
   **DL-ARCH2**.
4. **"Workflow" store entity** — named recipe over pooled profiles. → **DL-STORE1**.
5. **Bundled demo content** (ship `Testing/ICS` as loadable examples) + confirm no
   measurement-data primitive (EOTF/InvEOTF are transfer-function reference, transform
   lives in the profiles). → consistent with **DL-SCOPE1**.
**Mapping (DL-CANVAS1):** gaps 1–2 → canvas **edges** (order/roles) + typed
**color-space ports** (connection validation); gap 4 → **SerializedWorkflow**.
**Input:**

### DL-CANVAS1 — Connectivity canvas (node-graph) as the linking mechanism · 🕓 LATER PHASE *(design sourced 2026-07-18; deferred per user — phase 1 = DL-PHASE1)*
**Decision to adopt:** use a **node-graph "connectivity canvas"** — nouns (profiles /
images / color-value sets, drawn from the pool) wired through engine nodes (apply /
link / extract / metric) to sinks — as the concrete realization of DL-IA1 opt 4's
"select ≥2 → multi-profile activity." Also covers **single-image processing** (a linear
Image→Apply→Output graph) and **ICS multi-part** (a topo-ordered apply chain), per user
2026-07-18.
**Design source (verified):** `~/code/pflt/apps/pfgraph` (+ framework-free core
`~/code/pflt/packages/workflow-runtime`). Reusable pieces:
- **Registry** (`registerNodeKind`) — single source of truth; canvas, library,
  validation, executor all read it. Add a capability = register one node.
- **`NodeKindSpec = RuntimeNodeSpec (framework-free run()) + React UI`.** The executor
  reads only the runtime half → the *same* `run()` drives canvas + a future headless
  worker/CLI. **Swap seam for profiletool: `ctx.api` = in-browser WASM engine facade**
  (pflt's is a server client; the executor/node contract is identical).
- **Node families** `data | engine | decision`: data = nouns (ProfileSource from pool,
  ImageSource, ColorValuesSource; sinks ProfileOutput→pool, ImageOutput download);
  engine = ApplyProfile / BuildLink / ExtractFromImage / IccFromCube / V5→V4 /
  Gamut·RoundTrip; **Matlab/external API = more `data` nodes** (future req, no arch
  change).
- **Typed ports + `canConnect`/`portTypesCompatible`** (`canvas/validation.ts`) →
  encode color space + PCS + illuminant/observer as `PortType`; edge validity = ICS
  space/conditions matching.
- **`SerializedWorkflow {version, nodes[], edges[]}`** (zod, versioned, additive;
  `workflow/schema.ts`) = the **workflow store entity** (DL-STORE1/DL-ICS1 gap 4);
  bundled ICS demos ship as these. autosave/serialize ready-made.
- **`runPipeline`** (`executor.ts`, topo-sort → `run()` each node) = the apply-chain
  executor.
**Subsumes DL-D1** (the canvas *is* the chain-builder, more general). **Realizes**
DL-STORE1's workflow entity + DL-ICS1 gaps 1/2/4. **Also the home for image-noun
gathering** — `SpecSepToTiff` (N spectral image separations → assembly node → TIFF, P1-c)
is the image analogue of ICS profile-chain gathering.
**Adaptation gaps (NOT a drop-in — profiletool constraints):**
- **a. No-server.** pfgraph is multi-tenant + server-backed (`auth/`, `api/client`,
  Job/Ticket/Volume nodes, headless worker). Pull canvas/registry/node-spec/ports/
  serialize/validate/executor; **drop** all auth/tenant/job/server nodes; `ctx.api` →
  WASM; data nodes → in-browser pool. Preserves *no-server / no-data-leaves*.
- **b. `@xyflow/react`** (React Flow) — client-side, CSP-compatible (`script-src
  'self'`), but a substantial new dep + bundle cost; must be skinned to the chardata
  visual identity.
- **c. TS → JS.** pfgraph is TS + zod; profiletool frontend is JS/JSX. Patterns port;
  literal code + zod schemas need re-expression (or introduce TS to profiletool).
- **d. Staging.** Free-form canvas = large surface vs today's validator. It's the
  *destination* for the linking/ICS half — stage: pool + single-profile inspect first,
  maybe a simple linear apply before the full canvas. Canvas earns its weight once
  linking/ICS are live.
- **e. Shared-core option.** `@pflt/workflow-runtime` (RuntimeNodeSpec/PortType/
  runPipeline/registry) is framework-free — fork-and-port vs vendor/share. Likely port
  the pattern (lang/constraint mismatch), but the seam exists.
**Input:**

### DL-C1 — Image drop affordance · 🔲 OPEN
**Q:** DropZone starts accepting TIFF/PNG/JPEG (Group C). Same silent drop target, or
a visible hint that images-with-embedded-profiles are accepted?
**Input:**

### DL-C2 — Image failure / multiplicity messaging · 🔲 OPEN
**Q:** What does the user see when an image has **no** embedded profile (non-error
"nothing to inspect" state), and when a JPEG carries a **multi-marker** profile
(reassembled) vs inconsistent/missing markers?
**Input:**

### DL-B1 — Construct input affordances · 🔲 OPEN *(only if DL-IA1 ≠ opt 1)*
**Q:** `.cube` text (B1) — paste-box vs file-upload? B2 needs **two** ICC inputs —
dual-drop UX?
**Input:**

### DL-B2 — Construct: close the loop · 🔲 OPEN *(only if DL-IA1 ≠ opt 1)*
**Q:** After building an ICC, auto-feed it into the inspector (validate what you built)
or just offer a download? *(Under DL-IA1 opt 4 this is automatic — constructed profiles
land in the pool, inherently inspectable.)*
**Input:**

### DL-D1 — Chain-builder depth · 🔲 OPEN *(only if DL-IA1 ≠ opt 1)*
**Q:** D's N-profile + per-profile-intent builder is the big UX lift. Full interactive
builder, or a minimal fixed 2-profile form for a first cut? *(Under DL-IA1 opt 4 the
builder collapses into pool multi-selection + per-profile order/intent — much of the
lift is absorbed by the selection model.)*
**Superseded by DL-CANVAS1** — the connectivity canvas (node graph) *is* the
chain-builder: edges express order, typed color-space ports express the per-connection
constraint. This entry is now the "how deep is the first canvas cut" staging question.
**Input:**

### DL-D2 — Color-input encoding exposure · 🔲 OPEN *(only if DL-IA1 ≠ opt 1)*
**Q:** Expose the CLI's full 0–6 encoding table, or the common subset (Lab/XYZ, %,
8/16-bit)?
**Input:**

### DL-ARCH1 — B3 ApplyToLink: pulls IccLibConnect? · 🔲 OPEN (factual — resolvable by source read)
**Q:** Does B3's chain-config pull in IccLibConnect? If yes → reclassify to Group D.
*(orig open-decision #2)* Settle by reading `iccApplyToLink.cpp` — I can resolve this
without user input.
**Input:**

### DL-ARCH2 — Group D dependency scope · 🔲 OPEN
**Q:** Scope down to plain `CIccCmm`/`CIccNamedColorCmm` (cheap; loses `-ENV`/`-PCC`/
config fidelity) **or** add IccLibConnect to the mirrored source manifest (full
fidelity; the hand-mirrored-source fragility, §2.5). *(orig open-decision #3; decide
before any D build)*
**Update (2026-07-18, verified):** the WASM build **already links the full iccMAX apply
stack** — `IccMpeBasic/Calc/Spectral/ACS`, `IccTagMPE`, `IccArrayBasic`,
`IccStructBasic`, `IccSolve`, `IccSparseMatrix`, `IccPcc`, `IccCAM`, `IccCmm`,
`IccCmmSearch` (`validator-wasm/CMakeLists.txt`). So the **color kernel** for
MPE/spectral/PCC chains is present; "scope down to plain CIccCmm" is moot. The residual
ARCH2 question narrows to the **chain-config surface** (IccLibConnect) only — the
transform engine is not the gap. The gap is a bound **apply/link entry point** (see
DL-ICS1).
**Input:**

### DL-ARCH3 — Pin iccDEV as a submodule · 🔲 OPEN
**Q:** Pin iccDEV as a git submodule (§2.5) vs the current unpinned `ICCDEV_ROOT`
path. *(orig open-decision #4)* Note: a pin also makes the **iccviz sync-back** (Track
1) reproducible, so this spans both parity tracks.
**Input:**

## Related iccDEV issues
- **#1711** (OPEN, active) — bring GamutVolume/RoundTripDE/neutral-axis to the IccProfilePlot iccviz
  engine. The upstream track for our migration; directly touches Group A round-trip.
- **#197 / #203 / #1090 / #826 / #435** — the CLI-tools-as-WASM (`callMain`/npm) effort we are
  deliberately NOT replicating. #203 (toolchain merge, "may be forked, Q1/2026") is the open
  upstream-strategy question `iccdev-wasm-analysis.md` feeds.
- **#667** — closed iccV5DspObsToV4Dsp CLI patch (reference for B2).

## Phase 1 — Build Spec (synthesis of locked decisions)

Locked: **DL-IA1** opt 4 (pool workbench, staged) · **DL-STORE1** (filesystem-ephemeral,
no DB) · **DL-PHASE1** (multi-select + verb, no node graph) · **DL-IMG1** (profiles-only)
· **DL-SCOPE1** · **DL-A1** (round-trip in Profile Statistics). **Goal:** cover the iccDEV
`wasm/` CLI-tool set — *minus* the 4 `Apply*`/`ToLink` chain tools (→ canvas phase) — via
the pool + verb frame.

### 1. The pool shell (new IA — three-zone chardata layout; P1-a RESOLVED 2026-07-18)
- **Left — info pane = the data-store list view** (the pool). **Collapsible + resizable**;
  it is **the drag-and-drop target** + browse-load entry. Growing/hiding it shrinks/grows
  the main canvas. Load: multi-file `<input multiple>` + drag-drop → in-memory pool, dedup
  by `profileId`/content hash *(folder/subfolder load deferred post-phase-1, DL-STORE1)*.
  Rows = filename + auto-classification badges (class, colour space, PCS, version, size)
  from `validateProfile`; multi-select (click · shift/ctrl-range · select-all).
- **Centre — main canvas = 3 tabs: `Profile` · `Compare` · `Link`** (P1-a activation,
  revised 2026-07-18). **Activate by clicking a tab OR dragging profile(s) from the info
  pane onto a tab.** *(Mobile may need a different tab UX — deferred to phase 2.)*
  - **Profile** — all single-profile views/actions: today's `ProfileViewer`
    (Header/Tags/Validation/Analysis/XML/JSON + save toolbar) **plus more**, **minus gamut**
    (gamut relocates to `Compare`; round-trip stays here — P1-b / DL-A1). Operates on 1.
  - **Compare** — the **sole home for gamut**, **1..N** profiles: gamut-volume (per-intent
    table) + **3D gamut mesh / 2D gamut slice** plots (P1-b), overlaid across the tab's set.
  - **Link** — linking / multi-profile transform. **Phase-stable home for the node canvas**
    (canvas phase slots in here); thin/placeholder in phase 1.
  - **Per-tab accumulator** (removable **chiclets** near the tabs): each tab keeps its
    **own** set of dropped profiles, shown as chiclets with a remove (✕) affordance —
    remove drops it from the tab's set, **not** the pool. Populated by **dragging from the
    info pane onto the tab**; the accumulator (not live info-pane selection) is the tab's
    authoritative set, **independent per tab**. **Drag semantics:** `Profile` **replaces**
    (holds 1; multi-drop → **last one wins**); `Compare` & `Link` **accumulate** (add).
    Multi-drag allowed into any tab.
  - **Two empty states — both need a designed display:** (a) **pool empty** (nothing
    loaded) → info pane shows the browse prompt; (b) **accumulator empty** (pool has
    profiles, none dropped on this tab) → the tab shows its own prompt ("drag a profile
    here to inspect / compare / link").
- **Right — settings pane** unchanged from today (`SettingsBlade` overlay); `GuidePanel`
  unchanged.
- **Division of labour:** the **tabs** = what you *do with* profiles (view / compare /
  link); the **info pane** = get profiles *in* — load + **ingest/create verbs**
  (from cube/xml/json, add-from-image, Make-V4 on a 2-selection) that produce *into* the
  pool. Today's `DropZone` is absorbed into the info pane.

### 2. Verbs → engines → output
| Verb | Arity | Engine | New? | Output |
|---|---|---|---|---|
| Inspect | 1 | validateProfile + describeTag | existing | ProfileViewer tabs |
| Dump / To JSON / To XML | 1 | validate / iccToJson / iccToXml | existing | tab / download |
| Round-Trip (PRMG) | 1 | iccRoundTrip (CIccMinMaxEval + CIccPRMG) | **new** (DL-A1) | Profile Statistics method column |
| Profile Plot | 1 | iccviz single | existing | Analysis plot |
| Plot Gamut (compare) | 1..N | **chardata gamut port — beyond parity** (iccviz boundary mesh/slice + lcms2→`CIccCmm`) | **new · P1-late** | 3D mesh / 2D slice overlay |
| PAWG Report | 1 | iccPawgReport | existing | report |
| Make V4 Display | 2 (roles by class) | iccV5DspObsToV4Dsp | **new** | download + add-to-pool |
| New from .cube | 0 | iccFromCube | **new** | add-to-pool + download |
| New from XML / JSON | 0 | iccFromXml / iccFromJson | existing | add-to-pool + download |
| Add from image | 0 | **JS** extract (TIFF/PNG/JPEG) | **new (JS only)** | add-to-pool |

### 3. New engine / WASM work
- **iccRoundTrip PRMG** (DL-A1) — port `CIccMinMaxEval` + `CIccPRMG`; rides the existing
  `iccplot` module (no CMake change). Wrapper `roundTrip(bytes, intent, useMpe)`.
- **Gamut compare (beyond parity — chardata port, NOT `ProfileVisualize`)** — no iccDEV tool
  produces a gamut-boundary overlay; this is a chardata port we're doing anyway. Deferred to
  **P1-late**, bundled with everything that *only* serves it: (a) extend **iccviz** to emit a
  **boundary mesh + 2D slice** (today it emits only the `GamutVolume` scalar); (b) port chardata's
  **3D-mesh / 2D-slice** renderers; (c) feed their device→PCS step from **IccProfLib** (iccviz A2B/CMM
  sampling), **replacing chardata's lcms2** (`chardata-gamut.mjs`) — the heavy, gamut-only item, per the
  P1-b engine note below. The existing `GamutVolume` scalar (Analysis) already uses this IccProfLib path
  and stays.
- **IccFromCube** — new engine; `kMaxCubeBytes` (~32 MB) cap; preserve `LUT_3D_SIZE∈[2,255]`
  bound; `CIccMemIO` byte-return.
- **IccV5DspObsToV4Dsp** — new engine; 2 profiles in → 1 out; `CIccMemIO` byte-return;
  role auto-detect by class (`mntr`/RGB display vs `spac` PCC observer).
- **Image extract** — JS only, no C++: TIFF tag 34675; PNG `iCCP` (inflate + zip-bomb
  guard); JPEG `APP2` multi-marker reassembly (Group C).

### 4. Cross-cutting (per the checklist)
Per-verb WASM entry-point byte caps; 12-locale i18n + `sync-translations.mjs`; MANUAL →
`help.html`; WASM rebuild → SHA256SUMS → version bump → tag per engine change; A/B vs the
native CLI + a smoketest case.

### 5. Recommended phase-1 sequencing
1. ✅ **Pool shell** wrapping **existing** verbs only (Inspect/Dump/JSON/XML/PAWG/single-plot)
   — pure UX, **zero new C++**. Ships the workbench.
2. ✅ **Round-Trip** (DL-A1, Profile Statistics method control).
3. ✅ **Add from image** (JS extract — Group C). **DONE 2026-07-18.** `lib/embeddedProfile.js`
   pulls the embedded ICC from TIFF (IFD tag 34675), PNG (`iCCP`, native
   `DecompressionStream('deflate')` inflate + 64 MB decompression-bomb cap), and JPEG
   (`APP2` `ICC_PROFILE` multi-marker reassembly by sequence). Wired through the existing
   `fileKind.js` → `App.jsx::ingestOne` choke point (IMAGE kind now accepted; extract →
   `addIccEntry` or reject "no embedded profile"). No C++ / no WASM rebuild. Round-tripped
   byte-exact against libjpeg/libpng/libtiff (PIL) output for all three formats.
4. ✅ **New from .cube** (producer).
5. **Make V4 Display** (`V5→V4`).
6. **Gamut compare** (**P1-late · beyond parity**): iccviz boundary mesh/slice + chardata 3D/2D
   renderers + **lcms2→`CIccCmm`**. Last in phase 1 — heaviest, and the only item needing the CMM swap.

*(`SpecSepToTiff` **deferred to the canvas phase** — P1-c: gathers N image nouns → an
assembly node, a natural node-graph fit, not a phase-1 multi-select-verb fit.)*

### Open phase-1 sub-decisions (surfaced by this spec)
- **P1-a** ✅ RESOLVED — **three-zone chardata layout** (left collapsible/resizable info
  pane = pool list + drop target; centre main canvas switches single↔multi by selection;
  right settings overlay unchanged). See §1.
- **P1-b** — 🔷 **FORMS RESOLVED 2026-07-18; engine wiring still deferred within phase 1.**
  **Forms (user):** adopt chardata's **3D gamut mesh + 2D gamut slice** views, homed in the
  `Compare` tab, serving **1..N** profiles (overlay each profile's mesh/slice, distinct
  colours). chardata renders both on a **2D `<canvas>`** (no WebGL/three.js → CSP-safe, no
  heavy new dep). **Drop point/scatter plotting** — no data-point overlay; use the
  **profile-derived** boundary mesh/slice (chardata's ICC-A2B-CLUT path shape), NOT its
  `fitModel` polynomial/measurement path (consistent with **DL-SCOPE1**).
  **Engine source — deferred, but clear direction:** drive the geometry from **IccProfLib**
  (extend **iccviz**: boundary-cloud 2-skeleton triangulation + slice-hull fed by iccviz
  A2B sampling), **NOT** chardata's **lcms2**-based `chardata-gamut.mjs` — profiletool stays
  IccProfLib-only + rides the upstream path ([[iccviz-upstream-migration-plan]]). Port
  chardata's *geometry algorithm + 2D-canvas renderer*; feed with IccProfLib A2B.
  **Single-profile gamut RELOCATES to `Compare`** (user 2026-07-18) — `Compare` is the
  **sole home for gamut** (volume table + 3D/2D plots, 1..N); `Profile` shows no gamut.
  **Consequence for DL-A1:** the current Profile-Statistics table **splits** — gamut-volume
  → `Compare`; **round-trip STAYS in `Profile`** (single-profile quality, not a comparison)
  as its own per-intent table (method listbox per DL-A1). Only the iccviz mesh/slice engine
  wiring remains deferred.
- **P1-c** ✅ RESOLVED — **DEFER to the CANVAS phase (not dropped).** `SpecSepToTiff` is a
  **spectral-imaging assembly tool** (concatenates N single-wavelength TIFFs → one
  multi-sample TIFF, optional profile embed). It **gathers N image nouns**, which fits the
  node canvas naturally (N image-source nouns → assembly engine node → TIFF sink, optional
  profile input) — same "gather many nouns" shape as ICS profile chains. Not a phase-1
  multi-select-verb fit; not out of scope. TIFF-write impl TBD at canvas time (JS-side per
  Group C, or the compiled tool).
- **P1-d** ✅ RESOLVED — **info-pane type-sniff.** The single info-pane drop/browse target
  sniffs file type: ICC profiles load directly into the pool; images (TIFF/PNG/JPEG) →
  extract embedded profile → pool. No distinct entry point.
- **P1-e** ✅ RESOLVED — **per-tab accumulator + drag semantics.** Each tab has an
  **accumulator** (removable chiclets near the tabs) = its own independent profile set,
  drag-populated from the info pane. `Profile` **replaces** (1; multi-drop → last-wins);
  `Compare` & `Link` **accumulate**; multi-drag allowed into any; chiclet ✕ removes from
  the accumulator (not the pool). Resolves replace-vs-add and tab↔selection coupling: tab
  sets are **accumulator-driven, per-tab, independent** of live info-pane selection. Each
  tab needs a designed **empty state** (accumulator-empty, distinct from pool-empty).

### 6. Step-1 implementation sketch (build-ready)

**Component tree** (2.x shell; ✅ reuse · 🆕 new · ♻ absorb):
```
App (2.x shell) 🆕
├─ PoolPane (left; collapsible + resizable) 🆕
│  ├─ LoadControls — <input multiple> + drop target + type-sniff ♻ (absorbs DropZone)
│  ├─ PoolList — rows: filename + class/space/PCS/version/size badges; multi-select 🆕
│  └─ CreateVerbs — From .cube/XML/JSON · Add-from-image · Make-V4 (2-sel) 🆕 (per engine step)
├─ MainCanvas (centre; width tracks PoolPane) 🆕
│  ├─ TabBar: Profile · Compare · Link  + per-tab Accumulator chiclets 🆕
│  └─ active TabPanel:
│     ├─ ProfileTab → <ProfileViewer> ✅ (Header/Tags/Validation/Analysis/XML/JSON)
│     ├─ CompareTab → <GamutView profiles={…}> (1..N) 🆕 (P1-b)
│     └─ LinkTab → stub/placeholder 🆕 (node canvas = canvas phase)
├─ SettingsBlade (right overlay) ✅
└─ GuidePanel ✅
```

**State shape** (session-ephemeral; App-level store/context):
- `pool: Map<id,{ id, filename, bytes, meta{class,colorSpace,pcs,version,sizeBytes}, json }>`
  — `id` = profileId/content hash (dedup); `json` = full `validateProfile` output, so we
  **validate once at load** and it drives BOTH the row badges AND `ProfileViewer`.
- `selectedPoolIds: Set<id>` — info-pane highlight / drag source (transient).
- `accumulators: { Profile: id|null, Compare: id[], Link: id[] }` — per-tab sets.
- `activeTab: 'Profile'|'Compare'|'Link'`.
- `ui: { poolPaneWidth, poolPaneCollapsed }` — localStorage-persisted (chardata blade pattern).

**Data flow:** (1) load file(s) → sniff (profile vs image→extract embedded) →
`validateProfile` → derive `meta` → add to `pool` (dedup by id). (2) drag PoolList row(s) →
drop on a tab → mutate `accumulators` (Profile **replace**/multi→last; Compare/Link
**append**+dedup). (3) each tab renders from its accumulator — ProfileTab feeds the cached
`json` to `<ProfileViewer>`, CompareTab feeds N entries to `<GamutView>`. (4) chiclet ✕
removes from that accumulator; removing from pool purges it from all accumulators.

**Reuse:** `ProfileViewer` + all children, `validator.js`, `SettingsBlade`, `GuidePanel`,
`i18n`. **New:** the shell (App / PoolPane / PoolList / MainCanvas / TabBar / Accumulator /
GamutView / LinkTab). **Absorb:** `DropZone` → `LoadControls`.

**Step-1 cut (zero new C++):** PoolPane + PoolList + 3-tab shell + accumulators; ProfileTab
fully functional (`ProfileViewer`); CompareTab shows the **existing** single-profile gamut
for a 1-accumulator (full 1..N overlay = P1-b, later step); LinkTab = placeholder;
CreateVerbs deferred to their engine steps. **Ships the whole IA with no WASM change.**
