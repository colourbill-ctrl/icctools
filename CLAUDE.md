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
    ├── HeaderTable.jsx  — renders header{} as a key/value table
    ├── TagTable.jsx     — renders tags[] with pad colouring; rows open the modal
    ├── ValidationPanel.jsx — status card + messages list
    └── TagDetailModal.jsx — signature + type + offset + size + Describe() text
```

Each component has a co-located `*.module.css` file. Global tokens (colours, fonts) are CSS custom properties in `src/index.css`. Style targets the institutional look of color.org (crimson `#BF003F` accent, Verdana on grey).

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
