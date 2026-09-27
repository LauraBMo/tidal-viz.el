// QUESTION: does `smear' give usable motion trails on @strudel/draw's __pianoroll,
// or does it saturate the canvas to solid colour?  What value should STYLES.trails use?
//
// Method: render 20 consecutive frames with a shifting `time' (so content moves)
// onto ONE canvas at smear 0, 0.2, 0.5, 0.8, and after each frame count ink =
// pixels that are neither the background colour nor fully transparent.
//
// TWO VARIANTS, because __pianoroll only skips its own clear when smear is truthy
// (verified from fn.toString(): `u || (clearRect(...), fillRect(...))`) while the
// daemon calls clearRect itself before every frame -- which would wipe the
// accumulation smear exists to create.
//   "daemon clearRect" = clearRect() before each __pianoroll call  (today's code)
//   "no clearRect"     = leave the canvas alone between frames    (what trails needs)
//
// RUN: node --import ../daemon/register.mjs \
//        smear-trajectory.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = `${path.join(HERE, '..', 'daemon')}/`;
const req = createRequire(PROJECT);
const draw = await import(req.resolve('@strudel/draw'));
const core = await import(req.resolve('@strudel/core'));
const { createCanvas } = await import(req.resolve('@napi-rs/canvas'));

const W = 500, H = 180;
const BACKGROUND = '#ffffff';
const ACTIVE = '#859900';
const INACTIVE = '#a6a6a6';
const PLAYHEAD = '#556b72';

// Same window geometry the daemon uses: lookbehind 2 + lookahead 0.5.
const CYCLES = 2.5;
const PLAYHEAD_FRAC = 2 / 2.5;

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const [BR, BG, BB] = hexToRgb(BACKGROUND);

// ---- haps: the real capture, tiled in cycles so a moving window never empties --
const CAPTURE =
  path.join(HERE, 'data', 'events.jsonl');

function captureEvents() {
  const out = [];
  for (const line of readFileSync(CAPTURE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const { packet } = JSON.parse(line);
    const walk = (x) => {
      if (x.bundle) return x.elements.forEach(walk);
      if (x.address !== '/dirt/play') return;
      const o = {};
      for (let i = 0; i + 1 < x.args.length; i += 2) o[x.args[i]] = x.args[i + 1];
      if (typeof o.cycle !== 'number' || typeof o.delta !== 'number' || !o.cps) return;
      out.push({ cycle: o.cycle, delta: o.delta, cps: o.cps, orbit: o.orbit ?? 0, s: o.s, note: o.note ?? o.n });
    };
    walk(packet);
  }
  return out;
}

const base = captureEvents();
const period = Math.max(...base.map((e) => e.cycle + e.delta * e.cps)) + 0.25;
const haps = [];
const rowForSample = new Map();
for (let k = 0; k < 6; k++) {
  for (const e of base) {
    const c0 = e.cycle + k * period;
    const c1 = c0 + e.delta * e.cps;
    const ts = new core.TimeSpan(c0, c1);
    let row = e.note;
    if (row === undefined) {
      if (!rowForSample.has(e.s)) rowForSample.set(e.s, rowForSample.size);
      row = rowForSample.get(e.s);
    }
    haps.push(new core.Hap(ts, ts, { s: e.s, note: row }));
  }
}

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

function inkPercent() {
  const d = ctx.getImageData(0, 0, W, H).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue; // fully transparent
    if (Math.abs(d[i] - BR) <= 2 && Math.abs(d[i + 1] - BG) <= 2 && Math.abs(d[i + 2] - BB) <= 2) continue;
    ink++;
  }
  return (100 * ink) / (W * H);
}

function run(smear, clearEach, frames = 20) {
  // Start from a clean slate for each run, then never clear again if !clearEach.
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, W, H);
  const traj = [];
  for (let f = 0; f < frames; f++) {
    if (clearEach) ctx.clearRect(0, 0, W, H);
    draw.__pianoroll({
      ctx,
      haps,
      time: 1 + f * 0.06,
      cycles: CYCLES,
      playhead: PLAYHEAD_FRAC,
      background: BACKGROUND,
      active: ACTIVE,
      inactive: INACTIVE,
      playheadColor: PLAYHEAD,
      autorange: 1,
      labels: false,
      fillActive: true,
      smear,
    });
    traj.push(inkPercent());
  }
  return traj;
}

for (const clearEach of [true, false]) {
  console.log(
    `\n=== ${clearEach ? 'daemon clearRect (today)' : 'no clearRect (trails needs this)'} ===`,
  );
  for (const smear of [0, 0.2, 0.5, 0.8]) {
    const t = run(smear, clearEach);
    const fmt = (v) => v.toFixed(2).padStart(6);
    console.log(
      `smear ${smear}: last5 =${t.slice(-5).map(fmt).join('')}  max=${Math.max(...t).toFixed(2)}%  ` +
        `trajectory = ${t.filter((_, i) => i % 4 === 0).map((v) => v.toFixed(1)).join(' -> ')}`,
    );
  }
}

// ---- does smear ever stop climbing?  80 frames, no clearRect -------------------
{
  const t = run(1, false, 80);
  const sat = t.findIndex((v) => v >= 99.5);
  console.log(
    `\nsmear 1, 80 frames, no clearRect: ink at f20/f40/f60/f80 = ` +
      `${t[19].toFixed(1)} / ${t[39].toFixed(1)} / ${t[59].toFixed(1)} / ${t[79].toFixed(1)}%  ` +
      `-> ${sat >= 0 ? `saturates (>=99.5%) at frame ${sat + 1}` : 'never reached 99.5%'}`,
  );
}

// ---- the honest alternative: a decaying background wash each frame ------------
// smear stays on (no clear), but a translucent background fillRect fades old ink
// geometrically, so coverage should reach an equilibrium instead of climbing.
function runFade(fade, frames) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, W, H);
  const traj = [];
  for (let f = 0; f < frames; f++) {
    ctx.globalAlpha = fade;
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    draw.__pianoroll({
      ctx,
      haps,
      time: 1 + f * 0.06,
      cycles: CYCLES,
      playhead: PLAYHEAD_FRAC,
      background: BACKGROUND,
      active: ACTIVE,
      inactive: INACTIVE,
      playheadColor: PLAYHEAD,
      autorange: 1,
      labels: false,
      fillActive: true,
      smear: 1,
    });
    traj.push(inkPercent());
  }
  return traj;
}

console.log('\n=== decaying wash (smear 1 + translucent background fill each frame) ===');
for (const fade of [0.3, 0.5, 0.6, 0.7]) {
  const t = runFade(fade, 60);
  console.log(
    `fade ${fade}: ink at f10/f20/f30/f45/f60 = ` +
      `${t[9].toFixed(1)} / ${t[19].toFixed(1)} / ${t[29].toFixed(1)} / ${t[44].toFixed(1)} / ${t[59].toFixed(1)}%  ` +
      `range over f30..f60 = ${Math.min(...t.slice(30)).toFixed(1)}..${Math.max(...t.slice(30)).toFixed(1)}%`,
  );
}
