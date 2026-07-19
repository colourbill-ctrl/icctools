// (c) 2026 William Li
//
// Smoketest / A-B harness for the iccconstruct `v5DspObsToV4` export — the parity
// port of the `iccV5DspObsToV4Dsp` CLI. Combines a V5 RGB display + a V5 observer
// (ColorSpace-class PCC) profile into a V4 RGB matrix/TRC display and, given a
// third path, byte-compares against a reference .icc from the native tool:
//
//   node v5tov4-smoketest.mjs <display.v5.icc> <observer.v5.icc> [reference.v4.icc]
//
// Verified byte-identical (modulo timestamp + profile ID, see below) to the
// current-source native iccV5DspObsToV4Dsp on the CI pair
// (.github/ci/test-data/v5dspobs-lcddisplay.icc + v5dspobs-cat8lab.icc).
import createIccConstruct from './build/iccconstruct.mjs';
import { readFileSync } from 'node:fs';

const [dspPath, obsPath, refPath] = process.argv.slice(2);
if (!dspPath || !obsPath) {
  console.error('Usage: node v5tov4-smoketest.mjs <display.v5.icc> <observer.v5.icc> [reference.v4.icc]');
  process.exit(1);
}

const mod = await createIccConstruct();
const dsp = new Uint8Array(readFileSync(dspPath));
const obs = new Uint8Array(readFileSync(obsPath));

let bytes;
try {
  bytes = mod.v5DspObsToV4(dsp, obs);   // Uint8Array
} catch (e) {
  // Unwrap the embind exception to the engine's specific rejection.
  const msg = mod.getExceptionMessage ? (() => { try { return mod.getExceptionMessage(e)[1] } catch { return e } })() : e;
  console.error('v5DspObsToV4 rejected the inputs:', msg);
  process.exit(1);
}

const out = Buffer.from(bytes);
console.log('Display :', dspPath);
console.log('Observer:', obsPath);
console.log('Output  :', out.length, 'bytes  (V4 display)');
console.log('Header  : size', out.readUInt32BE(0),
            '| version 0x' + out.readUInt32BE(8).toString(16).padStart(8, '0'),
            '| class', out.toString('latin1', 12, 16),
            '| space', out.toString('latin1', 16, 20),
            '| pcs', out.toString('latin1', 20, 24));

if (refPath) {
  // The tool stamps wall-clock time into dateTime (24..35) and the MD5 profile ID
  // (84..99), so two runs differ in exactly those regions. Zero both before
  // comparing so the check tests the *content*, not the clock.
  const normalize = (buf) => {
    const b = Buffer.from(buf);
    if (b.length >= 100) { b.fill(0, 24, 36); b.fill(0, 84, 100); }
    return b;
  };
  const ref = readFileSync(refPath);
  if (normalize(ref).equals(normalize(out))) {
    console.log('Compare : ✅ byte-identical to', refPath, '(datetime + profile ID normalized)');
  } else {
    console.log(`Compare : ❌ differs (reference ${ref.length} bytes vs ${out.length})`);
    process.exit(2);
  }
}
