// (c) 2026 William Li
//
// Smoketest / A-B harness for the iccplot `roundTrip` export — the parity port
// of the `iccRoundTrip` CLI. Prints the same numbers the CLI prints so a human
// can diff them side by side:
//
//   node roundtrip-smoketest.mjs <profile.icc> [intent=1] [use_mpe=0]
//   iccRoundTrip                 <profile.icc> [intent=1] [use_mpe=0]
//
// Verified against native iccRoundTrip on Testing/CMYK-3DLUTs/CMYK-3DLUTs.icc
// (intent 1, mpe 0): RT1/RT2 min·mean·max, both worst-Lab triples, and all five
// PRMG buckets + total match exactly.
import createIccplot from './build/iccplot.mjs';
import { readFileSync } from 'node:fs';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node roundtrip-smoketest.mjs <profile.icc> [intent=1] [use_mpe=0]');
  process.exit(1);
}
const intent = Number(process.argv[3] ?? 1);
const useMpe = (process.argv[4] ?? '0') !== '0';

const bytes = readFileSync(profilePath);
const mod = await createIccplot();
const r = JSON.parse(mod.roundTrip(new Uint8Array(bytes), intent, useMpe));

if (r.error) { console.error('ERROR:', r.error); process.exit(1); }
if (r.status === 'tooManySamples') {
  console.log('Round trip skipped (too many samples):', r.message);
  process.exit(0);
}

const f2 = (v) => v.toFixed(2);
const lab = (a) => a.map((v) => v.toFixed(6)).join(', ');

console.log('Profile         :', profilePath);
console.log('Intent / useMpe :', r.intent, '/', r.useMpe);
console.log('Specified Gamut :', r.prmg?.ok ? (r.prmg.implied ? 'PRMG' : 'Not Specified')
                                            : `Not evaluated (${r.prmg?.message})`);
console.log('\nRound Trip 1  min / mean / max :', f2(r.roundTrip1.minDE), f2(r.roundTrip1.meanDE), f2(r.roundTrip1.maxDE));
console.log('Round Trip 1  worst L, a, b    :', lab(r.roundTrip1.maxLab));
console.log('Round Trip 2  min / mean / max :', f2(r.roundTrip2.minDE), f2(r.roundTrip2.meanDE), f2(r.roundTrip2.maxDE));
console.log('Round Trip 2  worst L, a, b    :', lab(r.roundTrip2.maxLab));

if (r.prmg?.ok && r.prmg.total) {
  const s = 100 / r.prmg.total;
  const line = (le, n) => `DE <= ${le.padStart(4)} (${String(n).padStart(8)}): ${(s * n).toFixed(1)}%`;
  console.log('\nPRMG Interoperability');
  console.log(line('1.0', r.prmg.de1));
  console.log(line('2.0', r.prmg.de2));
  console.log(line('3.0', r.prmg.de3));
  console.log(line('5.0', r.prmg.de5));
  console.log(line('10.0', r.prmg.de10));
  console.log(`Total     (${String(r.prmg.total).padStart(8)})`);
} else {
  console.log('\nPRMG skipped:', r.prmg?.message);
}
