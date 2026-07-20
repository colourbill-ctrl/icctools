// (c) 2026 William Li
'use strict';
// scripts/generate-help.js
// Run with: node scripts/generate-help.js
// Regenerates frontend/public/help.html from MANUAL.md, including SVG layout
// diagrams that get inlined under matching section anchors.
//
// Pattern mirrors chardata's scripts/generate-help.js — same SHARED_STYLE,
// same markdown subset, same diagram-injection hook. Keep the two in sync
// when extending one of them.

const fs   = require('fs');
const path = require('path');
const OUT  = path.join(__dirname, '../frontend/public/help.html');

// ── SVG primitives ────────────────────────────────────────────────────────────

// Every selector is scoped under `.diag` (the class on each diagram's <svg>).
// An SVG <style> inside an HTML document is NOT shadow-scoped — its rules apply
// document-wide — so a bare `text{…}` or `:root{--tx…}` here would leak onto the
// app's own SVG graphs (viz/GraphSvg.jsx) when the guide panel injects these
// diagrams into the live DOM. Scoping to `.diag` also confines the CSS variables
// to the diagram subtree.
//
// Theming: the SAME help.html serves two contexts, so the diagrams follow both.
//   • In profiletool (GuidePanel), the app owns the theme — it sets `body.dark`
//     for dark and `body.light` for light (see SettingsBlade::applyTheme). So
//     `body.dark .diag` drives dark, and `body:not(.light)` guards the OS media
//     query so an app set to *light* on a dark-OS machine stays light.
//   • Standalone help.html has no body theme class, so the media query falls
//     through to the OS preference (`body:not(.light)` always matches there).
const DIAG_DARK = `
    --bg:#1a1c1f; --pnl:#22262e; --pnl-bd:#3a4048; --hd:#252930; --hd-bd:#3a4048;
    --sec:#1e2128; --sec-bd:#333a44; --btn:#252930; --btn-bd:#444;
    --act:#2a5a90; --act2:#1f4070; --red:#8a2a2a; --amber:#7a5418; --green:#1f6a3a;
    --tx:#c8cdd4; --tx2:#9aa0a8; --tx3:#555e6a; --txW:#c8cdd4; --txA:#7ab8e8;
    --ln:#2e3440;`;
const SHARED_STYLE = `
<style>
.diag {
  --bg:#f0f2f5; --pnl:#fff; --pnl-bd:#ccd6e0; --hd:#e8edf2; --hd-bd:#c0ccd8;
  --sec:#f5f6f8; --sec-bd:#dde4ec; --btn:#e8edf2; --btn-bd:#bbb;
  --act:#4a90e2; --act2:#2a6ab5; --red:#e24a4a; --amber:#d49930; --green:#27ae60;
  --tx:#333; --tx2:#555; --tx3:#888; --txW:#fff; --txA:#1a5a8a;
  --ln:#dde4ec;
}
body.dark .diag {${DIAG_DARK}
}
@media(prefers-color-scheme:dark){
  body:not(.light) .diag {${DIAG_DARK}
  }
}
.diag rect.bg    { fill:var(--bg); }
.diag rect.pnl   { fill:var(--pnl);  stroke:var(--pnl-bd); stroke-width:1.5; }
.diag rect.hd    { fill:var(--hd);   stroke:var(--hd-bd);  stroke-width:1; }
.diag rect.sec   { fill:var(--sec);  stroke:var(--sec-bd); stroke-width:1; }
.diag rect.btn   { fill:var(--btn);  stroke:var(--btn-bd); stroke-width:1; }
.diag rect.act   { fill:var(--act);  stroke:var(--act2);   stroke-width:1; }
.diag rect.red   { fill:var(--red);  stroke:#a03030;       stroke-width:1; }
.diag rect.amber { fill:var(--amber);stroke:#a07418;       stroke-width:1; }
.diag rect.green { fill:var(--green);stroke:#1f7a44;       stroke-width:1; }
.diag rect.lnbd  { fill:none; stroke:var(--ln); stroke-width:1; }
.diag line.div   { stroke:var(--ln); stroke-width:1; }
.diag text       { font-family:Arial,sans-serif; font-size:11px; fill:var(--tx); }
.diag text.tT    { font-size:13px; font-weight:bold; fill:var(--txA); }
.diag text.tB    { font-weight:bold; }
.diag text.t2    { fill:var(--tx2); }
.diag text.t3    { fill:var(--tx3); font-size:10px; }
.diag text.tW    { fill:var(--txW); }
.diag text.tA    { fill:var(--txA); font-weight:bold; }
.diag text.mono  { font-family:ui-monospace,Menlo,Consolas,monospace; }
</style>`;

function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" class="diag" viewBox="0 0 ${w} ${h}"
  style="width:100%;max-width:${w}px;display:block;margin:20px 0;border-radius:8px;overflow:visible;">
${SHARED_STYLE}
${body}
</svg>`;
}

const R = (x,y,w,h,cls,rx=5) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" class="${cls}"/>`;

const T = (x,y,s,cls='',anchor='middle') =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${s}</text>`;

const L = (x1,y1,x2,y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="div"/>`;

function callout(lx, ly, tx, ty, label, cls='t3') {
  return `<line x1="${lx}" y1="${ly}" x2="${tx}" y2="${ty}" stroke="var(--tx3)" stroke-width="1" stroke-dasharray="3,2"/>
${T(tx, ty - 3, label, cls, tx > lx ? 'start' : 'end')}`;
}

// ── Diagram 1: Overall layout (profile loaded) ───────────────────────────────
function diag_layout() {
  const W = 780, H = 420;
  const CX = 30, CW = 640;             // centred card
  const BX = 700, BW = 70;             // right blade (collapsed-ish slice w/ tab column)

  let b = '';
  b += R(0,0,W,H,'bg',0);

  // Main card
  b += R(CX,10,CW,H-20,'pnl',8);

  // Title row + banner
  b += T(CX+20, 36, 'ICC Profile Tool', 'tT', 'start');
  b += T(CX+20, 60, 'Upload an ICC profile to validate it against the ICC.1 specification', 't3', 'start');
  b += T(CX+20, 74, 'using the iccDEV reference implementation.', 't3', 'start');
  b += L(CX+20, 84, CX+CW-20, 84);

  // Toolbar
  b += R(CX+20, 96, 110, 22, 'act', 4);
  b += T(CX+20+55, 111, 'Save ICC profile', 'tW tB');
  b += R(CX+136, 96, 100, 22, 'btn', 4);
  b += T(CX+136+50, 111, 'Load another', 't2');
  b += R(CX+244, 100, 130, 16, 'lnbd', 3);
  b += T(CX+244+65, 112, '● Modified — unsaved', 'tA');

  // Profile viewer card
  const VY = 130;
  b += R(CX+20, VY, CW-40, H-VY-30, 'pnl', 6);

  // Title bar inside viewer
  b += R(CX+20, VY, CW-40, 28, 'sec', 6);
  b += T(CX+30, VY+18, 'sample-cmyk.icc', 'tB mono', 'start');
  b += T(CX+150, VY+18, '· 488 bytes · IccProfLib 2.3.1', 't3', 'start');
  b += R(CX+CW-80, VY+6, 50, 16, 'green', 3);
  b += T(CX+CW-55, VY+18, 'VALID', 'tW tB');

  // Tab strip
  const TY = VY+28;
  const tabs = [['Header', true], ['Tags', false], ['Validation', false], ['Analysis', false], ['XML', false], ['JSON', false]];
  let tx = CX+30;
  for (const [label, active] of tabs) {
    const tw = label === 'Header' ? 60 : label === 'Validation' || label === 'Analysis' ? 78 : label === 'Tags' ? 70 : 50;
    if (active) {
      b += `<line x1="${tx}" y1="${TY+30}" x2="${tx+tw}" y2="${TY+30}" stroke="var(--act)" stroke-width="3"/>`;
      b += T(tx + tw/2, TY+20, label, 'tA');
    } else {
      b += T(tx + tw/2, TY+20, label, 't2');
    }
    if (label === 'Tags') {
      b += R(tx+tw-22, TY+9, 20, 12, 'act', 6);
      b += T(tx+tw-12, TY+19, '14', 'tW');
    }
    tx += tw + 6;
  }
  b += L(CX+20, TY+32, CX+CW-20, TY+32);

  // Profile-ID strip (Header content)
  const PY = TY+44;
  b += R(CX+30, PY, CW-60, 24, 'sec', 4);
  b += T(CX+40, PY+15, 'PROFILE ID', 't3 tB', 'start');
  b += T(CX+120, PY+15, '9efa8dc6c12f4e0b8b3a04e6c5a6e51c', 'tA mono', 'start');

  // Header table rows
  const rowH = 18;
  const rows = [
    ['Profile Class',     'Output Profile'],
    ['Data Color Space',  'CMYK'],
    ['PCS',               'Lab'],
    ['Profile Version',   '4.30.00'],
    ['Rendering Intent',  'Perceptual'],
    ['Creation Date',     '2025-08-14 10:24:09 UTC'],
    ['Cmm',               'Adobe ACMS'],
    ['Platform',          'Apple'],
  ];
  for (let i = 0; i < rows.length; i++) {
    const ry = PY + 28 + i*rowH;
    if (i % 2 === 0) b += R(CX+30, ry, CW-60, rowH, 'sec', 0);
    b += T(CX+40, ry+12, rows[i][0], 't3', 'start');
    b += T(CX+220, ry+12, rows[i][1], 't2', 'start');
  }

  // Right settings blade — collapsed bar with tab column floating off the edge
  b += R(BX, 10, 6, H-20, 'pnl', 0);          // narrow bar (collapsed state)
  b += R(BX+6, 30, 38, 34, 'btn', 5);          // ⚙
  b += T(BX+25, 51, '⚙', 't2 tB');
  b += R(BX+6, 70, 38, 34, 'btn', 5);          // ?
  b += T(BX+25, 91, '?', 't2 tB');
  b += R(BX+6, 110, 38, 34, 'btn', 5);         // ✉
  b += T(BX+25, 131, '✉', 't2');

  // Callouts
  b += callout(CX+20+55, 111, CX+20+55, 88, 'Toolbar', 't3');
  b += callout(CX+CW-55, VY+18, CX+CW-55, VY-2, 'Validity badge', 't3');
  b += callout(CX+150, TY+19, CX+CW-100, TY+8, 'Tabs · count badge on Tags', 't3');
  b += callout(BX+25, 51, BX-10, 51, '⚙ Settings', 't3');
  b += callout(BX+25, 91, BX-10, 91, '? Help', 't3');
  b += callout(BX+25, 131, BX-10, 131, '✉ Contact', 't3');

  return svg(W, H, b);
}

// ── Diagram 2: Settings panel (Display group) ────────────────────────────────
function diag_settings() {
  const W = 380;
  const PX = 50, PW = W - PX - 14;
  const VALW = 130;
  const VALX = PX + PW - VALW - 4;

  let content = '';
  let gy = 56;

  const row = (label, value) => {
    content += T(PX + 4, gy + 13, label, 't3 tB', 'start');
    content += R(VALX, gy, VALW, 22, 'btn', 4);
    content += T(VALX + 10, gy + 15, value, 't2', 'start');
    content += T(VALX + VALW - 10, gy + 15, '▾', 't3', 'end');
    gy += 30;
  };
  const section = (label) => {
    content += T(PX + 4, gy + 13, label, 'tA tB', 'start');
    gy += 22;
  };

  section('Display');
  row('Background', 'System');
  row('Language', 'System default (English)');

  const H = gy + 18;

  let chrome = '';
  chrome += R(0, 0, W, H, 'bg', 0);
  chrome += R(8, 8, W - 16, H - 16, 'pnl', 8);

  // Tab column on the inner (left) edge
  chrome += R(8, 24, 38, 34, 'btn', 5);    chrome += T(27, 45, '⚙', 't2 tB');
  chrome += R(8, 64, 38, 34, 'btn', 5);    chrome += T(27, 85, '?', 't2 tB');
  chrome += R(8, 104, 38, 34, 'btn', 5);   chrome += T(27, 125, '✉', 't2');
  chrome += L(46, 8, 46, H - 8);

  // Heading
  chrome += T(PX + 4, 32, 'Settings', 'tT', 'start');
  chrome += L(PX, 44, PX + PW, 44);

  return svg(W, H, chrome + content);
}

// ── Diagram 3: Combine tab (Link Pipeline) ───────────────────────────────────
function diag_combine() {
  const W = 780, H = 452;
  let b = R(0,0,W,H,'bg',0);

  // Pool pane (left)
  const PX = 16, PW = 150;
  b += R(PX,12,PW,H-24,'pnl',8);
  b += R(PX,12,PW,26,'hd',8);
  b += T(PX+12,29,'Profiles','tB','start');
  const chips = ['sRGB.icc','Coated.icc'];
  for (let i=0;i<chips.length;i++){
    const cy = 48 + i*34;
    b += R(PX+10, cy, PW-20, 28, 'sec', 5);
    b += T(PX+20, cy+18, chips[i], 't2 mono', 'start');
  }
  b += T(PX+10, 132, 'Drag into the chain →', 't3', 'start');

  // Combine card (centre/right)
  const CX = 186, CW = W-CX-16;
  b += R(CX,12,CW,H-24,'pnl',8);
  b += T(CX+16,32,'Combine — Link Pipeline','tT','start');
  b += T(CX+16,48,'Chain profiles, then make a DeviceLink or transform an image / dataset.','t3','start');
  b += L(CX+16,56,CX+CW-16,56);

  // Drop slots
  b += R(CX+16,64,270,32,'sec',6);
  b += T(CX+28,84,'🖼  Drop an image (TIFF/PNG/JPEG)','t2','start');
  b += R(CX+296,64,CW-312,32,'sec',6);
  b += T(CX+308,84,'🔢  Drop a dataset (CGATS/CSV/CxF)','t2','start');

  // Global rendering intent
  b += T(CX+16,116,'Rendering intent (all)','t3','start');
  b += R(CX+150,104,150,18,'btn',4);
  b += T(CX+156,116,'Relative Colorimetric','t2','start');

  // Vertical chain — two stages with a connecting space between
  const stage = (y, num, name, from, to, ri) => {
    let s = R(CX+16, y, CW-32, 38, 'sec', 6);
    s += T(CX+30, y+23, '⠿', 't3', 'start');
    s += R(CX+44, y+11, 16, 16, 'act', 4);
    s += T(CX+52, y+23, num, 'tW tB');
    s += T(CX+70, y+23, name, 't2 mono', 'start');
    s += T(CX+CW-150, y+23, from+' → '+to, 't3', 'start');
    s += R(CX+CW-58, y+10, 42, 18, 'btn', 4);
    s += T(CX+CW-37, y+23, ri, 't2');
    return s;
  };
  b += stage(130,'1','sRGB.icc','RGB','Lab','Rel');
  // connector + connecting-space chip
  b += `<line x1="${CX+52}" y1="168" x2="${CX+52}" y2="180" stroke="var(--ln)" stroke-width="2"/>`;
  b += R(CX+CW/2-24,170,48,14,'lnbd',7);
  b += T(CX+CW/2,181,'Lab','t3');
  b += stage(184,'2','Coated.icc','Lab','CMYK','Perc');

  // Chain summary
  b += T(CX+16,244,'Chain:','t3','start');
  b += T(CX+58,244,'RGB → CMYK','tA','start');

  // Action buttons
  const btn = (x,label) => R(x,256,124,24,'act',5) + T(x+62,272,label,'tW tB');
  b += btn(CX+16,'Make DeviceLink');
  b += btn(CX+148,'Transform Image');
  b += btn(CX+280,'Transform Data');

  // Image output-options panel
  const OY = 296;
  b += R(CX+16, OY, CW-32, 96, 'sec', 6);
  b += T(CX+28, OY+18, 'Image output options', 'tB', 'start');
  const opt = (x,y,lab,val) => T(x,y,lab,'t3','start') + R(x, y+6, 96, 16, 'btn', 4) + T(x+48, y+18, val, 't2');
  b += opt(CX+28,  OY+34, 'Encoding',        'Same as source');
  b += opt(CX+140, OY+34, 'Compression',     'None');
  b += opt(CX+252, OY+34, 'Planar',          'Composite');
  b += opt(CX+28,  OY+70, 'CMM interp.',     'Tetrahedral');
  b += opt(CX+140, OY+70, 'Embed ICC',       '☑ yes');

  // Callouts point LEFT (tx < lx) so callout()'s 'end' anchoring keeps the label inside
  // the canvas — a right-pointing label here would run past the 780px viewBox.
  b += callout(CX+CW-37, 138, CX+CW-120, 118, 'Per-stage intent', 't3');
  b += callout(CX+CW-140, OY+4, CX+CW-170, OY-10, 'iccApplyProfiles output knobs', 't3');

  return svg(W, H, b);
}

// ── Markdown → HTML (subset) ─────────────────────────────────────────────────
// Lifted from chardata/scripts/generate-help.js so output formatting matches.
function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false, inList = false, inPara = false;

  const flush = () => {
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
    if (inList)  { out.push('</ul>'); inList = false; }
    if (inPara)  { out.push('</p>'); inPara = false; }
  };

  const inline = s => s
    .replace(/\\\*/g, '').replace(/\\_/g, '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(//g, '*').replace(//g, '_');

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{4}\s/.test(l))      { flush(); out.push(`<h4>${inline(l.replace(/^#{4}\s/,''))}</h4>`); }
    else if (/^#{3}\s/.test(l)) { flush(); out.push(`<h3 id="${slug(l)}">${inline(l.replace(/^#{3}\s/,''))}</h3>`); }
    else if (/^#{2}\s/.test(l)) { flush(); out.push(`<h2 id="${slug(l)}">${inline(l.replace(/^#{2}\s/,''))}</h2>`); }
    else if (/^#{1}\s/.test(l)) { flush(); out.push(`<h1>${inline(l.replace(/^#{1}\s/,''))}</h1>`); }
    else if (/^---$/.test(l))   { flush(); out.push('<hr>'); }
    else if (/^\|/.test(l)) {
      if (!inTable) {
        flush();
        out.push('<table><thead>');
        const hcells = l.split('|').filter((_,i,a)=>i>0&&i<a.length-1).map(c=>`<th>${inline(c.trim())}</th>`);
        out.push('<tr>' + hcells.join('') + '</tr></thead><tbody>');
        i++; // skip separator row
        inTable = true;
      } else {
        const cells = l.split('|').filter((_,i,a)=>i>0&&i<a.length-1).map(c=>`<td>${inline(c.trim())}</td>`);
        out.push('<tr>' + cells.join('') + '</tr>');
      }
    }
    else if (/^- /.test(l)) {
      if (!inList) { flush(); out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(l.replace(/^- /,''))}</li>`);
    }
    else if (/^\s*<\/?\w/.test(l)) {
      flush();
      out.push(l);
    }
    else if (l.trim() === '') {
      flush();
    }
    else {
      if (!inPara) { out.push('<p>'); inPara = true; }
      else out.push(' ');
      out.push(inline(l));
    }
  }
  flush();
  return out.join('\n').replace(/<p>\n([^\n]*)\n<\/p>/g, '<p>$1</p>');
}

function slug(h) {
  return h.replace(/^#+\s*/,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
}

// ── Assemble help.html ────────────────────────────────────────────────────────
const manual = fs.readFileSync(path.join(__dirname, '../MANUAL.md'), 'utf8');

// Strip the H1 title (replaced by hardcoded HTML below) plus the optional
// single-line "ICC Profile Tool is a …" subtitle that may follow.
const stripped = manual
  .replace(/^#[^#].*\n+/, '');

// Split into intro (before the first `---`) and body (after it). The same
// pattern as chardata's generator keeps the markdown source readable as a
// standalone document while letting the generator drop a separate <nav>
// table-of-contents above the body.
const firstDash = stripped.indexOf('\n---\n');
const introMd = firstDash === -1 ? '' : stripped.slice(0, firstDash).trim();
const bodyMd  = firstDash === -1
  ? stripped
  : stripped.slice(firstDash).replace(/^\n---\n[\s\S]*?\n---\n+/, '');

function insertAfter(html, marker, injection) {
  const idx = html.indexOf(marker);
  if (idx === -1) return html;
  const end = html.indexOf('\n', idx) + 1;
  return html.slice(0, end) + injection + html.slice(end);
}

const intro = mdToHtml(introMd);
let body = mdToHtml(bodyMd);
body = insertAfter(body, 'id="1-loading-a-profile"', '\n' + diag_layout());
body = insertAfter(body, 'id="2-settings-panel"',    '\n' + diag_settings());
body = insertAfter(body, 'id="4-combine-tab"',       '\n' + diag_combine());

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ICC Profile Tool — Help</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, 'Noto Sans SC', 'Hiragino Sans', 'Microsoft YaHei', 'Apple SD Gothic Neo', sans-serif; background: #f0f2f5; color: #333; line-height: 1.6; }
    .page { max-width: 860px; margin: 0 auto; padding: 40px 24px 80px; }
    h1 { font-size: 24px; color: #1a5a8a; margin-bottom: 6px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    h2 { font-size: 17px; color: #1a5a8a; margin: 36px 0 10px; padding-bottom: 5px; border-bottom: 2px solid #d0e6f5; }
    h3 { font-size: 14px; font-weight: bold; color: #333; margin: 20px 0 6px; }
    h4 { font-size: 13px; font-weight: bold; color: #555; margin: 14px 0 4px; }
    p { font-size: 14px; margin-bottom: 10px; }
    ul, ol { font-size: 14px; margin: 8px 0 10px 24px; }
    li { margin-bottom: 4px; }
    code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; background: #e8edf2; padding: 1px 5px; border-radius: 3px; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; font-size: 13px; }
    th { background: #e8edf2; text-align: left; padding: 6px 10px; border: 1px solid #ccd6e0; font-weight: bold; color: #444; }
    td { padding: 5px 10px; border: 1px solid #dde4ec; vertical-align: top; }
    tr:nth-child(even) td { background: #f7f9fb; }
    .note { background: #fff8e6; border-left: 3px solid #f0b429; padding: 8px 12px; font-size: 13px; margin: 10px 0; border-radius: 0 4px 4px 0; }
    nav { background: #fff; border: 1px solid #dde; border-radius: 8px; padding: 16px 20px; margin-bottom: 32px; font-size: 13px; }
    nav ol { margin-left: 18px; }
    nav li { margin-bottom: 3px; }
    nav a { color: #1a5a8a; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    hr { border: none; border-top: 1px solid #dde; margin: 32px 0; }
    strong { color: #222; }
    section { margin-bottom: 8px; }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1c1f; color: #d0d4da; }
      h1 { color: #7ab8e8; }
      h2 { color: #7ab8e8; border-bottom-color: #2a4a60; }
      h3 { color: #c8cdd4; }
      h4 { color: #9aa0a8; }
      code { background: #2a2e35; color: #a8d4f0; }
      table { color: #c8cdd4; }
      th { background: #252930; border-color: #3a4048; color: #9aa0a8; }
      td { border-color: #2e3440; }
      tr:nth-child(even) td { background: #1e2128; }
      .note { background: #2a2410; border-left-color: #c08820; color: #c8b880; }
      nav { background: #22262e; border-color: #333a44; }
      nav a { color: #7ab8e8; }
      hr { border-top-color: #2e3440; }
      strong { color: #e0e4ea; }
      .subtitle { color: #666e7a; }
    }
  </style>
</head>
<body>
<div class="page">

  <h1>ICC Profile Tool — Help</h1>
  <p class="subtitle">Browser-based ICC profile inspector, validator, and round-trip editor</p>

${intro}

  <nav>
    <strong>Contents</strong>
    <ol>
      <li><a href="#1-loading-a-profile">Loading a profile</a></li>
      <li><a href="#2-settings-panel">Settings panel</a></li>
      <li><a href="#3-profile-views">Profile views</a>
        <ol>
          <li><a href="#3-1-header">Header</a></li>
          <li><a href="#3-2-tags">Tags</a></li>
          <li><a href="#3-3-validation">Validation</a></li>
          <li><a href="#3-4-analysis">Analysis</a></li>
          <li><a href="#3-5-xml">XML</a></li>
          <li><a href="#3-6-json">JSON</a></li>
        </ol>
      </li>
      <li><a href="#4-combine-tab">Combine tab</a>
        <ol>
          <li><a href="#4-1-building-a-chain">Building a chain</a></li>
          <li><a href="#4-2-make-devicelink">Make DeviceLink</a></li>
          <li><a href="#4-3-transform-image">Transform Image</a></li>
          <li><a href="#4-4-transform-data">Transform Data</a></li>
          <li><a href="#4-5-v4-display-maker">V4 Display maker</a></li>
          <li><a href="#4-6-compare-and-spectral-tabs">Compare and Spectral tabs</a></li>
        </ol>
      </li>
      <li><a href="#5-round-trip-editing">Round-trip editing</a></li>
      <li><a href="#6-launching-from-chardata">Launching from chardata</a></li>
      <li><a href="#7-launching-with-a-url">Launching with a URL</a></li>
      <li><a href="#8-mobile">Mobile</a></li>
      <li><a href="#9-limits-and-security">Limits and security</a></li>
    </ol>
  </nav>

${body}

</div>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('Written: ' + OUT);
