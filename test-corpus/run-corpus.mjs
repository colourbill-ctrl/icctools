// Headless driver for profiletool's WASM validator. Runs every *.icc in the
// corpus through validateProfile() and prints the level/status/messages — the
// same JSON the browser UI renders, minus the chrome.
//
// Usage:
//   node test-corpus/run-corpus.mjs                  # repo WASM + this folder
//   node test-corpus/run-corpus.mjs <wasmDir> <corpusDir>
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmDir   = process.argv[2] || join(here, '..', 'frontend', 'public', 'wasm');
const corpusDir = process.argv[3] || here;

const factory = (await import(pathToFileURL(join(wasmDir, 'iccprofiledump.mjs')).href)).default;
const mod = await factory({ locateFile: (p) => join(wasmDir, p) });

const files = readdirSync(corpusDir).filter(f => f.endsWith('.icc')).sort();
console.log('libraryVersion:', JSON.parse(mod.validateProfile(blobFor(files[0]))).libraryVersion);
console.log('');

function blobFor(f) {
  const buf = readFileSync(join(corpusDir, f));
  // embind std::string arg accepts a Uint8Array as raw bytes (no UTF-8 mangling)
  return new Uint8Array(buf);
}

for (const f of files) {
  let out;
  try {
    out = JSON.parse(mod.validateProfile(blobFor(f)));
  } catch (e) {
    console.log(`### ${f}\n  DRIVER-THREW: ${e}\n`);
    continue;
  }
  const v = out.validation || {};
  console.log(`### ${f}`);
  if (out.error) { console.log(`  error: ${out.error}`); }
  console.log(`  level:  ${v.level}`);
  console.log(`  status: ${v.status}`);
  if (v.messages && v.messages.length) {
    for (const m of v.messages) console.log(`    - ${m}`);
  }
  console.log('');
}
