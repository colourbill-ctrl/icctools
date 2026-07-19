// (c) 2026 William Li
//
// Smoketest for the iccconstruct `buildLink` export — the in-memory port of
// iccApplyToLink's core (Pipeline builder, DL-PIPELINE1). Bakes an ordered profile
// chain into one v4 DeviceLink and checks the produced 'link' profile's header +
// space wiring. With CLI args it links an arbitrary chain:
//
//   node buildlink-smoketest.mjs <p1.icc> <p2.icc> ... [--intent N] [--grid G]
//
// No args → runs the built-in RGB→RGB and RGB→CMYK cases against iccDEV test data.
import createIccConstruct from './build/iccconstruct.mjs';
import { readFileSync } from 'node:fs';

const ICCDEV = '/home/colour/code/iccdev';
const RGB = ICCDEV + '/Testing/sRGB_v4_ICC_preference.icc';
const CMYK = ICCDEV + '/Testing/CMYK-3DLUTs/CMYK-3DLUTs.icc';

const mod = await createIccConstruct();
const sig = (u8, off) => String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
const err = (e) => (mod.getExceptionMessage ? (() => { try { return mod.getExceptionMessage(e)[1] } catch { return e } })() : e);

function link(paths, intent = 1, grid = 0) {
  const chain = paths.map((p) => new Uint8Array(readFileSync(p)));
  return mod.buildLink(chain, intent, grid);
}

function report(label, paths, intent = 1, grid = 0) {
  let out;
  try { out = link(paths, intent, grid); }
  catch (e) { console.log(`${label}: ❌ ${err(e)}`); process.exitCode = 2; return; }
  const size = (out[0] << 24 | out[1] << 16 | out[2] << 8 | out[3]) >>> 0;
  const cls = sig(out, 12), inSp = sig(out, 16), outSp = sig(out, 20), acsp = sig(out, 36);
  const ok = out.length > 128 && size === out.length && cls === 'link' && acsp === 'acsp';
  console.log(`${label}: ${ok ? '✅' : '❌'} ${out.length}B | class '${cls}' | ${inSp.trim()} → ${outSp.trim()} | acsp '${acsp}'`);
  if (!ok) process.exitCode = 2;
}

const args = process.argv.slice(2);
if (args.length && !args[0].startsWith('--')) {
  const paths = args.filter((a) => !a.startsWith('--'));
  const gi = args.indexOf('--grid'), ii = args.indexOf('--intent');
  report(`chain(${paths.length})`, paths, ii >= 0 ? +args[ii + 1] : 1, gi >= 0 ? +args[gi + 1] : 0);
} else {
  report('RGB→RGB  ', [RGB, RGB]);
  report('RGB→CMYK ', [RGB, CMYK]);
  // error path: an empty chain must be rejected, not crash.
  try { mod.buildLink([], 1, 0); console.log('empty    : ❌ did not reject'); process.exitCode = 2; }
  catch (e) { console.log(`empty    : ✅ rejected (${err(e)})`); }
}
