#!/usr/bin/env node
// Synthetic Tidal sender — the A/B partner for the tidal-viz daemon.
//
// QUESTION IT ANSWERS:
//   How fast can ../daemon/daemon.mjs actually go?  Feeding it a synthetic
//   /dirt/play stream that looks like Tidal's (one event per packet, bundle
//   timetag ~270ms in the future, ~11.5 events/s across two orbits, cps 0.575)
//   removes ghci, Tidal, SuperDirt and scsynth from the picture, so anything
//   slow is the daemon's own code rather than CPU contention with the audio stack.
//
// RUN (with the daemon already listening on 57121):
//   node synth-tidal.mjs [--seconds 8] [--port 57121]
//
// Shape copied from a real capture: /dirt/play args are flat key/value pairs, and
// `delta` is in SECONDS (= cycles/cps), which is why it is computed that way here.
// (Measured 2026-09-26.)

import dgram from 'node:dgram';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const SECONDS = arg('--seconds', 8);
const PORT = arg('--port', 57121);
const HOST = '127.0.0.1';

const NTP_EPOCH_OFFSET = 2208988800;
const CPS = 0.575;

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

// One event per packet, ~11.5/s: d1 is a 4-per-cycle sample pattern on orbit 0,
// d2 a 6-per-cycle pitched one on orbit 1 — the same pair used in the M0 capture.
const D1 = ['bd', 'hh', 'sn', 'hh'];
const D2 = [4, -25, -29, 11, -25, -36];
const EVENT_MS = 1000 / 11.5;
const LEAD = 0.27; // seconds; measured Tidal lead was 250-290ms

const sock = dgram.createSocket('udp4');
const t0 = Date.now() / 1000;
let n = 0;
let sent = 0;

const iv = setInterval(() => {
  const now = Date.now() / 1000;
  const cycle = (now - t0) * CPS + 1; // start at cycle 1, like a fresh pattern
  const orbit = n % 2;
  const args =
    orbit === 0
      ? ['_id_', '1', 'cps', CPS, 'cycle', cycle, 'delta', 0.25 / CPS, 'gain', 0, 'orbit', 0, 's', D1[n % 4]]
      : ['_id_', '2', 'cps', CPS, 'cycle', cycle, 'delta', (1 / 6) / CPS, 'gain', 0, 'orbit', 1, 'n', D2[n % 6], 's', 'arpy'];
  sock.send(encBundle(now + LEAD, [encMessage('/dirt/play', args)]), PORT, HOST);
  n++;
  sent++;
}, EVENT_MS);

setTimeout(() => {
  clearInterval(iv);
  sock.close();
  console.error(`synth-tidal: sent ${sent} events in ${SECONDS}s`);
}, SECONDS * 1000);
