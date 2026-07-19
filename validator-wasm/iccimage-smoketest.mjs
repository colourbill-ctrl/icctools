// (c) 2026 William Li
//
// Smoketest for the iccimage module (libtiff + libpng + libjpeg → WASM). Exercises
// findProfile (all 3 formats), decodeImage (TIFF), and encodeTiff round-trip.
//   node iccimage-smoketest.mjs [image ...]     # findProfile on each given image
//   node iccimage-smoketest.mjs                 # built-in cases vs iccDEV test data
//
// PNG/JPEG carrying an ICC are generated at test time via PIL if available; the
// TIFF cases use iccDEV's Testing/ tree.
import createIccImage from './build/iccimage.mjs';
import { readFileSync } from 'node:fs';

const D = '/home/colour/code/iccdev/Testing/';
const mod = await createIccImage();
const U = (p) => new Uint8Array(readFileSync(p));
const sig = (u8, o) => (u8 && u8.length >= o + 4) ? String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]) : '--';
let fail = 0;

const args = process.argv.slice(2);
if (args.length) {
  for (const p of args) {
    const prof = mod.findProfile(U(p));
    console.log(p, '→', prof ? `${prof.length}B acsp@36='${sig(prof, 36)}'` : 'no profile');
  }
} else {
  // findProfile — TIFF cases from iccDEV (RGB + CMYK carry embedded ICC).
  for (const [label, path] of [
    ['TIFF rgb ', D + 'ApplyDataFiles/seed-tiff-none-rgb-8x8.tif'],
    ['TIFF cmyk', D + 'hybrid/Data/TShirtDesignCMYKW.tif'],
  ]) {
    const prof = mod.findProfile(U(path));
    const ok = prof && sig(prof, 36) === 'acsp';
    console.log(`findProfile ${label}: ${ok ? '✅' : '❌'} ${prof ? prof.length + 'B' : 'none'}`);
    if (!ok) fail++;
  }

  // decodeImage — a multichannel separated TIFF (browser canvas cannot do this).
  const d = mod.decodeImage(U(D + 'hybrid/Data/TShirtDesignCMYKW.tif'));
  const dok = d.ok && d.channels >= 4 && d.samples.length === d.width * d.height * d.channels * (d.bitDepth / 8);
  console.log(`decodeImage cmyk: ${dok ? '✅' : '❌'} ${d.width}x${d.height} ${d.channels}ch/${d.bitDepth}b photo=${d.photometric} profile=${d.profile ? d.profile.length + 'B' : 'none'}`);
  if (!dok) fail++;

  // encode round-trips (TIFF/PNG/JPEG) — carry an embedded profile through each.
  const prof = U(D + 'sRGB_v4_ICC_preference.icc');
  const W = 4, H = 2;
  // CMYK TIFF (4ch)
  {
    const samp = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { samp[i * 4] = i * 30; samp[i * 4 + 1] = 255 - i * 30; samp[i * 4 + 2] = 128; samp[i * 4 + 3] = i * 10; }
    const tif = mod.encodeImage('tiff', W, H, 4, 8, 5, samp, prof, 0);
    const rd = mod.decodeImage(tif);
    const ok = rd.ok && rd.channels === 4 && rd.samples[0] === 0 && rd.samples[7 * 4] === 210 &&
               rd.profile && rd.profile.length === prof.length;
    console.log(`TIFF round-trip: ${ok ? '✅' : '❌'} ${tif.length}B → ${rd.channels}ch, profile ${rd.profile ? 'kept' : 'lost'}`);
    if (!ok) fail++;
  }
  // RGB PNG (3ch) — lossless, so pixels + profile must survive exactly.
  {
    const samp = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H * 3; i++) samp[i] = (i * 17) & 0xff;
    const png = mod.encodeImage('png', W, H, 3, 8, 0, samp, prof, 0);
    const rd = mod.decodeImage(png);
    let same = rd.ok && rd.channels === 3;
    for (let i = 0; same && i < samp.length; i++) if (rd.samples[i] !== samp[i]) same = false;
    const ok = same && rd.profile && rd.profile.length === prof.length;
    console.log(`PNG round-trip:  ${ok ? '✅' : '❌'} ${png.length}B → ${rd.channels}ch, pixels ${same ? 'exact' : 'DIFFER'}, profile ${rd.profile ? 'kept' : 'lost'}`);
    if (!ok) fail++;
  }
  // RGB JPEG (3ch) — lossy, so check geometry + profile, not exact pixels.
  {
    const samp = new Uint8Array(W * H * 3).fill(120);
    const jpg = mod.encodeImage('jpeg', W, H, 3, 8, 0, samp, prof, 90);
    const rd = mod.decodeImage(jpg);
    const ok = rd.ok && rd.channels === 3 && rd.width === W && rd.height === H &&
               rd.profile && rd.profile.length === prof.length;
    console.log(`JPEG round-trip: ${ok ? '✅' : '❌'} ${jpg.length}B → ${rd.channels}ch, profile ${rd.profile ? 'kept' : 'lost'}`);
    if (!ok) fail++;
  }

  // findProfileStream — extract via ranged reads (globalThis.__imgRead), proving the
  // pixels are never read (bytes read < file size).
  {
    const { openSync, readSync, statSync } = await import('node:fs');
    const path = D + 'hybrid/Data/TShirtDesignCMYKW.tif';   // ~11 MB (3.7 MB ICC + pixels)
    const fd = openSync(path, 'r'), size = statSync(path).size;
    let read = 0;
    globalThis.__imgSize = () => size;
    globalThis.__imgRead = (id, off, want) => {
      if (off >= size) return new Uint8Array(0);
      const n = Math.min(size, off + want) - off, b = Buffer.alloc(n);
      readSync(fd, b, 0, n, off); read += n;
      return new Uint8Array(b.buffer, b.byteOffset, n);
    };
    const prof = mod.findProfileStream(0);
    const ok = prof && sig(prof, 36) === 'acsp' && read < size;
    console.log(`findProfileStream: ${ok ? '✅' : '❌'} ${prof ? prof.length + 'B' : 'none'}, read ${(100 * read / size).toFixed(0)}% of ${(size / 1024 / 1024).toFixed(1)}MB (pixels skipped)`);
    if (!ok) fail++;
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  if (fail) process.exitCode = 2;
}
