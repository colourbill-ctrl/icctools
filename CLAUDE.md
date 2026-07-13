<!-- (c) 2026 William Li -->

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

profiletool is a web-based ICC profile validation tool that wraps the [iccDEV](https://github.com/InternationalColorConsortium/iccDEV) C++ reference implementation. Validation runs **entirely client-side** via a WASM build of IccProfLib — there is no backend service. The iccDEV source is expected at `/home/colour/code/iccdev` and must **not** be modified.

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
└── GuidePanel.jsx       — slide-in user-guide pane (renders help.html body + search)
```

Each component has a co-located `*.module.css` file. Global tokens (colours, fonts) are CSS custom properties in `src/index.css`. The visual identity matches chardata (Arial on `#f0f2f5` blue-grey, blue `#4a90e2` accent, rounded white card with light shadow, gradient `.btn-primary` buttons) so users moving between the two apps see a consistent look. When tweaking colours, edit the CSS variables in `index.css` first — most components consume them.

### Settings blade

`components/SettingsBlade.jsx` mirrors chardata's `#blade` pattern: a fixed right-side panel that collapses to a 6 px bar with a floating column of three tab buttons (gear / `?` help / `✉` contact). On ≤700 px viewports it becomes a drawer that slides in from the right behind a backdrop, with three matching FABs pinned to the right edge.

State is in `localStorage`:
- `profiletool.bladeCollapsed` — `'0' | '1'`
- `profiletool.bgTheme` — `'system' | 'light' | 'dark'`
- `profiletool.lang` — `'system'` or any code from `i18n.jsx::LANG_OPTIONS`

When the user picks **System** for theme, the blade subscribes to `prefers-color-scheme` and re-applies; switching to Light/Dark detaches the listener (matches chardata's `_attachSystemListener` / `_detachSystemListener`). Theme flips `body.dark` and the dark-mode rules in `index.css` override the CSS variables — most components recolour automatically, but anything with a hardcoded gradient (tab buttons, selects, the `.btn-primary` blue) has explicit `body.dark` rules.

The blade also toggles `body.blade-open` / `body.blade-collapsed` so the centred 841 px `.layout` gets `padding-right` to avoid being overlapped on narrow viewports. The mobile breakpoint resets the padding to zero.

The **Help** button (`?`) — on both the blade tab column and the mobile FAB — calls `onOpenHelp` (passed from `App`), which opens the in-app **`GuidePanel`** (see "Help / MANUAL.md" below) rather than navigating to a new tab.

The **Contact** button (`✉`) opens `https://www.colourbill.com/?contact=profiletool`. The IIFE on colourbill.com that opens the contact modal allow-lists `['chardata', 'profiletool']` and passes the matched value through to the form's hidden `cb-source` field; the server-side handler (`colourbill_handle_contact()` in `colourbill-customizations.php`) mirrors the same allow-list and prefixes the email subject with `[profiletool]` for attribution.

### Help / MANUAL.md

`frontend/public/help.html` is **auto-generated** from `MANUAL.md` (repo root) via `scripts/generate-help.js`. The script:
- Strips the H1 title (replaced with hardcoded HTML in the page chrome).
- Splits the doc into intro (before the first `---`) and body (after it).
- Renders a small markdown subset → HTML (headings, lists, tables, paragraphs, fenced inline `code`, `**bold**` / `*italic*`, `[links](…)`, raw HTML blocks like `<div class="note">`).
- Inlines two SVG diagrams under `id="1-loading-a-profile"` and `id="2-settings-panel"` via `insertAfter()`. Diagram colours follow a `prefers-color-scheme` variable scheme so the help page works in both light and dark UA themes (independently of profiletool's own theme switch). Every diagram selector is **scoped under `.diag`** (the class on each `<svg>`): an SVG `<style>` in an HTML document is not shadow-scoped, so an unscoped `text{…}` / `:root{--…}` would leak onto the app's own SVG graphs (`viz/GraphSvg.jsx`) when `GuidePanel` renders the diagrams into the live DOM.

The pre-commit hook regenerates `help.html` when `MANUAL.md` or `scripts/generate-help.js` is staged, and **aborts the commit** if `help.html` is hand-edited. Edit `MANUAL.md` (or the generator for diagrams / layout) instead.

This setup mirrors chardata's `MANUAL.md` / `scripts/generate-help.js` / `hooks/pre-commit` flow exactly. If you extend one generator with a new feature (new diagram primitive, new markdown construct), consider keeping the two in sync so future maintainers can copy patterns between them.

**In-app guide pane (`components/GuidePanel.jsx`).** The `?` help button opens a tiffview-style slide-in pane (dimmed backdrop over the rest of the window, panel slides in from the right) instead of a new tab. It fetches `help.html` **once** and renders its `.page` body — but because the pre-commit **F4 invariant forbids any HTML-injection sink in `frontend/src`** (`dangerouslySetInnerHTML`/`.innerHTML`/… — the grep matches *comments* too, so don't spell those tokens out), the body is **parsed with `DOMParser` and converted to real React elements** via `domToReact()` (text → auto-escaped string children; `class`→`className`, hyphenated SVG attrs → camelCase; the page `<h1>`/subtitle are stripped since the pane has its own header). The header carries a persistent **search box** (magnifier + input + `n/m` count + `˄`/`˅` nav) — a plain in-page find ported from tiffview: it walks the rendered body with a `TreeWalker`, wraps matches in `<mark>`, jumps to the first, cycles with `Enter`/`Shift+Enter`, and `Escape` clears (a second `Escape` closes). The marking is imperative DOM mutation, which is safe only because the converted tree is `useMemo`'d on the fetched text, so the body subtree keeps stable element references and React never reconciles the marks away. New user-facing chrome strings (`guide_*`) are in `i18n.jsx` across all 12 locales.

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

Production instance: `https://chardata.colourbill.com/profiletool/` — nginx on the same Lightsail box that serves chardata. profiletool is a static dist; nginx serves it from `/var/www/profiletool/` at the `/profiletool/` location.

Vite's `base` is `/profiletool/` for `npm run build` and `/` for `npm run dev` (see `vite.config.js`), so dev URLs stay at `http://localhost:5173/` while production assets resolve under `/profiletool/`. Each `WASM_DIR` constant in `src/lib/*.js` is computed from `import.meta.env.BASE_URL` so the WASM loader follows the same prefix.

**CI is the primary deploy path.** `.github/workflows/deploy.yml` auto-deploys on every push to `main` and on any `v*` tag: a GitHub-hosted runner runs `npm ci && npm run build` (committed WASM in `frontend/public/wasm/` ships as-is — the runner needs no Emscripten/iccDEV), then `rsync --delete frontend/dist/ → admin@$SSH_HOST:/var/www/profiletool/`. The tag trigger matters because `vite.config.js` resolves `__APP_VERSION__` from `git describe --tags --abbrev=0`, so the live footer version follows the **git tag**. Required repo secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`.

> **⚠ Lightsail SSH host — the deploy-breaking gotcha.** `chardata.colourbill.com` is Cloudflare-proxied: HTTPS/443 works, but **port 22 is not exposed**, so SSH/rsync to the *hostname* fails with `connect to host … port 22: Network is unreachable`. The Lightsail **origin IP is `54.203.184.14`** (us-west-2, user `admin`). Both the `SSH_HOST` GitHub secret and the local `~/.ssh/config` `chardata` alias must use that IP, never the hostname (the deploy.yml comment's "same value chardata uses" = this IP). `SSH_KNOWN_HOSTS` pins by host, so it must hold `ssh-keyscan -H 54.203.184.14`. If the live version stops advancing after a push, check the deploy run for this error first. (Fixed 2026-06-14 after the domain moved behind Cloudflare; chardata's secret already used the IP, profiletool's had drifted to the hostname.)

Manual redeploy (fallback — only works if the local `chardata` SSH alias points at the origin IP above):

```bash
scripts/deploy.sh                   # rebuilds WASM + frontend, rsyncs to chardata:/var/www/profiletool/
NO_WASM=1 scripts/deploy.sh         # frontend-only rebuild + rsync
```

nginx server block: the chardata.colourbill.com vhost needs a `location /profiletool/` that aliases to `/var/www/profiletool/` with `try_files $uri $uri/ /profiletool/index.html;` (SPA fallback). Drop the legacy `:5173` server block once `/profiletool/` is live.

### Releasing (runbook)

Patch release that rebuilds the WASM against the latest iccDEV (the common case):

```bash
# 1. Build all WASM modules against a CLEAN iccDEV master (not a feature/test branch).
#    Wipe the build dir so it reconfigures against the clean root.
git -C ~/code/iccdev worktree add --detach /tmp/iccdev-clean origin/master
source ~/emsdk-install/emsdk/emsdk_env.sh
rm -rf validator-wasm/build
ICCDEV_ROOT=/tmp/iccdev-clean scripts/build-wasm.sh     # copies into frontend/public/wasm/ + refreshes SHA256SUMS
git -C ~/code/iccdev worktree remove /tmp/iccdev-clean --force

# 2. Bump "version" in frontend/package.json AND frontend/package-lock.json (root + packages."" only).

# 3. Commit the WASM artifacts + version files (not the untracked iccdev-pr*/ scratch dirs):
git add frontend/package.json frontend/package-lock.json frontend/public/wasm/
git commit            # subject convention: "X.Y.Z: <summary>"; trailer Co-Authored-By: Claude ...

# 4. Tag BEFORE deploy so __APP_VERSION__ resolves to the new version, then push (CI deploys):
git tag -a vX.Y.Z -F <same message>
git push origin main && git push origin vX.Y.Z

# 5. GitHub release (these ARE the release notes — no CHANGELOG file):
gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --notes-file <notes.md>
```

Verify after the CI deploy goes green: fetch `https://chardata.colourbill.com/profiletool/`, grab the `assets/index-*.js` it references, and confirm the bundle contains the new version string; optionally diff a live `wasm/*.wasm` sha256 against the committed `SHA256SUMS`.

## Launch protocol (cross-app hand-off)

When opened with `?source=chardata`, profiletool posts `{type:'profiletool:ready'}` to `window.opener` once on mount, then waits for a `{type:'profiletool:load', filename, bytes}` reply. `bytes` is accepted as `Uint8Array`, `ArrayBuffer`, or array-like. The flow is one-way: there is no return channel back to the opener.

The listener (App.jsx) enforces two checks before accepting bytes:

- **Sender identity**: `ev.source === window.opener` AND `ev.origin` is in an allowlist (`window.location.origin`, `http://localhost:3001`, `http://127.0.0.1:3001`). The dev-port entries cover chardata's local server; same-origin covers prod where both apps are served from `chardata.colourbill.com`. Adding a new caller means extending that allowlist.
- **Size cap**: bytes are rejected if their `byteLength` exceeds `MAX_ICC_BYTES` (256 MB). Real profiles are well under 10 MB; this only stops a hostile opener from blowing the tab's heap before validation runs.

chardata's `launchIccEditor()` in `public/index.html` is the canonical caller — it opens `http://localhost:5173/?source=chardata` in dev, `/profiletool/?source=chardata` in prod.

## Security posture

profiletool makes no network requests after the initial asset load, so the threat model is "untrusted bytes inside the tab," not "untrusted server." The mitigations:

- **CSP** is a `<meta http-equiv="Content-Security-Policy">` in `frontend/index.html`. `script-src` is `'self' 'wasm-unsafe-eval' blob: https://www.googletagmanager.com` — `blob:` is required by the dynamic-import-via-blob-URL pattern in `validator.js` / `xmlConverter.js` / `jsonConverter.js`; `wasm-unsafe-eval` is required by Emscripten; the googletagmanager host is the one allow-listed off-origin script (the GA4 gtag loader — init lives in bundled `lib/analytics.js`, **not** inline, so `'unsafe-inline'` stays out of `script-src`). `img-src` adds `https://www.google-analytics.com` for GA beacons. `connect-src` is `'self' blob: https:` — the `https:` was added in v1.1.5 so the `#url=` launch fragment can fetch a profile from any HTTPS host (subject to CORS). This trades the former "no off-origin fetch" property for "https-only fetch": an XSS regression could exfiltrate over https. We accept that for the URL-launch feature; the fetched bytes only flow into the validator and are never re-sent, and the postMessage allowlist still gates hostile **inbound** bytes. `frame-ancestors 'none'` blocks embedding. Don't widen `script-src` to `'unsafe-eval'` — the WASM build is compiled with `DYNAMIC_EXECUTION=0` so embind doesn't need it.
  - Because `connect-src https:` permits off-origin exfil, two related guards matter: (1) `lib/analytics.js` pins `page_location` to `origin + pathname`, stripping the `?query`/`#fragment` so the `#url=` profile target (and any token in it) is never shipped to GA; (2) `App.jsx::loadFromUrl` confirms (`url_confirm`) before any **cross-origin** `#url=` fetch, so a crafted link can't silently make the browser GET an arbitrary URL. Keep both if you touch analytics or the URL-launch path.
  - The XML/JSON converter placeholders render trusted i18n markup (`<em>`/`<code>`) via `lib/richText.jsx`, **not** `dangerouslySetInnerHTML` — so a future templated/untrusted translation can't become an XSS sink. Don't reintroduce an innerHTML sink for dictionary strings.
- **WASM input caps**: `kMaxJsonBytes` (json-wrapper.cpp) and `kMaxXmlBytes` (xml-wrapper.cpp) are both 32 MB and gate the *text→ICC* direction; the JS counterparts in `lib/{jsonConverter,xmlConverter}.js` (`MAX_JSON_BYTES` / `MAX_XML_BYTES`) gate before MEMFS write. The *ICC-bytes→X* entry points (`validateProfile` / `describeTag` in wrapper.cpp, `iccToJson`, `iccToXml`, `pawgReport`) each enforce their own `kMaxIccBytes` = 256 MB, mirroring `MAX_ICC_BYTES` in App.jsx — so every WASM entry point is independently authoritative and none trusts the JS caller to have bounded the input. Keep the C++ and JS limits in sync.
- **XML entity-bomb guard**: `xml-wrapper.cpp::containsDoctypeOrEntity()` rejects any XML containing `<!DOCTYPE` or `<!ENTITY` — or any NUL byte (i.e. non-UTF-8 input such as UTF-16/UTF-32, which would let a wide-char `<!DOCTYPE` slip past the narrow-byte scan while libxml2 auto-detects the encoding) — before libxml2 sees it. Upstream IccLibXML calls libxml2 with `XML_PARSE_HUGE`, which disables libxml2's billion-laughs / nesting / name-length caps. We can't change that flag without patching iccDEV, so the pre-scan is the workaround. iccDEV's own XML emitter never writes a DTD and emits NUL-free UTF-8, so the guard has zero legitimate-input false positives.
- **Parse cache in wrapper.cpp**: `describeTagBytes` and friends parse the same profile bytes multiple times during normal UI use (validate → expand tag → expand another tag). `wrapper.cpp` keeps a single-slot cache keyed on FNV-1a64(bytes) + length, so re-describe of a different tag on the same profile skips the re-parse. Single-slot is enough because the UI only views one profile at a time; don't grow the cache to a map without measuring memory cost first.

## Responsive layout

The layout drops the fixed `841 px` width below `720 px`. The tag table reflows from a 6-column grid to stacked cards (`grid-template-areas: "num name name name" / "num id id id" / "num off size pad"`), the header table cells stack, tabs wrap, and the tag-detail modal goes full-screen. Style targets match chardata's mobile breakpoint so users moving between the two apps see consistent reflow behaviour.
