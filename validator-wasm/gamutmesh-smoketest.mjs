// (c) 2026 William Li
//
// Smoketest for the iccplot `gamutMesh` export — the gamut-boundary surface behind
// the Compare-tab 3-D gamut / 2-D slice. Loads a profile, builds the mesh for one
// rendering intent (built from the profile's device→PCS transform — LUT or matrix),
// and checks the geometry is well-formed:
//
//   node gamutmesh-smoketest.mjs <profile.icc> [intent=1] [steps=0]
//
// Verifies: vertices/triangles present, every triangle index in range, Lab bounds
// sane, and reports the finite-vertex fraction (non-finite verts are allowed — the
// renderer drops triangles that touch them). Works for matrix profiles (AdobeRGB) too.
import createIccPlot from './build/iccplot.mjs';
import { readFileSync } from 'node:fs';

const [path, intentArg = '1', stepsArg = '0'] = process.argv.slice(2);
if (!path) {
  console.error('Usage: node gamutmesh-smoketest.mjs <profile.icc> [intent=1] [steps=0]');
  process.exit(1);
}
const intent = parseInt(intentArg, 10);
const steps = parseInt(stepsArg, 10);

const mod = await createIccPlot();
const bytes = new Uint8Array(readFileSync(path));

const m = mod.gamutMesh(bytes, intent, steps);
if (m.error) { console.error('gamutMesh error:', m.error); process.exit(1); }

const verts = m.vertices;     // Float32Array, 3/vertex
const tris = m.triangles;     // Int32Array, 3/triangle
const nV = verts.length / 3;
const nT = tris.length / 3;

console.log('Profile      :', path);
console.log('Intent       :', intent);
console.log('nColorants   :', m.nColorants, '| samplesPerAxis(S):', m.samplesPerAxis);
console.log('Vertices     :', nV, '| Triangles:', nT);

// Index bounds.
let badIdx = 0;
for (let i = 0; i < tris.length; i++) if (tris[i] < 0 || tris[i] >= nV) badIdx++;

// Finite fraction + Lab bounds over finite verts.
let finite = 0;
let Lmin = Infinity, Lmax = -Infinity, amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
for (let i = 0; i < nV; i++) {
  const L = verts[i * 3], a = verts[i * 3 + 1], b = verts[i * 3 + 2];
  if (Number.isFinite(L) && Number.isFinite(a) && Number.isFinite(b)) {
    finite++;
    if (L < Lmin) Lmin = L; if (L > Lmax) Lmax = L;
    if (a < amin) amin = a; if (a > amax) amax = a;
    if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
}

const fmt = (x) => x.toFixed(1);
console.log('Finite verts :', finite, `(${((finite / nV) * 100).toFixed(1)}%)`);
console.log('L* range     :', fmt(Lmin), '…', fmt(Lmax));
console.log('a* range     :', fmt(amin), '…', fmt(amax));
console.log('b* range     :', fmt(bmin), '…', fmt(bmax));
console.log('Index check  :', badIdx === 0 ? '✅ all triangle indices in range' : `❌ ${badIdx} out-of-range indices`);

const ok = badIdx === 0 && nV > 0 && nT > 0 && finite > 8 &&
           Lmin >= -5 && Lmax <= 105 && amin >= -160 && amax <= 160 && bmin >= -160 && bmax <= 160;
console.log('Verdict      :', ok ? '✅ mesh well-formed' : '❌ mesh looks wrong');
process.exit(ok ? 0 : 2);
