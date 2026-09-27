// QUESTION: what time->x mapping does @strudel/draw's getPunchcardPainter use?
// Method: render ONE hap at a known cycle onto a white 500x180 canvas, read pixels
// back with getImageData, find the x-range with non-white pixels.
// Fixed frame: time=5, cycles=4, playhead=0.5  =>  window [3,7] if same as __pianoroll.
//
// RUN:  node --import ../daemon/register.mjs punchcard-calib.mjs
// (imports resolve via createRequire against the project dir, so cwd does not affect the imports;
//  the register.mjs shim must be preloaded with --import to alias @kabelsalat/web)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = `${path.join(HERE, '..', 'daemon')}/`;
const req = createRequire(PROJECT);
const draw = await import(req.resolve('@strudel/draw'));
const core = await import(req.resolve('@strudel/core'));
const { createCanvas } = await import(req.resolve('@napi-rs/canvas'));

const W = 500, H = 180;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

const ACTIVE = '#859900';   // rgb(133,153,0)
const INACTIVE = '#a6a6a6'; // rgb(166,166,166)
const PLAYHEAD = '#556b72'; // rgb(85,107,114)
const OPTS = {
  background: '#ffffff', active: ACTIVE, inactive: INACTIVE,
  playheadColor: PLAYHEAD, autorange: 1, labels: false, fillActive: true,
};

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const [AR, AG, AB] = hexToRgb(ACTIVE);
const [IR, IG, IB] = hexToRgb(INACTIVE);
const [PR, PG, PB] = hexToRgb(PLAYHEAD);
const isWhite = (r, g, b) => r > 250 && g > 250 && b > 250;
const match = (r, g, b, t, tol = 6) => Math.abs(r - t[0]) <= tol && Math.abs(g - t[1]) <= tol && Math.abs(b - t[2]) <= tol;

// Options are the FACTORY argument: getPunchcardPainter(opts) returns (ctx,time,haps,drawTime)
const painter = draw.getPunchcardPainter(OPTS);

function scan(hap) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  // 4th arg is the drawTime tuple [lookbehind, lookahead] (see getDrawOptions/`ve`):
  // cycles = |back|+fwd = 4, playhead = fwd/cycles = 0.5
  painter(ctx, 5, [hap], [-2, 2]);
  const d = ctx.getImageData(0, 0, W, H).data;
  let blockMin = Infinity, blockMax = -1, phMin = Infinity, phMax = -1;
  // playhead: scan row y=0 only (blocks are filled from y=1 down)
  for (let x = 0; x < W; x++) {
    const i0 = x * 4;
    if (!isWhite(d[i0], d[i0 + 1], d[i0 + 2])) { if (x < phMin) phMin = x; if (x > phMax) phMax = x; }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const i = (y * W + x) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (isWhite(r, g, b)) continue;
      if (match(r, g, b, [AR, AG, AB]) || match(r, g, b, [IR, IG, IB])) { if (x < blockMin) blockMin = x; if (x > blockMax) blockMax = x; }
    }
  }
  return { block: blockMax >= 0 ? [blockMin, blockMax] : null, playhead: phMax >= 0 ? [phMin, phMax] : null };
}

const mk = (a, b) => new core.Hap(new core.TimeSpan(a, b), new core.TimeSpan(a, b), { s: 'bd', note: 5 });

console.log('--- getPunchcardPainter, time=5 cycles=4 playhead=0.5 (drawTime [-2,2] -> full-height blocks) ---');
for (const c of [3, 4, 5, 6, 7]) {
  const { block, playhead } = scan(mk(c, c + 1));
  console.log(`cycle ${c}: block x=${block ? block.join('..') : 'none'}  playhead x=${playhead ? playhead.join('..') : 'none'}`);
}

// Verification: is getPunchcardPainter literally __pianoroll + merged opts?
console.log('--- cross-check: same haps via __pianoroll({cycles:4,playhead:0.5,...}) ---');
for (const c of [3, 4, 5, 6, 7]) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  draw.__pianoroll({ ctx, haps: [mk(c, c + 1)], time: 5, cycles: 4, playhead: 0.5, ...OPTS });
  const d = ctx.getImageData(0, 0, W, H).data;
  let mn = Infinity, mx = -1, pmn = Infinity, pmx = -1;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
    if (isWhite(r, g, b)) continue;
    if (match(r, g, b, [PR, PG, PB])) { if (x < pmn) pmn = x; if (x > pmx) pmx = x; }
    else if (match(r, g, b, [AR, AG, AB]) || match(r, g, b, [IR, IG, IB])) { if (x < mn) mn = x; if (x > mx) mx = x; }
  }
  console.log(`cycle ${c}: block x=${mx >= 0 ? mn + '..' + mx : 'none'}  playhead x=${pmx >= 0 ? pmn + '..' + pmx : 'none'}`);
}
