#!/usr/bin/env node
// tidal-viz daemon -- Tidal's OSC in, Strudel pianoroll frames out.
//
// Listens on 127.0.0.1:57121 (Tidal's *second* OSC target, added to
// ~/src/tidal-music/BootTidal.hs), keeps a rolling window of the /dirt/play
// events it hears, and paints them with Strudel's own __pianoroll.  Each frame is
// written atomically -- to <out>.tmp, then renamed over <out> -- so a reader can
// never catch a half-written PNG -- and announced on stdout as one line, so the
// Emacs side can be event-driven rather than polling.
//
// RUN (from this directory, which owns node_modules):
//   node --import ./register.mjs daemon.mjs [options]
//     --fps N         frames per second to emit      (default 30)
//     --lookbehind N  cycles of history on screen    (default 2)
//     --lookahead N   cycles of future on screen     (default 0.5 -- Tidal only
//                     ever sends ~0.25s ahead, so a large value is wasted space)
//     --out PATH      PNG to write                   (default frame.png)
//     --port N        UDP port to listen on          (default 57121)
//     --visual-latency SECONDS
//                     hold the playhead back this far if the visual runs ahead
//                     of what you hear                    (default 0)
//     --quiet         no stats on stderr
//
// stdout protocol -- exactly one line per rendered frame:
//   frame <orbit> <cycle>
// Nothing else.  Diagnostics go to stderr.
//
// Time is in CYCLES, not seconds.  Wall-clock maps through the newest event heard:
// Tidal timestamps each /dirt/play bundle with the moment that cycle position
// plays (SuperDirt turns the same timetag into its latency), so
//   cycle_now = last.cycle + (now - last.timetag) * last.cps
// which keeps the visual aligned to the audio without estimating anything.

import dgram from 'node:dgram';
import { writeFileSync, renameSync } from 'node:fs';
import { decodePacket } from './osc.mjs';

// @strudel/core prints a banner ("@strudel/core loaded") to STDOUT on import, and
// stdout here is the frame protocol -- every line must be a frame line.  Mute
// console.log across the import and restore it afterwards.  Its "cannot use
// window: not in browser?" notice goes to stderr and is harmless.
const realConsoleLog = console.log;
console.log = () => {};
const { createCanvas } = await import('@napi-rs/canvas');
const core = await import('@strudel/core');
const draw = await import('@strudel/draw');
console.log = realConsoleLog;
const { Hap, TimeSpan } = core;

// ------------------------------------------------------------------- options

const opts = {
  fps: 30,
  // Overridable so a test daemon can listen somewhere else and not compete for
  // Tidal's stream with the one the user has running.
  port: 57121,
  lookbehind: 2,
  lookahead: 0.5,
  out: 'frame.png',
  width: 1000,
  height: 360,
  staleAfter: 3,
  // Seconds to hold the playhead back.  The timetag Tidal sends is exact, so
  // this is not drift correction: it is the gap between scsynth being told to
  // play an event and the sound actually leaving the speakers.
  visualLatency: 0,
  // Colours come from the Emacs theme (see tidal-viz.el).  __pianoroll takes
  // them directly, so the frame can sit on the same background as the code
  // instead of reading as a pasted-in picture.
  background: '#1e1e1e',
  active: '#d0d0d0',
  inactive: '#4a4a4a',
  playhead: '#808080',
  smear: 0,
  quiet: false,
};
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case '--fps': opts.fps = Number(a[++i]); break;
      case '--lookbehind': opts.lookbehind = Number(a[++i]); break;
      case '--lookahead': opts.lookahead = Number(a[++i]); break;
      case '--out': opts.out = a[++i]; break;
      case '--size': {
        const m = /^(\d+)x(\d+)$/.exec(a[++i] ?? '');
        if (!m) {
          console.error("tidal-viz: --size wants WxH, e.g. 800x288");
          process.exit(2);
        }
        opts.width = Number(m[1]);
        opts.height = Number(m[2]);
        break;
      }
      case '--port': opts.port = Number(a[++i]); break;
      case '--stale-after': opts.staleAfter = Number(a[++i]); break;
      case '--visual-latency': opts.visualLatency = Number(a[++i]); break;
      case '--background': opts.background = a[++i]; break;
      case '--active': opts.active = a[++i]; break;
      case '--inactive': opts.inactive = a[++i]; break;
      case '--playhead': opts.playhead = a[++i]; break;
      case '--smear': opts.smear = Number(a[++i]); break;
      case '--quiet': opts.quiet = true; break;
      default:
        console.error(`tidal-viz: unknown option '${a[i]}'`);
        process.exit(2);
    }
  }
}

// A canvas SILENTLY IGNORES an invalid fillStyle: the previous colour stays in
// place, so a bad colour means invisible drawing rather than an error.  Emacs
// hands over names like "gray65" as readily as hex, and exactly that produced a
// frame that was background-only.  Validate here and complain loudly instead.
const DEFAULT_COLORS = {
  background: '#1e1e1e',
  active: '#d0d0d0',
  inactive: '#4a4a4a',
  playhead: '#808080',
};
for (const key of Object.keys(DEFAULT_COLORS)) {
  if (!/^#[0-9a-fA-F]{6}$/.test(String(opts[key]))) {
    console.error(
      `tidal-viz: --${key} '${opts[key]}' is not #rrggbb; falling back to ${DEFAULT_COLORS[key]}`,
    );
    opts[key] = DEFAULT_COLORS[key];
  }
}

const PORT = opts.port;
const RETAIN_CYCLES = 32;

// ---------------------------------------------------------------- event store

const events = [];
const rowForSample = new Map();
let received = 0;
let bundlePackets = 0;
let barePackets = 0;

// A pattern with no pitches still deserves distinct rows, so give each sample
// name its own row by first appearance.  Our choice, not Strudel's.
function rowFor(e) {
  if (e.note !== undefined) return e.note;
  if (e.n !== undefined) return e.n;
  if (!rowForSample.has(e.s)) rowForSample.set(e.s, rowForSample.size);
  return rowForSample.get(e.s);
}

function flatPairs(args) {
  const o = {};
  for (let i = 0; i + 1 < args.length; i += 2) o[args[i]] = args[i + 1];
  return o;
}

const sock = dgram.createSocket('udp4');
sock.on('error', (e) => {
  console.error(`tidal-viz: socket error: ${e.message}`);
  process.exit(1);
});
sock.on('message', (buf) => {
  let pkt;
  try {
    pkt = decodePacket(buf);
  } catch (e) {
    console.error(`tidal-viz: undecodable packet (${buf.length}B): ${e.message}`);
    return;
  }
  if (pkt.bundle) bundlePackets++;
  else barePackets++;
  const walk = (x, tt) => {
    if (x.bundle) {
      for (const el of x.elements) walk(el, x.timetag ?? tt);
      return;
    }
    if (x.address !== '/dirt/play') return;
    const o = flatPairs(x.args);
    // cps/delta/cycle are the ones we cannot do without; delta is SECONDS.
    if (typeof o.cycle !== 'number' || typeof o.delta !== 'number' || !o.cps) return;
    events.push({
      t: tt,
      cycle: o.cycle,
      delta: o.delta,
      cps: o.cps,
      orbit: o.orbit ?? 0,
      s: o.s,
      n: o.n,
      note: o.note,
    });
    received++;
  };
  walk(pkt, null);
});

// ------------------------------------------------------------------- styles
//
// One painter, many looks: a style is a set of __pianoroll option overrides
// merged OVER the base options in drawStyled, so a new look is a line of data
// rather than another drawing routine.  The map this replaced held three
// functions, of which two were dead ends -- punchcard was a byte-identical
// restatement of the default, and pitchwheel could not be themed at all.
//
// `punchcard' therefore survives only as an ALIAS: getPunchcardPainter is a thin
// wrapper around __pianoroll in this package version and renders identically
// pixel for pixel, so offering it as a separate picture would be a lie.  The
// name is kept because it is already in muscle memory (and in older notes).
//
// pitchwheel is deliberately NOT offered.  It is polar and takes no colour
// options -- it draws black whatever it is passed -- and a black disc on this
// user's light theme reads as a failed render, not a visual.  Do not add it
// back.  (spiral and wordfall do not exist in this package at all.)
//
// `fade' is the one key here that __pianoroll does not understand; drawStyled
// consumes it.  (The --smear FLAG is still inert on its own: drawStyled clears
// the canvas unless a style sets fade, so the base smear only ever reaches
// __pianoroll behind a style that wants trails.)  Two MEASURED facts shaped it:
//
//   * `smear' is only tested for TRUTHINESS around __pianoroll's clear, so 0.2,
//     0.5 and 0.8 produce the same picture -- byte-identical to one another.
//     There is no value to tune, which is why the entry is a plain 1.
//   * Skipping the clear is not enough on its own: nothing then ever removes old
//     ink, so coverage climbs frame after frame (22% -> 94% over 80 consecutive
//     frames) and the canvas ends up a solid block.  A trail has to be wiped
//     GRADUALLY instead, hence the translucent wash of the background colour,
//     which fades old ink geometrically and settles at a stable coverage
//     (measured ~42% at fade 0.6, against ~22% for pianoroll).
const STYLES = {
  pianoroll: {}, // the default: solid blocks in the theme colours
  punchcard: {}, // alias -- same picture, see above
  trails: { smear: 1, fade: 0.6 }, // moving blocks leave a fading trail behind
  // `stroke' MUST be set as well as the fills cleared: the stroke switch is
  // `stroke ?? (strokeActive && isSounding)', so without it only the haps the
  // playhead happens to be sitting on get an outline -- every other block
  // vanishes, which is a near-empty picture rather than hollow blocks.
  outline: { fill: 0, fillActive: false, stroke: 1 }, // hollow blocks
  vertical: { vertical: 1 }, // time runs top to bottom
  sparse: { hideInactive: 1 }, // only what is sounding now
};

// ---------------------------------------------------------- control channel
//
// One line per directive on stdin.  Stdin is the right channel because it is
// one-way and ordered, which is all this needs -- Emacs says which orbit wants a
// visual, and the daemon never has to answer.
//
//   viz all <style>        one aggregate frame, all orbits, to --out
//   viz <orbit> <style>    render that orbit on its own, to <out>-<orbit>.png
//   viz <orbit> none       stop rendering it
//
// Until a `viz' line arrives, the daemon stays in aggregate mode, so the
// side-buffer view of M2/M3 keeps working unchanged.

const styles = new Map(); // orbit -> style name, per-orbit mode
let aggregateStyle = 'pianoroll';
let mode = 'aggregate';

// Names are validated HERE and not at draw time: a typo in someone's config
// should be complained about once, when the `viz' line arrives, rather than
// thirty times a second at frame rate.
function validStyle(name) {
  if (STYLES[name]) return name;
  console.error(`tidal-viz: '${name}' is not a style; drawing pianoroll`);
  return 'pianoroll';
}

function handleControl(line) {
  const m = /^viz\s+(all|\d+)\s+(\S+)$/.exec(line);
  if (!m) {
    console.error(`tidal-viz: ignoring unrecognised control line '${line}'`);
    return;
  }
  const which = m[1];
  const name = m[2];
  if (which === 'all') {
    aggregateStyle = name === 'none' ? null : validStyle(name);
    mode = 'aggregate';
    console.error(`tidal-viz: aggregate frame -> ${aggregateStyle ?? '(off)'}`);
    return;
  }
  const orbit = Number(which);
  if (name === 'none') styles.delete(orbit);
  else styles.set(orbit, validStyle(name));
  mode = 'per-orbit';
  console.error(`tidal-viz: orbit ${orbit} -> ${name === 'none' ? '(off)' : name}`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {}); // a closed stdin just means no control
let controlBuf = '';
process.stdin.on('data', (chunk) => {
  controlBuf += chunk;
  let nl;
  while ((nl = controlBuf.indexOf('\n')) >= 0) {
    const line = controlBuf.slice(0, nl).trim();
    controlBuf = controlBuf.slice(nl + 1);
    if (line) handleControl(line);
  }
});

// --------------------------------------------------------------------- clock
//
// The clock is driven by events, and it must NOT keep extrapolating once they
// stop: the window would walk past every event and the visual would sit empty
// while still burning frames.  So when nothing has arrived for `staleAfter`
// seconds we pin the playhead at the last known cycle, draw that one final
// frame, and stay quiet until events resume.

let frozen = false;

function clock() {
  const wall = Date.now() / 1000;

  // Anchor on the newest event that has ALREADY been reached, and extrapolate
  // FORWARD from it.  Anchoring on the newest event overall is what this first
  // did, and it is wrong at a tempo change: Tidal sends ~0.27s ahead, so that
  // walks BACKWARD from a future point, and the length of the step is a fixed
  // time converted to cycles at the current cps.  The instant a new-cps event
  // becomes "newest", the step changes size and the playhead leaps -- measured
  // at 0.114-0.169 cycles for a 0.575 <-> 1.2 change, BACKWARD on a rise, which
  // rewinds the visual.  A past anchor's step is at most one event gap, so the
  // same change costs at most ~0.05 cycles and can never rewind.
  let anchor = null;
  let newest = null;
  for (const e of events) {
    if (e.t == null || !e.cps) continue;
    if (!newest || e.t > newest.t) newest = e;
    if (e.t <= wall && (!anchor || e.t > anchor.t)) anchor = e;
  }
  // Before the first event has played there is no past anchor, and the newest
  // event is all there is to go on.
  if (!anchor) anchor = newest;
  if (!anchor) return { now: null, stale: false };

  const age = wall - anchor.t;
  // Staleness is judged on the REAL age, before the latency offset: the offset
  // is a display concern and must not make a stopped stream look alive.
  if (age > opts.staleAfter) return { now: anchor.cycle, stale: true };
  return { now: anchor.cycle + (age - opts.visualLatency) * anchor.cps, stale: false };
}

// --------------------------------------------------------------------- render

// A fresh canvas is fully TRANSPARENT, and `trails' never lays down an opaque
// background (its wash is translucent by design, since that is the whole
// mechanism), so an unprimed canvas would emit one see-through frame.  Prime
// every canvas with the theme background as it is created; the other styles
// repaint it opaquely on every frame anyway, so this is invisible to them.
function newCtx() {
  const c = createCanvas(opts.width, opts.height).getContext('2d');
  c.fillStyle = opts.background;
  c.fillRect(0, 0, opts.width, opts.height);
  return c;
}

const ctx = newCtx();
const span = opts.lookbehind + opts.lookahead;

let frames = 0;
let dropped = 0;
let nullClock = 0;
let frozenTicks = 0;
let ticks = 0;
let busy = false;
let lastStats = Date.now();
// Where the per-frame time actually goes.  Measured at 1000x360: drawing ~4ms,
// encode ~46ms, write+rename ~0.5ms -- PNG encoding is the ceiling, and it
// scales with pixel count, so --size is the real fps lever.
let tDraw = 0;
let tEncode = 0;
let tWrite = 0;

function drawStyled(c, haps, now, style) {
  const { fade, ...overrides } = style;
  if (fade) {
    // trails: fade the previous frame out rather than erasing it.  __pianoroll's
    // own clear is off for this style (smear is on), so this wash is the ONLY
    // thing removing ink -- drop it and the canvas fills up solid (see STYLES).
    c.globalAlpha = fade;
    c.fillStyle = opts.background;
    c.fillRect(0, 0, opts.width, opts.height);
    c.globalAlpha = 1;
  } else {
    c.clearRect(0, 0, opts.width, opts.height);
  }
  draw.__pianoroll({
    ctx: c,
    haps,
    // `time' is the PLAYHEAD, not the window's right edge: __pianoroll draws
    // [time - cycles*playhead, time + cycles*(1-playhead)], measured by putting a
    // single block at a known cycle and reading which pixels it landed on.
    // Passing the right edge here (as this first did) puts the whole visible span
    // in the future, leaving most of the canvas empty.
    time: now,
    cycles: span,
    playhead: opts.lookbehind / span,
    // Theme colours, explicit rather than via setTheme, so the visual matches the
    // buffer it lives in.  `labels' stays off: the numbers read as data pasted
    // over the code, while solid blocks read as part of it.
    background: opts.background,
    active: opts.active,
    inactive: opts.inactive,
    playheadColor: opts.playhead,
    // autorange fits the rows to whatever Tidal actually sent.  Without it the
    // default 10..90 midi window pushes sample rows (0,1,2) off the canvas.
    autorange: 1,
    labels: false,
    fillActive: true,
    smear: opts.smear,
    ...overrides, // a style's overrides win over every base option above
  });
}

const orbitCanvases = new Map();
function orbitCtx(orbit) {
  let c = orbitCanvases.get(orbit);
  if (!c) {
    c = newCtx();
    orbitCanvases.set(orbit, c);
  }
  return c;
}

function orbitOutPath(orbit) {
  const m = /^(.*)\.png$/.exec(opts.out);
  return m ? `${m[1]}-${orbit}.png` : `${opts.out}-${orbit}.png`;
}

function hapsFor(list, now) {
  const lo = now - opts.lookbehind;
  const hi = now + opts.lookahead;
  const out = [];
  for (const e of list) {
    const end = e.cycle + e.delta * e.cps; // delta is seconds; * cps gives cycles
    if (end < lo || e.cycle > hi) continue;
    const ts = new TimeSpan(e.cycle, end);
    out.push(new Hap(ts, ts, { s: e.s, note: rowFor(e) }));
  }
  return out;
}

async function paint(c, haps, now, style, outPath, orbit) {
  let t = performance.now();
  drawStyled(c, haps, now, style);
  tDraw += performance.now() - t;

  t = performance.now();
  const png = await c.canvas.encode('png');
  tEncode += performance.now() - t;

  t = performance.now();
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, png);
  renameSync(tmp, outPath);
  tWrite += performance.now() - t;

  process.stdout.write(`frame ${orbit} ${now.toFixed(4)}\n`);
  frames++;
}

async function renderFrame() {
  const { now, stale } = clock();
  if (now === null) return 'no-clock'; // no event with a timetag yet, so no clock
  if (stale) {
    if (frozen) return 'frozen'; // already drew the final frame; idle cheaply
    frozen = true;
  } else if (frozen) {
    frozen = false; // events are back
  }

  const cutoff = now - RETAIN_CYCLES;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].cycle < cutoff) events.splice(i, 1);
  }

  // One frame per requested orbit, or a single aggregate frame when nothing has
  // been asked for by name.  Per-orbit is what makes the blocks chunky: autorange
  // then fits each orbit's own values, instead of one tall range that nothing
  // fills -- sample rows 0..2 sharing an axis with notes down to -36 squashed
  // every block into 3.75px across 48 rows.
  if (mode === 'per-orbit' && styles.size) {
    for (const [orbit, styleName] of styles) {
      const list = events.filter((e) => (e.orbit ?? 0) === orbit);
      await paint(
        orbitCtx(orbit),
        hapsFor(list, now),
        now,
        STYLES[styleName],
        orbitOutPath(orbit),
        orbit,
      );
    }
    return 'ok';
  }

  // `viz all none' means nothing was asked for -- idle rather than draw an
  // aggregate frame nobody wants, which is the whole point of explicit opt-in.
  if (aggregateStyle === null) return 'idle';
  await paint(ctx, hapsFor(events, now), now, STYLES[aggregateStyle], opts.out, 0);
  return 'ok';
}

setInterval(async () => {
  ticks++;
  if (busy) {
    dropped++;
    return;
  }
  busy = true;
  try {
    const outcome = await renderFrame();
    if (outcome === 'no-clock') nullClock++;
    else if (outcome === 'frozen') frozenTicks++;
  } catch (e) {
    console.error(`tidal-viz: render failed: ${e.message}`);
  } finally {
    busy = false;
  }
  if (!opts.quiet && Date.now() - lastStats >= 2000) {
    lastStats = Date.now();
    const n = Math.max(frames, 1);
    const withT = events.filter((e) => e.t != null).length;
    console.error(
      `tidal-viz: ${frames} frames | ${received} events (${bundlePackets} bundled / ${barePackets} bare) | ` +
        `${withT} of ${events.length} in buffer carry a timetag | ${ticks} ticks: ${nullClock} no-clock, ${frozenTicks} frozen, ${dropped} missed | ` +
        `avg draw ${(tDraw / n).toFixed(1)}ms encode ${(tEncode / n).toFixed(1)}ms ` +
        `write ${(tWrite / n).toFixed(2)}ms => ~${(1000 / ((tDraw + tEncode + tWrite) / n)).toFixed(1)} fps ceiling`,
    );
  }
}, 1000 / opts.fps);

sock.bind(PORT, '127.0.0.1', () => {
  console.error(
    `tidal-viz: listening on 127.0.0.1:${PORT} | asking ${opts.fps} fps | ` +
      `window ${opts.lookbehind}-${opts.lookahead} cycles | ${opts.width}x${opts.height} | ` +
      `bg ${opts.background} active ${opts.active} | out ${opts.out} | aggregate until told otherwise`,
  );
});
