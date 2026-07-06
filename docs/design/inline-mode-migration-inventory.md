# Inline-mode migration inventory (pi-style normal buffer)

Scope: enumerate every alt-screen / fullscreen / absolute-grid dependency in the
mixdog TUI and score each for a "pi-style inline mode" — normal buffer, no
`?1049h` alt screen, no SGR mouse capture, transcript flows into the terminal's
own scrollback, and only the bottom UI (prompt + statusline + overlays) is
redrawn in place. Verdicts: **KILLS** (feature impossible in inline), **KEEP**
(works unchanged), **REDESIGN** (needs rework). Read-only analysis.

## Core architectural finding

The current renderer is a *fixed bottom-anchored fullscreen frame*: every commit
re-emits the WHOLE viewport (transcript included) via log-update, inside the alt
screen. The transcript is not append-only — it is a bounded `overflow:hidden`
clip box (`App.jsx:3053-3078`) scrolled by negative `marginBottom`, redrawn each
frame. Inline mode inverts this: settled transcript rows must be *emitted once*
into scrollback and never rewritten; only a small live/bottom region is redrawn.
That inversion is the root of every REDESIGN below.

## Subsystem inventory

| Subsystem | Fullscreen / absolute-grid / no-scrollback assumption | Anchor | Verdict | Migration action |
|---|---|---|---|---|
| Alt-screen enter/teardown | Enters `?1049h` + `\x1b[2J\x1b[H`; teardown `?1049l`. Owns entire screen; scrollback hidden. | `index.jsx:452`, `:442`, `:26` | REDESIGN | Drop `?1049h`/`?1049l`; keep `TERMINAL_MODE_RESET` (mouse) + OSC bg; never full-clear on boot — print into normal buffer. |
| Mouse boot gate | App mode arms SGR `?1000/1002/1006` on the assumption reported (row,col) map 1:1 to the owned grid. | `index.jsx:508-512`, `use-mouse-input.mjs:117-120` | REDESIGN | Default to native mouse; stop enabling app SGR selection; keep only `?1007` alt-scroll if any. |
| ink renderer (frame writer) | `renderInteractiveFrame` diff/clearTerminal assumes fixed viewport it fully owns; `forceFullRepaint` = clearTerminal+rewrite. | `ink.js:1132-1195`, `:582`, `:354` | REDESIGN | Split output: settled lines → append-once (scrollback); dynamic tail → in-place. Full-clear repaints become bottom-region-only clear-and-reemit. |
| log-update writer | Relative-walk `eraseLines(previousLineCount)` / WT-safe absolute `cursorTo(0,i)` rewrite the whole recorded block each frame. | `log-update.js:182-256`, `:64-72` | REDESIGN | Bound the log-update block to the bottom UI only; transcript lines leave the diff set once printed. |
| ink `<Static>` vs live tree | App deliberately uses NO `<Static>` — full-width bands + hardware caret need real layout (`Static` collapses them). | `App.jsx:15-17`, `Static.js` | REDESIGN | Inline model = Static's "print once, never rewrite". Route settled transcript items through `<Static>` (or an equivalent append writer); keep bottom cluster live — accepting it breaks the measured-row/selection grid. |
| Transcript in-place updates | Bounded clip box, negative-margin scroll, per-frame re-serialize of mounted items. | `App.jsx:3053-3078`, `3088-3118` | REDESIGN | Settled items → append-only into scrollback + full clear-and-reemit only on upstream mutation of an already-emitted item. |
| Tool-card collapse / ctrl+O expand | Toggling `toolOutputExpanded` mutates an item's height in place → whole viewport re-layout. | `App.jsx:3096`, `transcript-window.mjs:328-373` | REDESIGN | Live/unsettled cards stay in redrawn bottom zone; retro-expand of a scrolled-off card needs full clear-and-reemit or must be disabled once committed to scrollback. |
| Streaming updates during a turn | Streaming assistant tail grows + measured-rows harvest re-lays out the frame every token flush. | `transcript-window.mjs:601-666`, `use-transcript-window` (measuredRowsVersion) | REDESIGN | Keep the streaming tail in the dynamic bottom region until `streaming:false`, then commit the settled block to scrollback once. |
| Drag selection engine | Selection is an ABSOLUTE output-cell rect `{x1,y1,x2,y2}` into the full frame grid; SGR (col,row) mapped 1:1. | `output.js:81-97`, `use-mouse-input.mjs:117-120,284-677` | KILLS | Cannot address scrollback rows. Drop app selection; hand selection/copy to the terminal (native mode behavior). |
| Stitch buffer / clipboard | Harvests grid rows under the selection keyed by `screenY - scrollTarget`; rebuilds copied text across app scroll. | `use-transcript-scroll.mjs:47-167`, `:432-518` | KILLS | Removed with app selection; clipboard becomes terminal-native Ctrl+C over scrollback. |
| Wheel scroll (app) | SGR wheel → `queueScrollCoalesced` → `scrollTranscriptRows` moves the clip box margin (app-owned viewport). | `use-mouse-input.mjs:316-337`, `use-transcript-scroll.mjs:432-550` | KILLS | Wheel goes to the terminal's own scrollback; delete app scroll path (or keep only for a pinned bottom overlay). |
| Native scroll router | Converts WT alt-scroll arrow bursts into app transcript scroll while native mode owns selection. | `use-native-scroll-router.mjs:44-118` | KILLS | Moot once transcript lives in scrollback — terminal handles the wheel; remove `?1007` routing. |
| Smooth-scroll / reading anchor | Animates `scrollOffset`, captures item-id reading anchors, bottom-follow — all app-viewport concepts. | `use-transcript-scroll.mjs:175-218`, `:456-482` | KILLS | Bottom-follow is implicit in append-only output; remove anchor/smooth-scroll machinery. |
| Row-index / windowing engine | `buildTranscriptRowIndex` + measured-rows + window caps exist to bound per-frame re-serialize cost of a mounted transcript. | `transcript-window.mjs:41-52`, `:545-561`, `:688-709` | REDESIGN | Append-only removes the re-serialize cost; windowing/measure caches shrink to just the live tail. |
| Slash palette / pickers / panels | Rendered as bands in the bottom cluster attached ABOVE the prompt — screen-relative only within the redrawn bottom region, never absolute. | `App.jsx:3154-3171`, `SlashCommandPalette.jsx`, `app/*-picker.mjs` | KEEP | Already bottom-anchored; survive as long as the bottom UI region is fully redrawn each frame. |
| Overlay scroll gate | `overlayBlocksGlobalTranscriptScroll` stops wheel reaching transcript while an overlay owns focus. | `slash-commands.mjs`, `use-mouse-input.mjs:329` | REDESIGN | With app scroll gone, gate only overlay-internal wheel (picker list) vs terminal scrollback. |
| Statusline band | Fixed 3-row bottom band, part of the redrawn frame; also a selectable grid region. | `App.jsx:781`, `:3154+`, `use-mouse-input.mjs:155-167` | KEEP | Stays in the redrawn bottom UI; drop its grid-selection region with the selection engine. |
| Resize reflow | Fixed `viewportHeight` from `resizeState.rows`; ink `clearTerminal` on width change; region routing reads `frameRowsRef`. | `App.jsx:3056`, `:2834-2840`, `ink.js:354` | REDESIGN | Terminal reflows scrollback itself; on resize clear-and-reemit ONLY the bottom UI — no full `clearTerminal`. |
| `/mouse app` vs `native` | `app` = SGR capture + app grid selection (needs owned fullscreen grid); `native` = terminal owns selection + alt-scroll wheel. | `App.jsx:1177-1195`, `index.jsx:508-512` | REDESIGN | Inline forces native-style behavior; `app` mode loses its selection/scroll purpose — remove it or restrict to bottom-UI hit-testing only. |
| forceRenderRepaint (WT native-highlight clear) | Full clear+rewrite frame to dismiss WT's native selection overlay before app paint. | `use-mouse-input.mjs:364`, `ink.js:582` | KILLS | Only needed because app selection coexists with native; gone once selection is native-only. |

## Hardest couplings (top 3)

1. **Renderer is a fixed fullscreen frame, not append-only** (`ink.js:1132-1195`,
   `log-update.js:182-256`, `App.jsx:3053-3078`). The whole viewport (transcript
   included) is re-serialized and rewritten every commit. Inline mode requires
   splitting output into "settled → scrollback, print once" vs "live → redraw",
   which the log-update/clearTerminal diff model has no seam for today.
2. **Selection + clipboard are built on an absolute output-cell grid**
   (`output.js:81-97`, `use-mouse-input.mjs:117-120`, `use-transcript-scroll.mjs:47-167`).
   Once rows live in terminal scrollback the app can no longer address them, so
   the entire drag/word/line/stitch/copy stack must be dropped in favor of native
   terminal selection — a large behavioral regression, not just code removal.
3. **In-place mutation of already-shown transcript items** (streaming tail growth
   + ctrl+O tool-card expand, `transcript-window.mjs:601-666`, `App.jsx:3096`).
   Append-only scrollback cannot rewrite committed lines, so streaming must stay
   in the live zone until settled and retro-expansion of old cards needs a full
   clear-and-reemit path (or must be forbidden post-commit).
