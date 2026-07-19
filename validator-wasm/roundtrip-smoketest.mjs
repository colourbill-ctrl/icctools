// (c) 2026 William Li
//
// Smoketest / A-B harness for the iccplot `roundTripStats` export — the unified
// round-trip metric (RT0/RT1/RT2/PRMG) behind the Analysis-tab Profile-Statistics
// table. It A/Bs our in-app numbers against the native `iccRoundTrip` CLI:
//
//   node roundtrip-smoketest.mjs <profile.icc> [intent=1] [use_mpe=0] [iccRoundTrip-path]
//
// The CLI is the *ground truth for the underlying colour math* (not for the app's
// presentation): our RT1/RT2 min·mean·max + worst-Lab must match its Round Trip 1/2,
// and — critically — our IN-APP PRMG walk must reproduce CIccPRMG's five cumulative
// bucket counts exactly (min/mean/P90/max + worst-Lab are our additions on top). RT0
// is iccviz's own metric (no CLI counterpart) so it is printed, not asserted.
//
// Verified on Testing/CMYK-3DLUTs/CMYK-3DLUTs.icc (intent 1, mpe 0).
import createIccplot from './build/iccplot.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node roundtrip-smoketest.mjs <profile.icc> [intent=1] [use_mpe=0] [iccRoundTrip-path]');
  process.exit(1);
}
const intent = Number(process.argv[3] ?? 1);
const useMpe = (process.argv[4] ?? '0') !== '0';
const cliPath = process.argv[5] ??
  `${process.env.HOME}/code/iccdev/Build/Tools/IccRoundTrip/iccRoundTrip`;

const bytes = readFileSync(profilePath);
const mod = await createIccplot();
const r = JSON.parse(mod.roundTripStats(new Uint8Array(bytes), intent, useMpe));
if (r.error) { console.error('ERROR:', r.error); process.exit(1); }

const T = r.types || {};
const f2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—');
const lab = (a) => Array.isArray(a) ? a.map((v) => v.toFixed(4)).join(', ') : '—';

// ── print every type in the app's uniform shape ──────────────────────────────
console.log('Profile         :', profilePath);
console.log('Intent / useMpe :', r.intent, '/', r.useMpe);
for (const key of ['RT0', 'RT1', 'RT2', 'PRMG']) {
  const s = T[key];
  if (!s || s.ok === false) { console.log(`\n${key}: not evaluated${s?.message ? ` (${s.message})` : ''}`); continue; }
  console.log(`\n${key}  min/mean/P90/max :`, f2(s.min), f2(s.mean), f2(s.p90), f2(s.max),
              '  worst L,a,b:', lab(s.worstLab));
  if (Array.isArray(s.buckets))
    console.log(`${key}  ≤1/2/3/5/10      :`, s.buckets.join(' / '), ' total', s.total,
                key === 'PRMG' ? `  (implied=${s.implied})` : '');
}

// ── A/B against the native CLI ───────────────────────────────────────────────
let cliOut;
try {
  cliOut = execFileSync(cliPath, [profilePath, String(intent), useMpe ? '1' : '0'], { encoding: 'utf8' });
} catch (e) {
  console.log(`\n(skipped CLI A/B — could not run ${cliPath}: ${e.message})`);
  process.exit(0);
}

// Parse the CLI's Round Trip 1/2 min·mean·max and the five PRMG bucket counts.
const grab = (re) => { const m = cliOut.match(re); return m ? Number(m[1]) : NaN; };
const block = (name) => cliOut.slice(cliOut.indexOf(name));
const rt1b = block('Round Trip 1'), rt2b = block('Round Trip 2');
const cli = {
  rt1: {
    min:  Number((rt1b.match(/Min DeltaE:\s*([\d.-]+)/)  || [])[1]),
    mean: Number((rt1b.match(/Mean DeltaE:\s*([\d.-]+)/) || [])[1]),
    max:  Number((rt1b.match(/Max DeltaE:\s*([\d.-]+)/)  || [])[1]),
  },
  rt2: {
    min:  Number((rt2b.match(/Min DeltaE:\s*([\d.-]+)/)  || [])[1]),
    mean: Number((rt2b.match(/Mean DeltaE:\s*([\d.-]+)/) || [])[1]),
    max:  Number((rt2b.match(/Max DeltaE:\s*([\d.-]+)/)  || [])[1]),
  },
  prmg: {
    de1:  grab(/DE <= 1\.0 \(\s*(\d+)\)/),
    de2:  grab(/DE <= 2\.0 \(\s*(\d+)\)/),
    de3:  grab(/DE <= 3\.0 \(\s*(\d+)\)/),
    de5:  grab(/DE <= 5\.0 \(\s*(\d+)\)/),
    de10: grab(/DE <=10\.0 \(\s*(\d+)\)/),
  },
};

const fails = [];
// min/mean/max compared at the CLI's own 2-decimal precision.
const eq2 = (a, b) => f2(a) === (Number.isFinite(b) ? b.toFixed(2) : 'NaN');
for (const rt of ['rt1', 'rt2']) {
  for (const k of ['min', 'mean', 'max']) {
    const key = rt === 'rt1' ? 'RT1' : 'RT2';
    if (!eq2(T[key]?.[k], cli[rt][k])) fails.push(`${key}.${k}: wasm ${f2(T[key]?.[k])} vs cli ${cli[rt][k]}`);
  }
}
// PRMG buckets must match the CLI's CIccPRMG counts EXACTLY (integer counts).
const pb = Array.isArray(T.PRMG?.buckets) ? T.PRMG.buckets : [];
[['de1', 0], ['de2', 1], ['de3', 2], ['de5', 3], ['de10', 4]].forEach(([k, i]) => {
  if (pb[i] !== cli.prmg[k]) fails.push(`PRMG.${k}: wasm ${pb[i]} vs cli ${cli.prmg[k]}`);
});

console.log('\n── A/B vs native iccRoundTrip ──');
if (fails.length === 0) {
  console.log('PASS — RT1/RT2 min·mean·max match (2dp) and all 5 PRMG buckets match exactly.');
} else {
  console.log('FAIL:');
  for (const f of fails) console.log('  ✗', f);
  process.exit(1);
}
