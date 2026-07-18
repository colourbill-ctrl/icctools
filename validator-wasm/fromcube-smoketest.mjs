// (c) 2026 William Li
//
// Smoketest / A-B harness for the iccconstruct `fromCube` export — the parity
// port of the `iccFromCube` CLI. Converts a .cube to an ICC DeviceLink and, when
// given a second path, byte-compares against a reference .icc (e.g. one produced
// by the native tool) so parity is a one-command check:
//
//   node fromcube-smoketest.mjs <input.cube> [reference.icc]
//
// Verified byte-identical to CURRENT-master native iccFromCube on the simple
// (link_srgb) and custom-domain (iridas_3d) cubes, and message-identical on the
// reject path (issue-1179 → "Invalid DOMAIN_MAX value"). NB: native binaries
// built before iccDEV #1685 mis-parse multi-value DOMAIN_MIN/MAX — compare only
// against a current-master build.
import createIccConstruct from './build/iccconstruct.mjs';
import { readFileSync } from 'node:fs';

const cubePath = process.argv[2];
const refPath = process.argv[3];
if (!cubePath) {
  console.error('Usage: node fromcube-smoketest.mjs <input.cube> [reference.icc]');
  process.exit(1);
}

const text = readFileSync(cubePath, 'utf8');
const mod = await createIccConstruct();

let bytes;
try {
  bytes = mod.fromCube(text, cubePath);   // Uint8Array; cubePath = the default-description label
} catch (e) {
  // Unwrap the embind exception to the engine's specific reason.
  const msg = mod.getExceptionMessage ? (() => { try { return mod.getExceptionMessage(e)[1] } catch { return e } })() : e;
  console.error('fromCube rejected the cube:', msg);
  process.exit(1);
}

const out = Buffer.from(bytes);
console.log('Input   :', cubePath);
console.log('Output  :', out.length, 'bytes  (ICC DeviceLink)');
console.log('Header  : size', out.readUInt32BE(0), '| class', out.toString('latin1', 12, 16), '| pcs', out.toString('latin1', 20, 24));

if (refPath) {
  // iccFromCube (and thus this port) stamps the current wall-clock time into the
  // header dateTime (offset 24..35) and computes the profile ID / MD5 over the
  // whole profile (offset 84..99) — so two runs a second apart differ in exactly
  // those regions. Zero both before comparing so the check tests the *content*,
  // not the clock. Everything else must match the native reference byte-for-byte.
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
