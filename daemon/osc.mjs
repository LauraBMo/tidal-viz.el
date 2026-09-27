// Minimal dependency-free OSC (1.0) decoder -- bundles with NTP timetags and
// messages, enough for what Tidal sends.
//
// Verified against a real capture and against an encoder round-trip (including a
// live UDP loopback) in ~/.claude/test-scripts/-home-laury--config-doom/osc-probe/,
// whose --selftest exits 0/1.  This is that decoder, lifted into the daemon.
//
// Note on types: Tidal mixes them per value -- `cps` always arrives as a float
// while `cycle` came as a float for 0.25/0.5/0.75 and as an int for 1.  Decode
// both; do not assume a key has one wire type.

const NTP_EPOCH_OFFSET = 2208988800; // seconds between 1900 and 1970

function readString(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', off, end);
  let next = end + 1;
  while (next % 4 !== 0) next++;
  return [str, next];
}

function decodeMessage(buf, off) {
  const [address, afterAddr] = readString(buf, off);
  let p = afterAddr;
  let types = '';
  if (buf[p] === 0x2c) {
    // ','
    [types, p] = readString(buf, p);
    types = types.slice(1);
  }
  const args = [];
  for (const t of types) {
    if (t === 'i') {
      args.push(buf.readInt32BE(p));
      p += 4;
    } else if (t === 'f') {
      args.push(buf.readFloatBE(p));
      p += 4;
    } else if (t === 's') {
      const [s, np] = readString(buf, p);
      args.push(s);
      p = np;
    } else if (t === 'd') {
      args.push(buf.readDoubleBE(p));
      p += 8;
    } else if (t === 'h') {
      args.push(buf.readBigInt64BE(p));
      p += 8;
    } else if (t === 't') {
      args.push(buf.readBigUInt64BE(p));
      p += 8;
    } else if (t === 'b') {
      const n = buf.readInt32BE(p);
      p += 4;
      args.push(buf.subarray(p, p + n));
      p += n;
      while (p % 4 !== 0) p++;
    } else if ('TFNI'.includes(t)) {
      args.push(t);
    } else {
      throw new Error(`unsupported OSC type tag '${t}' in '${address}'`);
    }
  }
  return { address, types, args };
}

/**
 * Decode one UDP datagram.
 * Bundle  -> { bundle: true, timetag, immediate, elements: [...] }
 * Message -> { bundle: false, address, types, args }
 * Nested bundles carry their own timetag down to their children.
 */
export function decodePacket(buf) {
  if (buf.length >= 16 && buf.toString('ascii', 0, 7) === '#bundle') {
    const secs = buf.readUInt32BE(8);
    const frac = buf.readUInt32BE(12);
    const immediate = secs === 0 && frac === 1;
    const timetag = immediate ? null : secs - NTP_EPOCH_OFFSET + frac / 4294967296;
    const elements = [];
    let p = 16;
    while (p + 4 <= buf.length) {
      const size = buf.readInt32BE(p);
      p += 4;
      if (size <= 0 || p + size > buf.length) break;
      elements.push(decodePacket(buf.subarray(p, p + size)));
      p += size;
    }
    return { bundle: true, timetag, immediate, elements };
  }
  return { bundle: false, ...decodeMessage(buf, 0) };
}
