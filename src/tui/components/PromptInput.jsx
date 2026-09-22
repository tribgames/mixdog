/*
 * components/PromptInput.jsx — the prompt input line.
 *
 * A self-contained editor built on ink's useInput. The text renders as plain
 * text and a thin NATIVE hardware cursor sits at the insertion point (also where
 * the terminal echoes typed/IME characters).
 *
 * CURSOR — via Mixdog's patched Ink runtime dependency: we
 * tag the text-box node with `internal_cursorAnchor = { col, row }` (the caret's
 * position WITHIN the box). Patched Ink, during renderNodeToOutput, parks the
 * hardware cursor at that node's REAL laid-out absolute cell + (col,row) — every
 * frame, from the actual yoga layout. This replaces ink's stock useCursor, whose
 * externally-supplied absolute coordinate drifted/vanished whenever the layout
 * above the input changed (spinner/thinking growth, Enter, fullscreen relayout)
 * because it was computed a beat before the final layout. The fork computes it
 * at the exact moment of drawing, so it can never be stale.
 */
import { useEffect, useLayoutEffect, useState, useRef } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import { theme, surfaceBackground } from '../theme.mjs';
import {
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
  previousOffset,
  previousWordOffset,
  replaceSelection,
  selectionRange,
  verticalOffset,
} from '../input-editing.mjs';
import {
  hintStyle,
  insertText,
  normalizePastedText,
  singleTrailingLineBreakPrefix,
  draftStateEqual,
  isModifiedEnterSequence,
  isAnyModifiedEnterSequence,
} from './prompt-input/edit-helpers.mjs';
import { cancelPromptImmediateFlush, schedulePromptImmediateFlush } from './prompt-input/immediate-render.mjs';
import { classifyPromptEscape } from './prompt-input/escape-policy.mjs';
import { paletteOwnsPromptVerticalArrow } from './prompt-input/restore-policy.mjs';
import { renderSelectedText } from './prompt-input/selected-text.jsx';
import { IME_LEFT_GUARD_COLUMNS, createCursorAnchor } from './prompt-input/cursor-anchor.mjs';
import {
  decodeArrowSignals,
  isCsiPrivateReply,
  isDiscardedControlInput,
  isMouseReportSequence,
  printableFromInput,
} from './prompt-input/key-signals.mjs';
import { createPromptMouseSelection } from './prompt-input/mouse-selection.mjs';
import { createUndoStack } from './prompt-input/undo-stack.mjs';

export function PromptInput({
  onSubmit,
  disabled = false,
  onDraftChange,
  interruptActive = false,
  onInterrupt,
  commandPaletteActive = false,
  commandPaletteOpen = commandPaletteActive,
  commandPaletteOptionCount = commandPaletteActive ? 2 : 0,
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
  hasQueuedMessages = false,
  hasMessages = false,
  onHistoryNavigate,
  onPasteText,
  selectionRef,
  valueRef,
  boxRectRef,
  mouseSelectionRef,
  suppressShiftNavRef,
}) {
  const [draft, setDraft] = useState(() => {
    const value = String(initialValue || '');
    return { value, cursor: value.length, selectionAnchor: null };
  });
  const [, bumpCursorAnchorEpoch] = useState(0);
  const draftRef = useRef(draft);
  const lastReportedValueRef = useRef(draft.value);
  // Bumped on every submit/draftOverride replace/unmount so an async paste
  // (clipboard read or onPasteText promise) that resolves after the draft
  // moved on can detect staleness and drop its result instead of mutating
  // whatever prompt is now in the box.
  const pasteGenerationRef = useRef(0);
  // One physical Enter must not enqueue twice when the terminal delivers the
  // chord as multiple input events before the draft clears (Windows CR/LF).
  const submitGateRef = useRef(false);
  const escapeClearAtRef = useRef(0);
  if (valueRef) valueRef.current = draftRef.current.value;
  const { isRawModeSupported } = useStdin();
  // The text box's ink DOM node. We mark it as the cursor anchor (forked ink
  // reads internal_cursorAnchor during render and parks the hardware cursor at
  // that node's REAL laid-out position + our caret col/row — no external
  // absolute-coordinate guessing, so it never drifts).
  const boxRef = useRef(null);
  const inkRootRef = useRef(null);
  const cursorEnabledRef = useRef(false); // latest enabled state, read by the anchor fn at render time
  const contentWidthRef = useRef(80);
  const preferredColumnRef = useRef(null);
  const mouseExtendCoalesceRef = useRef({ pendingNext: null, timer: null, t: 0 });
  // Undo/redo snapshot stack. Each entry is a { value, cursor, selectionAnchor }
  // draft snapshot. Continuous typing coalesces (see UNDO_COALESCE_MS) so a run
  // of characters collapses into one undo step; cursor-only moves are NOT
  // snapshotted. Reset on submit / draftOverride.
  const undoRef = useRef({ past: [], future: [], lastPushAt: 0, lastValue: null });
  const { value, cursor } = draft;
  draftRef.current = draft;
  if (selectionRef) {
    const range = selectionRange(draft);
    selectionRef.current = range ? { range, text: mask ? '' : draft.value.slice(range.start, range.end) } : null;
  }

  // Bypass ink's render throttle for keystroke echo. ink coalesces renders to
  // maxFps (leading+trailing throttle), so when typing faster than one frame the
  // last chars land on the trailing timer — felt as input lag ("a beat behind").
  // ink exposes an UNthrottled `onImmediateRender` on the ink-root node; walking
  // the parent chain from our box and firing it flushes the new draft in the same
  // tick. Guarded so a patched runtime structure change degrades to throttled
  // (slower) rendering, never a crash.
  const flushThrottleRef = useRef({ lastAt: 0, timer: null });
  const flushImmediate = () => {
    const cachedRoot = inkRootRef.current;
    if (typeof cachedRoot?.onImmediateRender === 'function') {
      cachedRoot.onImmediateRender();
      return;
    }
    let node = boxRef.current;
    for (let i = 0; node && i < 64; i++) {
      if (node.nodeName === 'ink-root') {
        inkRootRef.current = node;
        if (typeof node.onImmediateRender === 'function') node.onImmediateRender();
        return;
      }
      node = node.parentNode;
    }
  };

  // Keep prompt echo on the same leading+trailing immediate cadence while a
  // turn is active. Mid-turn typing stays responsive; suppressing
  // this path made the draft visibly trail the keyboard under streaming load.
  const scheduleImmediateFlush = () => {
    schedulePromptImmediateFlush({
      throttle: flushThrottleRef.current,
      flush: flushImmediate,
    });
  };

  useEffect(
    () => () => {
      cancelPromptImmediateFlush(flushThrottleRef.current);
    },
    []
  );

  // Undo/redo history: prompt-input/undo-stack.mjs. Built before commitDraft so
  // the commit path can record into it; applying a step commits back through
  // the same function.
  const undoStack = createUndoStack({
    stateRef: undoRef,
    draftRef,
    commit: (next, options) => commitDraft(next, options),
  });

  const commitDraft = (next, options = {}) => {
    escapeClearAtRef.current = 0;
    const sameDraft = draftStateEqual(draftRef.current, next);
    if (!options.keepPreferredColumn) preferredColumnRef.current = null;
    if (sameDraft) {
      // Mouse-up is a render boundary even when the final cell matches the last
      // coalesced drag cell: settle the final highlight immediately.
      if (options.immediateSettle) scheduleImmediateFlush();
      return;
    }
    if (!options.skipHistory) undoStack.record(draftRef.current, next, options);
    draftRef.current = next;
    setDraft(next);
    // Mouse drag motion uses Ink's normal maxFps render path; keyboard edits
    // and mouse-up finalization retain the low-latency immediate flush.
    if (!options.throttledRender) scheduleImmediateFlush();
    if (next.value !== lastReportedValueRef.current) {
      lastReportedValueRef.current = next.value;
      onDraftChange?.(next.value);
    }
    if (valueRef) valueRef.current = next.value;
  };

  const installCursorAnchor = () => {
    if (!boxRef.current || boxRef.current.internal_cursorAnchor) return false;
    // The anchor function itself (box-rect publish + caret math) lives in
    // prompt-input/cursor-anchor.mjs.
    boxRef.current.internal_cursorAnchor = createCursorAnchor({
      boxRef,
      boxRectRef,
      contentWidthRef,
      cursorEnabledRef,
      draftRef,
    });
    return true;
  };

  const updateDraft = (fn, options = {}) => {
    commitDraft(fn(draftRef.current), options);
  };

  // [mixdog] Mouse drag-selection driver: prompt-input/mouse-selection.mjs.
  // App's single mouse handler maps a click/drag cell over the prompt box to an
  // edit offset and calls these so the SAME selectionAnchor/cursor engine that
  // keyboard Shift-selection uses paints the highlight. Anchor on press, extend
  // on drag/release; clear on a plain click.
  if (mouseSelectionRef) {
    mouseSelectionRef.current = createPromptMouseSelection({
      coalesceRef: mouseExtendCoalesceRef,
      draftRef,
      contentWidthRef,
      commitDraft,
    });
  }

  useEffect(
    () => () => {
      const state = mouseExtendCoalesceRef.current;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.pendingNext = null;
    },
    []
  );

  const moveDraftVertically = (direction, { extend = false } = {}) => {
    const current = draftRef.current;
    const moved = verticalOffset(
      current.value,
      current.cursor,
      contentWidthRef.current,
      direction,
      preferredColumnRef.current
    );
    preferredColumnRef.current = moved.preferredColumn;
    if (moved.cursor === current.cursor) return false;
    commitDraft(moveCursor(current, moved.cursor, { extend }), { keepPreferredColumn: true });
    return true;
  };

  const restoreQueuedToDraft = ({ showHint = false } = {}) => {
    return (
      onRestoreQueued?.({
        restoreDraft: true,
        showHint,
        currentText: draftRef.current.value,
        getCurrentDraft: () => draftRef.current,
      }) === true
    );
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
    const pasteGeneration = pasteGenerationRef.current;
    const isStale = () => pasteGenerationRef.current !== pasteGeneration;
    const fallback = () => {
      if (pasted && !isStale()) insertAtDraft(pasted);
    };
    let handled;
    try {
      handled = onPasteText?.(pasted, meta);
    } catch {
      fallback();
      return;
    }
    const apply = (replacement) => {
      if (isStale()) return;
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
    pasteGenerationRef.current += 1;
    const nextValue = draftOverride.value;
    const nextCursor = Number.isFinite(draftOverride.cursor)
      ? Math.max(0, Math.min(nextValue.length, draftOverride.cursor))
      : nextValue.length;
    const nextAnchor = Number.isFinite(draftOverride.selectionAnchor)
      ? Math.max(0, Math.min(nextValue.length, draftOverride.selectionAnchor))
      : null;
    commitDraft({ value: nextValue, cursor: nextCursor, selectionAnchor: nextAnchor }, { skipHistory: true });
    undoStack.reset();
    // Every field the body reads is a dependency. `id` alone was not enough:
    // the publishers stamp overrides with Date.now() (app/use-prompt-queue-history.mjs,
    // app/message-selector.mjs, app/prompt-handlers/use-prompt-interrupt.mjs) and a
    // queued restore publishes TWICE — the optimistic local projection, then the
    // daemon-authoritative reconciliation a microtask later. Same millisecond, same
    // id, so the authoritative draft was dropped and the prompt kept the optimistic
    // text. `id` stays in the list so re-publishing the SAME text (picking the same
    // message again after editing the draft) still re-applies.
  }, [draftOverride?.id, draftOverride?.value, draftOverride?.cursor, draftOverride?.selectionAnchor]);

  useEffect(
    () => () => {
      pasteGenerationRef.current += 1;
      if (selectionRef) selectionRef.current = null;
    },
    [selectionRef]
  );

  const submitDraft = (next) => {
    if (submitGateRef.current) return;
    const text = next.value;
    if (!String(text || '').trim()) return;
    submitGateRef.current = true;
    const accepted = onSubmit?.(text) !== false;
    if (!accepted) {
      submitGateRef.current = false;
      commitDraft(next);
      return;
    }
    pasteGenerationRef.current += 1;
    commitDraft({ value: '', cursor: 0, selectionAnchor: null }, { skipHistory: true });
    undoStack.reset();
    // Unlock after this input batch drains so a second return event in the
    // same chord cannot re-submit the pre-clear draft.
    queueMicrotask(() => {
      submitGateRef.current = false;
    });
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
  usePaste(
    (text) => {
      if (disabled) return;
      handleExternalPaste(text, { source: 'paste' });
    },
    { isActive: isRawModeSupported && !disabled }
  );

  useInput(
    (input, key) => {
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
      const gridSelectionActive =
        typeof suppressShiftNavRef === 'function'
          ? suppressShiftNavRef()
          : typeof suppressShiftNavRef?.current === 'function'
            ? suppressShiftNavRef.current()
            : Boolean(suppressShiftNavRef?.current);
      if (gridSelectionActive) {
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

      if (!commandPaletteActive && ((key.ctrl && inputKey === 'v') || (key.meta && inputKey === 'v'))) {
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
          const completed = onCommandPaletteComplete?.(draftRef.current.value);
          if (typeof completed === 'string') {
            commitDraft({ value: completed, cursor: completed.length, selectionAnchor: null });
          }
          return;
        }
        if (onTab?.(draftRef.current.value) === true) return;
      }

      if (key.escape) {
        if (commandPaletteOpen) {
          onCommandPaletteCancel?.(draftRef.current.value);
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
        let escapeDecision = classifyPromptEscape({
          interruptActive,
          hasQueuedMessages,
          hasMessages,
          value: currentValue,
          lastClearPressAt: escapeClearAtRef.current,
        });
        if (escapeDecision.action === 'restore-queue') {
          if (restoreQueuedToDraft()) {
            escapeClearAtRef.current = 0;
            return;
          }
          // A stale projected queue can empty between render and key handling.
          // Fall through to the normal draft/idle action in that case.
          escapeDecision = classifyPromptEscape({
            interruptActive,
            hasMessages,
            value: currentValue,
            lastClearPressAt: escapeClearAtRef.current,
          });
        }
        escapeClearAtRef.current = escapeDecision.nextClearPressAt;
        // Active work always wins, even if the user has already typed a steering
        // draft. The draft is preserved; the old submitted prompt is restored only
        // when this box is still empty after cancellation.
        if (escapeDecision.action === 'interrupt') {
          const restoredText = onInterrupt?.(currentValue);
          if (!currentValue && typeof restoredText === 'string') {
            commitDraft({ value: restoredText, cursor: restoredText.length, selectionAnchor: null });
          }
          return;
        }
        if (escapeDecision.action === 'arm-clear') {
          onEscape?.(currentValue, { phase: 'clear-arm' });
          return;
        }
        if (escapeDecision.action === 'clear') {
          onEscape?.(currentValue, { phase: 'clear' });
          commitDraft({ value: '', cursor: 0, selectionAnchor: null });
          return;
        }
        // Empty draft + conversation history: first press arms, the second
        // opens the message selector.
        if (escapeDecision.action === 'arm-select') {
          onEscape?.('', { phase: 'select-arm' });
          return;
        }
        if (escapeDecision.action === 'message-selector') {
          onEscape?.('', { phase: 'select' });
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

      // Undo / redo. Covered encodings:
      //  • kitty protocol: ctrl+z → input 'z' + key.ctrl; ctrl+y → 'y' + key.ctrl;
      //    ctrl+shift+z → 'z' + key.ctrl + key.shift (redo).
      //  • legacy control bytes: Ctrl+Z is \x1a (SUB, 0x1A), Ctrl+Y is \x19 (EM,
      //    0x19). ink may deliver these as raw input without key.ctrl on some
      //    terminals, so match the byte directly too.
      const isCtrlZ = (key.ctrl && editingKey === 'z') || rawInput === '\x1a';
      const isCtrlY = (key.ctrl && editingKey === 'y') || rawInput === '\x19';
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

      // Printable input (ignore other control keys). The discarded Ctrl+Space
      // encodings and the printable filter live in prompt-input/key-signals.mjs.
      if (isDiscardedControlInput(rawInput)) {
        return;
      }
      const printable = printableFromInput(rawInput);
      if (printable && !key.ctrl && !key.meta) {
        updateDraft((d) => insertText(d, printable));
      }
    },
    { isActive: isRawModeSupported && !disabled }
  );

  // Mark the text-box node with a cursor-anchor FUNCTION. Patched Ink calls it
  // during renderNodeToOutput — AFTER yoga layout is final and (crucially)
  // during the same onRender that paints the new text. The function reads the
  // latest caret from refs (synced every render below), so the cursor can never
  // be stale: an earlier object-anchor set in a layout effect was always one
  // keystroke behind, because ink's reconciler runs onRender inside
  // resetAfterCommit BEFORE React layout effects — that lag made the 2nd+ char
  // appear to land behind the caret (the observed scramble). Computing inside
  // the fork, from the real layout + current refs, fixes that by construction.
  // Park the hardware cursor only when the prompt is a real, active edit target.
  // The anchor stays enabled during an active turn too: suppressing it while
  // the draft was empty (an earlier guard against a one-frame row-off paint
  // when the transcript height changed mid-turn) made the cursor vanish for
  // the whole turn after Enter, which reads as "the caret disappeared". A
  // momentary one-frame drift is the lesser evil versus a missing caret.
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
    <Box
      ref={boxRef}
      flexDirection="row"
      width="100%"
      flexGrow={1}
      flexShrink={1}
      backgroundColor={surfaceBackground()}
    >
      <Box width={IME_LEFT_GUARD_COLUMNS} flexShrink={0} backgroundColor={surfaceBackground()} />
      <Text color={theme.text} wrap="hard">
        {renderedValue}
      </Text>
      {!value && hint ? (
        <Box marginLeft={-1}>
          <Text color={hintMeta.textColor}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
