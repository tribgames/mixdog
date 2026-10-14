/*
 * components/prompt-input/key-handler.mjs — the PromptInput useInput handler.
 *
 * createPromptKeyHandler(ctx) closes over the component's per-render draft
 * helpers and callbacks and returns the (input, key) handler; PromptInput
 * passes it straight to ink's useInput. Escape policy lives in escape-key.mjs
 * and the edit chords shared with TextEntryPanel in edit-chords.mjs.
 */
import {
  clearSelection,
  lineEnd,
  lineStart,
  moveCursor,
  nextWordOffset,
  previousWordOffset,
  replaceSelection,
} from '../../input-editing.mjs';
import { applyEditChord } from './edit-chords.mjs';
import {
  insertText,
  isModifiedEnterSequence,
  isAnyModifiedEnterSequence,
  leftArrowOffset,
  rightArrowOffset,
  singleTrailingLineBreakPrefix,
} from './edit-helpers.mjs';
import { handleEscapeKey } from './escape-key.mjs';
import {
  decodeArrowSignals,
  isCsiPrivateReply,
  isDiscardedControlInput,
  isMouseReportSequence,
  printableFromInput,
} from './key-signals.mjs';
import { paletteOwnsPromptVerticalArrow } from './restore-policy.mjs';

// `suppressShiftNav` may be a predicate, a ref holding a predicate, or a ref
// holding a flag; resolve it at event time.
function gridSelectionActive(suppressShiftNavRef) {
  if (typeof suppressShiftNavRef === 'function') return suppressShiftNavRef();
  if (typeof suppressShiftNavRef?.current === 'function') return suppressShiftNavRef.current();
  return Boolean(suppressShiftNavRef?.current);
}

// A palette accept/complete may hand back the next draft: a string (caret at
// its end) or { value, cursor } (a `$name` skill mention completed at the caret).
export function paletteResultDraft(result) {
  if (typeof result === 'string') return { value: result, cursor: result.length, selectionAnchor: null };
  if (typeof result?.value === 'string') return { value: result.value, cursor: result.cursor, selectionAnchor: null };
  return null;
}

export function createPromptKeyHandler(ctx) {
  const {
    disabled,
    escapeClearAtRef,
    suppressShiftNavRef,
    draftRef,
    commitDraft,
    updateDraft,
    handleExternalPaste,
    submitEnterChunk,
    submitDraft,
    commandPaletteActive,
    commandPaletteOptionCount,
    commandPaletteMovesCaret,
    onCommandPaletteNavigate,
    onCommandPaletteAccept,
    onCommandPaletteComplete,
    onTab,
    hasQueuedMessages,
    moveDraftVertically,
    restoreQueuedToDraft,
    applyHistoryNavigation,
    undoStack,
  } = ctx;

  return (input, key) => {
    if (disabled) return;

    const rawInput = String(input ?? '');
    const inputKey = rawInput.toLowerCase();
    if (!key.escape) escapeClearAtRef.current = 0;
    // Arrow / shift / ctrl+shift decode: prompt-input/key-signals.mjs.
    const {
      ctrlShiftHeld,
      rawCtrlShiftDown,
      rawCtrlShiftLeft,
      rawCtrlShiftRight,
      rawCtrlShiftUp,
      rawDownArrow,
      rawShiftArrowForGrid,
      rawShiftDown,
      rawShiftLeft,
      rawShiftRight,
      rawShiftUp,
      rawUpArrow,
      shiftHeld,
    } = decodeArrowSignals(rawInput, key);

    // App owns Shift+Arrow when a transcript/status ink-grid selection is live.
    // Because the parent (App) useInput handler fires AFTER this child handler
    // for the same event, a flag SET in App's handler is always one event stale.
    // Instead call a synchronous predicate derived from dragRef at event time.
    if (gridSelectionActive(suppressShiftNavRef)) {
      const isShiftArrow =
        key.shift && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.home || key.end);
      if (isShiftArrow || rawShiftArrowForGrid) return;
    }

    // Terminal reports are not text: drop SGR mouse sequences and CSI-private
    // replies before anything can type them into the prompt
    // (prompt-input/key-signals.mjs).
    if (isMouseReportSequence(rawInput)) {
      return;
    }
    if (isCsiPrivateReply(rawInput)) {
      return;
    }

    const lineBreakIndex = rawInput.search(/[\r\n]/);
    const rawEnter = rawInput === '\r' || rawInput === '\n' || rawInput === '\r\n';
    const trailingEnterPrefix = singleTrailingLineBreakPrefix(rawInput);
    const rawModifiedEnter = isModifiedEnterSequence(rawInput);
    const modifiedLineBreak = key.shift || key.meta || key.ctrl || rawModifiedEnter;

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

    // Consume uncommon modified-Enter combinations outside the normal
    // Shift/Alt/Ctrl newline set so raw CSI bytes never enter the prompt.
    if (!rawModifiedEnter && isAnyModifiedEnterSequence(rawInput)) {
      return;
    }

    // Legacy guard only. Bracketed paste is now buffered by the termio parser
    // and routed on the 'paste' channel (handleExternalPaste via usePaste), so
    // multi-line paste never reaches useInput here. This newline-sniffing branch
    // remains a defensive fallback for terminals/paths that somehow deliver a
    // multi-char newline chunk through 'input'; under normal bracketed paste it
    // does not trigger (paste never reaches useInput).
    const pasteFallback =
      lineBreakIndex !== -1 && trailingEnterPrefix === null && !rawEnter && (rawInput.length > 1 || !key.return);
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

    if (rawModifiedEnter) {
      updateDraft((d) => replaceSelection(d, '\n'));
      return;
    }

    if (!commandPaletteActive && (key.ctrl || key.meta) && inputKey === 'v') {
      // Ctrl+V / Meta+V: read OS clipboard (text first, image fallback) — the
      // empty text arg tags the shortcut path in handlePromptPaste.
      handleExternalPaste('', { source: 'clipboard-shortcut' });
      return;
    }

    if (key.return) {
      if (modifiedLineBreak) {
        updateDraft((d) => replaceSelection(d, '\n'));
        return;
      }

      if (commandPaletteActive) {
        const accepted = onCommandPaletteAccept?.(draftRef.current.value, draftRef.current.cursor);
        // A draft-shaped accept (skill mention completion) replaces the draft.
        const replacement = paletteResultDraft(accepted);
        if (replacement) {
          commitDraft(replacement);
        } else if (accepted !== false) {
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

    // Ctrl+Shift+Left/Right → extend selection whole-word. Kept before the plain
    // shift-arrow branches so the ctrl+shift chord never falls through to a
    // char-wise extend. (Up/Down ctrl+shift extend to line-relative vertical
    // move with extend — same as shift alone; handled in the vertical branch.)
    if (ctrlShiftHeld && (rawCtrlShiftLeft || (key.ctrl && key.shift && key.leftArrow))) {
      if (!commandPaletteActive) {
        updateDraft((d) => moveCursor(d, previousWordOffset(d.value, d.cursor), { extend: true }));
      }
      return;
    }
    if (ctrlShiftHeld && (rawCtrlShiftRight || (key.ctrl && key.shift && key.rightArrow))) {
      if (!commandPaletteActive) {
        updateDraft((d) => moveCursor(d, nextWordOffset(d.value, d.cursor), { extend: true }));
      }
      return;
    }

    if (key.upArrow || rawUpArrow || rawShiftUp || rawCtrlShiftUp) {
      if (commandPaletteActive && paletteOwnsPromptVerticalArrow(commandPaletteOptionCount)) {
        onCommandPaletteNavigate?.(-1);
      } else {
        // A Shift-held Up is a SELECTION gesture, never history navigation:
        // extend the selection up one visual line, and if already on the first
        // line extend all the way to document start (offset 0). History
        // navigation (restoreQueued / applyHistoryNavigation) MUST NOT fire.
        if (shiftHeld) {
          if (!moveDraftVertically(-1, { extend: true })) {
            updateDraft((d) => moveCursor(d, 0, { extend: true }));
          }
        } else if (!moveDraftVertically(-1, { extend: false })) {
          const emptyDraft = String(draftRef.current.value || '').length === 0;
          if (!hasQueuedMessages || !restoreQueuedToDraft()) {
            applyHistoryNavigation('up', { emptyDraft });
          }
        }
      }
      return;
    }

    if (key.downArrow || rawDownArrow || rawShiftDown || rawCtrlShiftDown) {
      if (commandPaletteActive && paletteOwnsPromptVerticalArrow(commandPaletteOptionCount)) {
        onCommandPaletteNavigate?.(1);
      } else {
        // Shift-held Down: extend selection down one line, or to document end
        // (value.length) when already on the last line. Never history nav.
        if (shiftHeld) {
          if (!moveDraftVertically(1, { extend: true })) {
            updateDraft((d) => moveCursor(d, d.value.length, { extend: true }));
          }
        } else if (!moveDraftVertically(1, { extend: false })) {
          applyHistoryNavigation('down', { emptyDraft: String(draftRef.current.value || '').length === 0 });
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
        const completed = paletteResultDraft(
          onCommandPaletteComplete?.(draftRef.current.value, draftRef.current.cursor)
        );
        if (completed) commitDraft(completed);
        return;
      }
      if (onTab?.(draftRef.current.value) === true) return;
    }

    if (key.escape) {
      handleEscapeKey(ctx);
      return;
    }

    if (key.leftArrow || rawShiftLeft) {
      if (commandPaletteActive && !commandPaletteMovesCaret) {
        onCommandPaletteNavigate?.('left');
        return;
      }
      updateDraft((d) =>
        moveCursor(d, leftArrowOffset(d, { word: key.ctrl || key.meta, extend: shiftHeld }), { extend: shiftHeld })
      );
      return;
    }
    if (key.rightArrow || rawShiftRight) {
      if (commandPaletteActive && !commandPaletteMovesCaret) {
        onCommandPaletteNavigate?.('right');
        return;
      }
      updateDraft((d) =>
        moveCursor(d, rightArrowOffset(d, { word: key.ctrl || key.meta, extend: shiftHeld }), { extend: shiftHeld })
      );
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

    // Undo / redo. Covered encodings:
    //  • kitty protocol: ctrl+z → input 'z' + key.ctrl; ctrl+y → 'y' + key.ctrl;
    //    ctrl+shift+z → 'z' + key.ctrl + key.shift (redo).
    //  • legacy control bytes: Ctrl+Z is \x1a (SUB, 0x1A), Ctrl+Y is \x19 (EM,
    //    0x19). ink may deliver these as raw input without key.ctrl on some
    //    terminals, so match the byte directly too.
    const isCtrlZ = (key.ctrl && inputKey === 'z') || rawInput === '\x1a';
    const isCtrlY = (key.ctrl && inputKey === 'y') || rawInput === '\x19';
    if (isCtrlZ && (key.shift || shiftHeld)) {
      undoStack.redo();
      return;
    }
    if (isCtrlZ) {
      undoStack.undo();
      return;
    }
    if (isCtrlY) {
      undoStack.redo();
      return;
    }

    // ctrl+a selects all like a normal text box; ctrl+e keeps readline line-end.
    if (key.ctrl && inputKey === 'a') {
      updateDraft((d) => (d.value ? { ...d, cursor: d.value.length, selectionAnchor: 0 } : clearSelection(d)));
      return;
    }
    if (key.ctrl && inputKey === 'e') {
      updateDraft((d) => moveCursor(d, lineEnd(d.value, d.cursor), { extend: key.shift }));
      return;
    }
    if (applyEditChord(key, inputKey, updateDraft)) return;

    // Printable input (ignore other control keys). The discarded Ctrl+Space
    // encodings and the printable filter live in prompt-input/key-signals.mjs.
    if (isDiscardedControlInput(rawInput)) {
      return;
    }
    const printable = printableFromInput(rawInput);
    if (printable && !key.ctrl && !key.meta) {
      updateDraft((d) => insertText(d, printable));
    }
  };
}
