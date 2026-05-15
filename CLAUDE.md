# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

icctools is a web-based ICC profile validation tool that wraps the [iccDEV](https://github.com/InternationalColorConsortium/iccDEV) C++ reference implementation. Validation runs **entirely client-side** via a WASM build of IccProfLib — there is no backend service. The iccDEV source is expected at `/home/colour/code/iccdev` and must **not** be modified.

## Layout

| Path | Contents |
|------|----------|
| `frontend/` | Vite + React SPA (port 5173 in dev). Loads the WASM module from `public/wasm/` and runs `validateProfile(bytes) → JSON` in the browser. |
| `validator-wasm/` | Emscripten project: `wrapper.cpp` + a standalone `CMakeLists.txt` that compiles IccProfLib sources directly (bypassing iccDEV's top-level CMake). Produces `iccprofiledump.{mjs,wasm}`. |
| `scripts/build-wasm.sh` | Rebuilds the WASM, copies artifacts into `frontend/public/wasm/`, refreshes `SHA256SUMS`. Pass `--verify` to check the committed artifacts still match source. |
| `MANUAL.md` + `scripts/generate-help.js` | User-facing help source + generator. Produces `frontend/public/help.html` (served at `/help.html` in dev, `/profiletool/help.html` in prod). Edit `MANUAL.md`, run `node scripts/generate-help.js`. |
| `hooks/pre-commit` | Auto-regenerates `help.html` when `MANUAL.md` or the generator is staged; rejects hand edits to `help.html`. Activate with `git config core.hooksPath hooks` after a fresh clone. |

Both packages use ES modules (`"type": "module"`).

## Dev commands

```bash
# frontend only — validation runs in the browser
cd frontend
npm install          # first time
npm run dev          # http://localhost:5173
npm run build        # production build → frontend/dist/

# rebuild the WASM module after editing wrapper.cpp or pulling iccDEV changes
source ~/emsdk-install/emsdk/emsdk_env.sh
scripts/build-wasm.sh
```

## validator-wasm details

`wrapper.cpp` exports one embind function:

```cpp
std::string validateProfile(emscripten::val bytes);   // returns JSON
```

JS side wraps that as `validateProfile(file)` in `frontend/src/lib/validator.js` — lazy-loads the module, fetches the `.mjs` glue, instantiates via a blob URL (to sidestep Vite's `/public` import rule), and passes `file.arrayBuffer()` bytes.

### Key IccProfLib APIs used

| API | Purpose |
|-----|---------|
| `ValidateIccProfile(pMem, nSize, report, status)` | Memory-buffer overload — avoids any filesystem use in WASM |
| `pProfile->m_Header` | `icHeader` struct — all 128-byte header fields |
| `pProfile->m_Tags` | `TagEntryList` — iterate for tag directory |
| `CIccTag::Describe(str, verboseness=100)` | Full human-readable tag dump (same as `wxProfileDump`) |
| `CIccInfo` | Converts signatures/enums to human-readable strings |
| `icFtoD`, `icF16toF` | Fixed-point / half-float converters for header fields |

### JSON output shape

```jsonc
{
  "libraryVersion": "2.3.1.7",
  "profileId": "9efa8dc6...",
  "sizeBytes": 488,
  "sizeBytesHex": "1e8",
  "header": { "Attributes": "...", "Data Color Space": "...", ... },
  "tags": [{ "name": "profileDescriptionTag", "id": "desc", "type": "descType",
             "isArrayType": false, "description": "<full Describe() text>",
             "offset": 240, "size": 120, "pad": 0 }, ...],
  "validation": { "level": "valid|warning|error|unknown",
                  "status": "Profile is valid",
                  "messages": ["..."] }
}
```

Tags are sorted by `offset`. `pad < 0` means overlapping tags (non-compliant); `pad > 3` is a warning. The `description` field drives the tag-detail modal in the UI.

## Frontend component hierarchy

```
App.jsx                  — preloads WASM, orchestrates validation, top-level error/loading state
└── DropZone.jsx         — drag-and-drop + <input type=file>; calls onFile(File)
└── ProfileViewer.jsx    — tabbed shell (Header / Tags / Validation / Raw Output)
│   ├── HeaderTable.jsx  — renders header{} as a key/value table
│   ├── TagTable.jsx     — renders tags[] with pad colouring; rows open the modal
│   ├── ValidationPanel.jsx — status card + messages list
│   └── TagDetailModal.jsx — signature + type + offset + size + Describe() text
└── SettingsBlade.jsx    — right-side slide-out panel (Background + Language)
```

Each component has a co-located `*.module.css` file. Global tokens (colours, fonts) are CSS custom properties in `src/index.css`. The visual identity matches chardata (Arial on `#f0f2f5` blue-grey, blue `#4a90e2` accent, rounded white card with light shadow, gradient `.btn-primary` buttons) so users moving between the two apps see a consistent look. When tweaking colours, edit the CSS variables in `index.css` first — most components consume them.

### Settings blade

`components/SettingsBlade.jsx` mirrors chardata's `#blade` pattern: a fixed right-side panel that collapses to a 6 px bar with a floating column of three tab buttons (gear / `?` help / `✉` contact). On ≤700 px viewports it becomes a drawer that slides in from the right behind a backdrop, with three matching FABs pinned to the right edge.

State is in `localStorage`:
- `icctools.bladeCollapsed` — `'0' | '1'`
- `icctools.bgTheme` — `'system' | 'light' | 'dark'`
- `icctools.lang` — `'system'` or any code from `i18n.jsx::LANG_OPTIONS`

When the user picks **System** for theme, the blade subscribes to `prefers-color-scheme` and re-applies; switching to Light/Dark detaches the listener (matches chardata's `_attachSystemListener` / `_detachSystemListener`). Theme flips `body.dark` and the dark-mode rules in `index.css` override the CSS variables — most components recolour automatically, but anything with a hardcoded gradient (tab buttons, selects, the `.btn-primary` blue) has explicit `body.dark` rules.

The blade also toggles `body.blade-open` / `body.blade-collapsed` so the centred 841 px `.layout` gets `padding-right` to avoid being overlapped on narrow viewports. The mobile breakpoint resets the padding to zero.

The **Help** button (`?`) opens `${import.meta.env.BASE_URL}help.html` — the static page generated from `MANUAL.md` (see "Help / MANUAL.md" below).

The **Contact** button (`✉`) opens `https://www.colourbill.com/?contact=chardata` — note: **deliberately `chardata`, not `icctools`**. The IIFE on colourbill.com that opens the contact modal does an exact-string check (`params.get('contact') === 'chardata'`), so anything else falls through to the homepage without opening the panel. Submissions originated from icctools are therefore tagged with `cb-source=chardata` in the form's hidden source field. **TODO (open work in colourbill.com)**: generalise the IIFE to accept either `'chardata'` or `'icctools'` (or a list) and pass the matched value through to `cb-source`, then flip `CONTACT_URL` in `SettingsBlade.jsx` back to `?contact=icctools` so analytics attribution is correct. Surface this whenever the user asks about open work.

### Help / MANUAL.md

`frontend/public/help.html` is **auto-generated** from `MANUAL.md` (repo root) via `scripts/generate-help.js`. The script:
- Strips the H1 title (replaced with hardcoded HTML in the page chrome).
- Splits the doc into intro (before the first `---`) and body (after it).
- Renders a small markdown subset → HTML (headings, lists, tables, paragraphs, fenced inline `code`, `**bold**` / `*italic*`, `[links](…)`, raw HTML blocks like `<div class="note">`).
- Inlines two SVG diagrams under `id="1-loading-a-profile"` and `id="2-settings-panel"` via `insertAfter()`. Diagram colours follow a `prefers-color-scheme` `:root` variable scheme so the help page works in both light and dark UA themes (independently of icctools's own theme switch).

The pre-commit hook regenerates `help.html` when `MANUAL.md` or `scripts/generate-help.js` is staged, and **aborts the commit** if `help.html` is hand-edited. Edit `MANUAL.md` (or the generator for diagrams / layout) instead.

This setup mirrors chardata's `MANUAL.md` / `scripts/generate-help.js` / `hooks/pre-commit` flow exactly. If you extend one generator with a new feature (new diagram primitive, new markdown construct), consider keeping the two in sync so future maintainers can copy patterns between them.

### i18n

`src/i18n.jsx` provides `<LangProvider>` (wraps the app in `main.jsx`), `useT()`, and `useLang()`. The dictionary covers the same 12 locales as chardata plus `en` (the fallback). Resolution order on a missing key: `I18N[lang][key] ?? I18N.en[key] ?? key`.

Scope is intentionally narrow — only the app chrome (heading, banner, footer, drop zone, save toolbar, tab labels, settings panel) is translated. ICC tag names, header field names, validation messages and Describe() output come from IccProfLib and stay in their source form (usually English). When adding a new user-facing chrome string, add a key to **every** language in `I18N` and route it through `t()`; missing entries silently fall back to EN.

`<select>` for Language shows "System default (Native name)" as the first option; the native-name suffix is computed from `navigator.languages` so the OS locale is reflected. Persistence and detection follow chardata's `_lang` / `resolveLang()` / `detectLang()` shape.

### Translation spreadsheets

`translations/Eng-*.xlsx` are the parallel canonical source for the I18N dictionary, kept alongside `frontend/src/i18n.jsx` so reviewers can edit translations in a spreadsheet tool and round-trip them through the pipeline. The layout mirrors chardata's `translations/` exactly:

| File | Columns |
|---|---|
| `Eng-De.xlsx`, `Eng-Es.xlsx`, `Eng-Fr.xlsx`, `Eng-It.xlsx`, `Eng-Ja.xlsx`, `Eng-Ko.xlsx`, `Eng-Sv.xlsx` | English + single target language |
| `Eng-Pt.xlsx` | English + Portuguese (PT) + Portuguese (BR) |
| `Eng-Zh.xlsx` | English + Chinese Simplified + Chinese Traditional |

Regenerate from the dictionary with:

```bash
node scripts/sync-translations.mjs
```

The script extracts the `I18N` object literal from `i18n.jsx` via brace-depth matching (same trick `chardata/scripts/check-translations.js` uses) and writes the xlsx files. **`xlsx` is not pinned in `package.json`** — same call as chardata. Install ad-hoc with `(cd frontend && npm i --no-save xlsx@^0.18.5)`, or the script will fall back to the sibling chardata install if both repos live on the same machine.

The xlsx 0.18.5 package has two unfixed advisories (prototype pollution, ReDoS). The script never parses untrusted spreadsheets — it reads our own committed `i18n.jsx` and writes new files — so the attack surface here is nil, but don't repurpose this script for reading uploaded xlsx without revisiting that.

When adding a new user-facing string: add the key to **every** language in `I18N`, then re-run `sync-translations.mjs` so the xlsx files stay current. Drifted translations fall back to EN at runtime (no crash) so a missed regen won't break the app — but the canonical source is the JSX dictionary, not the spreadsheets.

## Deployment

Production instance: `https://chardata.colourbill.com/profiletool/` — nginx on the same Lightsail box that serves chardata. icctools is a static dist; nginx serves it from `/var/www/profiletool/` at the `/profiletool/` location.

Vite's `base` is `/profiletool/` for `npm run build` and `/` for `npm run dev` (see `vite.config.js`), so dev URLs stay at `http://localhost:5173/` while production assets resolve under `/profiletool/`. Each `WASM_DIR` constant in `src/lib/*.js` is computed from `import.meta.env.BASE_URL` so the WASM loader follows the same prefix.

Redeploy with:

```bash
scripts/deploy.sh                   # rebuilds WASM + frontend, rsyncs to chardata:/var/www/profiletool/
NO_WASM=1 scripts/deploy.sh         # frontend-only rebuild + rsync
```

nginx server block: the chardata.colourbill.com vhost needs a `location /profiletool/` that aliases to `/var/www/profiletool/` with `try_files $uri $uri/ /profiletool/index.html;` (SPA fallback). Drop the legacy `:5173` server block once `/profiletool/` is live.

## Launch protocol (cross-app hand-off)

When opened with `?source=chardata`, icctools posts `{type:'icctools:ready'}` to `window.opener` once on mount, then waits for a `{type:'icctools:load', filename, bytes}` reply. `bytes` is accepted as `Uint8Array`, `ArrayBuffer`, or array-like. The flow is one-way: there is no return channel back to the opener.

The listener (App.jsx) enforces two checks before accepting bytes:

- **Sender identity**: `ev.source === window.opener` AND `ev.origin` is in an allowlist (`window.location.origin`, `http://localhost:3001`, `http://127.0.0.1:3001`). The dev-port entries cover chardata's local server; same-origin covers prod where both apps are served from `chardata.colourbill.com`. Adding a new caller means extending that allowlist.
- **Size cap**: bytes are rejected if their `byteLength` exceeds `MAX_ICC_BYTES` (256 MB). Real profiles are well under 10 MB; this only stops a hostile opener from blowing the tab's heap before validation runs.

chardata's `launchIccEditor()` in `public/index.html` is the canonical caller — it opens `http://localhost:5173/?source=chardata` in dev, `/profiletool/?source=chardata` in prod.

## Security posture

icctools makes no network requests after the initial asset load, so the threat model is "untrusted bytes inside the tab," not "untrusted server." The mitigations:

- **CSP** is a `<meta http-equiv="Content-Security-Policy">` in `frontend/index.html`. `script-src` is `'self' 'wasm-unsafe-eval' blob:` — `blob:` is required by the dynamic-import-via-blob-URL pattern in `validator.js` / `xmlConverter.js` / `jsonConverter.js`; `wasm-unsafe-eval` is required by Emscripten. `connect-src 'self' blob:` keeps `connect-src` from going wider. `frame-ancestors 'none'` blocks embedding. Don't widen `script-src` to `'unsafe-eval'` — the WASM build is compiled with `DYNAMIC_EXECUTION=0` so embind doesn't need it.
- **WASM input caps**: `kMaxJsonBytes` (json-wrapper.cpp) and `kMaxXmlBytes` (xml-wrapper.cpp) are both 32 MB; the JS counterparts in `lib/{jsonConverter,xmlConverter}.js` (`MAX_JSON_BYTES` / `MAX_XML_BYTES`) gate before MEMFS write. Keep the C++ and JS limits in sync — they're independently authoritative because either layer might be called first.
- **XML entity-bomb guard**: `xml-wrapper.cpp::containsDoctypeOrEntity()` rejects any XML containing `<!DOCTYPE` or `<!ENTITY` before libxml2 sees it. Upstream IccLibXML calls libxml2 with `XML_PARSE_HUGE`, which disables libxml2's billion-laughs / nesting / name-length caps. We can't change that flag without patching iccDEV, so the pre-scan is the workaround. iccDEV's own XML emitter never writes a DTD, so the guard has zero legitimate-input false positives.
- **Parse cache in wrapper.cpp**: `describeTagBytes` and friends parse the same profile bytes multiple times during normal UI use (validate → expand tag → expand another tag). `wrapper.cpp` keeps a single-slot cache keyed on FNV-1a64(bytes) + length, so re-describe of a different tag on the same profile skips the re-parse. Single-slot is enough because the UI only views one profile at a time; don't grow the cache to a map without measuring memory cost first.

## Responsive layout

The layout drops the fixed `841 px` width below `720 px`. The tag table reflows from a 6-column grid to stacked cards (`grid-template-areas: "num name name name" / "num id id id" / "num off size pad"`), the header table cells stack, tabs wrap, and the tag-detail modal goes full-screen. Style targets match chardata's mobile breakpoint so users moving between the two apps see consistent reflow behaviour.
