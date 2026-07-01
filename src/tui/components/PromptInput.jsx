/*
 * components/PromptInput.jsx — the prompt input line.
 *
 * A self-contained editor built on ink's useInput. The text renders as plain
 * text and a thin NATIVE hardware cursor sits at the insertion point (also where
 * the terminal echoes typed/IME characters).
 *
 * CURSOR — via a small ink fork (vendor/ink, mirrored into node_modules): we
 * tag the text-box node with `internal_cursorAnchor = { col, row }` (the caret's
 * position WITHIN the box). Forked ink, during renderNodeToOutput, parks the
 * hardware cursor at that node's REAL laid-out absolute cell + (col,row) — every
 * frame, from the actual yoga layout. This replaces ink's stock useCursor, whose
 * externally-supplied absolute coordinate drifted/vanished whenever the layout
 * above the input changed (spinner/thinking growth, Enter, fullscreen relayout)
 * because it was computed a beat before the final layout. The fork computes it
 * at the exact moment of drawing, so it can never be stale.
 */
import React, { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme, surfaceBackground } from '../theme.mjs';
import {
  caretPosition,
  clearSelection,
  deleteBackwardWord,
  deleteForwardWord,
  deleteSelectedText,
  deleteToLineEnd,
  deleteToLineStart,
  lineEnd,
  lineStart,
  moveCursor,
  nextOffset,
  nextWordOffset,
  offsetAtCell,
  previousOffset,
  previousWordOffset,
  replaceSelection,
  selectionRange,
  verticalOffset,
} from '../input-editing.mjs';

function hintStyle(tone) {
  if (tone === 'error') return { textColor: theme.error };
  if (tone === 'warn' || tone === 'cancel') return { textColor: theme.warning };
  if (tone === 'plain') return { textColor: theme.subtle };
  return { textColor: theme.inactive };
}

// Windows Terminal IME composition can clip a glyph that starts exactly at the
// left edge of the editable text node. The rounded prompt box already adds a
// paddingX of 1, so the typing start can sit directly against that padding
// without an extra guard column.
const IME_LEFT_GUARD_COLUMNS = 0;
// Coalesce prompt mouse-drag extend commits (SGR motion can fire faster than ink
// needs to immediate-render). Matches transcript selection paint cadence.
const MOUSE_EXTEND_COALESCE_MS = 24;

function insertText(draft, input) {
  if (!input) return draft;
  return replaceSelection(draft, input);
}

function renderSelectedText(displayValue, range, trailingSpace = false) {
  if (!range) return trailingSpace ? `${displayValue} ` : displayValue;
  const start = Math.max(0, Math.min(displayValue.length, range.start));
  const end = Math.max(start, Math.min(displayValue.length, range.end));
  return (
    <>
      {start > 0 ? displayValue.slice(0, start) : null}
      {end > start ? (
        <Text color={theme.selectionText} backgroundColor={theme.selectionBackground}>{displayValue.slice(start, end)}</Text>
      ) : null}
      {displayValue.slice(end)}
      {trailingSpace ? ' ' : ''}
    </>
  );
}

function normalizePastedText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

function singleTrailingLineBreakPrefix(text) {
  const normalized = normalizePastedText(text);
  if (!normalized.endsWith('\n')) return null;
  const prefix = normalized.slice(0, -1);
  return prefix.includes('\n') ? null : prefix;
}

function draftStateEqual(a, b) {
  return (
    a.value === b.value
    && a.cursor === b.cursor
    && a.selectionAnchor === b.selectionAnchor
  );
}

// Recognize a MODIFIED Enter delivered via the kitty keyboard protocol
// (\x1b[13;<mod>u) or modifyOtherKeys (\x1b[27;<mod>;13~). The xterm modifier
// param is (1 + bitmask) where the bitmask bits are shift=1, alt=2, ctrl=4. We
// treat Ctrl+Enter AND Shift+Enter (the two common "insert newline" chords) as a
// newline, so we match when the shift OR ctrl bit is set. Ctrl+J is handled
// separately as the protocol-independent fallback.
const MODIFIED_ENTER_SHIFT_OR_CTRL = 1 | 4;
function isModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return ((Number(kitty[1]) - 1) & MODIFIED_ENTER_SHIFT_OR_CTRL) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && (((Number(modifyOtherKeys[1]) - 1) & MODIFIED_ENTER_SHIFT_OR_CTRL) !== 0));
}

// Recognize ANY modified Enter (any modifier bitmask, e.g. Alt+Enter \x1b[13;3u
// / \x1b[27;3;13~). Used to CONSUME modified-Enter sequences we don't map to a
// newline (Alt-only, etc.) so they aren't typed into the prompt as raw CSI text
// under modifyOtherKeys. Plain Enter (mod param = 1, bitmask 0) is intentionally
// NOT matched, so it still submits.
function isAnyModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return (Number(kitty[1]) - 1) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && ((Number(modifyOtherKeys[1]) - 1) !== 0));
}

export function PromptInput({
  onSubmit,
  disabled = false,
  onDraftChange,
  interruptActive = false,
  onInterrupt,
  commandPaletteActive = false,
  mask = false,
  hint = '',
  hintTone = 'info',
  initialValue = '',
  draftOverride,
  onEscape,
  onTab,
  onCommandPaletteNavigate,
  onCommandPaletteAccept,
  onCommandPaletteCancel,
  onCommandPaletteComplete,
  onRestoreQueued,
  onHistoryNavigate,
  onPasteText,
  selectionRef,
  valueRef,
  boxRectRef,
  mouseSelectionRef,
}) {
  const [draft, setDraft] = useState(() => {
    const value = String(initialValue || '');
    return { value, cursor: value.length, selectionAnchor: null };
  });
  const [, bumpCursorAnchorEpoch] = useState(0);
  const draftRef = useRef(draft);
  const lastReportedValueRef = useRef(draft.value);
  if (valueRef) valueRef.current = draftRef.current.value;
  const { isRawModeSupported } = useStdin();
  // The text box's ink DOM node. We mark it as the cursor anchor (forked ink
  // reads internal_cursorAnchor during render and parks the hardware cursor at
  // that node's REAL laid-out position + our caret col/row — no external
  // absolute-coordinate guessing, so it never drifts).
  const boxRef = useRef(null);
  const cursorEnabledRef = useRef(false); // latest enabled state, read by the anchor fn at render time
  const contentWidthRef = useRef(80);
  const preferredColumnRef = useRef(null);
  const mouseExtendCoalesceRef = useRef({ pendingNext: null, timer: null, t: 0 });
  const { value, cursor } = draft;
  draftRef.current = draft;
  if (selectionRef) {
    const range = selectionRange(draft);
    selectionRef.current = range
      ? { range, text: mask ? '' : draft.value.slice(range.start, range.end) }
      : null;
  }

  // Bypass ink's render throttle for keystroke echo. ink coalesces renders to
  // maxFps (leading+trailing throttle), so when typing faster than one frame the
  // last chars land on the trailing timer — felt as input lag ("a beat behind").
  // ink exposes an UNthrottled `onImmediateRender` on the ink-root node; walking
  // the parent chain from our box and firing it flushes the new draft in the same
  // tick. Guarded so a structure change in the ink fork degrades to throttled
  // (slower) rendering, never a crash.
  const flushImmediate = () => {
    let node = boxRef.current;
    for (let i = 0; node && i < 64; i++) {
      if (node.nodeName === 'ink-root') {
        if (typeof node.onImmediateRender === 'function') node.onImmediateRender();
        return;
      }
      node = node.parentNode;
    }
  };

  const commitDraft = (next, options = {}) => {
    const sameDraft = draftStateEqual(draftRef.current, next);
    if (!options.keepPreferredColumn) preferredColumnRef.current = null;
    if (sameDraft) return;
    draftRef.current = next;
    setDraft(next);
    queueMicrotask(flushImmediate);
    if (next.value !== lastReportedValueRef.current) {
      lastReportedValueRef.current = next.value;
      onDraftChange?.(next.value);
    }
    if (valueRef) valueRef.current = next.value;
  };

  const installCursorAnchor = () => {
    if (!boxRef.current || boxRef.current.internal_cursorAnchor) return false;
    boxRef.current.internal_cursorAnchor = (yogaNode) => {
      // [mixdog] Report the editable content box's REAL absolute rect up to App
      // every frame so the mouse handler can map a click/drag cell to an edit
      // offset. Walk the parent chain summing yoga computed offsets (same math
      // render-node-to-output uses) — boxRef is the flex-row that holds the text
      // node, so its absolute x/y is the first content cell (col 0,row 0).
      if (boxRectRef) {
        let absLeft = 0;
        let absTop = 0;
        let node = boxRef.current;
        for (let i = 0; node && i < 64; i++) {
          const yn = node.yogaNode;
          if (yn?.getComputedLeft) {
            absLeft += yn.getComputedLeft() || 0;
            absTop += yn.getComputedTop() || 0;
          }
          if (node.nodeName === 'ink-root') break;
          node = node.parentNode;
        }
        const wNow = yogaNode?.getComputedWidth?.() ?? 0;
        const hNow = yogaNode?.getComputedHeight?.() ?? 1;
        boxRectRef.current = {
          top: absTop,
          left: absLeft,
          height: Math.max(1, hNow || 1),
          contentWidth: contentWidthRef.current,
        };
      }
      if (!cursorEnabledRef.current) return null;
      const d = draftRef.current;
      const w = yogaNode?.getComputedWidth?.() ?? 0;
      const guardColumns = w > IME_LEFT_GUARD_COLUMNS ? IME_LEFT_GUARD_COLUMNS : 0;
      const contentWidth = Math.max(1, (w ? w - guardColumns : contentWidthRef.current) || 80);
      contentWidthRef.current = contentWidth;
      const caret = w > 0
        ? caretPosition(d.value, d.cursor, contentWidth)
        : { row: 0, col: stringWidth(d.value.slice(0, d.cursor)) };
      return w > 0
        ? { ...caret, col: caret.col + guardColumns }
        : caret;
    };
    return true;
  };

  const updateDraft = (fn, options = {}) => {
    commitDraft(fn(draftRef.current), options);
  };

  const cancelMouseExtendCoalesce = () => {
    const state = mouseExtendCoalesceRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pendingNext = null;
  };

  const queueMouseExtendCommit = (next, immediate = false) => {
    if (immediate) {
      cancelMouseExtendCoalesce();
      commitDraft(next);
      mouseExtendCoalesceRef.current.t = Date.now();
      return;
    }
    if (draftStateEqual(draftRef.current, next)) {
      cancelMouseExtendCoalesce();
      commitDraft(next);
      return;
    }
    const state = mouseExtendCoalesceRef.current;
    state.pendingNext = next;
    const now = Date.now();
    const elapsed = now - state.t;
    if (elapsed >= MOUSE_EXTEND_COALESCE_MS) {
      cancelMouseExtendCoalesce();
      state.t = now;
      commitDraft(next);
      return;
    }
    if (state.timer) return;
    state.timer = setTimeout(() => {
      const current = mouseExtendCoalesceRef.current;
      const pending = current.pendingNext;
      current.timer = null;
      current.pendingNext = null;
      current.t = Date.now();
      if (pending) commitDraft(pending);
    }, Math.max(1, MOUSE_EXTEND_COALESCE_MS - elapsed));
    state.timer.unref?.();
  };

  // [mixdog] Mouse drag-selection driver. App's single mouse handler maps a
  // click/drag cell over the prompt box to an edit offset and calls these so the
  // SAME selectionAnchor/cursor engine that keyboard Shift-selection uses paints
  // the highlight. Anchor on press, extend on drag/release; clear on a plain
  // click. Reuses contentWidthRef (the real measured content width).
  if (mouseSelectionRef) {
    mouseSelectionRef.current = {
      offsetAtCell: (row, col) => offsetAtCell(draftRef.current.value, row, col, contentWidthRef.current),
      anchorAt: (offset) => {
        cancelMouseExtendCoalesce();
        const value = draftRef.current.value;
        const off = Math.max(0, Math.min(value.length, Math.floor(Number(offset) || 0)));
        commitDraft({ ...draftRef.current, cursor: off, selectionAnchor: off });
        mouseExtendCoalesceRef.current.t = Date.now();
      },
      extendTo: (offset, immediate = false) => {
        if (offset == null) {
          if (immediate) cancelMouseExtendCoalesce();
          return;
        }
        const d = draftRef.current;
        const off = Math.max(0, Math.min(d.value.length, Math.floor(Number(offset) || 0)));
        const anchor = Number.isFinite(d.selectionAnchor) ? d.selectionAnchor : d.cursor;
        queueMouseExtendCommit({ ...d, cursor: off, selectionAnchor: anchor }, immediate);
      },
      clear: () => {
        cancelMouseExtendCoalesce();
        if (selectionRange(draftRef.current)) commitDraft(clearSelection(draftRef.current));
      },
    };
  }

  useEffect(() => () => {
    const state = mouseExtendCoalesceRef.current;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pendingNext = null;
  }, []);

  const moveDraftVertically = (direction, { extend = false } = {}) => {
    const current = draftRef.current;
    const moved = verticalOffset(
      current.value,
      current.cursor,
      contentWidthRef.current,
      direction,
      preferredColumnRef.current,
    );
    preferredColumnRef.current = moved.preferredColumn;
    if (moved.cursor === current.cursor) return false;
    commitDraft(moveCursor(current, moved.cursor, { extend }), { keepPreferredColumn: true });
    return true;
  };

  const restoreQueuedToDraft = () => {
    return onRestoreQueued?.(draftRef.current.value) === true;
  };

  const applyHistoryNavigation = (direction, meta = {}) => {
    const nextValue = onHistoryNavigate?.(direction, draftRef.current.value, meta);
    if (typeof nextValue !== 'string') return false;
    commitDraft({ value: nextValue, cursor: nextValue.length, selectionAnchor: null });
    return true;
  };

  const insertAtDraft = (text) => {
    const value = String(text ?? '');
    if (!value) return;
    commitDraft(insertText(draftRef.current, value));
  };

  const handleExternalPaste = (text, meta = {}) => {
    const pasted = normalizePastedText(text);
    const fallback = () => { if (pasted) insertAtDraft(pasted); };
    let handled;
    try {
      handled = onPasteText?.(pasted, meta);
    } catch {
      fallback();
      return;
    }
    const apply = (replacement) => {
      if (typeof replacement === 'string') {
        insertAtDraft(replacement);
        return;
      }
      if (replacement === false) return;
      fallback();
    };
    if (handled && typeof handled.then === 'function') {
      handled.then(apply).catch(fallback);
    } else {
      apply(handled);
    }
  };

  useEffect(() => {
    if (!draftOverride || typeof draftOverride.value !== 'string') return;
    commitDraft({ value: draftOverride.value, cursor: draftOverride.value.length, selectionAnchor: null });
  }, [draftOverride?.id]);

  useEffect(() => () => {
    if (selectionRef) selectionRef.current = null;
  }, [selectionRef]);

  const submitDraft = (next) => {
    const text = next.value;
    const accepted = onSubmit?.(text) !== false;
    if (!accepted) {
      commitDraft(next);
      return;
    }
    commitDraft({ value: '', cursor: 0, selectionAnchor: null });
  };

  const submitEnterChunk = (prefix = '') => {
    const current = draftRef.current;
    const next = prefix ? insertText(current, prefix) : current;
    if (commandPaletteActive) {
      const accepted = onCommandPaletteAccept?.(next.value);
      if (accepted !== false) {
        commitDraft({ value: '', cursor: 0, selectionAnchor: null });
      } else if (next !== current) {
        commitDraft(next);
      }
      return;
    }
    submitDraft(next);
  };

  // Input capture is only active on a real TTY (raw mode). In pipes/CI the input
  // is inert — useInput with isActive:false won't throw.
  usePaste((text) => {
    if (disabled) return;
    handleExternalPaste(text, { source: 'paste' });
  }, { isActive: isRawModeSupported && !disabled });

  useInput((input, key) => {
    if (disabled) return;

    const rawInput = String(input ?? '');
    const inputKey = rawInput.toLowerCase();

    // Drop SGR mouse-tracking sequences (wheel/click). When app mouse tracking
    // is explicitly enabled, App parses these off raw stdin itself;
    // ink still forwards the bytes here as "input", which would otherwise type
    // garbage like `[<64;55;22M` into the prompt. Match with or without the
    // leading ESC (terminals/ink may strip it): CSI '<' … final 'M'/'m'.
    if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(rawInput) || /^\[?<\d+;\d+;\d+[Mm]?$/.test(rawInput)) {
      return;
    }

    // Safety net: drop CSI-private replies/fragments like \x1b[?<n>u / \x1b[?...c
    // (escape may be stripped → `[?7u` / `[?1;0c`). We no longer query the
    // terminal (enables are written unconditionally at raw-mode-on), so these
    // should not normally appear — but a terminal that volunteers such a report
    // must never type it into the prompt. The required `?` after `[` means this
    // never matches a real kitty KEY event (those are \x1b[<codepoint>;<mods>u,
    // no `?`); the optional final byte also discards any partial fragment.
    if (/^(?:\x1b)?\[\?[\d;]*[uc]?$/.test(rawInput)) {
      return;
    }

    const rawUpArrow = rawInput === '\x1b[A' || rawInput === '\x1bOA' || rawInput === '[A' || rawInput === 'OA';
    const rawDownArrow = rawInput === '\x1b[B' || rawInput === '\x1bOB' || rawInput === '[B' || rawInput === 'OB';
    // Shift+Arrow modifier sequences (xterm `\x1b[1;2<dir>`, rxvt `\x1b[<dir>`
    // lowercase). Ink's useInput does not decode the `;2` (shift) modifier into
    // key.shift for arrows, so the bytes arrive as raw input and the plain-arrow
    // matchers above miss them — selection-extend never fires. Detect them here
    // and fold into a single `shiftHeld` signal used by every arrow/home/end
    // branch below (alongside ink's key.shift for terminals that DO decode it).
    const rawShiftUp = rawInput === '\x1b[1;2A' || rawInput === '\x1b[a' || rawInput === '[1;2A';
    const rawShiftDown = rawInput === '\x1b[1;2B' || rawInput === '\x1b[b' || rawInput === '[1;2B';
    const rawShiftRight = rawInput === '\x1b[1;2C' || rawInput === '\x1b[c' || rawInput === '[1;2C';
    const rawShiftLeft = rawInput === '\x1b[1;2D' || rawInput === '\x1b[d' || rawInput === '[1;2D';
    const shiftHeld = key.shift || rawShiftUp || rawShiftDown || rawShiftLeft || rawShiftRight;
    const lineBreakIndex = rawInput.search(/[\r\n]/);
    const rawEnter = rawInput === '\r' || rawInput === '\n' || rawInput === '\r\n';
    const trailingEnterPrefix = singleTrailingLineBreakPrefix(rawInput);
    const rawCtrlEnter = isModifiedEnterSequence(rawInput);
    const modifiedLineBreak = key.shift || key.meta || key.ctrl || rawCtrlEnter;

    // Ctrl+J is the protocol-INDEPENDENT newline that works on every terminal.
    //  • Legacy / modifyOtherKeys terminals: Ctrl+J is a lone '\n' (0x0A). A real
    //    Enter is CR, which ink marks key.return (name 'return'); a lone '\n'
    //    arrives as name 'enter' with key.return false. A multi-char paste that
    //    contains '\n' is length > 1 (handled by the paste paths below).
    //  • Kitty protocol active: Ctrl+J arrives as \x1b[106;5u, which ink decodes
    //    to input 'j' with key.ctrl set.
    // Either way → insert a newline. This MUST run before the trailing-newline/
    // submit paths, since singleTrailingLineBreakPrefix('\n') returns '' (not
    // null) and would otherwise route a bare Ctrl+J to submit.
    if ((rawInput === '\n' && !key.return) || (key.ctrl && inputKey === 'j')) {
      updateDraft((d) => replaceSelection(d, '\n'));
      return;
    }

    // A modified Enter that is NOT a newline chord (e.g. Alt+Enter \x1b[13;3u or
    // \x1b[27;3;13~). isModifiedEnterSequence already handled shift/ctrl above
    // (→ newline); here we CONSUME any other modified Enter so its raw CSI bytes
    // never type into the prompt under modifyOtherKeys. Plain Enter (mod=1) is
    // not matched and still submits below.
    if (!rawCtrlEnter && isAnyModifiedEnterSequence(rawInput)) {
      return;
    }

    const pasteFallback = lineBreakIndex !== -1 && trailingEnterPrefix === null && !rawEnter && (rawInput.length > 1 || !key.return);
    if (pasteFallback) {
      handleExternalPaste(rawInput, { source: 'paste-fallback' });
      return;
    }

    if (trailingEnterPrefix !== null) {
      if (modifiedLineBreak) {
        updateDraft((d) => insertText(d, `${trailingEnterPrefix}\n`));
        return;
      }
      submitEnterChunk(trailingEnterPrefix);
      return;
    }

    if (rawCtrlEnter) {
      updateDraft((d) => replaceSelection(d, '\n'));
      return;
    }

    if (!commandPaletteActive && ((key.ctrl && inputKey === 'v') || (key.meta && inputKey === 'v'))) {
      handleExternalPaste('', { source: 'clipboard-image-shortcut' });
      return;
    }

    if (key.return) {
      if (modifiedLineBreak) {
        updateDraft((d) => replaceSelection(d, '\n'));
        return;
      }

      if (commandPaletteActive) {
        const accepted = onCommandPaletteAccept?.(draftRef.current.value);
        if (accepted !== false) {
          commitDraft({ value: '', cursor: 0, selectionAnchor: null });
        }
        return;
      }

      const current = draftRef.current;
      if (current.value[current.cursor - 1] === '\\') {
        updateDraft((d) => ({
          value: `${d.value.slice(0, d.cursor - 1)}\n${d.value.slice(d.cursor)}`,
          cursor: d.cursor,
          selectionAnchor: null,
        }));
        return;
      }

      submitDraft(current);
      return;
    }

    if (key.upArrow || rawUpArrow || rawShiftUp) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(-1);
      } else {
        const hasDraftText = String(draftRef.current.value || '').trim().length > 0;
        if (!hasDraftText) {
          if (!restoreQueuedToDraft()) applyHistoryNavigation('up', { emptyDraft: true });
        } else if (!moveDraftVertically(-1, { extend: shiftHeld })) {
          applyHistoryNavigation('up', { emptyDraft: false });
        }
      }
      return;
    }

    if (key.downArrow || rawDownArrow || rawShiftDown) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.(1);
      } else {
        if (!moveDraftVertically(1, { extend: shiftHeld })) {
          applyHistoryNavigation('down', { emptyDraft: String(draftRef.current.value || '').trim().length === 0 });
        }
      }
      return;
    }

    if (commandPaletteActive && key.pageUp) {
      onCommandPaletteNavigate?.(-8);
      return;
    }

    if (commandPaletteActive && key.pageDown) {
      onCommandPaletteNavigate?.(8);
      return;
    }

    if (commandPaletteActive && key.home) {
      onCommandPaletteNavigate?.('home');
      return;
    }

    if (commandPaletteActive && key.end) {
      onCommandPaletteNavigate?.('end');
      return;
    }

    if (key.tab) {
      if (commandPaletteActive) {
        const completed = onCommandPaletteComplete?.(draftRef.current.value);
        if (typeof completed === 'string') {
          commitDraft({ value: completed, cursor: completed.length, selectionAnchor: null });
        }
        return;
      }
      if (onTab?.(draftRef.current.value) === true) return;
    }

    if (key.escape) {
      if (commandPaletteActive) {
        onCommandPaletteCancel?.(draftRef.current.value);
        commitDraft({ value: '', cursor: 0, selectionAnchor: null });
        return;
      }
      if (selectionRange(draftRef.current)) {
        commitDraft(clearSelection(draftRef.current));
        return;
      }
      const currentValue = draftRef.current.value;
      if (onEscape?.(currentValue, { phase: 'before' }) === true) {
        return;
      }
      if (currentValue) {
        onEscape?.(currentValue, { phase: 'clear' });
        commitDraft({ value: '', cursor: 0, selectionAnchor: null });
        return;
      }
      // Active turn takes precedence over queue restore (matches claude-code
      // useCancelRequest priority): Esc during a running turn interrupts the
      // turn and leaves queued steering prompts intact to run afterward. Queued
      // messages only pop back into the draft when the turn is idle.
      if (interruptActive) {
        const restoredText = onInterrupt?.('');
        if (typeof restoredText === 'string') {
          commitDraft({ value: restoredText, cursor: restoredText.length, selectionAnchor: null });
        }
        return;
      }
      if (restoreQueuedToDraft()) {
        return;
      }
      onEscape?.('', { phase: 'empty' });
      return;
    }

    if (key.leftArrow || rawShiftLeft) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.('left');
        return;
      }
      updateDraft((d) => {
        const range = !shiftHeld && !key.ctrl && !key.meta ? selectionRange(d) : null;
        const cursor = range
          ? range.start
          : key.ctrl || key.meta
            ? previousWordOffset(d.value, d.cursor)
            : previousOffset(d.value, d.cursor);
        return moveCursor(d, cursor, { extend: shiftHeld });
      });
      return;
    }
    if (key.rightArrow || rawShiftRight) {
      if (commandPaletteActive) {
        onCommandPaletteNavigate?.('right');
        return;
      }
      updateDraft((d) => {
        const range = !shiftHeld && !key.ctrl && !key.meta ? selectionRange(d) : null;
        const cursor = range
          ? range.end
          : key.ctrl || key.meta
            ? nextWordOffset(d.value, d.cursor)
            : nextOffset(d.value, d.cursor);
        return moveCursor(d, cursor, { extend: shiftHeld });
      });
      return;
    }
    if (key.home) {
      updateDraft((d) => moveCursor(d, lineStart(d.value, d.cursor), { extend: shiftHeld }));
      return;
    }
    if (key.end) {
      updateDraft((d) => moveCursor(d, lineEnd(d.value, d.cursor), { extend: shiftHeld }));
      return;
    }

    const editingKey = String(input || '').toLowerCase();

    // ctrl+a selects all like a normal text box; ctrl+e keeps readline line-end.
    if (key.ctrl && editingKey === 'a') {
      updateDraft((d) => (d.value ? { ...d, cursor: d.value.length, selectionAnchor: 0 } : clearSelection(d)));
      return;
    }
    if (key.ctrl && editingKey === 'e') {
      updateDraft((d) => moveCursor(d, lineEnd(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    // ctrl+b / ctrl+f — character left / right.
    if (key.ctrl && editingKey === 'b') {
      updateDraft((d) => moveCursor(d, previousOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.ctrl && editingKey === 'f') {
      updateDraft((d) => moveCursor(d, nextOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    // alt/option+b / alt/option+f — word left / right.
    if (key.meta && editingKey === 'b') {
      updateDraft((d) => moveCursor(d, previousWordOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (key.meta && editingKey === 'f') {
      updateDraft((d) => moveCursor(d, nextWordOffset(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    // ctrl+u / ctrl+k — delete to line start / end.
    if (key.ctrl && editingKey === 'u') {
      updateDraft(deleteToLineStart);
      return;
    }
    if (key.ctrl && editingKey === 'k') {
      updateDraft(deleteToLineEnd);
      return;
    }
    // ctrl+w / alt+backspace — delete previous word.
    if ((key.ctrl && editingKey === 'w') || ((key.ctrl || key.meta) && key.backspace)) {
      updateDraft(deleteBackwardWord);
      return;
    }
    // alt+d / ctrl+delete — delete next word.
    if ((key.meta && editingKey === 'd') || (key.ctrl && key.delete)) {
      updateDraft(deleteForwardWord);
      return;
    }

    if (key.backspace) {
      updateDraft((d) => {
        if (selectionRange(d)) return deleteSelectedText(d);
        if (d.cursor <= 0) return d;
        const start = previousOffset(d.value, d.cursor);
        return {
          value: d.value.slice(0, start) + d.value.slice(d.cursor),
          cursor: start,
          selectionAnchor: null,
        };
      });
      return;
    }

    if (key.delete) {
      updateDraft((d) => {
        if (selectionRange(d)) return deleteSelectedText(d);
        if (d.cursor >= d.value.length) return d;
        const end = nextOffset(d.value, d.cursor);
        return {
          value: d.value.slice(0, d.cursor) + d.value.slice(end),
          cursor: d.cursor,
          selectionAnchor: null,
        };
      });
      return;
    }

    // Printable input (ignore other control keys). Strip any embedded SGR mouse
    // sequences as a belt-and-suspenders guard (the early return above catches
    // whole-sequence inputs; this removes partials that rode in with real text).
    const printable = rawInput
      .replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, '')
      .replace(/[\r\n]/g, '');
    if (printable && !key.ctrl && !key.meta) {
      updateDraft((d) => insertText(d, printable));
    }
  }, { isActive: isRawModeSupported && !disabled });

  // Mark the text-box node with a cursor-anchor FUNCTION. Forked ink calls it
  // during renderNodeToOutput — AFTER yoga layout is final and (crucially)
  // during the same onRender that paints the new text. The function reads the
  // latest caret from refs (synced every render below), so the cursor can never
  // be stale: an earlier object-anchor set in a layout effect was always one
  // keystroke behind, because ink's reconciler runs onRender inside
  // resetAfterCommit BEFORE React layout effects — that lag made the 2nd+ char
  // appear to land behind the caret (the observed scramble). Computing inside
  // the fork, from the real layout + current refs, fixes that by construction.
  cursorEnabledRef.current = !disabled && isRawModeSupported;
  installCursorAnchor();

  useLayoutEffect(() => {
    if (!installCursorAnchor()) return;
    bumpCursorAnchorEpoch((epoch) => epoch + 1);
    queueMicrotask(flushImmediate);
  }, []);

  useLayoutEffect(() => {
    if (disabled || !isRawModeSupported) return;
    queueMicrotask(flushImmediate);
  }, [disabled, isRawModeSupported]);

  // Trailing space cell so the caret at end-of-input has a rendered cell to sit
  // on (kept visually blank — no synthetic underline).
  const displayValue = mask ? value.replace(/[^\n]/g, '*') : value;
  const renderedValue = renderSelectedText(displayValue, selectionRange(draft), cursor === value.length);
  const hintMeta = hintStyle(hintTone);

  return (
    <Box ref={boxRef} flexDirection="row" width="100%" flexGrow={1} flexShrink={1} backgroundColor={surfaceBackground()}>
      <Box width={IME_LEFT_GUARD_COLUMNS} flexShrink={0} backgroundColor={surfaceBackground()} />
      <Text color={theme.text} wrap="hard">{renderedValue}</Text>
      {!value && hint ? (
        <Box marginLeft={-1}>
          <Text color={hintMeta.textColor}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
