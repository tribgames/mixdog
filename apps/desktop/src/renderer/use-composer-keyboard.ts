import { useCallback, useRef, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react';
import type { DesktopRendererComposerActionDiagnostic } from '../shared/contract';
import { isComposerNewlineChord, shouldInterruptPrompt, shouldNavigatePromptHistory } from './renderer-logic.mjs';
import { foldAttachmentTokens } from './composer-attachment-restore';
import type { ComposerAttachment, ComposerHistoryEntry } from './composer-support';
import type { DesktopSlashCommand } from './slash-commands';
import { t } from './i18n';
import { isMobileRemoteSurface } from './mobile-surface';
import type { SkillMentionResult } from './composer-skill-mentions';
import { classifyPromptEscape } from '../../../../src/tui/components/prompt-input/escape-policy.mjs';
import { paletteOwnsPromptVerticalArrow } from '../../../../src/tui/components/prompt-input/restore-policy.mjs';

type TextareaKeyEvent = KeyboardEvent<HTMLTextAreaElement>;

/** Arrow/Home/End/Page movement shared by the list palettes; false = not ours. */
function movePaletteIndex(
  event: TextareaKeyEvent,
  count: number,
  setIndex: (move: (index: number) => number) => void
): boolean {
  if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !paletteOwnsPromptVerticalArrow(count)) return false;
  const last = count - 1;
  const moves: Record<string, (index: number) => number> = {
    ArrowDown: (index) => (index + 1) % count,
    ArrowUp: (index) => (index - 1 + count) % count,
    Home: () => 0,
    End: () => last,
    PageUp: (index) => Math.max(0, index - 8),
    PageDown: (index) => Math.min(last, index + 8),
  };
  const move = moves[event.key];
  if (!move) return false;
  event.preventDefault();
  setIndex(move);
  return true;
}

interface ComposerKeyboardOptions {
  draft: {
    value: string;
    set: Dispatch<SetStateAction<string>>;
    ref: RefObject<string>;
    textarea: RefObject<HTMLTextAreaElement | null>;
    setCaretOffset(offset: number): void;
  };
  slash: {
    open: boolean;
    commands: ReadonlyArray<DesktopSlashCommand>;
    index: number;
    setIndex: Dispatch<SetStateAction<number>>;
    setDismissed(value: string): void;
  };
  mention: {
    match: { start: number; end: number; query: string } | null;
    open: boolean;
    signature: string;
    results: string[];
    index: number;
    setIndex: Dispatch<SetStateAction<number>>;
    setDismissed(value: string): void;
    setResults(paths: string[]): void;
  };
  skillMention: {
    match: { start: number; end: number; query: string } | null;
    open: boolean;
    signature: string;
    results: SkillMentionResult[];
    index: number;
    setIndex: Dispatch<SetStateAction<number>>;
    setDismissed(value: string): void;
  };
  selector: {
    open: boolean;
    setOpen(open: boolean): void;
    index: number;
    setIndex: Dispatch<SetStateAction<number>>;
    messages: Array<{ id: string; text: string }>;
    openSelector(): void;
    rewindToMessage(messageId: string): Promise<void>;
  };
  history: {
    entries: ComposerHistoryEntry[];
    navigation: RefObject<{ index: number; seed: string }>;
    seedAttachments: RefObject<ComposerAttachment[]>;
    attachmentsRef: RefObject<ComposerAttachment[]>;
    replaceAttachments(attachments: ComposerAttachment[]): void;
  };
  runtime: {
    turnBusy: boolean;
    draftMode?: boolean;
    /** The prompt this pane sent last that has not settled yet. */
    pendingSubmissionId: string;
    attachments: ComposerAttachment[];
    escapeClearAt: RefObject<number>;
    showNotice(message: string): void;
  };
  ime: {
    composing: RefObject<boolean>;
    suppressLineBreak: RefObject<boolean>;
  };
  actions: {
    send(slashOverride?: string, source?: DesktopRendererComposerActionDiagnostic['source']): Promise<void>;
    stop(preserveDraft?: boolean, submissionId?: string): Promise<void>;
    clearAttachments(): void;
  };
}

export function useComposerKeyboard({
  draft,
  slash,
  mention,
  skillMention,
  selector,
  history,
  runtime,
  ime,
  actions,
}: ComposerKeyboardOptions) {
  // A suggested command is not consent to replace a literal slash or path.
  // Only arrow navigation explicitly selects a candidate for Enter.
  const slashNavigation = useRef({ draft: draft.value, selected: false });
  if (slashNavigation.current.draft !== draft.value) {
    slashNavigation.current = { draft: draft.value, selected: false };
  }
  const insertNewline = useCallback(
    (element: HTMLTextAreaElement) => {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      const atEnd = end === element.value.length;
      draft.set((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
      window.setTimeout(() => {
        if (draft.textarea.current !== element) return;
        element.focus();
        element.setSelectionRange(start + 1, start + 1);
        // Programmatic selection does not scroll like a native newline. Wait
        // for the controlled value and CSS autosize, then reveal an appended line.
        if (atEnd) element.scrollTop = element.scrollHeight;
      }, 0);
    },
    [draft]
  );

  const selectMention = useCallback(
    (path: string | undefined) => {
      if (!path || !mention.match) return;
      const before = draft.value.slice(0, mention.match.start);
      const after = draft.value.slice(mention.match.end);
      const inserted = `@${path}${after && /^\s/.test(after) ? '' : ' '}`;
      const next = `${before}${inserted}${after}`;
      const caret = before.length + inserted.length;
      draft.set(next);
      draft.setCaretOffset(caret);
      mention.setDismissed('');
      mention.setResults([]);
      history.navigation.current = { index: -1, seed: '' };
      window.setTimeout(() => {
        draft.textarea.current?.focus();
        draft.textarea.current?.setSelectionRange(caret, caret);
      }, 0);
    },
    [draft, history.navigation, mention]
  );

  // Replaces the typed `$fragment` with `$name ` and parks the caret after it.
  const selectSkillMention = useCallback(
    (name: string | undefined) => {
      if (!name || !skillMention.match) return;
      const before = draft.value.slice(0, skillMention.match.start);
      const after = draft.value.slice(skillMention.match.end);
      // The caret lands past the separating space (an existing one is reused),
      // so the finished mention does not reopen the palette.
      const separated = after && /^\s/.test(after);
      const inserted = `$${name}${separated ? '' : ' '}`;
      const next = `${before}${inserted}${after}`;
      const caret = before.length + inserted.length + (separated ? 1 : 0);
      draft.ref.current = next;
      draft.set(next);
      draft.setCaretOffset(caret);
      skillMention.setDismissed('');
      history.navigation.current = { index: -1, seed: '' };
      window.setTimeout(() => {
        draft.textarea.current?.focus();
        draft.textarea.current?.setSelectionRange(caret, caret);
        // A selection event from the value swap can report the old caret
        // first; settle the tracked caret on the placed one.
        draft.setCaretOffset(caret);
      }, 0);
    },
    [draft, history.navigation, skillMention]
  );

  const navigateSkillMentionPalette = useCallback(
    (event: TextareaKeyEvent) => {
      if (!skillMention.open) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        skillMention.setDismissed(skillMention.signature);
        return true;
      }
      const { results } = skillMention;
      if (!results.length) return false;
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
        event.preventDefault();
        selectSkillMention((results[skillMention.index] || results[0]).skill.name);
        return true;
      }
      return movePaletteIndex(event, results.length, skillMention.setIndex);
    },
    [selectSkillMention, skillMention]
  );

  const navigateSlashPalette = useCallback(
    (event: TextareaKeyEvent) => {
      if (!slash.open || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        slash.setDismissed(draft.value);
        slashNavigation.current.selected = false;
        runtime.escapeClearAt.current = 0;
        return true;
      }
      const command = slash.commands[slash.index] || slash.commands[0];
      if (!command) return false;
      if (event.key === 'Enter') {
        if (!slashNavigation.current.selected) return false;
        event.preventDefault();
        void actions.send(command.usage, 'keyboard-enter');
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const value = `${command.usage} `;
        draft.ref.current = value;
        draft.set(value);
        draft.setCaretOffset(value.length);
        history.navigation.current = { index: -1, seed: '' };
        window.setTimeout(() => draft.textarea.current?.setSelectionRange(value.length, value.length), 0);
        return true;
      }
      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        paletteOwnsPromptVerticalArrow(slash.commands.length)
      ) {
        event.preventDefault();
        slashNavigation.current.selected = true;
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        slash.setIndex((index) => (index + direction + slash.commands.length) % slash.commands.length);
        return true;
      }
      return false;
    },
    [actions, draft, history.navigation, runtime.escapeClearAt, slash]
  );

  const navigateMentionPalette = useCallback(
    (event: TextareaKeyEvent) => {
      if (!mention.open) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        mention.setDismissed(mention.signature);
        return true;
      }
      if (!mention.results.length) return false;
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        selectMention(mention.results[mention.index] || mention.results[0]);
        return true;
      }
      return movePaletteIndex(event, mention.results.length, mention.setIndex);
    },
    [mention, selectMention]
  );

  const navigateMessageSelector = useCallback(
    (event: TextareaKeyEvent) => {
      if (!selector.open) return false;
      if (event.key === 'Escape') {
        event.preventDefault();
        selector.setOpen(false);
        runtime.escapeClearAt.current = 0;
        return true;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        selector.setOpen(false);
        return false;
      }
      if (selector.messages.length === 0) return false;
      if (event.key === 'Enter') {
        event.preventDefault();
        void selector.rewindToMessage(selector.messages[selector.index]?.id || '');
        return true;
      }
      const last = selector.messages.length - 1;
      const moves: Record<string, (index: number) => number> = {
        ArrowDown: (index) => Math.min(last, index + 1),
        ArrowUp: (index) => Math.max(0, index - 1),
        Home: () => 0,
        End: () => last,
        PageUp: (index) => Math.max(0, index - 8),
        PageDown: (index) => Math.min(last, index + 8),
      };
      const move = moves[event.key];
      if (!move) return false;
      event.preventDefault();
      selector.setIndex(move);
      return true;
    },
    [runtime.escapeClearAt, selector]
  );

  const applyHistoryEntry = useCallback(
    (entry: ComposerHistoryEntry | undefined): string => {
      const folded = foldAttachmentTokens(entry?.text || '', entry?.attachments || []);
      const value = folded.text;
      history.replaceAttachments(folded.attachments.map((attachment) => ({ ...attachment })));
      draft.ref.current = value;
      draft.set(value);
      return value;
    },
    [draft, history]
  );

  const handleEscape = useCallback(
    (event: TextareaKeyEvent) => {
      const element = event.currentTarget;
      const escapeIntent = classifyPromptEscape({
        interruptActive: shouldInterruptPrompt({
          turnBusy: runtime.turnBusy,
          pendingSubmissionId: runtime.pendingSubmissionId,
          draftMode: runtime.draftMode,
        }),
        hasSelection: element.selectionStart !== element.selectionEnd,
        // Messages sent behind a turn live in the transcript, not a queue
        // the editor takes back.
        hasQueuedMessages: false,
        hasMessages: selector.messages.length > 0,
        value: draft.value || (runtime.attachments.length ? 'attachment' : ''),
        lastClearPressAt: runtime.escapeClearAt.current,
      });
      runtime.escapeClearAt.current = escapeIntent.nextClearPressAt;
      if (escapeIntent.action === 'interrupt') {
        event.preventDefault();
        void actions.stop(
          Boolean(draft.value || runtime.attachments.length),
          runtime.turnBusy ? '' : runtime.pendingSubmissionId
        );
      } else if (escapeIntent.action === 'collapse-selection') {
        event.preventDefault();
        const end = element.selectionEnd;
        window.setTimeout(() => element.setSelectionRange(end, end), 0);
      } else if (escapeIntent.action === 'arm-clear') {
        event.preventDefault();
        runtime.showNotice(t('Esc again to clear'));
      } else if (escapeIntent.action === 'clear') {
        event.preventDefault();
        draft.set('');
        actions.clearAttachments();
        runtime.showNotice('');
        history.navigation.current = { index: -1, seed: '' };
      } else if (escapeIntent.action === 'arm-select') {
        // Silent arm: the first Esc on an empty composer used to announce
        // "Esc again to pick a message", which read as noise for a key that
        // otherwise does nothing (user: ESC 아무것도 없을 때 UI 없어도 될 듯).
        // The second press still opens the picker.
        event.preventDefault();
      } else if (escapeIntent.action === 'message-selector') {
        event.preventDefault();
        runtime.showNotice('');
        selector.openSelector();
      }
    },
    [actions, draft, history, runtime, selector]
  );

  const onKeyDown = useCallback(
    (event: TextareaKeyEvent) => {
      if (event.key !== 'Escape') runtime.escapeClearAt.current = 0;
      const newlineChord = isComposerNewlineChord({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      });
      // Phone keyboards have no Shift+Enter, so Enter keeps its native line
      // break there and the send button submits.
      const mobile = isMobileRemoteSurface();
      const composing = event.nativeEvent.isComposing || ime.composing.current || event.nativeEvent.keyCode === 229;
      if (!composing) ime.suppressLineBreak.current = false;
      if (composing && event.key === 'Enter' && !mobile) {
        ime.suppressLineBreak.current = true;
      }
      if (composing && newlineChord && !mobile) {
        const element = event.currentTarget;
        window.setTimeout(() => {
          const caret = element.selectionStart;
          if (element.value.slice(Math.max(0, caret - 1), caret) === '\n') return;
          insertNewline(element);
        }, 0);
        return;
      }
      if (
        composing &&
        (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab' || event.key.startsWith('Arrow'))
      ) {
        event.stopPropagation();
        return;
      }
      if (event.key === 'Enter' && event.repeat) {
        event.preventDefault();
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'u') {
        event.preventDefault();
        const element = event.currentTarget;
        const selectionStart = element.selectionStart;
        const selectionEnd = element.selectionEnd;
        const lineStart = draft.value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
        const removeStart = selectionStart === selectionEnd ? lineStart : selectionStart;
        draft.set((current) => `${current.slice(0, removeStart)}${current.slice(selectionEnd)}`);
        window.setTimeout(() => draft.textarea.current?.setSelectionRange(removeStart, removeStart), 0);
        return;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        insertNewline(event.currentTarget);
        return;
      }
      if (navigateMessageSelector(event)) return;
      if (navigateSlashPalette(event)) return;
      if (navigateMentionPalette(event)) return;
      if (navigateSkillMentionPalette(event)) return;
      if (event.key === 'Escape') {
        handleEscape(event);
        return;
      }
      const historyIntent = shouldNavigatePromptHistory({
        key: event.key,
        value: draft.value,
        selectionStart: event.currentTarget.selectionStart,
        selectionEnd: event.currentTarget.selectionEnd,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        historyActive: history.navigation.current.index >= 0,
      });
      if (event.key === 'ArrowUp' && historyIntent && history.entries.length) {
        event.preventDefault();
        const navigation = history.navigation.current;
        if (navigation.index < 0) {
          navigation.seed = event.currentTarget.value;
          history.seedAttachments.current = history.attachmentsRef.current.map((attachment) => ({ ...attachment }));
        }
        navigation.index = Math.min(history.entries.length - 1, navigation.index + 1);
        applyHistoryEntry(history.entries[navigation.index]);
        window.setTimeout(() => draft.textarea.current?.setSelectionRange(0, 0), 0);
        return;
      }
      if (event.key === 'ArrowDown' && historyIntent && history.navigation.current.index >= 0) {
        event.preventDefault();
        const navigation = history.navigation.current;
        navigation.index -= 1;
        const entry: ComposerHistoryEntry =
          navigation.index < 0
            ? { text: navigation.seed, attachments: history.seedAttachments.current }
            : history.entries[navigation.index];
        const value = applyHistoryEntry(entry);
        window.setTimeout(() => draft.textarea.current?.setSelectionRange(value.length, value.length), 0);
        return;
      }
      if (event.key === 'Enter') {
        if (mobile) return;
        event.preventDefault();
        if (newlineChord) insertNewline(event.currentTarget);
        else void actions.send('', 'keyboard-enter');
      }
    },
    [
      actions,
      applyHistoryEntry,
      draft,
      handleEscape,
      history,
      ime,
      insertNewline,
      navigateMentionPalette,
      navigateMessageSelector,
      navigateSkillMentionPalette,
      navigateSlashPalette,
      runtime,
    ]
  );

  return { selectMention, selectSkillMention, onKeyDown };
}
