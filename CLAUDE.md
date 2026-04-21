# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

icctools is a web-based ICC profile validation tool that wraps the [iccDEV](https://github.com/InternationalColorConsortium/iccDEV) C++ reference implementation. The iccDEV source lives at `C:\Users\colou\code\iccdev` and must **not** be modified — icctools builds its own thin C++ tool (`validator-tool/`) against IccProfLib.

## Services

| Service | Directory | Port | Tech |
|---------|-----------|------|------|
| Validator API | `validator/` | 3003 | Node.js + Express (ESM) |
| Frontend | `frontend/` | 5173 | Vite + React |

Both packages use ES modules (`"type": "module"`).

## Dev commands

```bash
# Validator (set ICC_VALIDATOR_PATH to the locally built iccprofiledump binary)
cd validator
$env:ICC_VALIDATOR_PATH = "C:\Users\colou\code\icctools\validator-tool\build\iccprofiledump.exe"
npm run dev

# Frontend
cd frontend
npm run dev          # http://localhost:5173
npm run build        # production build → frontend/dist/
```

Vite proxies `/api/*` → `http://localhost:3003` (strips the `/api` prefix), so the frontend always calls `/api/validate` — never a hardcoded port.

## Validator tool (`validator-tool/`)

A small C++ program that calls IccProfLib directly and writes a JSON report to stdout. It replaces the previous approach of shelling out to `iccDumpProfile.exe` and parsing its text output.

### Build (Linux / Docker)

```bash
# Stage 1: build IccProfLib static library from iccDEV
cd /path/to/iccdev/Build
cmake -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED_LIBS=OFF -DENABLE_STATIC_LIBS=ON \
      -DENABLE_TOOLS=OFF -DENABLE_WXWIDGETS=OFF -DENABLE_ICCXML=OFF -DENABLE_ICCJSON=OFF Cmake
make -j$(nproc) IccProfLib2-static

# Stage 2: build iccprofiledump
cmake -S validator-tool -B validator-tool/build -DICCDEV_ROOT=/path/to/iccdev
cmake --build validator-tool/build
```

### Key IccProfLib APIs used

| API | Purpose |
|-----|---------|
| `ValidateIccProfile(path, report, status)` | Load, fully parse, and validate; returns `CIccProfile*` |
| `pProfile->m_Header` | `icHeader` struct — all 128-byte header fields |
| `pProfile->m_Tags` | `TagEntryList` — iterate for tag directory |
| `CIccInfo` | Converts signatures/enums to human-readable strings |
| `icFtoD(icS15Fixed16Number)` | Fixed-point → double (used for illuminant XYZ) |
| `icF16toF(icFloat16Number)` | Half-float → float (used for spectral range nm values) |

### JSON output shape

```jsonc
{
  "libraryVersion": "2.3.1.7",
  "profileId": "9efa8dc6...",
  "sizeBytes": 488,
  "sizeBytesHex": "1e8",
  "header": { "Attributes": "Reflective | Glossy", "Data Color Space": "RgbData", ... },
  "tags": [{ "name": "profileDescriptionTag", "id": "desc", "type": "descType",
             "offset": 240, "size": 120, "pad": 0 }, ...],
  "validation": { "level": "valid|warning|error|unknown",
                  "status": "Profile is valid",
                  "messages": ["..."] }
}
```

Tags are sorted by `offset`. `pad < 0` means overlapping tags (non-compliant); `pad > 3` is a warning. The `type` field (tag type signature name) is new compared to the old parser.js output.

`server.js` receives this JSON from stdout and passes it through to the frontend unchanged — there is no parsing layer.

## Validator API (`validator/server.js`)

- `GET  /health` — returns `{ status, tool }`.
- `POST /validate` — multipart/form-data, field `profile`, max 16 MB. Writes a temp file, calls `iccprofiledump <tmpfile>`, `JSON.parse`s stdout, adds `filename`/`exitCode`, returns to client.

## Frontend component hierarchy

```
App.jsx                  — fetch orchestration, top-level error/loading state
└── DropZone.jsx         — drag-and-drop + <input type=file>; calls onFile(File)
└── ProfileViewer.jsx    — tabbed shell (Header / Tags / Validation / Raw Output)
    ├── HeaderTable.jsx  — renders header{} as a key/value table
    ├── TagTable.jsx     — renders tags[] with pad colouring
    └── ValidationPanel.jsx — status card + messages list
```

Each component has a co-located `*.module.css` file. Global tokens (colours, fonts, radius) are CSS custom properties in `src/index.css`.

## Docker

`validator/Dockerfile` is a three-stage build. Build context must be `..` (the parent directory containing both `iccdev/` and `icctools/`):

1. **iccproflib-builder** — Ubuntu 22.04, builds only `IccProfLib2-static` from iccDEV (`ENABLE_TOOLS=OFF`, `ENABLE_ICCXML=OFF`, `ENABLE_ICCJSON=OFF`). libxml2/tiff/png/jpeg are still installed because iccDEV's top-level CMakeLists calls `find_package` for them unconditionally.
2. **tool-builder** — Ubuntu 22.04, copies just the IccProfLib headers + static lib, builds `iccprofiledump`.
3. **Final** — `node:20-slim`, copies the single `iccprofiledump` binary (no extra runtime libs needed beyond what Node.js already requires), runs `server.js`.

```bash
docker build -f icctools/validator/Dockerfile -t icctools-validator ..
```

`docker-compose.yml` sets `context: ..` automatically.
