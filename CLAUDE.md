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

Production instance: `https://chardata.colourbill.com:5173/` — nginx on a Lightsail box serves `frontend/dist/` as static files. Redeploy with:

```bash
cd frontend && npm run build
rsync -avz --delete dist/ chardata:/var/www/icctools/
```

nginx server block is under `/etc/nginx/sites-available/icctools` on the host; see current state with `ssh chardata 'sudo cat /etc/nginx/sites-available/icctools'`.
