# tidal-viz.el

Live visuals for Tidal, drawn in the buffer you are playing from: the frame for a
block appears under that block, follows the playhead, and never touches the file
on disk.

Two halves, in one repository:

- **`tidal-viz.el`** — the Emacs package. Starts the daemon, turns the frames it
  produces into an in-place image refresh, and puts one under each marked block.
- **`daemon/`** — a Node daemon that listens for Tidal's OSC, keeps a rolling
  window of `/dirt/play` events, and paints them with Strudel's own `__pianoroll`.

They talk over three channels, all of them local: the daemon's **stdout** carries
one `frame <orbit> <cycle>` line per rendered frame, its **stdin** takes one
`viz <orbit> <painter>` line per marked block, and the frames themselves are PNG
files written atomically (tmp + rename), so a reader can never catch one
half-written.

## Requirements

| | |
| --- | --- |
| Emacs | 29.1 or newer — `image-flush`, which is what the refresh is |
| Node | with the daemon's dependencies installed: `cd daemon && npm install` |
| Tidal | with a **second OSC target** added to `BootTidal.hs`, on `127.0.0.1:57121` |
| `tidal.el` | for the inline mode only: the advice is on `tidal-run-line` |

The second OSC target is the one piece that is not code in this repository. The
daemon's own header says it plainly:

> Listens on 127.0.0.1:57121 (Tidal's *second* OSC target, added to
> `~/src/tidal-music/BootTidal.hs`)

Tidal already sends on one target; the visual needs a copy of the same stream, so
the boot script has to be edited to send to both. Nothing else about your Tidal
setup changes.

## Install

```sh
cd daemon && npm install        # once; the checkout owns node_modules
```

```elisp
(add-to-list 'load-path "/path/to/tidal-viz.el/")
(require 'tidal-viz)

(add-hook 'tidal-mode-hook #'tidal-viz-inline-mode)
(add-hook 'literate-tidal-mode-hook #'tidal-viz-inline-mode)
```

Then, in a Tidal buffer:

```
M-x tidal-viz-start    start the daemon and show the buffer it will draw in
M-x tidal-viz-stop     stop it
M-x tidal-viz-status   frames seen, measured fps, dropped frames
```

`tidal-viz-start` is also all you need before the inline mode — turning the mode
on starts the daemon if it is not already up.

## Marking a block

A block opts in with a trailing comment, `-- viz` or `-- viz:painter`; its `dN`
runner says which orbit feeds it, so the frame shown is the frame for that
pattern and no other:

```haskell
d1 $ s "bd*4"
  -- viz:punchcard
```

Six painters, from the daemon's `STYLES` table:

| painter | |
| --- | --- |
| `pianoroll` | the default; Strudel's own |
| `punchcard` | |
| `trails` | |
| `outline` | |
| `vertical` | |
| `sparse` | |

The frame rides in an overlay's `after-string`, so the buffer text and the
`.tidal` file on disk are never modified — there is nothing to undo.

## Options

```elisp
;; Where the daemon lives.  Defaults to the daemon/ directory beside this file.
(setq tidal-viz-directory (expand-file-name "daemon/" "~/src/lisp/tidal-viz.el/"))

(setq tidal-viz-node "node")        ; which node to run
(setq tidal-viz-fps 30)             ; frames per second to ask for
(setq tidal-viz-size "1000x360")    ; canvas size; the first knob if the fps sags
(setq tidal-viz-window '(2 . 0.5))  ; (LOOKBEHIND . LOOKAHEAD) in cycles
(setq tidal-viz-latency 0)          ; hold the playhead back, if it runs ahead
(setq tidal-viz-colors nil)         ; alist, or nil to follow the current theme
```

`tidal-viz-window` puts the playhead at `LOOKBEHIND/(LOOKBEHIND+LOOKAHEAD)` across
the frame, the way a scrolling piano roll reads. `LOOKAHEAD` cannot usefully be
large: Tidal only ever sends about 0.25 s of future events, so a window with as
much future as past is half empty by construction.

`tidal-viz-latency` is not clock correction — the timetag Tidal sends is exact
and the daemon uses it directly. It is the gap between scsynth being told to play
an event and the sound leaving the speakers, so zero is right unless you can
*see* the frame leading what you *hear*.

## The daemon on its own

```sh
cd daemon
node --import ./register.mjs daemon.mjs --help
```

It takes `--fps`, `--lookbehind`, `--lookahead`, `--size`, `--out`, `--port`,
`--visual-latency` and the four colours. `register.mjs` is a module-resolution
shim that has to be preloaded with `--import`: it redirects `@kabelsalat/web`,
whose export is broken in the `@strudel/core` version this pins.

The package passes all of those from the defcustoms above; running it by hand is
how you check the daemon without Emacs in the way.

## Tests

`test/` holds the harness the daemon was built against. These are per-question
probes rather than a suite: each one answers one question about the daemon's
behaviour, and `test/INDEX.org` indexes them.

| | |
| --- | --- |
| `styles-verify.mjs` | do the six `STYLES` produce different pictures, from identical haps? Reports ink coverage and distinct colours, and reads the table out of `daemon.mjs` rather than copying it |
| `punchcard-calib.mjs` | is `getPunchcardPainter` byte-identical to `__pianoroll`, as assumed? |
| `smear-trajectory.mjs` | how does `smear` alone behave — truthiness-tested, saturating — which is where the `trails` fade comes from |
| `tempo-track.mjs` | does the emitted playhead stay monotonic across a mid-stream `cps` change? (It did not; the bug was found here) |
| `e2e-check.sh` | drives a real daemon over the real socket and stdin for three style combinations, and keeps the frames and logs |
| `synth-tidal.mjs` | the synthetic sender that driver feeds: a `/dirt/play` stream shaped like Tidal's, so nothing slow in the picture is anything but the daemon |

Run them from `test/`, after `npm install` in `daemon/`:

```sh
cd test && node --import ../daemon/register.mjs styles-verify.mjs
```

`test/e2e-report.txt` is the recorded output of a real end-to-end run. The scripts
write their frames and logs under `test/data/` and `test/e2e/`, which are
generated and untracked — with one exception: `test/data/events.jsonl` is an
*input*, a real capture of Tidal's OSC that the two style probes tile in cycles,
so it ships with the harness.

`tempo-track.mjs` and `e2e-check.sh` start their own daemon. `e2e-check.sh` uses
the real port by default, so it needs `57121` free — stop any daemon you have
running first.

## Design record

`docs/design.md` is the record the daemon was built from: the approach and the
alternatives rejected, the milestone table, and an archive of the measurements
behind the choices. Its own header calls it a transient plan to delete after
implementation; it is kept because its second half is not transient — the
measurements are what explains why the painters and the frame delivery are the
way they are.

## Known limitations

- **One daemon, one port.** The daemon listens on `127.0.0.1:57121`, so two at
  once is a port conflict. `--port` exists for tests, not for two live sessions.
- **`node_modules` is not shipped.** Run `npm install` in `daemon/`; the lockfile
  pins what that resolves to.
- **The inline frame is an overlay.** It is shown, never written into the buffer
  or the file, which is the point — and it also means the frame is not part of
  what you save, export, or share.
- **The second OSC target is a manual step.** No code here can add it to your
  `BootTidal.hs`.

## Licence

MIT — see [LICENSE](LICENSE).
