# ICC Profile Tool — User Manual

**ICC Profile Tool** (icctools) is a browser-based tool for inspecting, validating, and round-trip editing **ICC.1** colour profiles. It runs entirely in your browser — no upload, no install — using a WebAssembly build of [iccDEV](https://github.com/InternationalColorConsortium/iccDEV), the ICC's official reference implementation of IccProfLib.

**What you can do:**

- **Validate** an ICC profile against the ICC.1 specification — see the severity (valid / warning / error) and every diagnostic message produced by IccProfLib.
- **Browse the header** — every field of the 128-byte profile header, decoded into human-readable strings.
- **Browse the tag directory** — every tag with its signature, type, byte offset, size, and pad bytes. Click any tag to open a full type-specific description (the same output as the iccDEV `wxProfileDump` "Describe" view).
- **Round-trip edit** — convert the profile to XML or JSON, edit it in the built-in code editor, convert back to ICC, and re-validate. The save button downloads the edited binary.
- **Launch from chardata** — open a profile that's loaded in [chardata](https://chardata.colourbill.com/) directly here, with the bytes handed over in-browser via `postMessage`.

Everything runs client-side. Profile bytes never leave the browser tab.

---

## Contents

1. [Loading a profile](#1-loading-a-profile)
2. [Settings panel](#2-settings-panel)
3. [Profile views](#3-profile-views)
   - [Header](#3-1-header)
   - [Tags](#3-2-tags)
   - [Validation](#3-3-validation)
   - [Raw Output](#3-4-raw-output)
   - [XML](#3-5-xml)
   - [JSON](#3-6-json)
4. [Round-trip editing](#4-round-trip-editing)
5. [Launching from chardata](#5-launching-from-chardata)
6. [Mobile](#6-mobile)
7. [Limits and security](#7-limits-and-security)

---

## 1. Loading a profile

When the app first opens, the centre of the page shows a drop zone.

- **Drag and drop** an `.icc` or `.icm` file onto the drop zone, or
- Click **Choose file** and pick one from the file system.

Once a profile loads, the drop zone is replaced by a toolbar with **Load another** and **Save ICC profile** buttons, followed by a tabbed viewer.

A profile is accepted if its first 36 bytes contain the `acsp` signature and it parses through IccProfLib's `ValidateIccProfile`. Files that fail header parsing are rejected with the specific IccProfLib error message; bytes are not retained.

<div class="note">
<strong>Size limit:</strong> the loader rejects anything larger than 256 MB. Real profiles are normally well under 10 MB; the cap exists only to prevent a hostile drop or postMessage from exhausting the tab's WASM heap.
</div>

---

## 2. Settings panel

Open Settings by clicking the **⚙** button on the right edge of the screen (or the gear icon at the top-right on mobile). The panel slides over the content without resizing it. A **?** button below ⚙ opens this help page in a new tab; a **✉** button opens the contact form.

The panel currently exposes the **Display** group:

### Background

Switches the app between **Light**, **Dark**, and **System** (follows the OS preference) themes. The choice persists across sessions. In **System** mode the app subscribes to `prefers-color-scheme` and flips automatically when the OS theme changes; choosing Light or Dark explicitly detaches that listener.

### Language

Overrides the interface language. **System default (…)** detects the browser locale and uses the closest supported language, with the native name in the parenthetical so you can see which it picked. Translation covers the app chrome (heading, banner, drop zone, save toolbar, tab labels, settings panel). Strings produced by IccProfLib — tag descriptions, validation messages, header field names — are emitted by the C++ library in English and are not translated.

Supported languages: English, Français, Deutsch, Italiano, Español, Português (PT), Português (BR), Svenska, 中文（简体）, 中文（繁體）, 日本語, 한국어. The chardata Settings panel offers the same set, so toggling Language in one app gives a consistent reading experience in the other.

---

## 3. Profile views

Once a profile is loaded the viewer shows a title bar (filename · size · IccProfLib version · validity badge) and a tab strip. The badge colour summarises validation: green = valid, amber = warning, red = error.

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

**Click any row** to open a modal showing the full type-specific description for that tag — equivalent to running IccProfLib's `CIccTag::Describe(verbosity = 100)`. For tags that contain large CLUTs or curves (e.g. `A2B0`, `B2A0`), this includes every grid cell or curve point.

### 3.3 Validation

The status card at the top summarises the overall result:

- **Valid** — `ValidateIccProfile` returned `icValidateOK`
- **Warning** — at least one warning, no errors
- **Error** — at least one error (including critical errors)
- **Unknown** — IccProfLib couldn't classify the result

Below the card, every message returned by IccProfLib is listed as a bullet. The text is verbatim from IccProfLib so you can match it against the iccDEV source.

### 3.4 Raw Output

The complete JSON object produced by the validator wrapper — header, tags, validation, profile ID, sizes, library version. Useful when copy-pasting into a bug report or diffing two profiles textually.

### 3.5 XML

Converts the profile to XML (via IccLibXML, the same writer the iccDEV `iccToXml` CLI uses) and shows it in a CodeMirror editor with syntax highlighting. Edit the XML and click **Convert to ICC** to round-trip back to binary; the viewer re-validates and the **Save ICC profile** button downloads the result.

A **dirty** indicator shows when the editor text differs from the last converter output, so you can tell at a glance whether your edits have been applied. If conversion fails, IccLibXML's parse error is shown above the editor with the offending line / column.

### 3.6 JSON

Same idea as the XML tab but using a JSON representation of the profile produced by the validator wrapper (`json-wrapper.cpp`). Edit, click **Convert to ICC**, save. The JSON form is more compact and easier to script against; the XML form is more familiar if you've used the iccDEV CLI tools.

---

## 4. Round-trip editing

Both the XML and JSON tabs can write the profile back to ICC binary. The typical workflow:

1. **Load** an ICC profile.
2. Open the **XML** or **JSON** tab. Click **Convert to XML** / **Convert to JSON** to populate the editor.
3. **Edit** in the in-page editor. A dirty indicator appears next to the toolbar.
4. Click **Convert to ICC**. The wrapper builds a new profile, re-runs validation, and updates the Header / Tags / Validation tabs.
5. A **● Modified — unsaved edits** pill appears in the top toolbar.
6. Click **Save ICC profile**. The edited bytes are downloaded as `<original>-edited.icc`.

Both editors are independent — editing XML then editing JSON doesn't mix the two paths. The most recently produced ICC bytes are what gets saved.

<div class="note">
<strong>Caveat:</strong> conversion fidelity depends on what IccLibXML / the JSON wrapper supports for each tag type. If a tag type isn't representable, the round-trip will lose detail; check the Validation tab after the convert-back to confirm everything still parses cleanly.
</div>

The Tags tab highlights any tag whose bytes differ from the original load, so it's easy to see what your edits changed.

---

## 5. Launching from chardata

In **chardata**, after loading an ICC profile, click **Display File** to open the in-page viewer, then click **Launch editor**. A new tab opens here with `?source=chardata` in the URL.

The handover works entirely in-browser:

1. icctools opens, detects `?source=chardata`, and sends `{type:'icctools:ready'}` to `window.opener` via `postMessage`.
2. chardata replies with `{type:'icctools:load', filename, bytes}`.
3. icctools accepts the bytes (after verifying the sender's origin against an allowlist and the size against the 256 MB cap), runs validation, and shows the profile.

No upload, no server round-trip. The flow is one-way — edits made here are saved by clicking **Save ICC profile**, not handed back to chardata.

---

## 6. Mobile

On screens narrower than 700 px:

- The Settings panel collapses into a slide-in drawer from the right.
- A **⚙** floating button at the top-right opens / closes Settings.
- A **?** button below ⚙ opens this help page.
- A **✉** button opens the contact form.
- Tapping the dimmed backdrop closes the open drawer.
- The tag table reflows from a wide grid into stacked cards so every column stays readable without horizontal scrolling.
- The tag detail modal goes full-screen.

All features are available; the layout adapts to the smaller screen.

---

## 7. Limits and security

icctools makes no network requests after the initial page load. The validator, the XML converter, and the JSON converter are all WebAssembly compiled from iccDEV C++ sources and run entirely client-side.

| Limit | Where | Notes |
|---|---|---|
| **256 MB** | postMessage / drop-zone load | Refuses to load anything larger; prevents heap exhaustion from a hostile opener |
| **32 MB** | XML and JSON converters | Both the JS guard (`MAX_XML_BYTES` / `MAX_JSON_BYTES`) and the C++ wrappers (`kMaxXmlBytes` / `kMaxJsonBytes`) enforce this; the C++ side is independently authoritative |
| **XML entity-bomb guard** | XML converter | Any XML containing `<!DOCTYPE` or `<!ENTITY` is rejected before libxml2 sees it (defence against billion-laughs since IccLibXML enables `XML_PARSE_HUGE`) |
| **Origin allowlist** | postMessage launch | Only same-origin and chardata's dev-host origins can send `icctools:load` bytes |

If you need to inspect a profile that exceeds these limits, build iccDEV from source and use the native CLI tools — those have no JS-side caps.
