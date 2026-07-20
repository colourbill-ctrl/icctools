// (c) 2026 William Li
//
// Smoketest for the QC analyses added alongside the neutral-axis tone/dE curves:
//   whiteBlackPoints  — media white/black in relative + absolute, black inking, TAC
//   hueExtrema        — per-hue full-tone vs maximum-chroma colorimetry
//   shadowInkPaths    — four constant-L* sweeps through a B2A table
//   renderGraph       — neutral-axis graph, now carrying "tone" and "de" series
//
// Reference numbers to compare against, from QC_Gracol2013_PF.pdf p.1 (GRACoL2013_CRPC6):
//   White Pt LabREL = 100.0  0.000  0.000   | LabABS = 95.02 0.980 -4.02
//   Black Pt LabREL =  10.80 0.070  0.199   | LabABS =  9.65 0.293 -0.734
//   Inking at BP    = 0.845 0.751 0.603 1.000 | TAC = 3.20
//   Cyan <H C L>    = 231.0 62.41 59.23 (max C* identical -> no over-inking)
// Run against that profile to check parity; any other CMYK profile only exercises
// the code paths.
import createIccModule from './build/iccplot.mjs';
import { readFileSync } from 'node:fs';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node qc-smoketest.mjs <profile.icc> [B2A tag, default B2A1]');
  process.exit(1);
}
const tagSig = process.argv[3] || 'B2A1';

const bytes = new Uint8Array(readFileSync(profilePath));
const mod = await createIccModule();

const f = (n, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const lab = (a) => (a ? a.map((v) => f(v, 3)).join('  ') : '—');

// ── Q2: extrema colorimetry ──────────────────────────────────────────────────
console.log('=== whiteBlackPoints (' + tagSig + ') ===');
const wb = JSON.parse(mod.whiteBlackPoints(bytes, tagSig));
if (wb.error) {
  console.log('  error:', wb.error);
} else {
  console.log('  colorants   :', wb.nColorants, '| hasAbsolute:', wb.hasAbsolute);
  console.log('  White LabREL:', lab(wb.whiteLabRel));
  console.log('  White LabABS:', lab(wb.whiteLabAbs));
  console.log('  Black LabREL:', lab(wb.blackLabRel));
  console.log('  Black LabABS:', lab(wb.blackLabAbs));
  console.log('  Inking at BP:', wb.blackInk.map((v) => f(v, 3)).join('  '));
  console.log('  TAC         :', f(wb.tac, 3), '=', f(wb.tac * 100, 1) + '%');
}

// ── Q3: per-hue extrema ──────────────────────────────────────────────────────
console.log('\n=== hueExtrema ===');
const he = JSON.parse(mod.hueExtrema(bytes));
if (he.error) {
  console.log('  error:', he.error);
} else {
  console.log('  name      full-tone <H C L>            max-C* <H C L>              ramp   inks');
  for (const e of he.entries) {
    const ft = e.fullToneHCL.map((v) => f(v, 2).padStart(7)).join(' ');
    const mc = e.maxChromaHCL.map((v) => f(v, 2).padStart(7)).join(' ');
    const ink = e.maxChromaInk.map((v) => f(v, 3)).join(' ');
    console.log(`  ${e.name.padEnd(8)} ${ft}   ${mc}   ${f(e.rampFraction, 2)}   ${ink}`);
  }
  // The diagnosis: full tone and max chroma should coincide on a sane profile.
  const drift = he.entries.filter((e) => e.rampFraction < 0.999);
  console.log('  corners whose max chroma is BEFORE full tone (over-inking):',
    drift.length ? drift.map((e) => `${e.name}@${f(e.rampFraction, 2)}`).join(', ') : 'none');
}

// ── Q5: shadow ink paths ─────────────────────────────────────────────────────
console.log('\n=== shadowInkPaths (' + tagSig + ') ===');
const sp = JSON.parse(mod.shadowInkPaths(bytes, tagSig));
if (sp.error) {
  console.log('  error:', sp.error);
} else {
  console.log('  L* raw:', f(sp.lStarRaw, 2), '| L* used:', f(sp.lStar, 2),
              '| BPC applied:', sp.bpcApplied);
  for (const g of sp.graphs) {
    const n = g.series[0]?.points.length / 2;
    // Report each channel's range across the sweep — a flat 0 would mean the path
    // never engaged that colorant, which is worth noticing.
    const ranges = g.series.map((s) => {
      const ys = [];
      for (let i = 1; i < s.points.length; i += 2) ys.push(s.points[i]);
      return `${s.name}:${f(Math.min(...ys), 0)}-${f(Math.max(...ys), 0)}`;
    });
    console.log(`  ${g.title.padEnd(8)} ${n} pts  ${ranges.join('  ')}`);
  }
}

// ── Q1: neutral-axis graph now carries tone + dE ─────────────────────────────
console.log('\n=== neutral axis graph (' + tagSig + ') ===');
const descs = JSON.parse(mod.enumerate(bytes));
const nd = descs.find?.((d) => d.kind === 8 && d.title?.includes(tagSig))
        || descs.find?.((d) => d.kind === 8);
if (!nd) {
  console.log('  no neutral-axis visualization enumerated');
} else {
  const g = JSON.parse(mod.renderGraph(bytes, nd.id));
  if (g.error) {
    console.log('  error:', g.error);
  } else {
    console.log('  id:', nd.id, '| hasY2:', g.hasY2, '| y2:', g.y2Axis?.label);
    for (const s of g.series) {
      const ys = [];
      for (let i = 1; i < s.points.length; i += 2) ys.push(s.points[i]);
      console.log(`   ${s.id.padEnd(6)} ${s.name.padEnd(10)} useY2=${String(s.useY2).padEnd(5)}` +
                  ` n=${ys.length} range ${f(Math.min(...ys), 3)} .. ${f(Math.max(...ys), 3)}`);
    }
    // The tone curve's low plateau is the media black point; print it so it can be
    // checked against whiteBlackPoints above (they must agree).
    const tone = g.series.find((s) => s.id === 'tone');
    if (tone) {
      const ys = [];
      for (let i = 1; i < tone.points.length; i += 2) ys.push(tone.points[i]);
      console.log('   tone curve floor (= media black L*):', f(Math.min(...ys), 3),
                  '| whiteBlackPoints black L*:', f(wb.blackLabRel?.[0], 3));
    }
  }
}
