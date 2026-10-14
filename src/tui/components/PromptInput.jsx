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
import { selectionRange } from '../input-editing.mjs';
import { hintStyle, insertText, normalizePastedText, draftStateEqual } from './prompt-input/edit-helpers.mjs';
import { createVerticalMover } from './prompt-input/edit-chords.mjs';
import { cancelPromptImmediateFlush, schedulePromptImmediateFlush } from './prompt-input/immediate-render.mjs';
import { renderSelectedText } from './prompt-input/selected-text.jsx';
import { IME_LEFT_GUARD_COLUMNS, createCursorAnchor } from './prompt-input/cursor-anchor.mjs';
import { createPromptKeyHandler, paletteResultDraft } from './prompt-input/key-handler.mjs';
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
  commandPaletteMovesCaret = false,
  onCaretChange,
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
  const lastReportedCursorRef = useRef(null);
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
    const text = range && !mask ? draft.value.slice(range.start, range.end) : '';
    selectionRef.current = range ? { range, text } : null;
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
    reportCaret(next.cursor);
    if (valueRef) valueRef.current = next.value;
  };

  // The caret offset for caret-aware completion (`$name` skill mentions).
  function reportCaret(nextCursor) {
    if (nextCursor === lastReportedCursorRef.current) return;
    lastReportedCursorRef.current = nextCursor;
    onCaretChange?.(nextCursor);
  }
  // A (re)mounted input starts at the end of its initial value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only report
  useEffect(() => reportCaret(draftRef.current.cursor), []);

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

  const moveDraftVertically = createVerticalMover({ draftRef, contentWidthRef, preferredColumnRef, commitDraft });

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
      const accepted = onCommandPaletteAccept?.(next.value, next.cursor);
      const replacement = paletteResultDraft(accepted);
      if (replacement) {
        commitDraft(replacement);
      } else if (accepted !== false) {
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

  const keyContext = {
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
    commandPaletteOpen,
    commandPaletteOptionCount,
    commandPaletteMovesCaret,
    onCommandPaletteNavigate,
    onCommandPaletteAccept,
    onCommandPaletteCancel,
    onCommandPaletteComplete,
    onTab,
    onEscape,
    onInterrupt,
    interruptActive,
    hasQueuedMessages,
    hasMessages,
    moveDraftVertically,
    restoreQueuedToDraft,
    applyHistoryNavigation,
    undoStack,
  };
  useInput(createPromptKeyHandler(keyContext), { isActive: isRawModeSupported && !disabled });

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
