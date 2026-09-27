#!/usr/bin/env bash
# QUESTION: does daemon.mjs, driven through its real stdin control channel with the
# synthetic Tidal sender, actually render the new styles -- and does an unknown
# style name still fall back LOUDLY to pianoroll?  Ends by proving no daemon is
# left alive and port 57121 is free.
#
# RUN: bash e2e-check.sh
#
# Three cases, same 8s of synthetic events each (synth-tidal.mjs), only the stdin
# control lines differ, so any difference in the frames is the style's doing:
#   styles   viz all sparse | viz 0 trails | viz 1 outline   (3 styles, 2 orbits)
#   baseline viz 0 pianoroll | viz 1 pianoroll
#   fallback viz 0 nosuchstyle                                (must warn, use pianoroll)
#
# GOTCHA that cost a run: a `... | node ... &' pipeline makes $! the wrapper
# SUBSHELL, so killing it orphans the daemon -- which then squats on 57121 and
# makes every later case die with EADDRINUSE (a silent no-op, since the frames
# simply never appear).  Hence `exec' in the subshell, and the pre-flight check.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/daemon"
SYNTH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/synth-tidal.mjs"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e"
NODE=$(command -v node)

rm -rf "$OUT"; mkdir -p "$OUT"

if ss -lunp 2>/dev/null | grep -q 57121; then
  printf 'REFUSING TO RUN: something already holds port 57121:\n%s\n' "$(ss -lunp | grep 57121)"
  exit 1
fi

run_case() {
  local name="$1" secs="$2"; shift 2
  local dir="$OUT/$name"
  mkdir -p "$dir"
  # `exec' replaces the subshell with node, so $! IS the daemon and kill reaches
  # it.  stdin is a here-string: the control lines are consumed at once and the
  # channel then closes, which the daemon tolerates (its setInterval keeps it up,
  # and on EOF the stream just stops -- no 'end' handler, nothing to unwind).
  ( cd "$DIR" && exec "$NODE" --import ./register.mjs daemon.mjs \
      --size 500x180 --out "$dir/frame.png" --quiet \
      <<< "$(printf '%s\n' "$@")" ) 2> "$dir/daemon.err" &
  local dpid=$!
  sleep 1.5   # let it bind and the control lines land
  "$NODE" "$SYNTH" --seconds "$secs" > "$dir/synth.log" 2>&1
  sleep 2     # a couple more frames at the final style
  kill "$dpid" 2>/dev/null
  wait "$dpid" 2>/dev/null
  printf '\n=== case %s: %s\n' "$name" "$*"
  printf '  frames: %s\n' "$(ls "$dir"/frame*.png 2>/dev/null | tr '\n' ' ' || echo MISSING)"
  printf '  control-channel echo:\n'
  grep -E "\-> |is not a style|aggregate frame|socket error" "$dir/daemon.err" | sed 's/^/    /'
}

run_case styles   8 "viz all sparse" "viz 0 trails" "viz 1 outline"
run_case baseline 8 "viz 0 pianoroll" "viz 1 pianoroll"
run_case fallback 4 "viz 0 nosuchstyle"

# ---- how much ink each frame carries (same geometry as the styles table) -------
cd "$DIR" && "$NODE" --import ./register.mjs --input-type=module -e '
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire(process.argv[1]);
const { createCanvas, loadImage } = await import(req.resolve("@napi-rs/canvas"));
const hex = (h) => [1,3,5].map((i)=>parseInt(h.slice(i,i+2),16));
const BG = hex("#1e1e1e");
const base = process.argv[2];
console.log("\n=== ink in the frames the daemon actually wrote ===");
for (const name of ["styles","baseline","fallback"]) {
  for (const o of [0,1]) {
    const p = `${base}/${name}/frame-${o}.png`;
    if (!existsSync(p)) { console.log(`  ${name} frame-${o}: MISSING`); continue; }
    const img = await loadImage(p);
    const c = createCanvas(img.width, img.height); const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0,0,img.width,img.height).data;
    let ink = 0; const cols = new Set();
    for (let i=0;i<d.length;i+=4) {
      if (Math.abs(d[i]-BG[0])<=2 && Math.abs(d[i+1]-BG[1])<=2 && Math.abs(d[i+2]-BG[2])<=2) continue;
      ink++; cols.add((d[i]<<16)|(d[i+1]<<8)|d[i+2]);
    }
    console.log(`  ${name.padEnd(8)} frame-${o}: ${img.width}x${img.height}  ink ${(100*ink/(img.width*img.height)).toFixed(1)}%  colours ${cols.size}`);
  }
}
' "$DIR/" "$OUT" 2>/dev/null

# ---- nothing left behind ------------------------------------------------------
printf '\n=== leftovers ===\n'
printf '  port 57121: %s\n' "$(ss -lunp 2>/dev/null | grep 57121 || echo 'FREE (no listener)')"
printf '  daemon processes: %s\n' "$(pgrep -af '[d]aemon\.mjs' || echo 'none')"
