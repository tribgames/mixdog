/**
 * components/TextEntryPanel.jsx — inline editor used inside picker workflows.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, useInput, usePaste, useStdin } from 'ink';
import stringWidth from 'string-width';
import { theme, surfaceBackground } from '../theme.mjs';
import { clearSelection, lineEnd, lineStart, moveCursor, replaceSelection, selectionRange } from '../input-editing.mjs';
import { textEntryReservedRows } from '../app/text-layout.mjs';
import { createTextEntryCursorAnchor, singleLine } from './text-entry-layout.mjs';
import { renderTextEntryValue } from './text-entry-value.jsx';
import { SignInUrl, isSignInCopyKey, signInUrlNote, useCopyUrl } from './SignInUrl.jsx';
import { signInUrlLayout } from './sign-in-url-layout.mjs';
import { canSubmitTextEntry } from '../app/text-entry-policy.mjs';
import { truncatePanelText as truncateText } from './panel-cell-text.mjs';
import { applyEditChord, createVerticalMover } from './prompt-input/edit-chords.mjs';
import {
  insertText,
  isAnyModifiedEnterSequence,
  isModifiedEnterSequence,
  leftArrowOffset,
  normalizePastedText,
  rightArrowOffset,
  singleTrailingLineBreakPrefix,
} from './prompt-input/edit-helpers.mjs';
import { isCsiPrivateReply } from './prompt-input/key-signals.mjs';

export function TextEntryPanel({
  title,
  hint = '',
  detail = '',
  copyText,
  // Rows the panel can give the detail URL block (row-budgets.mjs); unbounded when unknown.
  urlMaxRows = Number.POSITIVE_INFINITY,
  initialValue = '',
  // Blank submit = the documented reset/clear action for some prompt kinds
  // (system shell → auto, provider auto-clear → built-in, profile title →
  // cleared). Off by default: every other prompt still requires a value.
  allowEmpty = false,
  mask = false,
  multiline = false,
  maxContentRows = 8,
  onContentRowsChange,
  columns = 80,
  actionLabel = 'save',
  promptLabel = '> ',
  onSubmit,
  onCancel,
}) {
  const [draft, setDraft] = useState(() => ({
    value: String(initialValue || ''),
    cursor: String(initialValue || '').length,
    selectionAnchor: null,
  }));
  const [, bumpCursorAnchorEpoch] = useState(0);
  const draftRef = useRef(draft);
  const submitGateRef = useRef(false);
  const boxRef = useRef(null);
  const cursorEnabledRef = useRef(false);
  const contentWidthRef = useRef(80);
  const preferredColumnRef = useRef(null);
  const { isRawModeSupported } = useStdin();
  draftRef.current = draft;
  // Optional sign-in URL (e.g. the OAuth URL), drawn complete and borderless
  // under the panel — in the live panel only, never pushed to the transcript, so
  // it disappears when the panel closes instead of lingering in scrollback.
  const detailText = String(detail || '').trim();
  const copyUrl = useCopyUrl(detailText, copyText);

  const flushImmediate = () => {
    let node = boxRef.current;
    for (let i = 0; node && i < 64; i += 1) {
      if (node.nodeName === 'ink-root') {
        if (typeof node.onImmediateRender === 'function') node.onImmediateRender();
        return;
      }
      node = node.parentNode;
    }
  };

  const commitDraft = (next, options = {}) => {
    if (!options.keepPreferredColumn) preferredColumnRef.current = null;
    draftRef.current = next;
    setDraft(next);
    queueMicrotask(flushImmediate);
  };

  const updateDraft = (fn, options = {}) => {
    commitDraft(fn(draftRef.current), options);
  };

  const moveDraftVertically = createVerticalMover({ draftRef, contentWidthRef, preferredColumnRef, commitDraft });

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the prompt (title/initialValue) changes; commitDraft is recreated every render and only touches refs/setState
  useEffect(() => {
    const value = String(initialValue || '');
    commitDraft({ value, cursor: value.length, selectionAnchor: null });
  }, [title, initialValue]);

  const labelCells = stringWidth(String(promptLabel || ''));
  // Bordered (1+1) + paddingX={1} (1+1) panel consumes 4 columns total; must
  // match the hint's `columns - 4` calc below or wrap/height/slice undercount.
  const contentCells = Math.max(1, columns - 4 - labelCells);

  useEffect(() => {
    if (!multiline) {
      onContentRowsChange?.(1);
      return;
    }
    const visible = mask ? draft.value.replace(/[^\n]/g, '*') : draft.value;
    onContentRowsChange?.(textEntryReservedRows(visible, contentCells, maxContentRows));
  }, [multiline, draft.value, mask, contentCells, maxContentRows, onContentRowsChange]);

  const submitEnterChunk = (prefix = '') => {
    if (submitGateRef.current) return;
    const current = draftRef.current;
    const next = prefix ? insertText(current, prefix) : current;
    if (!canSubmitTextEntry(next.value, allowEmpty)) return;
    submitGateRef.current = true;
    const accepted = onSubmit?.(next.value) !== false;
    if (accepted) {
      commitDraft({ value: '', cursor: 0, selectionAnchor: null });
      queueMicrotask(() => {
        submitGateRef.current = false;
      });
    } else if (next !== current) {
      submitGateRef.current = false;
      commitDraft(next);
    } else {
      submitGateRef.current = false;
    }
  };

  usePaste(
    (text) => {
      const pasted = normalizePastedText(text);
      if (!pasted) return;
      updateDraft((d) => insertText(d, pasted));
    },
    { isActive: isRawModeSupported }
  );

  useInput(
    (input, key) => {
      const rawSource = String(input ?? '');
      const rawInput = normalizePastedText(input);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matches the ESC byte of SGR mouse reports
      if (/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/.test(rawSource)) return;
      // Safety net: drop CSI-private replies/fragments (\x1b[?<n>u / \x1b[?...c);
      // a volunteered report must never type into the field.
      if (isCsiPrivateReply(rawSource)) return;

      if (key.escape) {
        if (selectionRange(draftRef.current)) {
          commitDraft(clearSelection(draftRef.current));
          return;
        }
        onCancel?.();
        return;
      }
      const trailingEnterPrefix = singleTrailingLineBreakPrefix(rawInput);
      const rawCtrlEnter = isModifiedEnterSequence(rawSource) || isModifiedEnterSequence(rawInput);
      // Newline-insert chords are meaningless (and dangerous — hidden newlines
      // in API keys/URLs) outside multiline mode; gate here so every downstream
      // branch that inserts '\n' inherits the guard.
      const modifiedLineBreak = multiline && (key.shift || key.meta || key.ctrl || rawCtrlEnter);

      // Ctrl+J — the protocol-independent newline that works on every terminal.
      // Legacy/modifyOtherKeys: a lone '\n' (real Enter is CR → key.return). Kitty:
      // \x1b[106;5u → input 'j' with key.ctrl. Either → insert a newline. Must
      // precede the trailing-newline/submit paths since
      // singleTrailingLineBreakPrefix('\n') returns '' (not null) and would
      // otherwise route Ctrl+J to submit.
      if (multiline && ((rawSource === '\n' && !key.return) || (key.ctrl && rawSource.toLowerCase() === 'j'))) {
        updateDraft((d) => replaceSelection(d, '\n'));
        return;
      }

      // A modified Enter that is NOT a newline chord (e.g. a Super/Hyper-only mod): consume it
      // so its raw CSI bytes don't type into the field under modifyOtherKeys. Plain
      // Enter (mod=1) is not matched and still submits below.
      if (!rawCtrlEnter && (isAnyModifiedEnterSequence(rawSource) || isAnyModifiedEnterSequence(rawInput))) {
        return;
      }

      const pasteFallback =
        rawInput.includes('\n') && trailingEnterPrefix === null && (rawInput.length > 1 || !key.return);
      if (pasteFallback) {
        updateDraft((d) => insertText(d, rawInput));
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
      if (multiline && rawCtrlEnter) {
        updateDraft((d) => replaceSelection(d, '\n'));
        return;
      }
      if (key.return) {
        if (modifiedLineBreak) {
          updateDraft((d) => replaceSelection(d, '\n'));
          return;
        }
        submitEnterChunk();
        return;
      }
      if (key.leftArrow) {
        updateDraft((d) =>
          moveCursor(d, leftArrowOffset(d, { word: key.ctrl || key.meta, extend: key.shift }), { extend: key.shift })
        );
        return;
      }
      if (key.rightArrow) {
        updateDraft((d) =>
          moveCursor(d, rightArrowOffset(d, { word: key.ctrl || key.meta, extend: key.shift }), { extend: key.shift })
        );
        return;
      }
      if (key.upArrow) {
        moveDraftVertically(-1, { extend: key.shift });
        return;
      }
      if (key.downArrow) {
        moveDraftVertically(1, { extend: key.shift });
        return;
      }
      const inputKey = String(input || '').toLowerCase();
      if (key.home || (key.ctrl && inputKey === 'a')) {
        updateDraft((d) =>
          key.ctrl && inputKey === 'a' && d.value
            ? { ...d, cursor: d.value.length, selectionAnchor: 0 }
            : moveCursor(d, lineStart(d.value, d.cursor), { extend: key.shift })
        );
        return;
      }
      if (key.end || (key.ctrl && inputKey === 'e')) {
        updateDraft((d) => moveCursor(d, lineEnd(d.value, d.cursor), { extend: key.shift }));
        return;
      }
      if (detailText && isSignInCopyKey(input, key)) {
        copyUrl.copy();
        return;
      }
      if (applyEditChord(key, inputKey, updateDraft)) return;
      if (rawInput && !key.ctrl && !key.meta) {
        updateDraft((d) => insertText(d, rawInput));
      }
    },
    { isActive: isRawModeSupported }
  );

  const installCursorAnchor = () => {
    if (!boxRef.current || boxRef.current.internal_cursorAnchor) return false;
    boxRef.current.internal_cursorAnchor = createTextEntryCursorAnchor({
      cursorEnabledRef,
      draftRef,
      contentWidthRef,
      contentCells,
      mask,
      multiline,
      maxContentRows,
      promptLabel,
    });
    return true;
  };

  cursorEnabledRef.current = isRawModeSupported;
  installCursorAnchor();

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only anchor install; the helpers are per-render closures over refs
  useLayoutEffect(() => {
    if (!installCursorAnchor()) return;
    bumpCursorAnchorEpoch((epoch) => epoch + 1);
    queueMicrotask(flushImmediate);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: title/multiline/draft are deliberate triggers to re-flush after content changes; flushImmediate is a per-render ref closure
  useLayoutEffect(() => {
    if (!isRawModeSupported) return;
    queueMicrotask(flushImmediate);
  }, [isRawModeSupported, title, multiline, draft.value, draft.cursor]);

  const { renderedValue, contentHeight } = renderTextEntryValue({
    draft,
    mask,
    multiline,
    contentCells,
    maxContentRows,
  });
  const action = String(actionLabel || 'save').trim() || 'save';
  const helpText = `Enter to ${action} · Esc to cancel`;
  // Standard panel rhythm: title row, blank, single-line hint, blank, content.
  // The hint is collapsed to one line and width-truncated so a long manual
  // OAuth URL can never wrap and push the bordered title off the top.
  // The URL block gets the rows the panel really has (urlMaxRows) and degrades
  // to fit; with no hint row under the URL, the hint row carries the copy note.
  const urlLayout = signInUrlLayout(detailText, columns, urlMaxRows);
  const hintText = truncateText(
    !urlLayout.hint && detailText ? signInUrlNote(copyUrl.status) : singleLine(hint),
    Math.max(0, columns - 4)
  );

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>{helpText}</Text>
        </Box>
        <Text> </Text>
        <Text color={theme.subtle}>{hintText || ' '}</Text>
        <Text> </Text>
        {multiline ? (
          <Box flexDirection="row" width="100%" alignItems="flex-start" backgroundColor={surfaceBackground()}>
            <Text color={theme.inactive}>{promptLabel}</Text>
            <Box
              ref={boxRef}
              flexGrow={1}
              flexDirection="column"
              height={contentHeight}
              overflow="hidden"
              backgroundColor={surfaceBackground()}
            >
              <Text color={theme.text} wrap="hard">
                {renderedValue}
              </Text>
            </Box>
          </Box>
        ) : (
          <Box ref={boxRef} flexDirection="row" width="100%" backgroundColor={surfaceBackground()}>
            <Text color={theme.inactive}>{promptLabel}</Text>
            <Text color={theme.text} wrap="truncate">
              {renderedValue}
            </Text>
          </Box>
        )}
      </Box>
      <SignInUrl url={detailText} layout={urlLayout} status={copyUrl.status} />
    </Box>
  );
}
