<!-- (c) 2026 William Li -->

# ICC Profile Tool — User Manual

**ICC Profile Tool** (profiletool) is a browser-based tool for inspecting, validating, and round-trip editing **ICC.1** colour profiles. It runs entirely in your browser — no upload, no install — using a WebAssembly build of [iccDEV](https://github.com/InternationalColorConsortium/iccDEV), the ICC's official demo implementation of IccProfLib.

**What you can do:**

- **Browse the header** — every field of the 128-byte profile header, decoded into human-readable strings.
- **Browse the tag directory** — every tag with its signature, type, byte offset, size, and pad bytes. Click any tag to expand a full type-specific description (the same output as the iccDEV `wxProfileDump` "Describe" view), and — for tags that carry one — an inline **visualization**: tone-response curves, chromaticity charts, CLUT and gamut images, named-colour scatters, plus a single-point **transform evaluator**.
- **Validate** — run the ICC Profile Assessment Working Group checklist (Security / Conformance / Quality), each check with a verdict, filterable by category.
- **Round-trip edit** — convert the profile to XML or JSON, edit it in the built-in code editor, convert back to ICC, and re-validate. The save button downloads the edited binary.
- **Chain profiles** — in the **Combine** tab, drag pooled profiles into an ordered chain, then bake it into a **DeviceLink**, **transform an image** through it (with full control over output encoding, compression, planar layout and ICC embedding), or **transform a colour dataset**.
- **Launch from chardata** — open a profile that's loaded in [chardata](https://chardata.colourbill.com/) directly here, with the bytes handed over in-browser via `postMessage`.
- **Launch with a URL** — open a link that points the tool at a profile hosted on the web and, optionally, the tab to land on (e.g. `…/profiletool#url=…&tab=VAL`).

Everything runs client-side. Profile bytes never leave the browser tab.

---

## Contents

1. [The workspace](#1-the-workspace)
2. [Settings panel](#2-settings-panel)
3. [Profile views](#3-profile-views)
   - [Header](#3-1-header)
   - [Tags](#3-2-tags)
   - [Validation](#3-3-validation)
   - [Analysis](#3-4-analysis)
   - [XML](#3-5-xml)
   - [JSON](#3-6-json)
4. [Combine tab](#4-combine-tab)
   - [Building a chain](#4-1-building-a-chain)
   - [Make DeviceLink](#4-2-make-devicelink)
   - [Transform Image](#4-3-transform-image)
   - [Transform Data](#4-4-transform-data)
   - [Observer Change](#4-5-observer-change)
   - [Compare and Spectral tabs](#4-6-compare-and-spectral-tabs)
5. [Round-trip editing](#5-round-trip-editing)
6. [Launching from chardata](#6-launching-from-chardata)
7. [Launching with a URL](#7-launching-with-a-url)
8. [Mobile](#8-mobile)
9. [Limits and security](#9-limits-and-security)

---

## 1. The workspace

profiletool is a **multi-profile workbench**. The window has three parts:

- the **Profiles** pane down the left — the *pool* of everything you've loaded;
- the **canvas** on the right, with four tabs across the top — **Profile**, **Compare**, **Combine**, **Spectral**;
- the **Settings** blade on the right edge (see [Settings panel](#2-settings-panel)).

### Loading profiles

Load files in either of two ways:

- Click **Load Profiles** at the top of the Profiles pane and pick one or more files, or
- **Drag and drop** files onto the Profiles pane.

You can load `.icc` / `.icm` profiles *and* images — drop a TIFF, PNG or JPEG and the tool extracts its **embedded ICC profile** (reading only the file's metadata, never the pixels) and adds that to the pool. A **＋ New from .cube** button builds a DeviceLink from a `.cube` LUT.

A profile is accepted if its first 36 bytes contain the `acsp` signature and it parses through IccProfLib's `ValidateIccProfile`. Files that fail are listed in a rejection summary with the specific reason; their bytes are not retained.

### The Profiles pane

Loaded profiles are grouped into collapsible sections by **profile class** (Input, Display, Output, DeviceLink, ColorSpace, Abstract, Named Color, …). Each row shows the filename and badges for class, colour space, version and size; a profile that could only be partially parsed is flagged. Use the **A–Z** button to cycle the sort (load order → ascending → descending), the **×** on a row to remove it, and the handle on the pane's right edge to resize it — or collapse the pane entirely.

Click to select a row; Ctrl/Cmd-click to toggle and Shift-click to select a range. **Drag rows out of the pool onto a tab** to put them to work.

<div class="note">
<strong>The pool is session-only.</strong> Nothing is uploaded and nothing is persisted — your filesystem stays the durable store. Reloading the page empties the pool.
</div>

### The four tabs

| Tab | What it does |
|---|---|
| **Profile** | Inspects **one** profile — header, tags, validation, analysis, XML, JSON. Dropping a new profile here replaces the current one. |
| **Compare** | Overlays the gamuts of **two or more** profiles. |
| **Combine** | Chains profiles into a DeviceLink, or transforms an image / dataset through them. |
| **Spectral** | Assembles single-channel spectral images into one multi-channel TIFF. |

Each tab keeps its own set of profiles, shown as removable chips beneath the tab strip, with a count badge on the tab itself. The first profile you load opens automatically in the **Profile** tab; after that, drag from the pool onto whichever tab you want. Dropping files straight onto a tab loads them into the pool *and* places them on that tab in one action.

<div class="note">
<strong>Size limit:</strong> the loader rejects anything larger than 256 MB. Real profiles are normally well under 10 MB; the cap exists only to prevent a hostile drop or postMessage from exhausting the tab's WASM heap.
</div>

---

## 2. Settings panel

Open Settings by clicking the **⚙** button on the right edge of the screen (or the gear icon at the top-right on mobile). The panel slides over the content without resizing it.

Two more buttons sit below ⚙:

- **?** opens this guide **inside the app**, as a pane that slides in over the window. It has a search box in its header — type to highlight matches, then use `Enter` / `Shift+Enter` (or the `˄` `˅` buttons) to step through them; `Escape` clears the search, and a second `Escape` closes the pane.
- **✉** opens the contact form on colourbill.com in a new browser tab.

The panel exposes the **Display** group:

### Background

Switches the app between **Light**, **Dark**, and **System** (follows the OS preference) themes. The choice persists across sessions. In **System** mode the app subscribes to `prefers-color-scheme` and flips automatically when the OS theme changes; choosing Light or Dark explicitly detaches that listener.

### Number format

Chooses how numeric values are displayed throughout the profile views — **Hexadecimal** or **Decimal**.

### Language

Overrides the interface language. **System default (…)** detects the browser locale and uses the closest supported language, with the native name in the parenthetical so you can see which it picked. Translation covers the app chrome (the Profiles pane, tab labels, the Combine and Spectral tools, settings panel and this guide's chrome). Strings produced by IccProfLib — tag descriptions, validation messages, header field names — are emitted by the C++ library in English and are not translated.

Supported languages: English, Français, Deutsch, Italiano, Español, Português (PT), Português (BR), Svenska, 中文（简体）, 中文（繁體）, 日本語, 한국어. The chardata Settings panel offers the same set, so toggling Language in one app gives a consistent reading experience in the other.

---

## 3. Profile views

Drag a profile from the pool onto the **Profile** tab to inspect it. The tab shows a bar with the filename and a **Save profile** button (plus a *● Modified — unsaved edits* pill once you've edited it), and below that the viewer: a title bar (filename · size in bytes · IccProfLib version · validity badge) and its own tab strip.

The badge summarises the **Validation** report: green **Pass** when no check fails or warns, amber **Warning** when at least one check warns, red **Fail** when any check fails.

<div class="note">
<strong>Partially-parsed profiles:</strong> if a profile is damaged enough that the validator can only read it structurally, a warning banner appears and only the <strong>Header</strong> and <strong>Tags</strong> tabs are available — Validation, Analysis, XML and JSON are hidden, because the profile must not be applied.
</div>

### 3.1 Header

A two-column table of every field in the ICC profile's 128-byte binary header. Values are decoded into human-readable strings (signatures expanded, dates formatted, fixed-point values converted) using IccProfLib's `CIccInfo`. The **profile ID** (MD5 hash from the header) is shown in a highlighted strip at the top.

### 3.2 Tags

A six-column grid of every tag in the profile's tag directory:

| Column | Meaning |
|---|---|
| `#` | Position in the directory (1-based) |
| `Name` | Long human-readable name (e.g. `profileDescriptionTag`) |
| `ID` | 4-character signature (e.g. `desc`) |
| `Type` | Tag type signature (e.g. `descType`, `mft2`, `mAB`) |
| `Offset` | Byte offset from the start of the file |
| `Size` | Byte size of the tag data |
| `Pad` | Padding bytes between this tag and the next |

Tags are sorted by offset. The **Pad** column is colour-coded — `Pad < 0` (overlapping tags, non-compliant) is shown in red; `Pad > 3` (above-spec padding) is shown in amber.

**Click any row** to expand it in place (an accordion — one tag open at a time). The expanded detail always ends with the full type-specific description — equivalent to running IccProfLib's `CIccTag::Describe(verbosity = 100)`. For tags that contain large CLUTs or curves (e.g. `A2B0`, `B2A0`), this includes every grid cell or curve point.

Above that description, tags that carry visualizable data show one or more **inline visualizations**, each in a collapsible section:

| Tag type | Visualizations |
|---|---|
| Tone curves (`rTRC`/`gTRC`/`bTRC`/`kTRC`) | The tone-response curve plotted against the identity line; the curve table is collapsed below it. |
| RGB colorants (`rXYZ`/`gXYZ`/`bXYZ`) and white point (`wtpt`) | A CIE 1931 chromaticity chart with the relevant primary (or the white point) highlighted; the colorant/white-point data is shown beneath. |
| LUT transforms (`A2B0–3`, `B2A0–3`, `gamt`, `pre0–2`) | Input-side and output-side tone curves (overlaid, colour-coded per colorant, with a legend to toggle traces); the CLUT lattice as an image; the **gamut image** (for the profile's `gamutTag`, colour-coded — neutral = in gamut, red = out of gamut); the **evaluator** (below); and the raw data table, collapsed. |
| Named / colorant tables (`ncl2`/`nmcl`/`clrt`/`clot`) | A scatter of the colours on the CIELAB a\*b\* (and CIE xy) charts; the tables are collapsed below. |

<div class="note">
<strong>Malformed data is never hidden.</strong> If a curve or other visualizable element fails IccProfLib's validation — for example a tone curve with a degenerate gamma of 0 — the section still renders what it can and shows a ⚠ warning with the exact reason from the library, rather than silently omitting the graph.
</div>

#### The transform evaluator

For LUT transforms (`A2B*` / `B2A*` / preview tags) the **Evaluate** section applies that specific tag's transform to a single colour you supply, using IccProfLib directly — no external colour engine. The direction follows the tag (`A2B*` maps device → PCS; `B2A*` maps PCS → device), and the rendering intent is implied by the tag (`…0` perceptual, `…1` relative colorimetric, `…2` saturation).

- Enter input either as **floating-point** values (device channels, or PCS in human Lab/XYZ units) or, when the tag has a CLUT, by **grid-point** index (a node position on the lattice).
- The output is shown in **both** the internal normalized 0–1 encoding and human units (Lab/XYZ for a PCS result).

The gamut tag (`gamt`) has no evaluator — it is a one-channel in/out-of-gamut map rather than an invertible transform; its gamut image is shown instead.

### 3.3 Validation

Runs the **ICC Profile Assessment Working Group** checklist against the loaded profile and shows it as a report. The checks come from the iccDEV `iccPawgReport` tool, compiled to a separate WebAssembly module that's fetched only when you first open this tab. (The same report drives the validity badge in the title bar, and is reachable from a URL launch as either `VAL` or the legacy `PAWG`.)

Each check is grouped under **Security**, **Conformance**, or **Quality**, and carries one verdict:

| Verdict | Meaning |
|---|---|
| **Pass** | The check succeeded |
| **Warn** | A non-fatal concern worth reviewing |
| **Fail** | The profile does not satisfy the check |
| **Gap** | The check could not be fully evaluated (e.g. not yet implemented) |
| **N/A** | The check does not apply to this profile |
| **Not Run** | The check was skipped |

The summary row at the top tallies each verdict as a coloured pill. **Click a pill to filter** the report below — a blue halo marks the categories currently shown, and pills with zero items are inactive. For example, switch off **Pass** and **N/A** to focus on just the Warns and Fails.

### 3.4 Analysis

Whole-profile quality analyses derived from the profile's colour transforms — computed by a dedicated WebAssembly module (the iccDEV visualization engine) that's fetched only when you first open this tab, and plotted in the app's own style. Each analysis is a collapsible section; one that doesn't apply to the loaded profile shows a short *not applicable* note instead (for example, a matrix/TRC display profile has no device↔PCS CLUTs to analyse).

#### Profile Statistics

Per rendering intent, two whole-profile metrics computed from the device↔PCS lookup tables:

- **Gamut volume** — the volume (in ΔE\*ab³) enclosed by the device → PCS (`A2B`) transform, measured by voxelising the gamut boundary and counting the enclosed cells. A robust estimate of how much colour the profile can reproduce.
- **Round-trip ΔE** — how accurately the `B2A` (PCS → device) table inverts the `A2B`: in-gamut Lab values are pushed Lab → device → Lab and the error is reported as **mean**, **P90**, and **max** ΔE\*ab.

One row per intent (Perceptual, Relative Colorimetric, Saturation, Absolute Colorimetric); intents whose tags are absent are omitted.

#### Round-Trip (PRMG)

The full round-trip report, matching the iccDEV `iccRoundTrip` reference tool exactly. Where the Profile Statistics row above gives a quick single-direction summary, this section runs the reference metric: it seeds from the **device colour cube** and reports **both** round-trip directions plus a Perceptual Reference Medium Gamut (PRMG) interoperability histogram.

- **Round Trip 1** — the device → PCS → device error: ΔE\*ab between each device colour's Lab and its Lab after one round trip. Reported as **min**, **mean**, **max**, plus the worst-case `L, a, b`.
- **Round Trip 2** — the PCS round-trip stability: ΔE\*ab between the first and second round trip, again with min / mean / max and worst-case `L, a, b`.
- **PRMG interoperability** — the count and share of samples whose round-trip ΔE falls within **1, 2, 3, 5, and 10**, and whether the profile implies the Perceptual Reference Medium Gamut.

Two controls drive it: a **rendering intent** selector (Perceptual / Relative / Saturation / Absolute) and a **Use MPE (color) tags** checkbox (off = the colorimetric lookup tables; on = the multi-processing-element / color tags). Results are computed on demand when you open the section and cached per intent and MPE setting. A profile that can't be round-tripped — one lacking the device↔PCS transforms this metric needs — shows a *not applicable* note; a device space too wide to sample is reported as skipped rather than as an error.

#### Neutral Axis Inking

Sweeps the neutral axis (a\*=b\*=0) from white (L\*=100) down to black (L\*=0) through the profile's `B2A` (PCS → device) table and plots how much of each device colorant the profile lays down along the way — the classic GCR / neutral-build curve. One curve per device channel, colour-coded per colorant. **Output (printer) profiles only**; other profile classes show a note.

### 3.5 XML

Converts the profile to XML (via IccLibXML, the same writer the iccDEV `iccToXml` CLI uses) and shows it in a CodeMirror editor with syntax highlighting. Edit the XML and click **Convert to ICC** to round-trip back to binary; the viewer re-validates and the **Save profile** button in the Profile-tab bar downloads the result.

A **dirty** indicator shows when the editor text differs from the last converter output, so you can tell at a glance whether your edits have been applied. If conversion fails, IccLibXML's parse error is shown above the editor with the offending line / column.

### 3.6 JSON

Same idea as the XML tab but using a JSON representation of the profile produced by the validator wrapper (`json-wrapper.cpp`). Edit, click **Convert to ICC**, save. The JSON form is more compact and easier to script against; the XML form is more familiar if you've used the iccDEV CLI tools.

---

## 4. Combine tab

profiletool keeps every loaded profile in a **Profile Pool** on the left. Across the top are four tabs — **Profile** (the single-profile viewer above), **Compare**, **Combine**, and **Spectral**. The **Combine** tab is where you chain profiles together and put them to work: build a **DeviceLink**, **transform an image**, or **transform a colour dataset** through the chain.

### 4.1 Building a chain

Drag one or more profiles from the pool into the Combine card to add them to the chain, in order. The chain is a **vertical stack**: the source is at the top, the sink at the bottom. Each profile contributes **one transform**, and the tool shows the colour space entering and leaving it (e.g. `RGB → Lab`), with the **connecting space** labelled on the line between stages. The engine validates the whole chain live and reports the end-to-end flow (e.g. *Chain: RGB → CMYK*) or explains, per stage, where it fails to connect.

- **Reorder** a stage by dragging its grip (`⠿`) or with the ▲ / ▼ buttons; remove one with ×.
- **Flip direction** — the head transform's ⇅ button reverses the chain's direction, rippling through the following stages.
- **Rendering intent** — pick one for the whole chain with *Rendering intent (all)*, or override any single stage with its own listbox. Hover either control for a description of the selected intent. Beyond the four base intents, a profile that carries the necessary tables also offers the *no D2Bx/B2Dx* and *+ BPC* (black-point compensation) variants.

### 4.2 Make DeviceLink

Bakes the whole chain into a single **DeviceLink** profile (an in-browser port of iccDEV's `iccApplyToLink`). Name it and click **Make DeviceLink**; the result lands in the pool and the Combine accumulator like any other profile, ready to inspect on the Profile tab or reuse in another chain.

### 4.3 Transform Image

Drop one raster image (TIFF, PNG or JPEG) into the image slot and click **Transform Image** to run it through the chain (an in-browser port of `iccApplyProfiles`). The image is validated by a header-only probe first — its colour space must match the chain's input. The result **downloads**; images are never stored in the pool.

When a valid image is loaded, an **Image output options** panel appears with the destination knobs that mirror the `iccApplyProfiles` CLI:

- **Encoding** — *Same as source*, 8-bit, 16-bit, or **Float (32-bit)**.
- **Compression** — None, **LZW**, or **ZIP** (Deflate).
- **Planar** — **Composite** (chunky) or **Separated** planes.
- **CMM interpolation** — **Tetrahedral** or **Linear**.
- **Embed ICC** — tag the output with the chain's last (output-space) profile.

The friendly default keeps RGB/Gray output as a PNG; choosing a TIFF-only knob (float, LZW/ZIP, or separated planes) switches the container to TIFF.

<div class="note">
<strong>Embedded profiles:</strong> if the dropped image carries its own embedded ICC profile, a banner offers to <strong>extract</strong> it — the profile is added to the pool and placed at the head of the chain (its source space) in one click.
</div>

### 4.4 Transform Data

Drop a colour dataset (CGATS/IT8, CSV, CxF, or JSON) into the data slot and click **Transform Data** to run every patch through the chain (the `iccApplyNamedCmm` equivalent). The tool reads the dataset's kinds (device / Lab / XYZ / spectral) and feeds whichever the chain's input needs; a **spectral** input is converted to colorimetry with iccDEV's canonical calculator, using the **Observer** and **Illuminant** you choose. Duplicate patches can be filtered (median or mean). The result opens in a table you can **Save** as CSV.

### 4.5 Observer Change

The Combine tab holds **two** maker cards. Above the Link Pipeline, the **Observer Change** card builds a v4.3 matrix/TRC display profile from a V5 RGB display profile plus a V5 observer (PCC) profile. Drag both onto the card — they are routed automatically into the **V5 RGB display** and **V5 observer (PCC)** slots by profile class — then click **Make V4 Display Profile**, name it, and click **Create**. The result joins the pool and this tab. A profile that is neither is ignored with a warning.

### 4.6 Compare and Spectral tabs

The **Compare** tab overlays the gamut boundaries of two or more pooled profiles — a 3-D shell plus a 2-D lightness slice — to see where they differ. The **Spectral** tab assembles a set of single-channel spectral images (dropped in channel order) into one multi-channel TIFF (`iccSpecSepToTiff`).

---

## 5. Round-trip editing

Both the XML and JSON tabs can write the profile back to ICC binary. The typical workflow:

1. **Load** an ICC profile.
2. Open the **XML** or **JSON** tab. Click **Convert to XML** / **Convert to JSON** to populate the editor.
3. **Edit** in the in-page editor. A dirty indicator appears next to the toolbar.
4. Click **Convert to ICC**. The wrapper builds a new profile, re-runs validation, and updates the Header / Tags / Validation tabs.
5. A **● Modified — unsaved edits** pill appears next to the filename in the Profile-tab bar.
6. Click **Save profile**. The edited bytes are downloaded as `<original>-edited.icc`.

Both editors are independent — editing XML then editing JSON doesn't mix the two paths. The most recently produced ICC bytes are what gets saved.

<div class="note">
<strong>Caveat:</strong> conversion fidelity depends on what IccLibXML / the JSON wrapper supports for each tag type. If a tag type isn't representable, the round-trip will lose detail; check the Validation tab after the convert-back to confirm everything still parses cleanly.
</div>

The Tags tab highlights any tag whose bytes differ from the original load, so it's easy to see what your edits changed.

---

## 6. Launching from chardata

In **chardata**, after loading an ICC profile, click **Display File** to open the in-page viewer, then click **Launch editor**. A new tab opens here with `?source=chardata` in the URL.

The handover works entirely in-browser:

1. profiletool opens, detects `?source=chardata`, and sends `{type:'profiletool:ready'}` to `window.opener` via `postMessage`.
2. chardata replies with `{type:'profiletool:load', filename, bytes}`.
3. profiletool accepts the bytes (after verifying the sender's origin against an allowlist and the size against the 256 MB cap), runs validation, and shows the profile.

No upload, no server round-trip. The flow is one-way — edits made here are saved by clicking **Save profile**, not handed back to chardata.

---

## 7. Launching with a URL

You can open the tool with a link that names a profile to load — and the tab to land on — using a **URL fragment** (the part after `#`):

```
https://chardata.colourbill.com/profiletool#url=<profile-url>&tab=<tab>
```

Both parameters are optional:

- **`url=`** — the web address the profile is fetched from. The bytes are downloaded in your browser and then run through exactly the same path as a local file: the `acsp` header check, full `ValidateIccProfile`, the 256 MB size cap, and the best-effort fallback for unparseable profiles. Nothing is uploaded — the fetched bytes only feed the validator and are never re-sent.
- **`tab=`** — which view to open once the profile has loaded.

A complete example:

```
https://chardata.colourbill.com/profiletool#url=https://example.org/profiles/sRGB.icc&tab=VAL
```

<div class="note">
<strong>Why a fragment, not a query string?</strong> The part after <code>#</code> is never sent to a web server, so the address of the profile you are inspecting stays on your own machine.
</div>

### Tab names

`tab=` accepts two interchangeable, case-insensitive naming schemes. The **short** codes are the preferred form:

| View | Short code | Long name |
|---|---|---|
| Header | `HEADER` | `Header` |
| Tags | `TAGS` | `Tags` |
| Validation | `VAL` | `Validation` |
| Analysis | `ANALYSIS` | `Analysis` |
| XML | `XML` | `XML` |
| JSON | `JSON` | `JSON` |

The long names are the on-screen tab labels with the spaces removed. Both schemes are kept stable even if the visible labels are renamed, so existing links keep working. The Validation tab also answers to the legacy code `PAWG` (it was formerly labelled "Profile Assessment WG"). An unrecognised `tab=` value is ignored and the Header view opens.

<div class="note">
<strong>Requirements for <code>url=</code>:</strong> the profile must be served over <strong>HTTPS</strong>, and the hosting server must allow cross-origin reads (a permissive <code>Access-Control-Allow-Origin</code> / CORS header). If either is missing the browser blocks the download and the tool shows a fetch error. If the profile URL itself contains <code>&</code> or <code>#</code> (its own query string), percent-encode the whole <code>url=</code> value so those characters don't terminate the fragment early.
</div>

---

## 8. Mobile

On screens narrower than 700 px:

- The Settings panel collapses into a slide-in drawer from the right.
- A **⚙** floating button at the top-right opens / closes Settings.
- A **?** button below ⚙ opens this guide in its slide-in pane.
- A **✉** button opens the contact form in a new browser tab.
- Tapping the dimmed backdrop closes the open drawer.
- The tag table reflows from a wide grid into stacked cards so every column stays readable without horizontal scrolling.
- The tag detail modal goes full-screen.

All features are available; the layout adapts to the smaller screen.

---

## 9. Limits and security

profiletool makes no network requests after the initial page load. The validator, the XML converter, and the JSON converter are all WebAssembly compiled from iccDEV C++ sources and run entirely client-side.

| Limit | Where | Notes |
|---|---|---|
| **256 MB** | postMessage / drop-zone load | Refuses to load anything larger; prevents heap exhaustion from a hostile opener |
| **32 MB** | XML and JSON converters | Both the JS guard (`MAX_XML_BYTES` / `MAX_JSON_BYTES`) and the C++ wrappers (`kMaxXmlBytes` / `kMaxJsonBytes`) enforce this; the C++ side is independently authoritative |
| **XML entity-bomb guard** | XML converter | Any XML containing `<!DOCTYPE` or `<!ENTITY` is rejected before libxml2 sees it (defence against billion-laughs since IccLibXML enables `XML_PARSE_HUGE`) |
| **Origin allowlist** | postMessage launch | Only same-origin and chardata's dev-host origins can send `profiletool:load` bytes |
| **HTTPS + CORS** | `#url=` launch | A URL-launch profile must be served over HTTPS from a host that permits cross-origin reads; the fetched bytes feed only the validator and are never re-sent |

The `#url=` launch (added in 1.1.5) is the one case where the tool makes an off-origin request after page load: it widens the Content-Security-Policy `connect-src` to `https:` so the named profile can be fetched. Script loading is **not** widened — only data fetches.

If you need to inspect a profile that exceeds these limits, build iccDEV from source and use the native CLI tools — those have no JS-side caps.
