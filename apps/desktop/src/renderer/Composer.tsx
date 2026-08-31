import { ArrowUp, Command, Mic, X } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { DesktopAbortOptions, DesktopCapability, DesktopModelSelection, DesktopPromptContent, DesktopSubmitOptions, SessionSnapshot } from "../shared/contract";
import { type RecordValue } from "./desktop-types";
import { t } from "./i18n";
import { useMobileBack } from "./mobile-back";
import { ModelSelector } from "./model-controls";
import { MxIcon } from "./MxIcon";
import { ProgressSpinner } from "./ProgressSpinner";
import { shouldStopComposerGeneration } from "./renderer-logic.mjs";
import {
  desktopSlashCommandDescription,
  resolveDesktopSlashCommand,
  SLASH_COMMANDS,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection,
} from "./slash-commands";
import { TURN_LOCKED_SLASH_COMMANDS, asRecord, oneLine } from "./text-format";
import { touchPrimaryPointer } from "./surface-input-focus";
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { pastedTextLineCount, shouldFoldPastedText } from "../../../../src/tui/paste-text-policy.mjs";


// Project-context pill, attachment budget, prompt history and the queued
// follow-up list live in composer-support.tsx.
import {
  COMPOSER_PLACEHOLDERS,
  MAX_PERSISTED_PROMPT_HISTORY,
  PROJECT_CONTEXT_LOCAL,
  ProjectContextSelector,
  QueueList,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory,
  type ComposerAttachment,
  type ComposerHistoryEntry,
  writePromptHistory,
} from "./composer-support";
import {
  composerDraftAfterScopeChange,
  shouldPreserveComposerDraftOnScopeChange,
} from "./composer-draft";
import { useComposerDictation } from "./use-composer-dictation";
import { useComposerAttachments } from "./use-composer-attachments";
import { useComposerShareIntake } from "./use-composer-share-intake";
import { useComposerQueue } from "./use-composer-queue";
import { useComposerSubmission } from "./use-composer-submission";
import { useComposerKeyboard } from "./use-composer-keyboard";
export {
  PROJECT_CONTEXT_LOCAL,
  ProjectContextSelector,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory
};

// The recording overlay renders m:ss over the typing surface. The placeholder
// cannot carry this signal: it is blank once a session has content (see
// `placeholder` below).
function formatDictationElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Envelope of the level meter: one shared level, five bars, tallest in the
// middle so the row reads as a voice instead of a progress bar.
const DICTATION_BAR_GAINS = [0.42, 0.72, 1, 0.78, 0.5];

// The meter owns its own animation frame and writes ONLY a CSS variable, so a
// live 60fps level never re-renders the composer around it.
function DictationMeter({ levelRef }: { levelRef: MutableRefObject<number> }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = window.requestAnimationFrame(function paint() {
      host.current?.style.setProperty('--mx-dictation-level', levelRef.current.toFixed(3));
      frame = window.requestAnimationFrame(paint);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [levelRef]);
  return (
    <span className="composer-dictation-meter" ref={host} aria-hidden="true">
      {DICTATION_BAR_GAINS.map((gain, index) => (
        <span key={index} style={{ '--mx-dictation-gain': gain } as CSSProperties} />
      ))}
    </span>
  );
}

function DictationProgress() {
  return (
    <span className="composer-dictation-progress" aria-hidden="true">
      {DICTATION_BAR_GAINS.map((_, index) => <span key={index} />)}
    </span>
  );
}

export const Composer = memo(function Composer({
  turnBusy,
  commandBusy,
  transitioning,
  focusRequest,
  historyScope,
  recoveryScope,
  projectScope,
  sessionId,
  hasConversation,
  promptHistoryList,
  provider,
  model,
  effort,
  fast,
  fastCapable,
  modelParameters,
  contextPercent,
  draftMode,
  onDraftModelSelection,
  onRoutePreferenceApplied,
  queued,
  hiddenQueueIds,
  pendingSubmissionIds,
  onQueuedRestored,
  userMessages,
  submit,
  abort,
  invokeResult,
  applySnapshot,
  onNewTask,
  onClearToNewTask,
  onResumeSession,
  onOpenSessions,
  onOpenProjects,
  onOpenSettings,
  onOpenCommandSurface,
  dropTargetRef,
  paneActive = true,
}: {
  turnBusy: boolean;
  commandBusy: boolean;
  transitioning: boolean;
  focusRequest: number;
  historyScope: string;
  recoveryScope: string;
  projectScope: string;
  /** This pane's session, so route changes address it instead of whatever the
   *  window happens to be focused on. */
  sessionId?: string;
  hasConversation: boolean;
  promptHistoryList?: unknown[];
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  modelParameters?: Record<string, string>;
  contextPercent?: number;
  draftMode?: boolean;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection) => void;
  queued?: unknown[];
  hiddenQueueIds?: Array<string | number>;
  pendingSubmissionIds?: Array<string | number>;
  onQueuedRestored?: (ids: string[]) => void;
  /** Rewindable user prompts (oldest → newest) for the Esc-Esc selector. */
  userMessages?: Array<{ id: string; text: string }>;
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  abort: (options?: DesktopAbortOptions) => Promise<unknown>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onNewTask: () => void;
  /** Session-pane /clear · /new: close this session's tab and open a New
   *  Task in its place with the session's settings inherited. */
  onClearToNewTask?: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenProjects: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  dropTargetRef: React.RefObject<HTMLElement | null>;
  /** This pane is the focused, visible one. A payload shared into the app from
   *  outside (share sheet) may only land in a composer the user can see. */
  paneActive?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submissionRecoveryVersion, setSubmissionRecoveryVersion] = useState(0);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  // A failed transport acknowledgement may still have landed in the session.
  // Reuse the same id when the exact restored payload is retried so daemon-side
  // idempotency acknowledges it instead of posting a duplicate user message.
  const submissionRetryRef = useRef<{ key: string; id: string } | null>(null);
  const [composerNotice, setComposerNotice] = useState('');
  // Composer notices are transient helpers (mic errors, etc.): auto-dismiss
  // after a beat instead of pinning to the composer forever (user-flagged).
  const composerNoticeTimer = useRef(0);
  const showComposerNotice = useCallback((message: string, durationMs = 6_000) => {
    window.clearTimeout(composerNoticeTimer.current);
    setComposerNotice(message);
    if (message) {
      composerNoticeTimer.current = window.setTimeout(() => setComposerNotice(''), durationMs);
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      window.clearTimeout(composerNoticeTimer.current);
    };
  }, []);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [caretOffset, setCaretOffset] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState('');
  // Esc-Esc selects a previous prompt, rewinds to it, and restores it for edit.
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectorIndex, setSelectorIndex] = useState(0);
  const [persistedHistory, setPersistedHistory] = useState(() => readPromptHistory(historyScope));
  const activeHistoryScope = useRef(historyScope);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Chromium does not report `KeyboardEvent.isComposing` consistently across
  // every IME event ordering, so keep the explicit composition lifecycle too.
  const composingRef = useRef(false);
  const suppressImeLineBreakRef = useRef(false);
  // True while the current Shift hold has already produced a character ('?' is
  // Shift+/), so the Enter that follows is a send, not a newline chord.
  const shiftLatchRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const escapeClearAtRef = useRef(0);
  const slashPalette = useRef<HTMLDivElement>(null);
  const messagePalette = useRef<HTMLDivElement>(null);
  const mentionPalette = useRef<HTMLDivElement>(null);
  const mentionSearchGeneration = useRef(0);
  const composerPaintSamplePending = useRef(false);
  const transitioningRef = useRef(transitioning);
  transitioningRef.current = transitioning;
  // Voice → send in one press. The transcript reaches the draft through a
  // state update, and `send` reads the textarea, so the intent is parked here
  // and fired by the effect below on the commit that carries the words.
  const voiceSubmitPending = useRef(false);
  const {
    dictationState,
    dictationInstalled,
    toggleDictation,
    stopDictationAndSend,
    cancelDictation,
    recordingElapsedMs,
    dictationLevelRef,
  } = useComposerDictation({
    transitioningRef,
    textarea,
    setDraft,
    invokeResult,
    showNotice: showComposerNotice,
    requestVoiceInstall: useCallback(() => onOpenSettings('voice'), [onOpenSettings]),
    onTranscriptSubmit: useCallback(() => { voiceSubmitPending.current = true; }, []),
  });
  const wasTransitioning = useRef(transitioning);
  const historyNavigation = useRef({ index: -1, seed: '' });
  const historySeedAttachments = useRef<ComposerAttachment[]>([]);
  const {
    attachments,
    attachmentsRef,
    attachmentError,
    setAttachmentError,
    draggingFiles,
    setDraggingFiles,
    attachmentSequence,
    fileInput,
    insertAttachment,
    clearAttachments,
    removeAttachments,
    removeAttachment,
    replaceAttachments,
    attachFiles,
    restoredAttachments,
    mergeRestoredAttachments,
    resetAttachments,
  } = useComposerAttachments({
    draftRef,
    setDraft,
    textarea,
    historyNavigation,
    transitioningRef,
    projectScope,
    recoveryScope,
    submissionRecoveryVersion,
    dropTargetRef,
  });
  // A shared link or note arrives as text: it JOINS the draft instead of
  // replacing whatever the user already typed.
  const appendSharedText = useCallback((text: string) => {
    setDraft((current) => {
      const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text;
      draftRef.current = next;
      return next;
    });
    window.setTimeout(() => { textarea.current?.focus(); }, 0);
  }, [draftRef, setDraft, textarea]);
  useComposerShareIntake({
    active: paneActive && !transitioning,
    attachFiles,
    appendText: appendSharedText,
  });
  useEffect(() => {
    const element = textarea.current;
    if (!element) return undefined;
    let reconcileFrame = 0;
    const onCompositionStart = () => {
      composingRef.current = true;
    };
    const onCompositionEnd = () => {
      // Match the reference composer: a keydown delivered after compositionend
      // is the user's submit Enter, even when Chromium keeps both events in the
      // same task. The separate beforeinput guard below still blocks the stray
      // insertLineBreak emitted by engines that end composition after keydown.
      composingRef.current = false;
      const committed = element.value;
      draftRef.current = committed;
      setDraft((current) => current === committed ? current : committed);
      setCaretOffset(element.selectionStart);
      window.cancelAnimationFrame(reconcileFrame);
      reconcileFrame = window.requestAnimationFrame(() => {
        if (composingRef.current || textarea.current !== element) return;
        const value = element.value;
        draftRef.current = value;
        setDraft((current) => current === value ? current : value);
        setCaretOffset(element.selectionStart);
      });
    };
    const onBeforeInput = (event: InputEvent) => {
      // A composing Enter commits the IME candidate; it is not a request for a
      // line break. Electron can deliver the follow-up newline after
      // compositionend and a later task, using either browser input type.
      const newline = event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph';
      if (newline &&
        (composingRef.current || event.isComposing || suppressImeLineBreakRef.current)) {
        event.preventDefault();
        suppressImeLineBreakRef.current = false;
      }
    };
    element.addEventListener('compositionstart', onCompositionStart);
    element.addEventListener('compositionend', onCompositionEnd);
    element.addEventListener('beforeinput', onBeforeInput);
    return () => {
      window.cancelAnimationFrame(reconcileFrame);
      element.removeEventListener('compositionstart', onCompositionStart);
      element.removeEventListener('compositionend', onCompositionEnd);
      element.removeEventListener('beforeinput', onBeforeInput);
    };
  }, []);
  useLayoutEffect(() => {
    if (activeHistoryScope.current === historyScope) return;
    const previousHistoryScope = activeHistoryScope.current;
    activeHistoryScope.current = historyScope;
    resetAttachments();
    composingRef.current = false;
    suppressImeLineBreakRef.current = false;
    mentionSearchGeneration.current += 1;
    // Scope settles ASYNC after a session switch/promotion; when the user is
    // ALREADY typing in the composer, the in-flight text carries over instead
    // of being wiped (user bug: draft vanished + scroll jumped mid-sentence).
    const typingElement = textarea.current;
    const typingLive = document.activeElement === typingElement;
    const preserveDraft = shouldPreserveComposerDraftOnScopeChange(
      previousHistoryScope,
      historyScope,
    );
    setDraft((current) => {
      // A remote snapshot can change scope in the same turn as a native input
      // event. The DOM already owns the newest character while React state may
      // still be one commit behind, so preserve the focused DOM value instead
      // of briefly writing the stale controlled value back into the textarea.
      const next = composerDraftAfterScopeChange({
        currentDraft: current,
        liveDomDraft: typingElement?.value ?? current,
        preserveDraft,
        typingLive,
      });
      draftRef.current = next;
      return next;
    });
    setComposerNotice('');
    setSlashIndex(0);
    setSlashDismissedDraft('');
    setComposerFocused(false);
    setCaretOffset(0);
    setMentionIndex(0);
    setMentionResults([]);
    setMentionLoading(false);
    setMentionDismissed('');
    setDraggingFiles(false);
    setSelectorOpen(false);
    setSelectorIndex(0);
    setPersistedHistory(readPromptHistory(historyScope));
    historyNavigation.current = { index: -1, seed: '' };
  }, [historyScope, resetAttachments]);
  const history = useMemo<ComposerHistoryEntry[]>(() => {
    const engineHistory: ComposerHistoryEntry[] = Array.isArray(promptHistoryList)
      ? promptHistoryList.map((entry) => typeof entry === 'string'
        ? { text: entry } : { text: String(asRecord(entry)?.text || asRecord(entry)?.displayText || '') })
        .filter((entry) => entry.text.trim())
      : [];
    const seen = new Set<string>();
    return [...persistedHistory, ...engineHistory].filter((entry) => {
      const key = entry.text.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  }, [persistedHistory, promptHistoryList]);
  const rememberPrompt = useCallback((value: string, submittedAttachments: ComposerAttachment[] = []) => {
    const prompt = value.trim();
    if (!prompt) return;
    const retained = submittedAttachments
      .filter((attachment) => attachment.kind === 'text' && attachment.token && prompt.includes(attachment.token))
      .map((attachment) => ({ ...attachment }));
    const entry: ComposerHistoryEntry = {
      text: prompt,
      ...(retained.length ? { attachments: retained } : {}),
    };
    setPersistedHistory((current) => {
      const next = [entry, ...current.filter((item) => item.text !== prompt)]
        .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
      try {
        writePromptHistory(historyScope, next);
      } catch {
        // The engine-provided history remains available when browser storage is unavailable.
      }
      return next;
    });
  }, [historyScope]);
  // User request: one stable placeholder — no rotating variants.
  // User request: once a session has content, the composer shows NO hint copy
  // at all — instructional placeholders belong to the empty new-task state.
  const placeholder = hasConversation ? ''
    : turnBusy ? t('Steer the active turn or queue a follow-up…')
      : commandBusy ? t('Queue a message after the current command…')
        : t(COMPOSER_PLACEHOLDERS[0]);
  // Match the TUI palette: it only owns a single, argument-free /token.
  // Once whitespace is entered the composer returns to normal editing and the
  // argument hint/submit path owns the draft.
  const slashMatch = /^\/([^\s]*)$/.exec(draft);
  const slashQuery = slashMatch?.[1]?.toLowerCase() || '';
  const slashCommands = slashMatch
    ? SLASH_COMMANDS.filter((command) => command.name.startsWith(slashQuery) ||
      command.aliases?.some((alias) => alias.startsWith(slashQuery)))
      .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }))
      .slice(0, 10)
    : [];
  const slashOpen = Boolean(!commandBusy && slashMatch && slashDismissedDraft !== draft);
  const mentionMatch = useMemo(() => {
    const beforeCaret = draft.slice(0, Math.max(0, Math.min(caretOffset, draft.length)));
    const match = /(^|[\s([{"'])@([^\s@]*)$/.exec(beforeCaret);
    if (!match) return null;
    const start = match.index + match[1].length;
    return { start, end: beforeCaret.length, query: match[2] || '' };
  }, [caretOffset, draft]);
  const mentionSignature = mentionMatch
    ? `${mentionMatch.start}:${mentionMatch.end}:${mentionMatch.query}`
    : '';
  const mentionOpen = Boolean(composerFocused && projectScope && mentionMatch && !transitioning &&
    mentionDismissed !== mentionSignature);
  // ABB: each open composer palette answers hardware back with the same
  // dismissal its own Escape performs.
  useMobileBack(slashOpen, () => setSlashDismissedDraft(draft));
  useMobileBack(mentionOpen, () => setMentionDismissed(mentionSignature));
  useMobileBack(selectorOpen, () => setSelectorOpen(false));
  const paletteCommandToken = (command: (typeof SLASH_COMMANDS)[number] | undefined) => {
    if (!command) return '';
    const typedToken = draft.slice(1).trim().toLowerCase();
    return typedToken && (typedToken === command.name || command.aliases?.includes(typedToken))
      ? typedToken
      : command.name;
  };
  // Autosize is CSS-native now (field-sizing: content). The old layout-effect
  // path forced TWO whole-document synchronous reflows per keystroke
  // (height:auto → scrollHeight read) — the measured source of typing lag on
  // long transcripts.
  useEffect(() => {
    if (!transitioning) return;
    setDraggingFiles(false);
  }, [transitioning]);
  useEffect(() => {
    if (wasTransitioning.current && !transitioning && !touchPrimaryPointer()) {
      window.setTimeout(() => {
        if (document.activeElement?.classList.contains("session-header-title-input")) return;
        textarea.current?.focus({ preventScroll: true });
      }, 0);
    }
    wasTransitioning.current = transitioning;
  }, [transitioning]);
  useEffect(() => {
    if (focusRequest <= 0 || transitioning || touchPrimaryPointer()) return undefined;
    const timer = window.setTimeout(() => {
      if (document.activeElement?.classList.contains("session-header-title-input")) return;
      textarea.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest, transitioning]);
  // First-paint focus (user): the app boot surface must land with the caret
  // already in the composer so typing works immediately. Mount-only — later
  // focus moves belong to the focusRequest/transition effects above, and an
  // element the user already focused is never stolen from.
  useEffect(() => {
    if (touchPrimaryPointer()) return undefined;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const typing = active instanceof HTMLElement
        && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable);
      if (typing) return;
      textarea.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only by design
  }, []);

  useEffect(() => setSlashIndex(0), [slashQuery]);
  useEffect(() => setMentionIndex(0), [mentionMatch?.query]);
  useEffect(() => {
    if (!mentionOpen || !mentionMatch) {
      mentionSearchGeneration.current += 1;
      setMentionResults([]);
      setMentionLoading(false);
      return;
    }
    const generation = ++mentionSearchGeneration.current;
    setMentionResults([]);
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      void window.mixdogDesktop.searchProjectFiles(projectScope, mentionMatch.query, 20)
        .then((paths) => {
          if (mentionSearchGeneration.current !== generation) return;
          setMentionResults(paths);
          setMentionLoading(false);
        })
        .catch(() => {
          if (mentionSearchGeneration.current !== generation) return;
          setMentionResults([]);
          setMentionLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      if (mentionSearchGeneration.current === generation) mentionSearchGeneration.current += 1;
    };
  }, [mentionMatch?.end, mentionMatch?.query, mentionMatch?.start, mentionOpen, projectScope]);
  useEffect(() => {
    if (!slashOpen) return;
    slashPalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [slashIndex, slashOpen, slashQuery]);
  useEffect(() => {
    if (!selectorOpen) return;
    messagePalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectorIndex, selectorOpen]);
  useEffect(() => {
    if (!mentionOpen) return;
    mentionPalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [mentionIndex, mentionOpen, mentionResults]);
  useEffect(() => {
    const receiveDraft = (event: Event) => {
      const text = String((event as CustomEvent<unknown>).detail || '');
      if (!text) return;
      setDraft((current) => {
        const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`;
        draftRef.current = next;
        return next;
      });
      historyNavigation.current = { index: -1, seed: '' };
      window.setTimeout(() => textarea.current?.focus(), 0);
    };
    window.addEventListener('mixdog:composer-draft', receiveDraft);
    return () => window.removeEventListener('mixdog:composer-draft', receiveDraft);
  }, []);

  const invokeCapability = useCallback(async <T,>(capability: DesktopCapability, args: unknown[] = []) => {
    // Every command this composer issues belongs to the session IT paints —
    // the queue ×/Edit, /clear, /compact. Focus decides nothing.
    const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<T>({
      capability,
      args,
      ...(sessionId ? { sessionId } : {}),
    }));
    if (result?.snapshot !== undefined) applySnapshot(result.snapshot);
    return result?.value;
  }, [applySnapshot, invokeResult, sessionId]);
  const {
    restoring,
    setRestoring,
    pendingSubmissionId,
    visibleQueued,
    hasRestorableQueuedMessages,
    restoreQueue,
    discardQueued,
    steerQueuedNow,
  } = useComposerQueue({
    queued,
    hiddenQueueIds,
    pendingSubmissionIds,
    draftMode,
    turnBusy,
    draftRef,
    setDraft,
    textarea,
    composingRef,
    historyNavigation,
    invokeCapability,
    abort,
    restoredAttachments,
    mergeRestoredAttachments,
    showNotice: showComposerNotice,
    onQueuedRestored,
    scope: historyScope,
  });

  // Rewindable prompts, oldest → newest (the newest row is preselected).
  const selectableMessages = Array.isArray(userMessages) ? userMessages : [];
  const openMessageSelector = () => {
    if (selectableMessages.length === 0) {
      showComposerNotice(t("No message to jump back to."));
      return;
    }
    setSelectorIndex(selectableMessages.length - 1);
    setSelectorOpen(true);
  };
  // Selecting a row drops the conversation from that prompt onward (engine
  // side) and returns its text for editing — the "restore
  // conversation".
  const rewindToMessage = async (messageId: string) => {
    if (!messageId || restoring) return;
    setSelectorOpen(false);
    setRestoring(true);
    try {
      const value = asRecord(await invokeCapability<RecordValue>('rewindToItem', [messageId]));
      const text = String(value?.text || '');
      if (!text) {
        showComposerNotice(t("Could not restore that message."));
        return;
      }
      historyNavigation.current = { index: -1, seed: '' };
      setDraft(text);
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(text.length, text.length);
      }, 0);
    } finally {
      setRestoring(false);
    }
  };

  const executeSlash = async (raw: string): Promise<boolean> => {
    let invocationFailed = false;
    const commandCapability = async <T,>(capability: DesktopCapability, args: unknown[] = []) => {
      if (draftMode && capability === 'setEffort' && onDraftModelSelection && provider && model) {
        onDraftModelSelection({
          provider,
          model,
          effort: String(args[0] || effort),
          ...(fastCapable ? { fast } : {}),
          ...(modelParameters && Object.keys(modelParameters).length ? { modelParameters } : {}),
        });
        return String(args[0] || effort) as T;
      }
      if (draftMode && capability !== 'listPresets' && capability !== 'getUsageDashboard') {
        setAttachmentError('Start the task with a message before running this command.');
        invocationFailed = true;
        return undefined;
      }
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<T>({
        capability,
        args,
        ...(sessionId ? { sessionId } : {}),
      }));
      if (result === undefined) {
        invocationFailed = true;
        return undefined;
      }
      if (result.snapshot !== undefined) applySnapshot(result.snapshot);
      return result.value;
    };
    const [token, ...tail] = raw.trim().slice(1).split(/\s+/);
    const rawName = token.toLowerCase();
    const argument = tail.join(' ').trim();
    const command = resolveDesktopSlashCommand(rawName);
    if (!command) {
      setAttachmentError(`Unknown command: /${rawName}`);
      return false;
    }
    const name = command.name;
    setAttachmentError('');
    setComposerNotice('');
    if (turnBusy && TURN_LOCKED_SLASH_COMMANDS.has(name)) {
      setAttachmentError(`Wait for the current turn to finish before /${rawName}.`);
      return false;
    }
    if (rawName === 'new' || name === 'clear') {
      // A session pane's /new and /clear close THIS session tab and open a
      // New Task in its place (settings inherited). Outside a session pane
      // the old routes remain: /new opens a draft, /clear clears the engine.
      if (!draftMode && sessionId && onClearToNewTask) onClearToNewTask();
      else if (rawName === 'new') onNewTask();
      else await commandCapability('clear');
    }
    else if (name === 'project') onOpenProjects();
    else if (name === 'resume') argument ? onResumeSession(argument) : onOpenSessions();
    else if (name === 'compact') await commandCapability('compact');
    else if (name === 'goal') {
      if (draftMode) {
        if (!argument) {
          setAttachmentError('Usage: /goal <objective> [--time 1h]');
          return false;
        }
        const accepted = await submit(argument, {
          displayText: argument,
          goalCommand: argument,
        });
        if (accepted !== true) return false;
      } else {
        const result = asRecord(await commandCapability<unknown>('goalControl', [{ command: argument }]));
        if (!invocationFailed) showComposerNotice(String(result?.message || 'Goal updated.'));
      }
    }
    else if (name === 'doctor') onOpenCommandSurface('doctor');
    else if (name === 'settings') onOpenSettings();
    // Desktop /quit leaves THIS task, not the app (user): it rides the same
    // close path as Ctrl+W, so unsaved-close guards and group collapse apply.
    // Explicit app quit stays in the File menu.
    else if (command.action === 'close-task') {
      window.dispatchEvent(new CustomEvent('mixdog:close-active-tab'));
    }
    else if (name === 'autoclear' && argument) {
      const value = argument.toLowerCase();
      const next = await commandCapability<unknown>(
        value === 'status' || value === 'current' || value === 'show' ? 'getAutoClear' : 'setAutoClear',
        value === 'status' || value === 'current' || value === 'show'
          ? []
          : [{ ...(value === 'on' || value === 'enable' || value === 'enabled'
            ? { enabled: true }
            : value === 'off' || value === 'disable' || value === 'disabled'
              ? { enabled: false }
              : { duration: value }) }],
      );
      const status = asRecord(next);
      if (!invocationFailed) {
        showComposerNotice(`Auto-clear ${status?.enabled ? 'on' : 'off'}${status?.idleMs
          ? ` · idle ${status.idleMs}ms`
          : ''}`);
      }
    } else if (name === 'outputstyle' && argument) {
      const statusOnly = ['status', 'current', 'show'].includes(argument.toLowerCase());
      const value = await commandCapability<unknown>(statusOnly ? 'getOutputStyle' : 'setOutputStyle',
        statusOnly ? [] : [argument]);
      if (!invocationFailed) {
        const result = asRecord(value);
        const current = asRecord(result?.current);
        showComposerNotice(`Output style: ${String(current?.label || current?.id ||
          result?.configured || result?.label || result?.id || argument)}`);
      }
    } else if (name === 'theme' && argument) {
      const statusOnly = ['status', 'current', 'show'].includes(argument.toLowerCase());
      const value = await commandCapability<unknown>(statusOnly ? 'getTheme' : 'setTheme',
        statusOnly ? [] : [argument, { persist: true }]);
      if (!invocationFailed) {
        const result = asRecord(value);
        showComposerNotice(`Theme: ${String(result?.label || result?.id || value || argument)}`);
      }
    } else if (name === 'effort' && argument) {
      const next = await commandCapability<unknown>('setEffort', [argument]);
      if (!invocationFailed) showComposerNotice(`Effort set to ${String(next || argument)}`);
    } else if (name === 'fast') {
      const value = argument.toLowerCase();
      const nextFast = value
        ? ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value)
          ? true
          : ['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value)
            ? false
            : null
        : !fast;
      if (nextFast === null) {
        setAttachmentError('Usage: /fast [on|off]');
        return false;
      }
      if (draftMode && onDraftModelSelection && provider && model) {
        onDraftModelSelection({
          provider, model, effort, fast: nextFast,
          ...(modelParameters && Object.keys(modelParameters).length ? { modelParameters } : {}),
        });
      } else {
        const next = await invokeResult(() => window.mixdogDesktop.setFast(nextFast, sessionId || undefined));
        if (next === undefined) return false;
        applySnapshot(next);
        if (provider && model) {
          onRoutePreferenceApplied?.({
            provider, model, effort, fast: nextFast,
            ...(modelParameters && Object.keys(modelParameters).length ? { modelParameters } : {}),
          });
        }
      }
      showComposerNotice(`Fast mode ${nextFast ? 'on' : 'off'}`);
    } else if (name === 'model' && argument) {
      if (argument.toLowerCase() === 'refresh') {
        const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ quick: false }));
        if (models === undefined) return false;
        onOpenSettings('model');
        return true;
      }
      const presetValue = await commandCapability<unknown>('listPresets');
      const presetSource = Array.isArray(presetValue)
        ? presetValue
        : (Array.isArray(asRecord(presetValue)?.presets) ? asRecord(presetValue)?.presets as unknown[] : []);
      const preset = presetSource.map(asRecord).find((entry) => entry && (
        String(entry.id || '').toLowerCase() === argument.toLowerCase() ||
        String(entry.name || '').toLowerCase() === argument.toLowerCase()));
      if (preset) {
        await commandCapability('setModel', [preset.id || preset.name]);
        if (invocationFailed) return false;
        return true;
      }
      const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ quick: false })) || [];
      const normalized = argument.toLowerCase();
      const model = models.find((entry) => `${entry.provider}:${entry.model}`.toLowerCase() === normalized ||
        entry.model.toLowerCase() === normalized || entry.display.toLowerCase() === normalized);
      if (!model) {
        setAttachmentError(`Model not found: ${argument}`);
        return false;
      }
      const selection = {
        provider: model.provider,
        model: model.model,
      };
      if (draftMode && onDraftModelSelection) {
        onDraftModelSelection(selection);
        return true;
      }
      if (!sessionId) return false;
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute(selection, sessionId));
      if (next === undefined) return false;
      applySnapshot(next);
      onRoutePreferenceApplied?.(selection);
    } else if (name === 'model') {
      onOpenSettings('model');
    } else if (name === 'usage') {
      if (['refresh', '--refresh', '-r', 'true'].includes(argument.toLowerCase())) {
        await commandCapability('getUsageDashboard', [{ refresh: true }]);
      }
      onOpenCommandSurface('usage');
    } else if (command.surface) onOpenCommandSurface(command.surface);
    else if (command.settingsRow) onOpenSettings(command.settingsRow);
    if (invocationFailed) return false;
    return true;
  };

  const { send, stop } = useComposerSubmission({
    turnBusy,
    commandBusy,
    draftMode,
    queued,
    recoveryScope,
    textarea,
    draftRef,
    attachmentsRef,
    transitioningRef,
    composingRef,
    submittingRef,
    submissionRetryRef,
    mountedRef,
    historyNavigation,
    setDraft,
    setSubmitting,
    setSubmissionRecoveryVersion,
    clearNotice: () => setComposerNotice(''),
    setAttachmentError,
    removeAttachments,
    mergeRestoredAttachments,
    restoredAttachments,
    executeSlash,
    rememberPrompt,
    submit,
    abort,
    onQueuedRestored,
  });
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void send('', 'form-submit'); };
  const { selectMention, onKeyDown, onKeyUp } = useComposerKeyboard({
    draft: {
      value: draft,
      set: setDraft,
      ref: draftRef,
      textarea,
      setCaretOffset,
    },
    mention: {
      match: mentionMatch,
      open: mentionOpen,
      signature: mentionSignature,
      results: mentionResults,
      index: mentionIndex,
      setIndex: setMentionIndex,
      setDismissed: setMentionDismissed,
      setResults: setMentionResults,
    },
    slash: {
      open: slashOpen,
      commands: slashCommands,
      index: slashIndex,
      setIndex: setSlashIndex,
      setDismissedDraft: setSlashDismissedDraft,
      commandToken: paletteCommandToken,
    },
    selector: {
      open: selectorOpen,
      setOpen: setSelectorOpen,
      index: selectorIndex,
      setIndex: setSelectorIndex,
      messages: selectableMessages,
      openSelector: openMessageSelector,
      rewindToMessage,
    },
    history: {
      entries: history,
      navigation: historyNavigation,
      seedAttachments: historySeedAttachments,
      attachmentsRef,
      replaceAttachments,
    },
    queue: {
      pendingSubmissionId,
      hasRestorableMessages: hasRestorableQueuedMessages,
      restore: (source) => { void restoreQueue('', source); },
    },
    runtime: {
      turnBusy,
      draftMode,
      attachments,
      escapeClearAt: escapeClearAtRef,
      showNotice: showComposerNotice,
    },
    ime: {
      composing: composingRef,
      suppressLineBreak: suppressImeLineBreakRef,
      shiftLatch: shiftLatchRef,
    },
    actions: {
      send,
      stop,
      clearAttachments,
    },
  });
  const stopOnly = shouldStopComposerGeneration({
    turnBusy,
    text: draft,
    attachments,
  });
  // A live take turns the send disc into "finish and send"; a running turn
  // still claims that disc for Stop.
  const voiceSend = !stopOnly && dictationState === 'recording';
  useEffect(() => {
    if (!voiceSubmitPending.current || dictationState !== 'idle') return;
    voiceSubmitPending.current = false;
    void send('', 'voice-submit');
  }, [dictationState, draft, send]);
  return (
    <>
      <QueueList queued={visibleQueued} restoring={restoring}
        onEdit={(id) => void restoreQueue(id, 'queue-row')}
        onSteer={(id) => void steerQueuedNow(id)}
        onRemove={(id) => void discardQueued(id)} />
      {/* Error/notice banners float ABOVE the input card (user-flagged: they
          previously rendered inside the pill and read as composer content). */}
      {(attachmentError) && <p className="composer-error" role="alert">
        <span>{attachmentError}</span>
        <button type="button" className="composer-banner-close" aria-label={t("Dismiss error")}
          onClick={() => setAttachmentError('')}><X size={14} /></button>
      </p>}
      {composerNotice && <p className="composer-notice" role="status">
        <span>{composerNotice}</span>
        <button type="button" className="composer-banner-close" aria-label={t("Dismiss notice")}
          onClick={() => showComposerNotice('')}><X size={14} /></button>
      </p>}
      {draggingFiles && !transitioning && dropTargetRef.current && createPortal(
        <div className="task-drop-overlay" role="status">
          <MxIcon name="photo" size={16} /><span>{t("Drop files or paths")}</span>
        </div>,
        dropTargetRef.current,
      )}
      <form className="composer" onSubmit={onSubmit}
        aria-busy={transitioning} onMouseDown={(event) => {
          if (touchPrimaryPointer()) return;
          const target = event.target as HTMLElement;
          if (!target.closest('button, input, textarea, [role="listbox"]')) textarea.current?.focus();
        }}>
      {selectorOpen && (
        <div ref={messagePalette} id="composer-message-selector"
          className="slash-palette message-selector" role="listbox" aria-label={t("Previous messages")}>
          <header><span>{t("Jump back to a message")}</span></header>
          {selectableMessages.map((message, index) => (
            <button type="button" role="option" aria-selected={index === selectorIndex} key={message.id}
              id={`composer-message-option-${index}`} title={message.text}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelectorIndex(index)}
              onClick={() => { void rewindToMessage(message.id); }}>
              <span>{oneLine(queuedFollowupPreview(message.text), 90)}</span>
            </button>
          ))}
        </div>
      )}
      {slashOpen && (
        <div ref={slashPalette} id="composer-slash-palette" className="slash-palette" role="listbox" aria-label={t("Slash commands")}>
          <header><Command size={14} /><span>{t("Commands")}</span></header>
          {slashCommands.length ? slashCommands.map((command, index) => (
            <button type="button" role="option" aria-selected={index === slashIndex} key={command.name}
              id={`composer-slash-option-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => { void send(`/${paletteCommandToken(command)}`, 'slash-click'); }}>
              <code>{command.usage || `/${command.name}`}{command.params ? ` ${command.params}` : ''}</code>
              <span>{desktopSlashCommandDescription(command)}</span>
            </button>
          )) : <p>{t("No matching command.")}</p>}
        </div>
      )}
      {mentionOpen && (
        <div ref={mentionPalette} id="composer-mention-palette"
          className="slash-palette mention-palette" role="listbox" aria-label={t("Project files")}>
          <header><MxIcon name="open-file" size={14} /><span>{t("Files")}</span></header>
          {mentionResults.length ? mentionResults.map((path, index) => {
            const separator = path.lastIndexOf('/');
            const directory = separator >= 0 ? path.slice(0, separator + 1) : '';
            const filename = separator >= 0 ? path.slice(separator + 1) : path;
            return (
              <button type="button" role="option" aria-selected={index === mentionIndex} key={path}
                id={`composer-mention-option-${index}`} title={path}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => selectMention(path)}>
                <MxIcon name="open-file" size={14} />
                <span className="mention-path"><span>{directory}</span><strong>{filename}</strong></span>
              </button>
            );
          }) : <p role="status">{mentionLoading ? t('Searching project files…') : t('No matching files.')}</p>}
        </div>
      )}
      {attachments.length > 0 && <div className="composer-attachments" aria-label={t("Attachments")}>
        {attachments.map((attachment) => <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
          {attachment.kind === 'image'
            ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
            : <span><MxIcon name="open-file" size={16} /></span>}
          <span data-tooltip={attachment.name}>{attachment.name}</span>
          <button type="button" aria-label={t("Remove {{name}}", { name: attachment.name })}
            onClick={() => removeAttachment(attachment)}
            className="attachment-remove" data-tooltip={t("Remove")}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>)}
      </div>}
      {/* Recording takes over the typing surface, never the footer: the stop
          and send discs below stay reachable, and the draft underneath is
          untouched until the transcript is appended to it. */}
      {dictationState !== 'idle' && <div className="composer-dictation-overlay" data-state={dictationState}>
        <div className="composer-dictation-status" data-state={dictationState}>
          {dictationState === 'recording' ? <>
            <DictationMeter levelRef={dictationLevelRef} />
            {/* No live region on the timer: a polite announcement twice a second
                would talk over everything else. The mic button's label carries
                the state instead. */}
            <span className="composer-dictation-elapsed">{formatDictationElapsed(recordingElapsedMs)}</span>
            <button type="button" className="composer-dictation-cancel"
              aria-label={t("Discard recording")} data-tooltip={t("Discard · Esc")} data-tooltip-side="top"
              onClick={() => cancelDictation()}>
              <X size={14} aria-hidden="true" />
            </button>
          </> : <>
            <DictationProgress />
            <span className="composer-dictation-elapsed" role="status">{t("Transcribing…")}</span>
          </>}
        </div>
      </div>}
      <textarea ref={textarea} value={draft} onChange={(event) => {
        // Perf diagnostics (MIXDOG_DESKTOP_PERF=1): keystroke→paint latency,
        // logged only when a frame is actually slow.
        if (window.mixdogDesktop?.perfLog && !composerPaintSamplePending.current) {
          composerPaintSamplePending.current = true;
          const inputAt = performance.now();
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            composerPaintSamplePending.current = false;
            const ms = performance.now() - inputAt;
            if (ms >= 25) window.mixdogDesktop?.perfLog?.(`composer-keystroke paint=${ms.toFixed(0)}ms`);
          }));
        }
        const value = event.currentTarget.value;
        draftRef.current = value;
        setDraft(value);
        escapeClearAtRef.current = 0;
        if (attachmentError) setAttachmentError('');
        if (composerNotice) setComposerNotice('');
        setCaretOffset(event.currentTarget.selectionStart);
        if (slashDismissedDraft) setSlashDismissedDraft('');
        if (mentionDismissed) setMentionDismissed('');
        historyNavigation.current = { index: -1, seed: '' };
      }} onFocus={() => setComposerFocused(true)} onBlur={() => {
        composingRef.current = false;
        suppressImeLineBreakRef.current = false;
        shiftLatchRef.current = false;
        setComposerFocused(false);
      }}
        onPointerDown={() => { escapeClearAtRef.current = 0; }}
        onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)} onKeyDown={onKeyDown} onKeyUp={onKeyUp}
        onPaste={(event) => {
          const itemFiles = Array.from(event.clipboardData.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files);
          if (files.length) {
            event.preventDefault();
            void attachFiles(files);
            return;
          }
          const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
          if (shouldFoldPastedText(text)) {
            const id = attachmentSequence.current++;
            const lines = pastedTextLineCount(text);
            const inserted = insertAttachment({
              id, name: `Pasted text · ${lines} lines`, kind: 'text', mimeType: 'text/plain', data: text,
              token: `[Pasted text #${id} +${lines} lines]`, source: 'paste', chipOnly: true,
            });
            if (inserted) event.preventDefault();
          }
        }}
        rows={1} placeholder={placeholder}
        disabled={transitioning}
        aria-controls={mentionOpen ? 'composer-mention-palette' : slashOpen ? 'composer-slash-palette' : undefined}
        aria-expanded={mentionOpen || slashOpen}
        aria-activedescendant={mentionOpen && mentionResults.length
          ? `composer-mention-option-${mentionIndex}`
          : slashOpen && slashCommands.length ? `composer-slash-option-${slashIndex}` : undefined}
        aria-label={t("Message Mixdog")} />
      <div className="composer-footer">
        <input ref={fileInput} type="file" hidden multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.md,.mdx,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.cc,.c,.h,.hh,.hpp,.sh,.zsh,.ps1,.bat,.cmd,.sql,.css,.scss,.sass,.html,.htm,.vue,.svelte,.env,.ini,.conf,.cfg,.gql,.graphql"
          onChange={(event) => { if (event.currentTarget.files) void attachFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
        <button type="button" className="composer-tool" disabled={transitioning} aria-label={t("Attach files")} data-tooltip={t("Attach images, PDFs, or text files")} data-tooltip-side="top"
        onClick={() => fileInput.current?.click()}><MxIcon name="plus" size={16} /></button>
        <ModelSelector provider={provider} model={model} effort={effort} fast={fast} fastCapable={fastCapable}
          modelParameters={modelParameters}
          contextPercent={contextPercent}
          sessionId={sessionId}
          modelDisabled={commandBusy || transitioning}
          // Effort/Fast stay live during a turn: the running turn already
          // captured its own effort/fast at turn start, so a change here lands
          // on the NEXT turn instead of being locked out. Only session-command
          // churn still disables the controls.
          tuningDisabled={commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot}
          onOpenSettings={onOpenSettings} onDraftSelection={onDraftModelSelection}
          onRoutePreferenceApplied={onRoutePreferenceApplied} />
        {/* The mic appears only once the voice runtime is installed
            (Extensions → Voice transcription): an uninstalled feature never
            advertises itself in the composer. */}
        {dictationInstalled && <button type="button"
          className={`composer-tool composer-mic ${dictationState !== 'idle' ? `is-${dictationState}` : ''}`.trim()}
          disabled={transitioning || dictationState === 'transcribing'}
          aria-label={dictationState === 'recording' ? t('Stop dictation') : t('Dictate with voice')}
          aria-pressed={dictationState === 'recording'}
          data-tooltip={dictationState === 'recording' ? t('Stop and transcribe · Enter')
            : dictationState === 'transcribing' ? t('Transcribing…') : t('Dictate')}
          data-tooltip-side="top"
          onClick={() => void toggleDictation()}>
          {/* Recording swaps the glyph for the stop square: the disc alone
              never said that pressing it ENDS the take. */}
          {dictationState === 'transcribing' ? <ProgressSpinner className="composer-mic-spinner" size={16} />
            : dictationState === 'recording' ? <MxIcon name="stop" size={16} />
              : <Mic size={16} />}
        </button>}
        {/* Mid-take the disc ENDS the take and sends what was spoken, instead
            of sitting disabled: the transcript still only reaches the draft
            after the recorder stops, so this press chains stop → transcribe →
            submit. Transcribing keeps it disabled — that take is already on
            its way. */}
        <button type={stopOnly || voiceSend ? "button" : "submit"}
          className={`send-button${stopOnly ? " stop" : ""}`}
          onClick={stopOnly ? () => void stop()
            : voiceSend ? () => stopDictationAndSend()
              : undefined}
          disabled={stopOnly || voiceSend ? false
            : (!draft.trim() && !attachments.some((attachment) => !attachment.token || attachment.chipOnly === true))
              || (submitting && Boolean(draftMode)) || transitioning || dictationState !== 'idle'}
          aria-label={stopOnly ? t("Stop generation")
            : voiceSend ? t("Stop dictation and send")
              : submitting ? (hasConversation ? t("Sending message") : t("Starting session"))
                : turnBusy ? t("Queue or steer active turn")
                  : commandBusy ? t("Queue after current command") : t("Send message")}
          data-tooltip={stopOnly ? t("Stop")
            : voiceSend ? t("Stop and send")
              : turnBusy ? t("Queue or steer · Enter")
                : commandBusy ? t("Queue after command · Enter") : t("Send · Enter")}
          data-tooltip-side="top">
          {stopOnly
            ? <MxIcon name="stop" size={16} />
            : submitting
              ? <ProgressSpinner className="composer-mic-spinner" size={16} />
              : <ArrowUp size={16} />}
        </button>
      </div>
      </form>
    </>
  );
});

// The terminal picker's normalizeModelOptions is the authority for WHICH
// models surface (family grouping/limits, recency ordering). The desktop
// modal only owns presentation. Shapes differ: desktop uses `model`, the
// TUI uses `id`.
// @ts-ignore -- shared TUI source has no declaration file.

export { ModelSelector, WorkflowSelect, providerSetupEntries, providerSetupState, workflowOptionsCache } from "./model-controls";
