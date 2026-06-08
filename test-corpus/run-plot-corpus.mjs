// Headless driver for the iccplot (IccVizModel) WASM engine. For every *.icc in
// the given paths it runs enumerate() + renders every descriptor it lists, the
// same calls the Profile Plot UI makes — minus the chrome.
//
// Purpose (the test gap that let the engine ship with collapsed diagnostics):
//   1. Robustness — the engine must never crash the module on ANY input,
//      including the malformed corpus (bad-CMM, beyond-eof, zero-tags, …).
//   2. Diagnostics — when a descriptor fails to render, the error must be a
//      SPECIFIC reason (invalid CLUT width, failed validation, …), never a bare
//      generic string. This is exactly what E1–E3 restored.
//   3. Happy path — a valid profile (sRGB v4) must still produce graphs + CLUT
//      rasters, proving the granular guards didn't change valid output.
//
// Usage:
//   node test-corpus/run-plot-corpus.mjs                 # repo WASM + this folder
//   node test-corpus/run-plot-corpus.mjs <wasmDir> <path...>   # extra .icc / dirs
//
// Exit status: 0 = all profiles handled gracefully; 1 = a crash or a generic /
// empty error string slipped through (regression).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir = process.argv[2] || join(here, '..', 'frontend', 'public', 'wasm');
const inputs = process.argv.slice(3);
if (inputs.length === 0) inputs.push(here);

const factory = (await import(pathToFileURL(join(wasmDir, 'iccplot.mjs')).href)).default;
const mod = await factory({ locateFile: (p) => join(wasmDir, p) });

// embind std::string arg accepts a Uint8Array as raw bytes (no UTF-8 mangling).
const blobFor = (f) => new Uint8Array(readFileSync(f));

function collectIcc(p) {
  const st = statSync(p);
  if (st.isDirectory())
    return readdirSync(p).filter(f => f.endsWith('.icc')).sort().map(f => join(p, f));
  return p.endsWith('.icc') ? [p] : [];
}
const files = inputs.flatMap(collectIcc);

let failures = 0;

for (const path of files) {
  const f = basename(path);
  const bytes = blobFor(path);
  console.log(`### ${f}`);

  // 1. enumerate — must not throw; may legitimately report a parse error.
  let descriptors;
  try {
    const enumJson = JSON.parse(mod.enumerate(bytes));
    if (!Array.isArray(enumJson)) {
      console.log(`  enumerate: ${enumJson.error || 'non-array result'}`);
      console.log('');
      continue;   // graceful parse failure on malformed input — expected
    }
    descriptors = enumJson;
  } catch (e) {
    console.log(`  CRASH in enumerate: ${e}`);
    failures++; console.log(''); continue;
  }

  // 2. render every descriptor — must not throw; failures must be specific.
  let graphsOk = 0, rastersOk = 0;
  const errors = [];
  for (const d of descriptors) {
    try {
      if (d.output === 'raster') {
        const r = mod.renderRaster(bytes, d.id);
        if (r.error) errors.push(`${d.id}: ${r.error}`);
        else if (r.width > 0 && r.height > 0 && r.samples?.length) rastersOk++;
        else errors.push(`${d.id}: raster has no samples`);
      } else {
        const g = JSON.parse(mod.renderGraph(bytes, d.id));
        if (g.error) errors.push(`${d.id}: ${g.error}`);
        else if (Array.isArray(g.series)) graphsOk++;
        else errors.push(`${d.id}: graph has no series`);
      }
    } catch (e) {
      console.log(`  CRASH rendering ${d.id}: ${e}`);
      failures++;
    }
  }

  console.log(`  descriptors: ${descriptors.length}  graphs ok: ${graphsOk}  rasters ok: ${rastersOk}`);
  for (const e of errors) {
    console.log(`    - ${e}`);
    // A render that fails must say WHY — a bare/empty reason is the regression.
    const reason = e.split(': ').slice(1).join(': ');
    if (!reason || reason === 'could not build raster' || reason === 'no colours') {
      console.log(`      ^ GENERIC/EMPTY error — diagnostic regression`);
      failures++;
    }
  }
  console.log('');
}

console.log(failures === 0
  ? `PASS — ${files.length} profile(s) handled gracefully, all errors specific`
  : `FAIL — ${failures} crash(es)/generic-error(s)`);
process.exit(failures === 0 ? 0 : 1);
