;;; tidal-viz.el --- Live Tidal visuals in a buffer -*- lexical-binding: t; -*-

;; Copyright (C) 2026 Laura Brustenga i Moncusí

;; Author: Laura Brustenga i Moncusí <laurea987@gmail.com>
;; Maintainer: Laura Brustenga i Moncusí <laurea987@gmail.com>
;; URL: https://github.com/LauraBMo/tidal-viz.el
;; Version: 0.1.0
;; Package-Requires: ((emacs "29.1"))
;; Keywords: tools, multimedia
;; SPDX-License-Identifier: MIT

;; This file is not part of GNU Emacs.

;;; Commentary:

;; The Emacs half of the Tidal visualiser.  It runs the Node daemon in
;; daemon/ (see daemon.mjs) and shows the frames it produces.
;;
;; Event-driven, not polling: the daemon writes one line per rendered frame on
;; stdout ("frame <orbit> <cycle>"), this filter turns that into an in-place
;; `image-refresh' of that orbit's image object.  The daemon writes each PNG
;; atomically (tmp + rename), so a frame can never be read half-written.
;;
;; The daemon is told which orbit wants which painter on ITS stdin, one
;; `viz <orbit> <painter>' line per marked block.
;;
;; Usage:
;;   M-x tidal-viz-start   start the daemon and show the buffer
;;   M-x tidal-viz-stop    stop it
;;   M-x tidal-viz-status  frames seen, measured fps, dropped frames
;;
;; Note on the flush: `image-flush' returns nil by design -- the flush is the
;; side effect -- and `image-refresh' is its alias, obsolete since 29.1, which is
;; why this file calls the one that is not.  Its docstring is the contract: the
;; next redisplay reads the file's current contents.  Hence the explicit
;; `force-window-update'.  (Measured 2026-09-26.)

;;; Code:

(require 'color)   ; `color-name-to-rgb' and `color-rgb-to-hex', for the theme

;; The two functions this file advises live in the `tidal' package, which is not
;; loaded when this file is compiled; declared so the compiler knows them.  Both
;; take no arguments.
(declare-function tidal-run-line "tidal" ())
(declare-function tidal-eval-multiple-lines "tidal" ())

(defgroup tidal-viz nil
  "Live visuals for Tidal patterns."
  :group 'tools)

(defcustom tidal-viz-directory
  (expand-file-name "daemon/"
                    (file-name-directory (or load-file-name buffer-file-name)))
  "Directory holding the tidal-viz Node daemon.
Defaults to the daemon/ directory beside this file, which is where it ships with
the package; set it here if you keep the daemon somewhere else."
  :type 'directory)

(defcustom tidal-viz-node "node"
  "Node executable to run the daemon with."
  :type 'string)

(defcustom tidal-viz-fps 30
  "Frames per second to ask the daemon for."
  :type 'integer)

(defcustom tidal-viz-window '(2 . 0.5)
  "Cons of (LOOKBEHIND . LOOKAHEAD) in cycles.
The playhead sits at LOOKBEHIND/(LOOKBEHIND+LOOKAHEAD) across the frame, so
leaning on history puts it near the right edge, the way a scrolling piano roll
reads.  LOOKAHEAD cannot usefully be large: Tidal only ever sends about 0.25s of
future events (its bundle timetag lead), so a window with as much future as past
is half empty by construction."
  :type '(cons number number))

(defcustom tidal-viz-size "1000x360"
  "Canvas size as WxH.  The dominant cost: PNG encoding scales steeply with
both pixel count and how much is drawn on the canvas, so this is the first knob
to turn if the frame rate is too low."
  :type 'string)

(defcustom tidal-viz-latency 0
  "Seconds to hold the playhead back, if the visual runs ahead of the sound.
This is not clock correction: the timetag Tidal sends is exact, and the daemon
uses it directly.  It is the gap between scsynth being told to play an event and
the sound leaving the speakers, so zero is right unless you can *see* the frame
leading what you *hear*.  Raise it in small steps if so."
  :type 'number)

(defcustom tidal-viz-colors nil
  "Colours for the visual, as an alist, or nil to follow the current theme.
Recognised keys: `background', `active', `inactive', `playhead'.  With nil the
background comes from the `default' face, so the frame sits on the same colour
as the code around it rather than looking pasted in."
  :type '(alist :key-type symbol :value-type string))

(defun tidal-viz--face-color (face attribute)
  "Colour of ATTRIBUTE on FACE, or nil if FACE is absent or leaves it unspecified."
  (when (facep face)
    (let ((v (face-attribute face attribute nil t)))
      (and (stringp v) (not (string= v "unspecified")) v))))

(defun tidal-viz--theme-color (key)
  "Pick KEY's colour out of the current theme."
  (pcase key
    ('background (tidal-viz--face-color 'default :background))
    ('active (or (tidal-viz--face-color 'font-lock-keyword-face :foreground)
                 (tidal-viz--face-color 'default :foreground)))
    ('inactive (or (tidal-viz--face-color 'shadow :foreground)
                   (tidal-viz--face-color 'font-lock-comment-face :foreground)
                   (tidal-viz--face-color 'default :foreground)))
    ('playhead (tidal-viz--face-color 'default :foreground))))

(defun tidal-viz--hex (color)
  "Return COLOR as #rrggbb, or nil if it is not a colour Emacs knows.
Face attributes come back as names (\"gray65\") as readily as hex, and the
painter is a canvas: an invalid fillStyle is silently ignored, so an
unconverted name would draw in whatever colour happened to be set already --
invisibly, if that was the background."
  (let ((rgb (and (stringp color) (color-name-to-rgb color))))
    (when rgb
      (apply #'color-rgb-to-hex (append rgb '(2))))))

(defun tidal-viz--color (key)
  "Colour for KEY as #rrggbb: the user's override, else the theme, else a fallback."
  (or (tidal-viz--hex (cdr (assq key tidal-viz-colors)))
      (tidal-viz--hex (tidal-viz--theme-color key))
      (pcase key
        ('background "#1e1e1e")
        ('active "#d0d0d0")
        ('inactive "#4a4a4a")
        (_ "#808080"))))

(defconst tidal-viz--buffer-name "*tidal-viz*")

(defvar tidal-viz--process nil)
(defvar tidal-viz--pending "")          ; partial line from the process filter
(defvar tidal-viz--count 0)             ; frames seen since the last reset
(defvar tidal-viz--count-start nil)     ; when that count began
(defvar tidal-viz--first-frame-at nil)  ; time of the first frame after a reset
(defvar tidal-viz--image nil)
(defvar tidal-viz--frame-file nil)
(defvar tidal-viz--started nil)

;; Inline-mode state lives up here, ABOVE tidal-viz--paint, deliberately: the
;; process filter can fire while this file is still being loaded, and it reaches
;; tidal-viz--blocks through tidal-viz--paint.  Defined further down, a frame
;; arriving mid-load signalled void-variable and took the filter out for that
;; frame.  Seen in *Messages*, 2026-09-26.
(defvar tidal-viz--blocks nil
  "One plist per block showing a frame.
Each has :overlay, :orbit, :painter, :buffer and :image.")
(defvar tidal-viz--advice-installed nil)

(defun tidal-viz--buffer ()
  "Return the visuals buffer, creating it."
  (get-buffer-create tidal-viz--buffer-name))

(defun tidal-viz-reset-stats ()
  "Zero the frame counter and begin a fresh fps measurement."
  (interactive)
  (setq tidal-viz--count 0
        tidal-viz--count-start (float-time)
        tidal-viz--first-frame-at nil)
  (message "tidal-viz: stats reset"))

(defun tidal-viz-fps ()
  "Average frames per second over the measured interval, or nil if too few.
Measured from the FIRST frame after a reset, not from the reset itself: before
any event arrives the daemon has no clock and emits nothing, so timing from the
reset would fold that idle stretch into the average and understate the rate.
Deliberately a plain count-over-elapsed rather than a rolling window of
timestamps, which could be corrupted by a burst and was hard to believe."
  (when (and tidal-viz--first-frame-at (> tidal-viz--count 1))
    (let ((elapsed (- (float-time) tidal-viz--first-frame-at)))
      (when (> elapsed 0)
        (/ (float (1- tidal-viz--count)) elapsed)))))

(defun tidal-viz--paint (&optional orbit)
  "Show the newest frame, wherever this session is displaying it.
With ORBIT, refresh only that orbit's block: the daemon emits one line per orbit
per tick, so refreshing every block on every line would do N times the work."
  (if tidal-viz--blocks
      (dolist (entry tidal-viz--blocks)
        (when (or (null orbit) (eq (plist-get entry :orbit) orbit))
          (tidal-viz--refresh-block entry)))
    (tidal-viz--paint-side)))

(defun tidal-viz--paint-side ()
  "Refresh the image in the *tidal-viz* side buffer."
  (with-current-buffer (tidal-viz--buffer)
    (unless tidal-viz--image
      (when (and tidal-viz--frame-file (file-exists-p tidal-viz--frame-file))
        ;; First frame only: create the image object once and keep it, so every
        ;; later frame is a refresh of the same object rather than a re-insert.
        (setq tidal-viz--image (create-image tidal-viz--frame-file 'png nil))
        (let ((inhibit-read-only t))
          (save-excursion
            (goto-char (point-max))
            (insert-image tidal-viz--image)
            (insert "\n")))))
    (when tidal-viz--image
      (image-flush tidal-viz--image)
      (force-window-update (current-buffer)))))

(defun tidal-viz--filter (_proc output)
  "Handle daemon OUTPUT: one `frame <orbit> <cycle>' line per rendered frame."
  (setq tidal-viz--pending (concat tidal-viz--pending output))
  (let ((start 0))
    (while (string-match "\n" tidal-viz--pending start)
      (let ((line (substring tidal-viz--pending start (match-beginning 0))))
        (setq start (match-end 0))
        (when (string-match "\\`frame \\([0-9]+\\)" line)
          (let ((orbit (string-to-number (match-string 1 line))))
            (setq tidal-viz--count (1+ tidal-viz--count))
            (unless tidal-viz--first-frame-at
              (setq tidal-viz--first-frame-at (float-time)))
            (tidal-viz--paint orbit)))))
    ;; This truncation must stay INSIDE the `let'.  Outside it, `start' is not
    ;; in scope under lexical-binding: the filter signalled void-variable on
    ;; every call, so `pending' was never cleared and each call reprocessed the
    ;; whole backlog.  Measured symptom: 36117 frames counted from 291 produced.
    (setq tidal-viz--pending (substring tidal-viz--pending start))))

(defun tidal-viz--sentinel (proc event)
  (unless (process-live-p proc)
    (when (eq proc tidal-viz--process)
      (setq tidal-viz--process nil)
      (message "tidal-viz: daemon stopped (%s)" (string-trim event)))))

(defun tidal-viz--start-daemon (&optional fps)
  "Start the daemon but do NOT show its side buffer.
Inline mode wants the daemon without the extra window."
  (tidal-viz-stop)
  (let ((fps (or fps tidal-viz-fps)))
    (setq tidal-viz--frame-file (expand-file-name "frame.png" tidal-viz-directory)
          tidal-viz--count 0
          tidal-viz--count-start (float-time)
          tidal-viz--first-frame-at nil
          tidal-viz--pending ""
          tidal-viz--image nil)
    (with-current-buffer (tidal-viz--buffer)
      (let ((inhibit-read-only t))
        (erase-buffer)
        (insert "Tidal -> Strudel pianoroll\n")
        (insert (format "daemon: %s\n\n" tidal-viz-directory))))
    ;; default-directory decides the child's cwd, and the daemon needs it for
    ;; ./register.mjs and node_modules.  Bind it for the make-process call.
    (let ((default-directory tidal-viz-directory))
      (setq tidal-viz--process
            (make-process
             :name "tidal-viz"
             :command (list tidal-viz-node "--import" "./register.mjs" "daemon.mjs"
                            "--fps" (number-to-string fps)
                            "--lookbehind" (number-to-string (car tidal-viz-window))
                            "--lookahead" (number-to-string (cdr tidal-viz-window))
                            "--size" tidal-viz-size
                            "--visual-latency" (number-to-string tidal-viz-latency)
                            "--background" (tidal-viz--color 'background)
                            "--active" (tidal-viz--color 'active)
                            "--inactive" (tidal-viz--color 'inactive)
                            "--playhead" (tidal-viz--color 'playhead)
                            "--out" tidal-viz--frame-file)
             :coding 'utf-8-unix
             :noquery t
             :connection-type 'pipe
             ;; stdout is the frame protocol and nothing else, so stderr must go
             ;; somewhere else -- mixing the two would put the daemon's stats in
             ;; the filter.  It lands in *tidal-viz-log*, which is also where its
             ;; own cost breakdown can be read.
             :stderr (get-buffer-create "*tidal-viz-log*")
             :filter #'tidal-viz--filter
             :sentinel #'tidal-viz--sentinel)))
    fps))

(defun tidal-viz-start (&optional fps)
  "Start the daemon and show its own buffer: the side-buffer view.
With FPS, ask for that many frames per second instead of `tidal-viz-fps'.
For the inline view instead, use `tidal-viz-inline-mode' in a .tidal buffer."
  (interactive)
  (let ((fps (tidal-viz--start-daemon fps)))
    (display-buffer (tidal-viz--buffer))
    (message "tidal-viz: started, asking for %d fps" fps)))

(defun tidal-viz-stop ()
  "Stop the tidal-viz daemon."
  (interactive)
  (when (process-live-p tidal-viz--process)
    (delete-process tidal-viz--process))
  (setq tidal-viz--process nil))

(defun tidal-viz-status ()
  "Report frames seen and measured fps."
  (interactive)
  (let ((fps (tidal-viz-fps)))
    (message "tidal-viz: %d frames, %s fps, %s"
             tidal-viz--count
             (if fps (format "%.1f" fps) "unknown")
             (if (process-live-p tidal-viz--process) "running" "stopped"))))

;;; Inline mode -- a frame under each marked block
;;
;; Explicit opt-in: a block shows a frame only if it carries a
;;   -- viz         (pianoroll)
;;   -- viz:punchcard
;; trailing comment.  Which orbit's events appear there comes from the block's
;; own dN runner: d1 is orbit 0, d2 orbit 1.  Each marked block gets its OWN
;; overlay, fed by its own frame-<orbit>.png.

(defconst tidal-viz--marker-re
  "--[ \t]*viz\\(?::\\([a-zA-Z]+\\)\\)?\\(?:[ \t]*$\\)"
  "Matches a trailing `-- viz' or `-- viz:painter' marker.")

(defconst tidal-viz--orbit-re "\\_<d\\([0-9]+\\)\\_>"
  "Matches a dN runner name at a word boundary.
The boundary matters: without it `bd1' would look like a runner too.")

(defun tidal-viz--marker-painter (text)
  "Painter named by a `-- viz[:painter]' marker in TEXT, or nil if there is none."
  (when (string-match tidal-viz--marker-re text)
    (or (match-string 1 text) "pianoroll")))

(defun tidal-viz--marker-orbit (text)
  "Orbit for the block TEXT, taken from its dN runner, or nil if it has none."
  (when (string-match tidal-viz--orbit-re text)
    (1- (string-to-number (match-string 1 text)))))

(defun tidal-viz--orbit-file (orbit)
  "The PNG the daemon writes for ORBIT."
  (expand-file-name (format "frame-%d.png" orbit) tidal-viz-directory))

(defun tidal-viz--tell-daemon (line)
  "Send LINE to the daemon's stdin: which orbit wants which painter.
Stdin is one-way and ordered, which is all this needs."
  (when (process-live-p tidal-viz--process)
    (process-send-string tidal-viz--process (concat line "\n"))))

(defun tidal-viz--clean-blocks ()
  "Drop entries whose overlay or buffer has gone."
  (setq tidal-viz--blocks
        (seq-filter (lambda (b)
                      (and (overlayp (plist-get b :overlay))
                           (overlay-buffer (plist-get b :overlay))
                           (buffer-live-p (plist-get b :buffer))))
                    tidal-viz--blocks)))

(defun tidal-viz--block-entry (orbit)
  (tidal-viz--clean-blocks)
  (seq-find (lambda (b) (eq (plist-get b :orbit) orbit)) tidal-viz--blocks))

(defun tidal-viz--ensure-block-image (entry)
  "The image object for ENTRY, created once its frame file exists."
  (or (plist-get entry :image)
      (let ((file (tidal-viz--orbit-file (plist-get entry :orbit))))
        (when (file-exists-p file)
          (let ((img (create-image file 'png nil)))
            (plist-put entry :image img)
            img)))))

(defun tidal-viz--block-string (entry)
  "The overlay text for ENTRY: its frame on its own line."
  (if (tidal-viz--ensure-block-image entry)
      (concat "\n" (propertize " " 'display (plist-get entry :image)) "\n")
    "\n[waiting for the first frame]\n"))

(defun tidal-viz--refresh-block (entry)
  "Refresh ENTRY's frame in place.  The overlay is never touched."
  (let ((ov (plist-get entry :overlay))
        (buf (plist-get entry :buffer)))
    (when (and (overlayp ov) (overlay-buffer ov) (buffer-live-p buf))
      (let ((had (plist-get entry :image)))
        (tidal-viz--ensure-block-image entry)
        (unless (eq had (plist-get entry :image))
          ;; its first frame has landed: swap the placeholder for the image
          (overlay-put ov 'after-string (tidal-viz--block-string entry))))
      (when (plist-get entry :image)
        (image-flush (plist-get entry :image))
        (force-window-update buf)))))

(defun tidal-viz--show-block (buf end orbit painter)
  "Show ORBIT's frame just after position END in BUF, moving any existing one."
  (with-current-buffer buf
    (let ((entry (tidal-viz--block-entry orbit))
          ov)
      (if entry
          (setq ov (plist-get entry :overlay))
        (setq ov (make-overlay end end buf t t)
              entry (list :overlay ov :orbit orbit :painter painter
                          :buffer buf :image nil))
        (push entry tidal-viz--blocks))
      (plist-put entry :painter painter)
      (plist-put entry :buffer buf)
      (move-overlay ov end end buf)
      (overlay-put ov 'after-string (tidal-viz--block-string entry))
      (force-window-update buf))))

(defun tidal-viz--forget-orbit (orbit)
  "Stop showing ORBIT and tell the daemon not to render it."
  (tidal-viz--tell-daemon (format "viz %d none" orbit))
  (let ((entry (tidal-viz--block-entry orbit)))
    (when entry
      (when (overlayp (plist-get entry :overlay))
        (delete-overlay (plist-get entry :overlay)))
      (setq tidal-viz--blocks (delq entry tidal-viz--blocks)))))

(defun tidal-viz--register-block (beg end)
  "Act on the marker in the block BEG..END, if it has one."
  (when (and (bound-and-true-p tidal-viz-inline-mode)
             (buffer-live-p (current-buffer)))
    (let* ((buf (current-buffer))
           (text (buffer-substring-no-properties beg end))
           (orbit (tidal-viz--marker-orbit text))
           (painter (tidal-viz--marker-painter text)))
      (cond
       ((null painter)
        ;; explicit opt-in: nothing marked, nothing shown
        (when orbit (tidal-viz--forget-orbit orbit)))
       ((null orbit)
        (message "tidal-viz: '-- viz' here, but no dN runner to say which orbit"))
       (t
        (tidal-viz--tell-daemon (format "viz %d %s" orbit painter))
        (tidal-viz--show-block buf end orbit painter))))))

;; The two send paths that know where the block is.  tidal.el's unit of work is
;; the paragraph: C-c C-c runs `tidal-run-line' (one line), and the dN runners go
;; through `tidal-eval-multiple-lines', which marks the paragraph first.

(defun tidal-viz--advise-line (orig)
  "Note which line is being sent, then hang the frame under it.
Bounds are captured before the command runs, because `tidal-run-line' calls
`forward-line' on its way out."
  (let ((buf (current-buffer))
        (beg (line-beginning-position))
        (end (line-end-position)))
    (prog1 (funcall orig)
      (with-current-buffer buf
        (tidal-viz--register-block beg end)))))

(defun tidal-viz--advise-paragraph (orig &rest args)
  "Note which paragraph is being sent, then hang the frame under it.
`mark-paragraph' moves point and sets the mark, so it is evaluated inside
`save-excursion' to leave the command's own view of point untouched."
  (let ((buf (current-buffer))
        (bounds (and (bound-and-true-p tidal-viz-inline-mode)
                     (save-excursion
                       (mark-paragraph)
                       (cons (region-beginning) (region-end))))))
    (prog1 (apply orig args)
      (when bounds
        (with-current-buffer buf
          (tidal-viz--register-block (car bounds) (cdr bounds)))))))

(defun tidal-viz--install-advice ()
  (unless tidal-viz--advice-installed
    (advice-add 'tidal-run-line :around #'tidal-viz--advise-line)
    (advice-add 'tidal-eval-multiple-lines :around #'tidal-viz--advise-paragraph)
    (setq tidal-viz--advice-installed t)))

;;;###autoload
(define-minor-mode tidal-viz-inline-mode
  "Show a live frame under each marked Tidal block.

A block opts in with a trailing `-- viz' or `-- viz:painter' comment; its dN
runner says which orbit feeds it.  The frame is carried in an overlay's
`after-string', so the buffer text and the .tidal file on disk are never
modified -- there is nothing to undo."
  :lighter " Viz"
  (if tidal-viz-inline-mode
      (progn
        (tidal-viz--install-advice)
        (if (process-live-p tidal-viz--process)
            ;; A daemon that is already up keeps its frame counter, so reset the
            ;; measurement.  Without this, `tidal-viz-fps' reports a rate averaged
            ;; since whenever the counter was last zeroed -- which read as a
            ;; seven-hour-old number the first time this was measured.
            (tidal-viz-reset-stats)
          (tidal-viz--start-daemon))
        ;; Idle until a block actually asks for a frame: rendering an aggregate
        ;; nobody asked for would burn the CPU this is trying to save.
        (tidal-viz--tell-daemon "viz all none")
        (message "tidal-viz: inline visuals on -- add `-- viz' to a block and send it"))
    (progn
      (tidal-viz--tell-daemon "viz all none")
      (dolist (entry tidal-viz--blocks)
        (when (overlayp (plist-get entry :overlay))
          (delete-overlay (plist-get entry :overlay))))
      (setq tidal-viz--blocks nil)
      (message "tidal-viz: inline visuals off"))))

(provide 'tidal-viz)
;;; tidal-viz.el ends here
