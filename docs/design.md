# Tidal → Strudel painters → Emacs (in-buffer live-coding visuals)

Transient plan — delete after implementation. Final decisions as of 2026-09-26.

## Goal

Real animation **inside an Emacs buffer** — pianoroll / punchcard / spiral that
updates as a Tidal pattern plays — driven by the existing stack: Tidal in ghci,
audio via SuperDirt, `.tidal` files sent with `C-c C-c`. Not a browser window.

## Chosen approach: Option 2

Tidal stays the language (user dislikes Strudel's dot notation "at all"). A Node
daemon sniffs Tidal's `/dirt/play` OSC, builds Strudel `Hap`s, runs Strudel's own
painters, and emits PNG frames. Emacs displays them with `image-refresh`.

Rejected: Strudel-native headless (dot notation), xwidget/Emacs-31.1 rebuild
(WebKit 2.52.5 cap + unknown WebGL under no-accel policy), pure-Elisp SVG (0%
Strudel reuse, ~10 fps). The Node middleman is **forced**: Strudel's painters are
JavaScript+Canvas2D; Tidal (Haskell) and SuperDirt (SuperCollider) can run neither.

## Confirmed decisions

1. **Approach:** Option 2 (above).
2. **Placement: C — inline, per-block** (the Strudel notebook model), confirmed
   against the user's screenshots. Not a side panel.
3. **Code lives in `local/`** — `tidal-viz.el` + Node daemon in `local/tidal-viz/`.
   Unfinished `local/` dirs stay untracked until done.
4. **First visual: pianoroll.** Orbits: start simple (one view), then per-orbit.
5. **Delivery: file-backed PNG first**, byte-stream later.
6. **Marker syntax: A** — trailing `-- viz:<painter>` comment (bare `-- viz` = pianoroll).

## UX target (confirmed from screenshots)

The Strudel notebook: each marked pattern block renders its visual **directly
below the block, in the same `.tidal` buffer** — one continuous pane, continuous
line numbers, multiple blocks → multiple interleaved visuals. Never side-by-side.

**Out of scope:** the audio-analyzer panel (strudel2.png: dB meter, spectrogram,
radial orb, oscilloscope) = Strudel's `scope`/`fscope`/`spectrum`, which need a
live Web Audio `AnalyserNode`. Our audio is in scsynth; these can never show what
we play. Correctly excluded.

## Marker syntax (decided: A)

```haskell
d1 $ n("c2 eb2 g2") # s "kalimba" -- viz:pianoroll
```

Trailing `-- viz:<painter>` comment. Valid Tidal (interpreter ignores `--`),
declares the visual where the code is (Strudel's `._pianoroll()` analogue).
Painter ∈ {pianoroll, punchcard, spiral, pitchwheel, wordfall}; bare `-- viz`
defaults to pianoroll. Block → orbit inferred from the leading `dN` (v1
simplification: one `dN` per block).

## Architecture

```
.tidal file ──C-c C-c──► ghci (Tidal)
                          │  /dirt/play (timetagged, flat k/v pairs)
                          ├──► SuperDirt :57120  →  scsynth (audio)   [untouched]
                          └──► Node sniffer :57121 → Hap builder → painter → PNG(s)
                                                                         │
                              Emacs `.tidal` buffer ◄── image-refresh (per orbit) ─┘
```

## Verified facts (read from source / probes — do not re-derive)

- `/dirt/play` args are a **flat list of alternating key/value pairs**, not
  positional: `event.putPairs(msg[1..])` (`SuperDirt.sc:292`). Schema:
  `[/dirt/play, "cps", 1.0, "cycle", 0.0, "delta", 0.25, "orbit", 0, "s", "bd",
  "note", "c2", …]`. Needed keys: `cps, cycle, delta, orbit, s, note`.
- **The OSC bundle timetag is the schedule.** SuperDirt does
  `latency = time - thisThread.seconds` (`SuperDirt.sc:283`), where `time` is the
  timetag. The sniffer gets the identical timetagged packet, so visual "now" =
  wall-clock and events align to audio by construction.
- **RMS is NOT a clock.** `SendPeakRMS.kr(..., cmdName:"/rms", replyID: orbitIndex)`
  (`core-synths-global.scd:59`) sends `/rms, <orbit>, <rms>, <peak>` — level only,
  silent through rests. Ignore it.
- Second target via `mkTidalWith` (form already commented in BootTidal.hs:13–17).
- Painters are called directly, no pattern engine at runtime:
  - `__pianoroll({ ctx, haps, time, cycles, playhead, labels, fillActive })`
  - `getPunchcardPainter({ labels, fillActive })` → `(ctx, time, haps, drawTime)`
  - `pitchwheel({ ctx, haps, time })`
  - `spiral({ … }).getPainters()` → `(ctx, time, haps, drawTime)`
- Hap shim (proven in probe3): `new Hap(new TimeSpan(cycle, cycle+delta),
  new TimeSpan(cycle, cycle+delta), { s, note })`.
- `@kabelsalat/web` import needs the alias fix (`loader.mjs` + `register.mjs`).

### M0 measured on the wire (2026-09-26, silent `d1 $ sound "bd hh sn hh" # gain 0`)

- **The second target fires with no handshake reply.** 11 `/dirt/play` bundles reached
  57121 while the sniffer stayed silent. Tidal also sends `/dirt/handshake` to it (3×) and
  carries on regardless — SuperDirt's reply is what satisfies Tidal's "Waiting for
  SuperDirt…" gate, so a mute second target blocks nothing.
- **Timetag confirmed as the schedule**: every bundle was **250–290 ms ahead** of receive
  time (+283.8, +268.6, +252.4, …). That is the real lead, measured, not assumed.
- **`delta` is in SECONDS, not cycles.** `delta = 0.4348` at `cps = 0.5750` with 4
  events/cycle → `delta = eDelta_cycles / cps` (0.25 / 0.5750 = 0.4348). So a Hap's duration
  is `delta` **as sent** — an earlier draft of this plan wrongly said `delta / cps`.
- **`cycle` is in cycles.** Confirmed: 0.25, 0.5, 0.75, 1.0 across a 4-event pattern.
- **Key set is pattern-dependent.** This run: `_id_, cps, cycle, delta, gain, orbit, s`.
  `note` is **absent** when the pattern has no notes — the shim must fall back to `s`.
  `_id_` (string) was not previously listed; ignore it.
- **OSC types are mixed**: `cps` float, `cycle` float *and* int (1 arrived as `i`),
  `orbit`/`gain` int, `s`/`_id_` string. The decoder accepts all; the summary surfaces them.
- **The patched boot parses and boots clean** — TidalCycles banner, "Listening for external
  controls on 127.0.0.1:6010", no errors. Verified by running it, not by reading the diff.

### M1 verified (2026-09-26, replay of the M0 capture)

- **The chain works on real traffic.** 45 `/dirt/play` events (orbits 0 and 1) → Hap array →
  `__pianoroll` → PNG, exit 0. Verified *numerically* rather than by eye: **17.8 % ink and 239
  distinct colours** on black — not a blank PNG that still "succeeded".
- **`image-refresh` IS `image-flush`.** `(eq (indirect-function 'image-refresh)
  (indirect-function 'image-flush))` → `t`, same arglist, same docstring. So it **returns nil by
  design** and that nil is not a failure signal — the flush is the side effect. The guarantee is
  the docstring: "the next redisplay of this image will read from the current contents of that
  file". Force a redisplay (`force-window-update` + `redisplay t`) or the flush waits.
- **Refresh-in-place measured.** With one image object in the buffer, swapping the file
  underneath it 1000×360 → 400×400 moved the reported `image-size` from (100.08 . 16.04) to
  (40.08 . 17.81) **characters** (that is the default unit, not pixels). The object stayed the
  same, so this is a refresh, not a re-insert.
- **`_id_` is the `dN` identity** — `"1"` for `d1`/orbit 0, `"2"` for `d2`/orbit 1. That is the
  natural key for the per-block visuals in M4.
- **The `typeof window === 'undefined'` guard is confirmed**: `@strudel/core` prints
  `cannot use window: not in browser?` on load under Node. It warns and does **not** abort; the
  painters still draw. (Previously unverifiable — the file lives under `node_modules`.)
- **Open, needs an eye not a script:** `n "c2 eb2 g2 bb2"` sent **6** events per cycle with
  values `[4, -25, -29, 11, -25, -36]`, not 4 notes. That is Tidal's parse, not the shim — the
  arg pairing is verified (16 args, 8 pairs, type tags `sssfsfsfsfsfsiss`).

### M2 measured (2026-09-26, live daemon driven from Emacs)

- **Emacs is NOT the bottleneck.** Over one run the daemon produced **646** frames and Emacs
  consumed **645** — it keeps up 1:1 with everything Node can emit. The process filter plus
  `image-refresh` plus `force-window-update` path has headroom to spare.
- **The ceiling is PNG encoding, in Node.** Per frame at 500×180: draw ~3.2 ms, **encode
  ~21 ms**, write+rename ~0.6 ms. At 1000×360, encode runs **114–152 ms** and the ceiling
  falls to ~7 fps.
- **Encode scales with pixels AND with how much is drawn.** A static-content benchmark
  predicted 46 ms / 19.7 fps at 1000×360; the live daemon pays 114–152 ms / ~7 fps on the
  same canvas, because live patterns put far more distinct shapes and labels on screen for
  deflate to chew on. Cost also grows as the buffer fills (draw 2.7→8.2 ms, encode 26→29 ms
  across a single run).
- **So the fps levers are `--size` and the window length** (`--lookbehind`/`--lookahead`,
  currently 2+2 = 4 cycles ≈ 7 s of history, which at ~11.5 events/s puts ~80–115 events on
  screen at once). No Emacs-side knob changes the rate.
- **Loop mechanics are not a limit:** an ablation held 60 ticks/s and ~60 fps at 500×180,
  and still 37 fps with Tidal playing. The tick rate only collapses (~11/s) while ghci is
  *booting*; it recovers to ~59/s once Tidal is up. Measuring during boot skews everything.
- **Unresolved:** the daemon exited once mid-run ("Process tidal-viz stderr finished").
  Suspected cause is its stderr *buffer* being killed — Emacs ties a process to that buffer —
  but this is NOT confirmed. It survived every other run.

### M4 verified (2026-09-26, per-block inline)

- **Marker → orbit → overlay.** A block opts in with a trailing `-- viz` or
  `-- viz:painter`; its `dN` runner names the orbit (`dN` → orbit N-1). Parser checked
  on: `d1 -- viz` → pianoroll/orbit 0; `d2 -- viz:punchcard` → punchcard/orbit 1;
  no marker → nil (nothing shown); `d10` → orbit 9; and `bd1` correctly NOT treated as a
  runner (the `\\_<` word boundary is what does that).
- **Explicit opt-in confirmed by the user**, so an unmarked block shows nothing and any
  previously-marked orbit is told `viz <orbit> none`. On enable the mode sends `viz all
  none` so the daemon idles instead of rendering an aggregate nobody asked for.
- **Two blocks, two overlays, two frames** — verified live: `frame-0.png` and
  `frame-1.png` both produced, both blocks holding their own image object.
- **Control channel is stdin**: `viz all <painter>` / `viz <orbit> <painter>` /
  `viz <orbit> none`. One-way and ordered, which is all it needs.
- **Cost: each visualised block halves the others' rate.** Two orbits means two renders
  per tick, so at 500x180 the daemon emits ~30 lines/s total (~15 fps per orbit) and drops
  ticks. `--fps` will not fix that (it is cost-bound); `tidal-viz-size` will. Per-orbit
  rendering is what makes the blocks chunky, so the trade is worth it.
- **Open:** Emacs counted 7804 frames against the daemon's 7131 over the same run (~9%),
  with only one daemon process and one holder of 57121. Unexplained; no visible effect.

### Theme-native visuals (2026-09-26)

- The painter takes colours directly (`background`, `active`, `inactive`,
  `playheadColor`) and `labels` defaults to **false** — the numbers that read as pasted-on
  data were ours to turn off, not its default.
- **A canvas silently ignores an invalid `fillStyle`** and keeps the previous colour.
  Emacs hands over names like `gray65` as readily as hex, so passing one straight through
  painted the blocks in the background colour, on background — a successful, empty frame.
  The elisp now converts via `color-name-to-rgb` → `#rrggbb`, and the daemon validates and
  falls back loudly.
- **`time` is the PLAYHEAD, not the window's right edge**: `__pianoroll` draws
  `[time - cycles*playhead, time + cycles*(1-playhead)]`. Calibrated by placing one block at
  a known cycle and reading which pixels it landed on. Passing the right edge put the whole
  visible span in the future; column coverage went 58% → 91.6% once fixed.
- **Lookahead cannot be large**: Tidal only ever sends ~0.25s ahead, so equal lookbehind and
  lookahead is half-empty by construction. Default is now `(2 . 0.5)` — playhead at 80%.

| setting | ceiling | notes |
|---|---|---|
| 1000×360, 4-cycle window | ~7 fps | encode 114–152 ms; unusable for live feel |
| 500×180, 4-cycle window | ~20 fps | encode ~21 ms; probably fine for motivation |
| 500×180, shorter window | untested | fewer events on screen should buy several fps |

### M3 verified (2026-09-26, inline overlay)

- **The overlay carries the image in its `after-string`**, so `buffer-modified-p` stays **nil**:
  the `.tidal` file on disk is never touched and there is nothing to undo. This is why an
  overlay was chosen over a text property.
- **`tidal.el`'s unit of work is the paragraph.** `C-c C-c` is `tidal-run-line` (one line, and
  it calls `forward-line` on the way out, so bounds must be captured *before* the call); the
  `dN` runners go through `tidal-eval-multiple-lines`, which does `mark-paragraph`. Both are
  advised with `:around`; `mark-paragraph` is evaluated inside `save-excursion` so the
  command's own view of point is undisturbed.
- **Live through the overlay:** 395 frames, 16.4 fps — the same envelope as the side buffer, so
  inline costs nothing extra on the Emacs side.
- **Freeze-on-stale works.** After events stop the daemon draws one final frame with the
  playhead pinned at the last known cycle, then goes quiet (`296 frozen` ticks, 0 missed, frame
  count unchanged over 4s). Without it the window walked into emptiness and burned frames
  forever — invisible in a side buffer, glaring inline.
- **Still untested: the real `C-c C-c` end to end.** Everything above was driven by calling
  `tidal-viz--place-overlay` directly plus synthetic events. The advice is attached and
  verified, but a live send needs Tidal running through tidal.el, which has not been started.

### M5 survey (2026-09-26) — the painter picker was mostly an illusion

Surveyed `@strudel/draw` at runtime via `fn.toString()`, then confirmed by pixels:

- **`getPunchcardPainter` IS `__pianoroll`.** A factory returning
  `(ctx, time, haps, drawTime) => __pianoroll({...getDrawOptions(drawTime, opts)})`. Options go
  to the FACTORY; the painter's 4th arg is a `[lookbehind, lookahead]` tuple that
  `getDrawOptions` converts to `cycles = |lookbehind| + lookahead` and
  `playhead = |lookbehind| / that`. Passing `cycles`/`playhead` to the factory, or options to
  the painter, is **silently ignored**. On the same capture both render **identically**:
  15.71% ink, 8 colours.
- **`wordfall` and `spiral` are NOT exported** — not as keys, and not as subpath imports
  (`@strudel/draw/wordfall` → ERR_MODULE_NOT_FOUND). The plan listed both as reusable; that was
  wrong. M1's spiral probe worked through a Pattern *method*, which is a different route.
- **`pitchwheel` exists but is polar**: haps map to (angle, radius) by MIDI pitch, it takes **no
  `time`** (no playhead — the shape is the window), and it accepts **no colour options**. It
  rendered 100% ink with a **black** dominant, so on a light theme it would look broken.
  Themeing it means driving `setTheme`, whose key names have not been surveyed.
- **`getPainters` is not exported either** — M1's note assumed it.
- **Conclusion: one time-axis painter, plus a polar one.** The distinct looks live in
  `__pianoroll`'s OPTIONS, not in separate painters: `smear` (trails), `stroke`/`fill` (outline
  vs solid), `vertical`, `hideInactive`, `colorizeInactive`, `fold`.
- **Decided and built:** painter *names* are gone in favour of style **variants** on the one
  working painter — `-- viz:trails|outline|vertical|sparse`, with `punchcard` kept as an alias.
  Implemented as a `STYLES` table merged over the base options; an unknown name logs loudly and
  falls back to pianoroll.

### M5 implemented (2026-09-26) — style variants

Delegated to a subagent, then spot-checked independently. **Two of my own specs were wrong** and
measurement caught both:

- **`trails` is not a `smear` value.** `smear` is only truthiness-tested (`u || (clear, fill)`), so
  0.2/0.5/0.8 render byte-identically — independently re-confirmed here — and with the daemon's
  own `clearRect` they are inert. With no decay term ink climbs 22% → 94% over 20 frames, i.e. a
  solid block. So `trails` paints the background at alpha instead of clearing
  (`{smear: 1, fade: 0.6}`), the value swept to settle near 40-45% and never saturate.
- **My `outline` spec was broken.** `{fill: 0, fillActive: false}` gave 0.40% ink in a thin band,
  because the stroke switch is `stroke ?? (strokeActive && isSounding)` — only haps under the
  playhead got an outline. It needs `stroke: 1` too: 4.11% ink spanning the canvas, measured
  independently here.
- **Styles verified to differ from the default** (my own render, identical haps): pianoroll
  15.71% ink / 7 colours; outline 4.11% / 12; vertical 15.48% / 4; sparse 0.40% / 2. `punchcard`
  is pixel-identical to pianoroll — the documented alias, not a bug.
- **`sparse` is very aggressive.** `hideInactive: 1` draws only haps under the playhead, so a
  single frame is near-empty and it flickers as the playhead passes. Faithful to "only what is
  sounding now", but likely too little to be useful.
- `pitchwheel` is deliberately not offered (no colour options — always black) and `spiral` /
  `wordfall` do not exist in the package. Both are commented in the daemon so they are not
  rediscovered later.
- **The delegated end-to-end percentages are NOT controlled**: a second sender (the user's live
  Tidal) was on 57121 during that run, so those frames mixed two patterns. The controlled
  comparison is the table above, where the haps are identical by construction.

### M5 final items (2026-09-27)

- **`--port N`** added (default 57121) so a test daemon can listen elsewhere instead of competing
  for Tidal's stream with the one the user has running. Verified: bound 57199, left 57121 alone.
- **`tidal-viz-latency`** (defcustom, default 0) → `--visual-latency`.  This is NOT clock
  correction — the wire timetag is exact — it is the gap between scsynth being told to play an
  event and the sound leaving the speakers.  Measured differentially (two daemons, one stream):
  the offset is exactly `L * cps` cycles and it tracks a tempo change correctly.
- **A real bug found and fixed: the playhead jumped at a mid-stream `cps` change.**  The clock
  anchored on the newest event, which Tidal sends ~0.27 s in the FUTURE, so it walked backward
  from a future point — and that step is a fixed time converted to cycles at the current cps.
  The instant a new-cps event arrived, the step changed size: measured at **0.114-0.169 cycles**,
  BACKWARD on a rise (rewinding the visual and breaking monotonicity) and forward on a drop.
  The law `(cpsB - cpsA) * (b - 0.27)` was confirmed by a phase sweep agreeing to <=0.003 cycles.
  Fixed by anchoring on the newest event already REACHED and extrapolating forward: slopes still
  track the sent cps, the rise is now monotone with a worst step of 0.0445, and the drop's +0.1319
  leap becomes a -0.0121 step.  The residual is a sawtooth bounded by `gap * dcps` (~0.03-0.045
  cycles) and is FUNDAMENTAL: between events the clock must extrapolate with the last cps it
  heard, and only Tidal could beat that by announcing a tempo change sooner.
- **Byte-stream delivery: deliberately NOT built.**  Measured why: a `:data` image has no file,
  and its spec *is* its bytes (identical bytes give an equal spec, different bytes do not).  So
  the file path refreshes ONE stable spec in place, while a byte stream would mint a new image
  object and a new image-cache entry per frame per orbit, and re-put the overlay string — all to
  save the measured 0.21-0.6 ms of `writeFileSync` + `rename` out of a ~13 ms frame.  And
  `image-refresh`'s only guarantee is file-conditional ("if SPEC specifies an image file, the
  next redisplay will read from the current contents of that file").  Strictly worse; declined.

## Component 1 — Tidal second target (only `.hs` change)

`BootTidal.hs:11` currently `mkTidal`. Replace:

```haskell
let dirt    = superdirtTarget { oLatency = 0.05, oAddress = "127.0.0.1", oPort = 57120 }
    sniffer = superdirtTarget { oLatency = 0.05, oAddress = "127.0.0.1", oPort = 57121 }
tidalInst <- mkTidalWith [(dirt, [superdirtShape]), (sniffer, [superdirtShape])]
                         (defaultConfig { cFrameTimespan = 1/50, cProcessAhead = 1/20 })
```

Same `oLatency` on both targets so visual stamps match audio stamps. Sniffer is a
pure listener; SuperDirt's handshake/replies go to Tidal, never to it.

## Component 2 — Node renderer daemon (`local/tidal-viz/`)

Runtime deps leaner than the probes: `@strudel/core` (Hap/TimeSpan) +
`@strudel/draw` (painters) + an OSC lib. No `@strudel/mini`, no pattern engine.

1. **Listener** — bind UDP 57121; on `/dirt/play` read the bundle **timetag** →
   absolute play time, and the flat k/v args → `cps, cycle, delta, orbit, s, note`.
2. **Hap shim** — probe3 verbatim. `t` = bundle timetag (seconds). **`delta` is already in
   seconds** (`delta = eDelta_cycles / cps`; measured 0.4348 = 0.25 / 0.5750), so the duration
   is `delta` as sent, *not* `delta / cps`:
   `new Hap(new TimeSpan(t, t+delta), new TimeSpan(t, t+delta), { s, note: note ?? s })`.
   `note` is absent when the pattern has none — carry `s` instead. Ignore `_id_`.
   Ring-buffer events per orbit in `[now−2s, now+2s]`.
3. **Paint** — one canvas per visualized orbit; call its painter; `canvas.encode('png')`.
4. **Frame to Emacs** — file-backed: write PNG per orbit to a known path, signal
   readiness with the orbit id.
5. **Clock** — `now = wall-clock`; `setInterval` at 30 Hz re-renders. Node side
   trivially 30–60 Hz; Emacs `image-refresh` is the bottleneck (measure).

## Component 3 — Emacs side (`local/lisp/tidal-viz.el`)

- **Inline anchoring (target):** when a marked block is sent, insert a live image
  below the block (overlay / image text-property) and refresh it in place — the
  org-mode inline-image mechanism. Node renders one PNG per visualized orbit; the
  "frame ready <orbit>" notification refreshes the matching image.
- **Stepping stone (M2):** a side `*tidal-viz*` buffer with one aggregate feed,
  to prove the pipe and measure real fps before doing the anchoring.
- `tidal-viz-mode`: `tidal-viz-start`/`-stop` (spawn Node via `make-process`);
  process filter maps "frame ready <orbit>" → `image-refresh` on the right image.

## Clock sync — closed, with two tunable constants

Events are timetagged by Tidal; SuperDirt and the sniffer get the same stamp.
- Tidal→SuperDirt scheduling latency cancels (same `oLatency` both targets).
- scsynth/soundcard latency: a fixed few-ms audible lag after `t`. If the visual
  visibly leads, add one `visualLatency` offset constant. One empirical test.

**Time-unit — narrowed at M1.** The painters want **cycles**: Strudel's scheduler is
cycle-based, probe3 built TimeSpans straight from `cycle` and drew correctly, and M1
rendered real cps≠1 traffic both ways (`render.mjs --unit cycles|seconds`). Cycles is
the consistent base; the seconds variant renders too but its axis is not comparable, so
it is kept only as a contrast. **Not yet settled by eye** — both PNGs sit side by side in
`node-probe/`. punchcard/spiral still need their own check when they land.

## Reusable vs written

- **Reused unchanged:** painters (`__pianoroll`, `getPunchcardPainter`, `pitchwheel`,
  `spiral().getPainters()`) + `Hap`/`TimeSpan`/`Fraction` + the `@kabelsalat/web` alias.
- **Written:** OSC listener + flat-k/v → `{s,note}` decoder + timetag→TimeSpan mapping
  + per-orbit render loop + frame push + the `.el` mode + inline anchoring + marker
  parsing. The hard half (Hap build + painter call) is proven.

## Milestones

| # | What | Proves |
|---|---|---|
| **M0** | Second target + one-shot UDP dump of a static pattern (raw timetag + full k/v list) | **DONE 2026-09-26** — all three answered: target fires without a handshake, timetag is the schedule (+250–290 ms), key set captured |
| **M1** | Replay dumped events → one PNG → `image-refresh` in a buffer | **DONE 2026-09-26** — full pipe on real traffic, verified numerically; refresh-in-place confirmed observable |
| **M2** | Live listener + window + `setInterval` + file-backed PNG → side buffer (A) | **DONE 2026-09-26** — Emacs keeps up 1:1 (645 of 646 frames); ceiling is Node-side PNG encoding (~20 fps loaded at 500×180, ~7 at 1000×360) |
| **M3** | Inline single image (follow last sent block) | **DONE 2026-09-26** — overlay under the sent block, buffer text untouched; freeze-on-stale added |
| **M4** | Inline per-block with markers (C) — orbit-keyed, accumulating | **DONE 2026-09-26** — `-- viz[:painter]` opt-in, dN→orbit, one overlay per block fed by its own `frame-<orbit>.png` |
| **M5** | Byte-stream delivery, `visualLatency` tuning, painter picker, tempo-change handling | polish + fps ceiling |

M0 is the "won't take on faith" gate.

## Reference artifacts

- Node probes (already working): `~/.claude/test-scripts/-home-laury--config-doom/node-probe/`
  — `probe.mjs`, `probe2.mjs`, `probe3.mjs`, `render.mjs`, `loader.mjs`, `register.mjs`.
  Run: `node --import ./register.mjs probe3.mjs` (painters) or
  `node --import ./register.mjs render.mjs ../osc-probe/data/events.jsonl out.png` (M1).
- OSC capture: `~/.claude/test-scripts/-home-laury--config-doom/osc-probe/osc-dump.mjs`
  (`--selftest` exits 0/1; `--json` for machine-readable frames).
- SuperDirt: `~/.local/share/SuperCollider/downloaded-quarks/SuperDirt/classes/SuperDirt.sc`
- Tidal boot: `~/src/tidal-music/BootTidal.hs`
