# pi Inline (Non-Alt-Screen) TUI Renderer — Port Notes

Source: `refs/pi/packages/tui/src`. All anchors are `file:line` into refs/pi.
Goal: port the concepts to mixdog. pi renders into the **normal buffer** (no
alt-screen), diffs line arrays, and drives scrollback natively.

## Model
- Components implement `render(width): string[]` — pure line arrays, no cursor
  moves (`tui.ts:64-88`). `Container.render` concatenates children (`tui.ts:280-289`).
- TUI keeps `previousLines[]` and diffs against fresh `render()` output each
  cycle (`tui.ts:297`, `doRender` `tui.ts:1254-1271`).
- Render is throttled: coalesced via `renderRequested`, min 16ms between frames
  (`MIN_RENDER_INTERVAL_MS` `tui.ts:309`, `scheduleRender` `tui.ts:741-759`).
  `requestRender(true)` forces a full clear by resetting all tracking (`tui.ts:712-735`).

## Three render strategies (README `README.md:591-599`)
`doRender` computes `widthChanged`/`heightChanged` (`tui.ts:1258-1259`), then:
1. **First render** (`previousLines.length===0`, no size change): emit all lines,
   NO clear — assumes clean screen (`tui.ts:1336-1340`, `fullRender(false)`).
2. **Full re-render** (`fullRender(true)`): clear screen+scrollback then re-emit.
   Triggers: width change (wrap changes) `tui.ts:1343-1347`; height change
   (except Termux keyboard toggle) `tui.ts:1352-1356`; `clearOnShrink` when
   content shrank below high-water `tui.ts:1361-1365`; **first changed line is
   above the previous viewport** `tui.ts:1455-1459`; deleted-lines edge cases
   `tui.ts:1411-1414,1422-1425`; kitty-image pre-clear that would scroll `tui.ts:1498-1506`.
3. **Normal (differential) update**: move to first changed line, clear-to-EOL per
   line, re-emit only `firstChanged..lastChanged` (`tui.ts:1461-1549`).

## Full-render cost model & flicker mitigation
- Clear sequence: `\x1b[2J\x1b[H\x1b[3J` = clear viewport, home, clear scrollback
  (`tui.ts:1289`). Cost: whole history above viewport is wiped and re-emitted,
  so scrollback is rebuilt — expensive and the main flicker source.
- Everything is wrapped in **synchronized output** `\x1b[?2026h … \x1b[?2026l`
  so the terminal presents each frame atomically (`tui.ts:1286,1308` full;
  `tui.ts:1463,1570` diff). This is the primary flicker mitigation.
- The diff path re-emits only the changed span, not to end-of-buffer, to keep
  single-line updates (e.g. spinner) cheap (`tui.ts:1490-1492`).
- **Why "change above viewport ⇒ full clear":** relative cursor moves can only
  reach visible rows; a changed line already scrolled into scrollback can't be
  addressed, so the only correct fix is clear+rebuild (`tui.ts:1453-1459`).
  Implication for mixdog: keep transcript lines *append-only/stable* so edits
  never land above the viewport, or full redraws (flicker) become frequent.

## Diff algorithm
- Scan `max(new,prev)` lines for first/last differing index (`tui.ts:1368-1381`).
- Appended lines extend `lastChanged` to new end (`tui.ts:1382-1388`).
- No change ⇒ only reposition hardware cursor and return (`tui.ts:1396-1402`).
- Diff emit: per line `\x1b[2K` (clear line) then the line text (`tui.ts:1519,1548`).
- Shrink: after emitting, walk remaining old rows writing `\r\n\x1b[2K`, then
  move cursor back up (`tui.ts:1554-1568`).

## Bottom-anchored interactive area (prompt/editor kept below transcript)
- There is **no absolute positioning** for the editor; it's just the *last*
  children in the line array, so it renders after the streaming transcript.
  Composition order in the coding agent: header, chat, pending, status,
  widgets-above, **editorContainer**, widgets-below, footer
  (`interactive-mode.ts:640-649`); focus set to editor (`:650`).
- Streaming appends transcript lines above; because the editor lines are always
  last in the array, the diff naturally re-emits them lower each frame. New
  transcript that pushes past the viewport bottom is handled by an explicit
  scroll: move to bottom row, emit `\r\n`×scroll, advance `viewportTop`
  (`tui.ts:1465-1478`).
- Takeaway for mixdog: model the prompt as the tail of the same line list —
  don't try to pin it with cursor math.

## Overlays in a normal-buffer world (`tui.ts:1031-1091`)
- Overlays are **composited into the line array before diffing**, not drawn
  separately. `compositeOverlays` pads content up to terminal height so overlays
  get screen-relative rows (`tui.ts:1067-1074`), computes `viewportStart`
  (`tui.ts:1074`), and splices each overlay line into the base line at its col
  via `compositeLineAt` (single-pass segment extract + width-safe truncate,
  `tui.ts:1176-1224`).
- Layout (anchor/percent/margins/maxHeight) resolved in `resolveOverlayLayout`
  (`tui.ts:897-995`); z-order by `focusOrder` (`tui.ts:1040-1041`).
- Because overlays are ordinary composited lines, they still flow through the
  same diff/full-render logic — no separate cursor-addressed layer.

## Resize / width change
- `resize` handler wired on `process.stdout` (`terminal.ts:150`); on start a
  SIGWINCH is forced to refresh stale dims after suspend/resume (`terminal.ts:154-156`).
- Any width change forces `fullRender(true)` since wrapping is width-dependent
  (`tui.ts:1343-1347`); height change likewise except Termux (`tui.ts:1352-1356`).
- Hard guard: if any emitted line's `visibleWidth > width`, dump crash log,
  `stop()`, and throw — overflow would corrupt the differential model
  (`tui.ts:1520-1547`). Port implication: every component MUST truncate to width.

## Cursor & IME focus
- Focusable components emit a zero-width APC marker `CURSOR_MARKER` (`\x1b_pi:c\x07`)
  at the caret (`tui.ts:104-120`). `extractCursorPosition` scans only the visible
  viewport, computes visual col via `visibleWidth`, strips the marker
  (`tui.ts:1234-1252`).
- `positionHardwareCursor` moves the real cursor there so IME candidate windows
  anchor correctly; cursor shown only if `showHardwareCursor`, else hidden
  (`tui.ts:1627-1658`). `hardwareCursorRow` is tracked separately from logical
  `cursorRow` (`tui.ts:310-311`).
- On stop, cursor is moved to end of content so exit doesn't overwrite output
  (`tui.ts:687-710`).

## Scrollback interaction
- No alt-screen ⇒ transcript lives in the terminal's real scrollback; mouse
  wheel scrolling is **native terminal behavior**, pi does nothing (no mouse
  capture — see below). Pitfall pi accepts: a full redraw's `\x1b[3J` wipes
  scrollback, so history is only as stable as the diff path staying on the
  incremental strategy.

## Input pipeline & explicit pitfalls handled
- `StdinBuffer` reassembles **partial escape sequences** split across chunks
  (CSI/OSC/DCS/APC/SS3 completion detection) before emitting whole sequences,
  with a 10ms flush timeout (`stdin-buffer.ts:29-78,192-255,371-387`).
- Bracketed paste (`\x1b[?2004h`) enabled at start (`terminal.ts:147`); paste
  content is buffered and re-wrapped for the editor (`stdin-buffer.ts:315-369`,
  `terminal.ts:195-199`).
- Kitty keyboard protocol queried at start, with `modifyOtherKeys` fallback and
  handling for **responses split across events** + a fragment flush timeout
  (`terminal.ts:166,220-307`); `drainInput` disables the protocol and drains so
  late key-release events don't leak to the parent shell (`terminal.ts:368-404`).
- **Per-line SGR/hyperlink reset:** every emitted line is `normalizeTerminalOutput`-ed
  and suffixed with `\x1b[0m\x1b]8;;\x07` (`SEGMENT_RESET`) so color/hyperlink
  state never bleeds across lines (`tui.ts:1093-1104`).
- Line-reset tracking: `\x1b[2K` before each rendered line prevents stale glyphs
  from a longer previous line (`tui.ts:1508,1519`).

## What pi deliberately does NOT do
- **No alt-screen** (`\x1b[?1049h` never emitted — grep of `tui/src` = 0 hits):
  output stays in normal buffer and scrollback; trade-off = must clear+rebuild
  scrollback on width/height/above-viewport changes.
- **No mouse tracking** (`\x1b[?1000/1002/1003/1006h` never emitted): mouse SGR
  sequences are *parsed defensively* in the buffer (`stdin-buffer.ts:42-46,103-120`)
  but never enabled — wheel/selection stay native to the terminal.
- No fixed-region/scroll-margin layout: bottom anchoring is purely array order.

## Minimal port checklist for mixdog
1. Components → `render(width): string[]`; strict width truncation.
2. Keep `previousLines`; diff first/last changed; emit `\x1b[2K`+line per changed row.
3. Wrap every frame in `\x1b[?2026h/l`.
4. Full clear (`\x1b[2J\x1b[H\x1b[3J`) only on width/height change or change above viewport.
5. Editor/prompt = tail of the line array; scroll via `\r\n`×n when appending past bottom.
6. IME: zero-width marker → strip → position hardware cursor.
7. Buffer stdin for partial escapes; enable bracketed paste; no mouse/alt-screen.
