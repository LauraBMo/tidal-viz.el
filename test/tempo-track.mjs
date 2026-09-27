#!/usr/bin/env node
// QUESTION IT ANSWERS:
//   Does local/tidal-viz/daemon.mjs keep the emitted playhead (`frame <orbit>
//   <cycle>` on stdout) SMOOTH across a mid-stream cps change, or does it jump?
//   Secondarily: does --visual-latency SECONDS hold the playhead back by
//   L * cps cycles?
//
// HOW: spawns the daemon as a child on a PRIVATE port, feeds it a synthetic
// /dirt/play stream whose cycle clock is a piecewise-linear integral of cps
// (cps changes once, mid-stream), timestamps every stdout frame line against a
// monotonic clock shared with the sender, and analyses the (wall, cycle) series.
//
// RUN (parent imports only node: builtins, so no register.mjs needed):
//   node tempo-track.mjs [rise|drop|latency|all]
//
// The child daemon IS spawned with `--import ./register.mjs` from
// ../daemon (that is where node_modules lives).
// Nothing is written into the repo; PNGs and JSONL evidence land in ./data/.
//
// Ports: 57197/57198 only.  57121 is the user's live Tidal -- never touched.

import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_DIR = path.join(HERE, '..', 'daemon');
const DATA = path.join(HERE, 'data');
fs.mkdirSync(DATA, { recursive: true });

const mono = () => Number(process.hrtime.bigint()) / 1e9; // seconds, monotonic
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEAD = 0.27; // seconds; Tidal's measured lead, encoded in the bundle timetag

// ------------------------------------------------------------------ OSC encode
// Copied from synth-tidal.mjs -- it already encodes bundles correctly.
const NTP_EPOCH_OFFSET = 2208988800;
const pad4 = (n) => (n + 3) & ~3;

function encString(str) {
  const len = Buffer.byteLength(str) + 1;
  const b = Buffer.alloc(pad4(len));
  b.write(str, 0, 'utf8');
  return b;
}

function encMessage(address, args) {
  let types = ',';
  const body = [];
  for (const a of args) {
    if (typeof a === 'string') {
      types += 's';
      body.push(encString(a));
    } else if (Number.isInteger(a)) {
      types += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a);
      body.push(b);
    } else {
      types += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      body.push(b);
    }
  }
  return Buffer.concat([encString(address), encString(types), ...body]);
}

function encBundle(timetag, messages) {
  const head = Buffer.alloc(16);
  head.write('#bundle\0', 0, 'ascii');
  let secs = Math.floor(timetag);
  let frac = Math.round((timetag - secs) * 4294967296);
  if (frac >= 4294967296) {
    secs += 1;
    frac -= 4294967296;
  }
  head.writeUInt32BE(secs + NTP_EPOCH_OFFSET, 8);
  head.writeUInt32BE(frac, 12);
  const parts = [head];
  for (const m of messages) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(m.length);
    parts.push(size, m);
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------- daemon

async function startDaemon({ port, latency, out, size = '240x96', fps = 30 }) {
  const args = [
    '--import', './register.mjs', 'daemon.mjs',
    '--port', String(port),
    '--out', out,
    '--quiet',
    '--fps', String(fps),
    '--size', size,
    '--visual-latency', String(latency),
  ];
  const child = spawn(process.execPath, args, {
    cwd: DAEMON_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = []; // { t, orbit, cycle }
  let stderrBuf = '';

  const ready = new Promise((resolve, reject) => {
    const to = setTimeout(
      () => reject(new Error(`daemon on ${port} never reported 'listening' (30s)`)),
      30000,
    );
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.includes(`listening on 127.0.0.1:${port}`)) {
        clearTimeout(to);
        resolve();
      }
    });
    child.on('exit', (c) => {
      clearTimeout(to);
      reject(new Error(`daemon on ${port} exited early (code ${c})`));
    });
  });

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const m = /^frame\s+(\d+)\s+(-?[\d.]+)\s*$/.exec(line);
    if (m) frames.push({ t: mono(), orbit: Number(m[1]), cycle: Number(m[2]) });
  });

  await ready;
  return { child, frames, port, stderr: () => stderrBuf };
}

// --------------------------------------------------------------------- sender
//
// The cycle clock is the integral of cps over wall time, with one change at S:
//   cycle(t) = 1 + cpsA * (min(t,S) - T0) + cpsB * max(0, t - S)
// which is exactly Tidal's setcps semantics: the tempo changes from that moment
// and the cycle position carries on.  Implemented incrementally as
// `cycle += cps * dt` with the interval split at S, so the switch is exact.
//
// `delta` is SECONDS: a quarter-cycle event is 0.25 / cps.

const D1 = ['bd', 'hh', 'sn', 'hh'];
const D2 = [4, -25, -29, 11, -25, -36];

function runStream({ ports, cpsA, cpsB, switchAfter, duration, eventHz = 11.5 }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const T0 = mono() + 0.05;
    const S = T0 + switchAfter;
    let cycle = 1.0;
    let prev = T0;
    let n = 0;
    const log = [];

    const modelCycle = (t) => 1.0 + cpsA * Math.max(0, Math.min(t, S) - T0) + cpsB * Math.max(0, t - S);

    const iv = setInterval(() => {
      const now = mono();
      if (prev < S && now > S) cycle += cpsA * (S - prev) + cpsB * (now - S);
      else cycle += (prev < S ? cpsA : cpsB) * (now - prev);
      prev = now;

      const cps = now < S ? cpsA : cpsB;
      const orbit = n % 2;
      const args =
        orbit === 0
          ? ['_id_', '1', 'cps', cps, 'cycle', cycle, 'delta', 0.25 / cps, 'gain', 0, 'orbit', 0, 's', D1[n % 4]]
          : ['_id_', '2', 'cps', cps, 'cycle', cycle, 'delta', (1 / 6) / cps, 'gain', 0, 'orbit', 1, 'n', D2[n % 6], 's', 'arpy'];
      // The NTP timetag must be WALL clock: the daemon ages it with Date.now().
      // Feeding it mono() here (the first version of this harness did) makes every
      // event look decades old, so the daemon draws one frame and goes stale.
      const pkt = encBundle(Date.now() / 1000 + LEAD, [encMessage('/dirt/play', args)]);
      for (const p of ports) sock.send(pkt, p, '127.0.0.1');
      log.push({ t: now, cycle, cps, orbit });
      n++;

      if (now - T0 >= duration) {
        clearInterval(iv);
        sock.close();
        resolve({ T0, S, log, modelCycle, cpsA, cpsB, duration });
      }
    }, 1000 / eventHz);
  });
}

// ------------------------------------------------------------------- analysis

function lsSlope(pts) {
  const n = pts.length;
  if (n < 3) return NaN;
  let sx = 0, sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  return den ? num / den : NaN;
}

function analyse({ frames, T0, S, cpsA, cpsB, duration, log }, label) {
  const f = frames
    .filter((x) => x.t >= T0 - 0.4 && x.t <= T0 + duration + 0.4)
    .sort((a, b) => a.t - b.t);
  const cpsAt = (t) => (t < S ? cpsA : cpsB);

  // cps_effective, read off the SEND LOG rather than assumed: the daemon extrapolates
  // from the newest event it has HEARD, so over any interval its rate is the cps of the
  // newest event sent at that moment.  Integrating that step function over a frame gap
  // predicts what a perfectly smooth tracker would emit, independent of the daemon.
  const rateEff = (t) => {
    let lo = 0, hi = log.length - 1, best = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (log[m].t <= t) { best = log[m]; lo = m + 1; } else hi = m - 1;
    }
    return (best ?? log[0]).cps;
  };
  const predictDelta = (t0, t1) => {
    const step = 0.001;
    let acc = 0;
    for (let t = t0; t < t1; t += step) acc += rateEff(t) * Math.min(step, t1 - t);
    return acc;
  };

  const win = (lo, hi) => f.filter((x) => x.t >= lo && x.t <= hi).map((x) => ({ x: x.t - T0, y: x.cycle }));
  const firstWin = win(T0 + 1.5, S - 0.5);
  const lastWin = win(S + 1.5, T0 + duration - 0.5);
  const transWin = win(S - 1.0, S + 1.0);

  // Step residuals over consecutive emitted frames.
  let worstRes = null;
  let minDelta = null;
  let decreases = 0;
  const steps = [];
  for (let i = 1; i < f.length; i++) {
    const dt = f[i].t - f[i - 1].t;
    const dcycle = f[i].cycle - f[i - 1].cycle;
    if (dt <= 0) continue;
    const mid = (f[i].t + f[i - 1].t) / 2;
    const exp = predictDelta(f[i - 1].t, f[i].t); // integral of the effective cps
    const naive = dt * cpsAt(mid);               // dt * cps_effective at the midpoint
    const res = dcycle - exp;
    steps.push({ t: f[i].t - T0, dt, dcycle, exp, naive, res });
    if (worstRes === null || Math.abs(res) > Math.abs(worstRes.res)) worstRes = steps[steps.length - 1];
    if (minDelta === null || dcycle < minDelta.dcycle) minDelta = steps[steps.length - 1];
    if (dcycle < 0) decreases++;
  }
  // Confirm the daemon implements its documented formula, so the jump is explained
  // rather than mysterious: predicted = last.cycle + (now - last.timetag) * last.cps
  let maxDev = 0, devAt = null;
  for (const x of f) {
    let lo = 0, hi = log.length - 1, best = null;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (log[m].t <= x.t) { best = log[m]; lo = m + 1; } else hi = m - 1;
    }
    if (!best) continue;
    const dev = x.cycle - (best.cycle + (x.t - (best.t + LEAD)) * best.cps);
    if (Math.abs(dev) > Math.abs(maxDev)) { maxDev = dev; devAt = x.t - T0; }
  }

  // Total discontinuity: the residual accumulated over the +/-0.5s around the switch.
  const totalStep = steps
    .filter((s) => s.t >= S - T0 - 0.5 && s.t <= S - T0 + 0.5)
    .reduce((a, s) => a + s.res, 0);

  // The law, derived from the daemon's own formula.  Let b = (arrival of the first
  // post-switch event) - (the switch).  Just before it, the daemon extrapolates the
  // OLD event at cpsA; just after, the NEW event at cpsB, and the extrapolated
  // distance to its timetag changes from 0.27*cpsA to 0.27*cpsB.  So
  //   jump = (cpsB - cpsA) * (b - 0.27)
  // which is negative (backwards) for a rise, positive for a drop, since b < 0.087.
  let jumpLaw = null;
  {
    // Recover T0 from the sender's own log: the first event carries cycle 1 + cpsA*(t-T0).
    const T0r = log[0].t - (log[0].cycle - 1) / cpsA;
    const i = log.findIndex((e) => e.cps === cpsB);
    if (i > 0) {
      const b = log[i].t - (T0r + (S - T0));
      const pred = (cpsB - cpsA) * (b - LEAD);
      jumpLaw = { b, pred, t: log[i].t - T0 };
    }
  }

  const round = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

  console.log(`\n=== ${label}: cps ${cpsA} -> ${cpsB} at t0+${(S - T0).toFixed(2)}s, ${duration}s stream ===`);
  console.log(`frames captured: ${f.length} (first-window ${firstWin.length}, last-window ${lastWin.length}, transition ${transWin.length})`);
  console.log(`  slope FIRST window  (t+1.5..${(S - T0 - 0.5).toFixed(1)}s): ${round(lsSlope(firstWin))}   [sent cpsA = ${cpsA}]`);
  console.log(`  slope LAST  window  (t+${(S - T0 + 1.5).toFixed(1)}..${(duration - 0.5).toFixed(1)}s): ${round(lsSlope(lastWin))}   [sent cpsB = ${cpsB}]`);
  console.log(`  slope TRANSITION    (t+${(S - T0 - 1).toFixed(1)}..${(S - T0 + 1).toFixed(1)}s): ${round(lsSlope(transWin))}`);
  console.log(`monotonic: ${decreases === 0 ? 'YES' : `NO -- ${decreases} backwards step(s)`}; worst single-frame dcycle = ${round(minDelta?.dcycle)} at t+${round(minDelta?.t, 3)}s`);
  console.log(`largest discontinuity (dcycle - integral of cps_effective): ${round(worstRes?.res)} at t+${round(worstRes?.t, 3)}s  (dt=${round(worstRes?.dt, 4)}, observed dcycle=${round(worstRes?.dcycle)}, expected=${round(worstRes?.exp)})`);
  console.log(`total residual over switch +/-0.5s: ${round(totalStep)} cycles`);
  if (jumpLaw) {
    console.log(`  law check: first new-cps event lands b=${round(jumpLaw.b, 4)}s after the switch -> predicted jump (cpsB-cpsA)*(b-0.27) = ${round(jumpLaw.pred)} ; measured ${round(totalStep)}`);
  }
  console.log(`formula check  d(cycle) - [last.cycle + (now - timetag)*last.cps]: max |${round(maxDev, 5)}| at t+${round(devAt, 3)}s`);

  // Print the transition window frame by frame: this is the evidence.
  const near = steps.filter((s) => s.t >= S - T0 - 0.6 && s.t <= S - T0 + 0.6);
  console.log('  frames across the switch (t_rel, dt, dcycle, exp, residual):');
  for (const s of near) {
    console.log(`    ${String(round(s.t, 3)).padStart(7)}  ${round(s.dt, 4)}  ${String(round(s.dcycle)).padStart(8)}  ${String(round(s.exp)).padStart(8)}  ${String(round(s.res)).padStart(9)}`);
  }
  return { label, cpsA, cpsB, Srel: S - T0, n: f.length, firstSlope: lsSlope(firstWin), lastSlope: lsSlope(lastWin), transSlope: lsSlope(transWin), decreases, minDelta, worstRes, totalStep, steps, frames: f, log, T0, S };
}

// ----------------------------------------------------------------- part 2

function interpAt(frames, t) {
  // linear interpolation of a sorted frame series at wall time t
  if (frames.length < 2) return NaN;
  if (t <= frames[0].t || t >= frames[frames.length - 1].t) return NaN;
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (frames[m].t <= t) lo = m; else hi = m;
  }
  const a = frames[lo], b = frames[hi];
  const w = (t - a.t) / (b.t - a.t);
  return a.cycle + w * (b.cycle - a.cycle);
}

async function part2() {
  const PORT_A = 57197, PORT_B = 57198;
  const [dA, dB] = await Promise.all([
    startDaemon({ port: PORT_A, latency: 0.0, out: path.join(DATA, 'lat0-frame.png') }),
    startDaemon({ port: PORT_B, latency: 1.0, out: path.join(DATA, 'lat1-frame.png') }),
  ]);
  const stream = await runStream({
    ports: [PORT_A, PORT_B], cpsA: 0.575, cpsB: 1.2, switchAfter: 6.0, duration: 12.0,
  });
  await sleep(300);
  dA.child.kill('SIGTERM');
  dB.child.kill('SIGTERM');

  const A = dA.frames.filter((x) => x.t >= stream.T0).sort((a, b) => a.t - b.t);
  const B = dB.frames.filter((x) => x.t >= stream.T0).sort((a, b) => a.t - b.t);
  const S = stream.S;
  const cpsAt = (t) => (t < S ? 0.575 : 1.2);

  const diffIn = (lo, hi) => {
    const ds = [];
    for (const b of B) {
      if (b.t < lo || b.t > hi) continue;
      const a = interpAt(A, b.t); // a NUMBER: the interpolated cycle of daemon A
      if (Number.isFinite(a)) ds.push({ t: b.t - stream.T0, d: b.cycle - a, cps: cpsAt(b.t) });
    }
    const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
    const m = mean(ds.map((x) => x.d));
    const sd = Math.sqrt(mean(ds.map((x) => (x.d - m) ** 2)));
    return { n: ds.length, mean: m, sd, expected: -1.0 * cpsAt(lo + (hi - lo) / 2) };
  };

  console.log('\n=== part 2: --visual-latency 0 (A) vs 1.0 (B), same stream to both ===');
  console.log(`daemon A frames ${A.length}, daemon B frames ${B.length}`);
  fs.writeFileSync(path.join(DATA, 'latency-frames.jsonl'),
    [...A.map((x) => JSON.stringify({ daemon: 'A', ...x })), ...B.map((x) => JSON.stringify({ daemon: 'B', ...x }))].join('\n') + '\n');
  const w1 = diffIn(stream.T0 + 1.5, S - 0.5);
  const w2 = diffIn(S + 1.5, stream.T0 + 11.5);
  for (const [nm, w, cps] of [['cps 0.575 window', w1, 0.575], ['cps 1.2 window', w2, 1.2]]) {
    console.log(`  ${nm}: n=${w.n} mean(B-A) = ${w.mean.toFixed(4)} cycles (sd ${w.sd.toFixed(4)}) | expected -L*cps = ${(-cps).toFixed(4)} | diff ${(w.mean + cps).toFixed(4)}`);
  }
  return { w1, w2 };
}

// --------------------------------------------------------------------- main

const MODE = process.argv[2] ?? 'all';
const results = {};

if (MODE === 'rise' || MODE === 'all') {
  const port = 57197;
  const d = await startDaemon({ port, latency: 0, out: path.join(DATA, 'rise-frame.png') });
  const stream = await runStream({ ports: [port], cpsA: 0.575, cpsB: 1.2, switchAfter: 6.0, duration: 12.0 });
  await sleep(300);
  d.child.kill('SIGTERM');
  results.rise = analyse({ ...stream, frames: d.frames }, 'RISE');
  fs.writeFileSync(path.join(DATA, 'rise-frames.jsonl'),
    d.frames.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(DATA, 'rise-sent.jsonl'),
    stream.log.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

if (MODE === 'drop' || MODE === 'all') {
  const port = 57197;
  const d = await startDaemon({ port, latency: 0, out: path.join(DATA, 'drop-frame.png') });
  const stream = await runStream({ ports: [port], cpsA: 1.2, cpsB: 0.575, switchAfter: 6.0, duration: 12.0 });
  await sleep(300);
  d.child.kill('SIGTERM');
  results.drop = analyse({ ...stream, frames: d.frames }, 'DROP');
  fs.writeFileSync(path.join(DATA, 'drop-frames.jsonl'),
    d.frames.map((x) => JSON.stringify(x)).join('\n') + '\n');
  fs.writeFileSync(path.join(DATA, 'drop-sent.jsonl'),
    stream.log.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

if (MODE === 'latency' || MODE === 'all') {
  results.latency = await part2();
}

// The jump is (cpsB-cpsA)*(b-0.27) where b is how long after the switch the next
// event lands, so its size depends on where the switch falls on the event grid.
// Sweep that phase to check the law instead of extrapolating it.
if (MODE === 'phase') {
  console.log('\n=== phase sweep (RISE 0.575 -> 1.2): jump vs where the switch falls between events ===');
  for (const off of [6.000, 6.022, 6.043, 6.065]) {
    const port = 57197;
    const d = await startDaemon({ port, latency: 0, out: path.join(DATA, 'phase-frame.png') });
    const stream = await runStream({ ports: [port], cpsA: 0.575, cpsB: 1.2, switchAfter: off, duration: off + 3 });
    await sleep(300);
    d.child.kill('SIGTERM');
    const r = analyse({ ...stream, frames: d.frames }, `PHASE off=${off}`);
    console.log(`  --> measured jump ${r.totalStep.toFixed(4)} cycles`);
  }
}

console.log('\n--- verdicts ---');
for (const k of ['rise', 'drop']) {
  const r = results[k];
  if (!r) continue;
  const jump = r.worstRes;
  console.log(`${k.toUpperCase()}: slopes ${r.firstSlope.toFixed(4)} -> ${r.lastSlope.toFixed(4)} (sent ${r.cpsA} -> ${r.cpsB}); ` +
    `${r.decreases === 0 ? 'monotone' : r.decreases + ' backwards step(s), worst ' + r.minDelta.dcycle.toFixed(4)}; ` +
    (jump
      ? `worst discontinuity ${jump.res.toFixed(4)} cycles at t+S${(jump.t - r.Srel >= 0 ? '+' : '')}${(jump.t - r.Srel).toFixed(3)}s`
      : 'no usable frame pairs'));
}
process.exit(0);
