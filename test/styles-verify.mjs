// QUESTION: do the STYLES in daemon.mjs actually produce different pictures, and do
// they do what their names promise?  (outline/sparse less ink than pianoroll,
// vertical rotated, trails more ink but still short of saturation.)
//
// Method: render the SAME haps (the real capture, tiled in cycles so a moving
// window never empties) to a 500x180 canvas on a known flat background, 20 frames
// with a shifting `time' per style, then read the last frame back with
// getImageData.  Ink = opaque pixels that are not the background colour.
//
// The STYLES table is EXTRACTED FROM daemon.mjs rather than copied here, so this
// measures the table that ships; the two draw branches (translucent wash when the
// style sets `fade', clearRect otherwise) mirror drawStyled's.
//
// RUN: node --import ../daemon/register.mjs \
//        styles-verify.mjs
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

// ---- the shipped style table -------------------------------------------------
const daemonSrc = readFileSync(`${PROJECT}daemon.mjs`, 'utf8');
const m = /const STYLES = \{(.*?)\n\};/s.exec(daemonSrc);
if (!m) throw new Error('could not extract STYLES from daemon.mjs');
// (the regex consumes the newline before `};', so the closing braces need one of
// their own -- otherwise the last `//' comment swallows them)
const STYLES = new Function(`return ({\n${m[1]}\n});`)();
console.log('STYLES read from daemon.mjs:', JSON.stringify(STYLES));

// daemon.mjs's own defaults, so the palette is the one that ships
const BACKGROUND = '#1e1e1e';
const ACTIVE = '#d0d0d0';
const INACTIVE = '#4a4a4a';
const PLAYHEAD = '#808080';
const W = 500, H = 180;
const CYCLES = 2.5, LOOKBEHIND = 2;
const PLAYHEAD_FRAC = LOOKBEHIND / CYCLES;
const FRAMES = 20;

const BASE = {
  background: BACKGROUND,
  active: ACTIVE,
  inactive: INACTIVE,
  playheadColor: PLAYHEAD,
  autorange: 1,
  labels: false,
  fillActive: true,
  smear: 0,
};

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const [BR, BG, BB] = hexToRgb(BACKGROUND);
const [PR, PG, PB] = hexToRgb(PLAYHEAD);
const near = (r, g, b, t, tol = 4) =>
  Math.abs(r - t[0]) <= tol && Math.abs(g - t[1]) <= tol && Math.abs(b - t[2]) <= tol;

// ---- haps: the real capture, tiled -------------------------------------------
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
      out.push({ cycle: o.cycle, delta: o.delta, cps: o.cps, s: o.s, note: o.note ?? o.n });
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
    const ts = new core.TimeSpan(c0, c0 + e.delta * e.cps);
    let row = e.note;
    if (row === undefined) {
      if (!rowForSample.has(e.s)) rowForSample.set(e.s, rowForSample.size);
      row = rowForSample.get(e.s);
    }
    haps.push(new core.Hap(ts, ts, { s: e.s, note: row }));
  }
}

// ---- render one style, exactly the way drawStyled does -----------------------
function renderStyle(style) {
  const { fade, ...overrides } = style;
  const c = createCanvas(W, H).getContext('2d');
  c.fillStyle = BACKGROUND; // daemon primes every canvas opaquely
  c.fillRect(0, 0, W, H);
  const inkPerFrame = [];
  for (let f = 0; f < FRAMES; f++) {
    if (fade) {
      c.globalAlpha = fade;
      c.fillStyle = BACKGROUND;
      c.fillRect(0, 0, W, H);
      c.globalAlpha = 1;
    } else {
      c.clearRect(0, 0, W, H);
    }
    draw.__pianoroll({
      ctx: c,
      haps,
      time: 1 + f * 0.06,
      cycles: CYCLES,
      playhead: PLAYHEAD_FRAC,
      ...BASE,
      ...overrides,
    });
    inkPerFrame.push(inkOf(c));
  }
  return { c, inkPerFrame, data: c.getImageData(0, 0, W, H).data };
}

function inkOf(c) {
  const d = c.getImageData(0, 0, W, H).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    if (near(d[i], d[i + 1], d[i + 2], [BR, BG, BB], 2)) continue;
    ink++;
  }
  return (100 * ink) / (W * H);
}

function stats(data) {
  const colours = new Set();
  let ink = 0;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  let pMinX = Infinity, pMaxX = -1, pMinY = Infinity, pMaxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a === 0) continue;
      const isPlayhead = near(r, g, b, [PR, PG, PB], 4);
      if (isPlayhead) {
        if (x < pMinX) pMinX = x; if (x > pMaxX) pMaxX = x;
        if (y < pMinY) pMinY = y; if (y > pMaxY) pMaxY = y;
      }
      if (near(r, g, b, [BR, BG, BB], 2)) continue;
      ink++;
      colours.add((r << 16) | (g << 8) | b);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return {
    ink: (100 * ink) / (W * H),
    colours: colours.size,
    bbox: maxX >= 0 ? `${minX},${minY} ${maxX - minX + 1}x${maxY - minY + 1}` : 'none',
    playheadBbox:
      pMaxX >= 0 ? `${pMinX},${pMinY} ${pMaxX - pMinX + 1}x${pMaxY - pMinY + 1}` : 'none',
  };
}

function diff(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
}

const names = Object.keys(STYLES);
const results = new Map();
for (const name of names) results.set(name, renderStyle(STYLES[name]));

const ref = results.get('pianoroll').data;
console.log(
  '\nstyle      | ink% (f1 -> f20)        | colours | ink bbox        | playhead bbox   | vs pianoroll',
);
console.log('-'.repeat(108));
for (const name of names) {
  const r = results.get(name);
  const s = stats(r.data);
  const d = name === 'pianoroll' ? 0 : diff(r.data, ref);
  const pct = d === 0 ? 'identical' : `${((100 * d) / (W * H)).toFixed(1)}% of pixels`;
  console.log(
    `${name.padEnd(10)} | ${r.inkPerFrame[0].toFixed(1).padStart(5)} -> ${s.ink.toFixed(1).padStart(5)}          ` +
      `| ${String(s.colours).padStart(7)} | ${s.bbox.padEnd(15)} | ${s.playheadBbox.padEnd(15)} | ${pct}`,
  );
}

// trails must be stable, not climbing to saturation
const tr = results.get('trails').inkPerFrame;
console.log(
  `\ntrails trajectory (every 4th frame): ${tr.filter((_, i) => i % 4 === 0).map((v) => v.toFixed(1)).join(' -> ')}`,
);
