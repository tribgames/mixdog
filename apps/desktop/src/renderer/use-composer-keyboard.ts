import { useCallback, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from "react";
import type { DesktopRendererComposerActionDiagnostic } from "../shared/contract";
import { t } from "./i18n";
import {
  isComposerNewlineChord,
  nextComposerShiftLatch,
  shouldInterruptPrompt,
  shouldNavigatePromptHistory,
} from "./renderer-logic.mjs";
import { type ComposerAttachment, type ComposerHistoryEntry } from "./composer-support";
import { type SLASH_COMMANDS } from "./slash-commands";
import { classifyPromptEscape, PROMPT_ESCAPE_HINT_TIMEOUT_MS } from "../../../../src/tui/components/prompt-input/escape-policy.mjs";
import { paletteOwnsPromptVerticalArrow } from "../../../../src/tui/components/prompt-input/restore-policy.mjs";

type SlashCommand = (typeof SLASH_COMMANDS)[number];
type TextareaKeyEvent = KeyboardEvent<HTMLTextAreaElement>;

export function useComposerKeyboard({
  draft,
  mention,
  slash,
  selector,
  history,
  queue,
  runtime,
  ime,
  actions,
}: {
  draft: {
    value: string;
    set: Dispatch<SetStateAction<string>>;
    ref: RefObject<string>;
    textarea: RefObject<HTMLTextAreaElement | null>;
    setCaretOffset(offset: number): void;
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
  slash: {
    open: boolean;
    commands: SlashCommand[];
    index: number;
    setIndex: Dispatch<SetStateAction<number>>;
    setDismissedDraft(value: string): void;
    commandToken(command: SlashCommand | undefined): string;
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
  queue: {
    pendingSubmissionId: string;
    hasRestorableMessages(): boolean;
    restore(source: DesktopRendererComposerActionDiagnostic["source"]): void;
  };
  runtime: {
    turnBusy: boolean;
    draftMode?: boolean;
    attachments: ComposerAttachment[];
    escapeClearAt: RefObject<number>;
    showNotice(message: string, durationMs?: number): void;
  };
  ime: {
    composing: RefObject<boolean>;
    suppressLineBreak: RefObject<boolean>;
    shiftLatch: RefObject<boolean>;
  };
  actions: {
    send(
      slashOverride?: string,
      source?: DesktopRendererComposerActionDiagnostic["source"],
    ): Promise<void>;
    stop(preserveDraft?: boolean, submissionId?: string): Promise<void>;
    clearAttachments(): void;
  };
}) {
  const insertNewline = useCallback((element: HTMLTextAreaElement) => {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    draft.set((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
    window.setTimeout(() => {
      draft.textarea.current?.focus();
      draft.textarea.current?.setSelectionRange(start + 1, start + 1);
    }, 0);
  }, [draft]);

  const selectMention = useCallback((path: string | undefined) => {
    if (!path || !mention.match) return;
    const before = draft.value.slice(0, mention.match.start);
    const after = draft.value.slice(mention.match.end);
    const inserted = `@${path}${after && /^\s/.test(after) ? "" : " "}`;
    const next = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    draft.set(next);
    draft.setCaretOffset(caret);
    mention.setDismissed("");
    mention.setResults([]);
    history.navigation.current = { index: -1, seed: "" };
    window.setTimeout(() => {
      draft.textarea.current?.focus();
      draft.textarea.current?.setSelectionRange(caret, caret);
    }, 0);
  }, [draft, history.navigation, mention]);

  const navigateMentionPalette = useCallback((event: TextareaKeyEvent) => {
    if (!mention.open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      mention.setDismissed(mention.signature);
      return true;
    }
    if (!mention.results.length) return false;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown")
      && !paletteOwnsPromptVerticalArrow(mention.results.length)) return false;
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectMention(mention.results[mention.index] || mention.results[0]);
      return true;
    }
    const last = mention.results.length - 1;
    const moves: Record<string, (index: number) => number> = {
      ArrowDown: (index) => (index + 1) % mention.results.length,
      ArrowUp: (index) => (index - 1 + mention.results.length) % mention.results.length,
      Home: () => 0,
      End: () => last,
      PageUp: (index) => Math.max(0, index - 8),
      PageDown: (index) => Math.min(last, index + 8),
    };
    const move = moves[event.key];
    if (!move) return false;
    event.preventDefault();
    mention.setIndex(move);
    return true;
  }, [mention, selectMention]);

  const navigateSlashPalette = useCallback((event: TextareaKeyEvent) => {
    if (!slash.open || slash.commands.length === 0) return false;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown")
      && !paletteOwnsPromptVerticalArrow(slash.commands.length)) return false;
    const last = slash.commands.length - 1;
    if (event.key === "Tab") {
      event.preventDefault();
      draft.set(`/${slash.commandToken(slash.commands[slash.index])} `);
      return true;
    }
    const moves: Record<string, (index: number) => number> = {
      ArrowDown: (index) => (index + 1) % slash.commands.length,
      ArrowRight: (index) => (index + 1) % slash.commands.length,
      ArrowUp: (index) => (index - 1 + slash.commands.length) % slash.commands.length,
      ArrowLeft: (index) => (index - 1 + slash.commands.length) % slash.commands.length,
      Home: () => 0,
      End: () => last,
      PageUp: (index) => Math.max(0, index - slash.commands.length),
      PageDown: (index) => Math.min(last, index + slash.commands.length),
    };
    const move = moves[event.key];
    if (!move) return false;
    event.preventDefault();
    slash.setIndex(move);
    return true;
  }, [draft, slash]);

  const navigateMessageSelector = useCallback((event: TextareaKeyEvent) => {
    if (!selector.open) return false;
    if (event.key === "Escape") {
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
    if (event.key === "Enter") {
      event.preventDefault();
      void selector.rewindToMessage(selector.messages[selector.index]?.id || "");
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
  }, [runtime.escapeClearAt, selector]);

  const onKeyUp = useCallback((event: TextareaKeyEvent) => {
    ime.shiftLatch.current = nextComposerShiftLatch(ime.shiftLatch.current, {
      type: "keyup",
      key: event.key,
      shiftKey: event.shiftKey,
    });
  }, [ime.shiftLatch]);

  const onKeyDown = useCallback((event: TextareaKeyEvent) => {
    if (event.key !== "Escape") runtime.escapeClearAt.current = 0;
    const shiftLatched = ime.shiftLatch.current;
    ime.shiftLatch.current = nextComposerShiftLatch(shiftLatched, {
      type: "keydown",
      key: event.key,
      shiftKey: event.shiftKey,
    });
    const newlineChord = isComposerNewlineChord({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftLatched,
    });
    const composing = event.nativeEvent.isComposing || ime.composing.current
      || event.nativeEvent.keyCode === 229;
    if (!composing) ime.suppressLineBreak.current = false;
    if (composing && event.key === "Enter") {
      ime.suppressLineBreak.current = true;
    }
    if (composing && newlineChord) {
      const element = event.currentTarget;
      window.setTimeout(() => {
        const caret = element.selectionStart;
        if (element.value.slice(Math.max(0, caret - 1), caret) === "\n") return;
        insertNewline(element);
      }, 0);
      return;
    }
    if (composing && (event.key === "Enter" || event.key === "Escape"
      || event.key === "Tab" || event.key.startsWith("Arrow"))) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && event.repeat) {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && event.key.toLowerCase() === "u") {
      event.preventDefault();
      const element = event.currentTarget;
      const selectionStart = element.selectionStart;
      const selectionEnd = element.selectionEnd;
      const lineStart = draft.value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
      const removeStart = selectionStart === selectionEnd ? lineStart : selectionStart;
      draft.set((current) =>
        `${current.slice(0, removeStart)}${current.slice(selectionEnd)}`);
      window.setTimeout(() =>
        draft.textarea.current?.setSelectionRange(removeStart, removeStart), 0);
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && event.key.toLowerCase() === "j") {
      event.preventDefault();
      insertNewline(event.currentTarget);
      return;
    }
    if (navigateMessageSelector(event)) return;
    if (navigateMentionPalette(event)) return;
    if (navigateSlashPalette(event)) return;
    if (slash.open && slash.commands.length && event.key === "Enter"
      && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      void actions.send(
        `/${slash.commandToken(slash.commands[slash.index])}`,
        "slash-keyboard",
      );
      return;
    }
    if (event.key === "Escape") {
      if (slash.open) {
        event.preventDefault();
        slash.setDismissedDraft(draft.value);
        runtime.escapeClearAt.current = 0;
        return;
      }
      const element = event.currentTarget;
      const escape = classifyPromptEscape({
        interruptActive: shouldInterruptPrompt({
          turnBusy: runtime.turnBusy,
          pendingSubmissionId: queue.pendingSubmissionId,
          draftMode: runtime.draftMode,
        }),
        hasSelection: element.selectionStart !== element.selectionEnd,
        hasQueuedMessages: queue.hasRestorableMessages(),
        hasMessages: selector.messages.length > 0,
        value: draft.value || (runtime.attachments.length ? "attachment" : ""),
        lastClearPressAt: runtime.escapeClearAt.current,
      });
      runtime.escapeClearAt.current = escape.nextClearPressAt;
      if (escape.action === "interrupt") {
        event.preventDefault();
        void actions.stop(
          Boolean(draft.value || runtime.attachments.length),
          runtime.turnBusy ? "" : queue.pendingSubmissionId,
        );
      } else if (escape.action === "collapse-selection") {
        event.preventDefault();
        const end = element.selectionEnd;
        window.setTimeout(() => element.setSelectionRange(end, end), 0);
      } else if (escape.action === "restore-queue") {
        event.preventDefault();
        queue.restore("escape");
      } else if (escape.action === "arm-clear") {
        event.preventDefault();
        runtime.showNotice("Esc again to clear", PROMPT_ESCAPE_HINT_TIMEOUT_MS);
      } else if (escape.action === "clear") {
        event.preventDefault();
        draft.set("");
        actions.clearAttachments();
        runtime.showNotice("");
        history.navigation.current = { index: -1, seed: "" };
      } else if (escape.action === "arm-select") {
        event.preventDefault();
        runtime.showNotice(
          t("Esc again to pick a message"),
          PROMPT_ESCAPE_HINT_TIMEOUT_MS,
        );
      } else if (escape.action === "message-selector") {
        event.preventDefault();
        runtime.showNotice("");
        selector.openSelector();
      }
      return;
    }
    const queueAvailable = queue.hasRestorableMessages();
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
      allowNonEmpty: event.key === "ArrowUp" && queueAvailable,
    });
    if (event.key === "ArrowUp" && historyIntent && !event.altKey && queueAvailable) {
      event.preventDefault();
      queue.restore("arrow-up");
      return;
    }
    if (event.key === "ArrowUp" && historyIntent && history.entries.length) {
      event.preventDefault();
      const navigation = history.navigation.current;
      if (navigation.index < 0) {
        navigation.seed = event.currentTarget.value;
        history.seedAttachments.current = history.attachmentsRef.current.map(
          (attachment) => ({ ...attachment }),
        );
      }
      navigation.index = Math.min(history.entries.length - 1, navigation.index + 1);
      const entry = history.entries[navigation.index];
      const value = entry?.text || "";
      const nextAttachments = (entry?.attachments || []).map(
        (attachment) => ({ ...attachment }),
      );
      history.replaceAttachments(nextAttachments);
      draft.ref.current = value;
      draft.set(value);
      window.setTimeout(() => draft.textarea.current?.setSelectionRange(0, 0), 0);
      return;
    }
    if (event.key === "ArrowDown" && historyIntent && history.navigation.current.index >= 0) {
      event.preventDefault();
      const navigation = history.navigation.current;
      navigation.index -= 1;
      const entry: ComposerHistoryEntry = navigation.index < 0
        ? { text: navigation.seed, attachments: history.seedAttachments.current }
        : history.entries[navigation.index];
      const value = entry?.text || "";
      const nextAttachments = (entry?.attachments || []).map(
        (attachment) => ({ ...attachment }),
      );
      history.replaceAttachments(nextAttachments);
      draft.ref.current = value;
      draft.set(value);
      window.setTimeout(() =>
        draft.textarea.current?.setSelectionRange(value.length, value.length), 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (newlineChord) insertNewline(event.currentTarget);
      else void actions.send("", "keyboard-enter");
    }
  }, [
    actions,
    draft,
    history,
    ime,
    insertNewline,
    mention,
    navigateMentionPalette,
    navigateMessageSelector,
    navigateSlashPalette,
    queue,
    runtime,
    selector,
    slash,
  ]);

  return { selectMention, onKeyDown, onKeyUp };
}
