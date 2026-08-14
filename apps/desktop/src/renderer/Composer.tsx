import { ArrowUp, Command, Mic, X } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { DesktopAbortOptions, DesktopCapability, DesktopModelSelection, DesktopPastedText, DesktopPromptAttachment, DesktopPromptContent, DesktopSubmitOptions, SessionSnapshot } from "../shared/contract";
import { type RecordValue } from "./desktop-types";
import {
  absolutePathsForDragPayload,
  dataTransferHasPathPayload,
  localFilesFromPaths,
  readFileDragPayload,
} from "./file-drag";
import { t } from "./i18n";
import { ModelSelector } from "./model-controls";
import { MxIcon } from "./MxIcon";
import { ProgressSpinner } from "./ProgressSpinner";
import {
  hasSendablePromptContent,
  shouldBlockPromptSubmit,
  shouldInterruptPrompt,
  shouldNavigatePromptHistory,
  shouldRestoreInterruptedPrompt,
  shouldStopComposerGeneration,
} from "./renderer-logic.mjs";
import {
  desktopSlashCommandDescription,
  resolveDesktopSlashCommand,
  SLASH_COMMANDS,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection,
} from "./slash-commands";
import { TURN_LOCKED_SLASH_COMMANDS, asRecord, oneLine } from "./text-format";
import { registerImagePreview } from "./transcript-metrics";
import { classifyPromptEscape, PROMPT_ESCAPE_HINT_TIMEOUT_MS } from "../../../../src/tui/components/prompt-input/escape-policy.mjs";
import {
  mergeQueuedRestoreDraft,
  paletteOwnsPromptVerticalArrow,
  queuedRestorePrefix,
  queuedRestoreProjection,
  replaceQueuedRestorePrefix,
} from "../../../../src/tui/components/prompt-input/restore-policy.mjs";


// Project-context pill, attachment budget, prompt history and the queued
// follow-up list live in composer-support.tsx.
import {
  COMPOSER_PLACEHOLDERS,
  MAX_COMPOSER_ATTACHMENTS,
  MAX_PERSISTED_PROMPT_HISTORY,
  MAX_SUBMIT_TEXT_LENGTH,
  PROJECT_CONTEXT_LOCAL,
  PROJECT_CONTEXT_OPEN,
  ProjectContextSelector,
  QueueList,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory,
  type ComposerAttachment,
  type ComposerHistoryEntry,
  writePromptHistory,
} from "./composer-support";
// Attachment budget policy and file -> attachment conversion.
import {
  attachmentFromFile,
  attachmentPolicyError,
  isSupportedComposerImagePath,
} from "./composer-attachments";
export {
  PROJECT_CONTEXT_LOCAL,
  PROJECT_CONTEXT_OPEN,
  ProjectContextSelector,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory
};

let composerSubmissionSequence = 0;

function nextComposerSubmissionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `desktop-submit-${uuid || `${Date.now()}-${++composerSubmissionSequence}`}`;
}

function submissionRetryKey(text: string, attachments: readonly ComposerAttachment[]): string {
  return JSON.stringify([
    text,
    attachments.map((attachment) => String(attachment.id)),
  ]);
}

export const Composer = memo(function Composer({
  turnBusy,
  commandBusy,
  transitioning,
  focusRequest,
  historyScope,
  projectScope,
  sessionId,
  hasConversation,
  promptHistoryList,
  provider,
  model,
  effort,
  fast,
  fastCapable,
  draftMode,
  onDraftModelSelection,
  onFastPreferenceApplied,
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
}: {
  turnBusy: boolean;
  commandBusy: boolean;
  transitioning: boolean;
  focusRequest: number;
  historyScope: string;
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
  draftMode?: boolean;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onFastPreferenceApplied?: (selection: DesktopModelSelection) => void;
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
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  // A failed transport acknowledgement may still have landed in the session.
  // Reuse the same id when the exact restored payload is retried so daemon-side
  // idempotency acknowledges it instead of posting a duplicate user message.
  const submissionRetryRef = useRef<{ key: string; id: string } | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const dictationSession = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    cancelled: boolean;
    stopTimer: number;
  } | null>(null);
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
  useEffect(() => () => window.clearTimeout(composerNoticeTimer.current), []);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [caretOffset, setCaretOffset] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [locallyHiddenQueueIds, setLocallyHiddenQueueIds] = useState<string[]>([]);
  // Esc-Esc message selector (TUI/Claude Code parity): pick a previous prompt,
  // rewind the conversation to it, and edit it in the composer.
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [selectorIndex, setSelectorIndex] = useState(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [persistedHistory, setPersistedHistory] = useState(() => readPromptHistory(historyScope));
  const activeHistoryScope = useRef(historyScope);
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Chromium does not report `KeyboardEvent.isComposing` consistently across
  // every IME event ordering, so keep the explicit composition lifecycle too.
  const composingRef = useRef(false);
  const suppressImeLineBreakRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const escapeClearAtRef = useRef(0);
  const queueRestoreInFlightRef = useRef(false);
  // A daemon response can settle one render before its queue projection does.
  // Snapshot shaping may clone the queue array, so remember its stable entry
  // signature rather than its identity. New queue ids re-arm Esc/Up normally.
  const queuedProjectionKey = Array.isArray(queued)
    ? queued.map((entry, index) => {
      const item = asRecord(entry);
      return String(item?.id ?? `${index}:${item?.text ?? item?.displayText ?? ''}`);
    }).join('\n')
    : '';
  useEffect(() => {
    const liveIds = new Set((Array.isArray(queued) ? queued : [])
      .map((entry) => asRecord(entry)?.id)
      .filter((id) => id !== undefined && id !== null)
      .map(String));
    setLocallyHiddenQueueIds((current) => {
      const next = current.filter((id) => liveIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [queuedProjectionKey]);
  const restoredQueueProjectionRef = useRef('');
  const hasRestorableQueuedMessages = () => Boolean(queuedProjectionKey)
    && restoredQueueProjectionRef.current !== queuedProjectionKey;
  const pendingSubmissionId = !draftMode && Array.isArray(pendingSubmissionIds)
    ? String(pendingSubmissionIds[pendingSubmissionIds.length - 1] || '').trim()
    : '';
  const slashPalette = useRef<HTMLDivElement>(null);
  const messagePalette = useRef<HTMLDivElement>(null);
  const mentionPalette = useRef<HTMLDivElement>(null);
  const mentionSearchGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentSequence = useRef(1);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepth = useRef(0);
  const composerPaintSamplePending = useRef(false);
  const transitioningRef = useRef(transitioning);
  transitioningRef.current = transitioning;
  const wasTransitioning = useRef(transitioning);
  const historyNavigation = useRef({ index: -1, seed: '' });
  const historySeedAttachments = useRef<ComposerAttachment[]>([]);
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
    activeHistoryScope.current = historyScope;
    attachmentsRef.current = [];
    dragDepth.current = 0;
    composingRef.current = false;
    suppressImeLineBreakRef.current = false;
    mentionSearchGeneration.current += 1;
    // Scope settles ASYNC after a session switch/promotion; when the user is
    // ALREADY typing in the composer, the in-flight text carries over instead
    // of being wiped (user bug: draft vanished + scroll jumped mid-sentence).
    const typingLive = document.activeElement === textarea.current;
    setDraft((current) => (typingLive && current.trim() ? current : ''));
    setAttachments([]);
    setAttachmentError('');
    setComposerNotice('');
    setSlashIndex(0);
    setSlashDismissedDraft('');
    setComposerFocused(false);
    setCaretOffset(0);
    setMentionIndex(0);
    setMentionResults([]);
    setMentionLoading(false);
    setMentionDismissed('');
    queueRestoreInFlightRef.current = false;
    setRestoring(false);
    setDraggingFiles(false);
    setSelectorOpen(false);
    setSelectorIndex(0);
    setPersistedHistory(readPromptHistory(historyScope));
    historyNavigation.current = { index: -1, seed: '' };
  }, [historyScope]);
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
    dragDepth.current = 0;
    setDraggingFiles(false);
  }, [transitioning]);
  useEffect(() => {
    if (wasTransitioning.current && !transitioning) {
      window.setTimeout(() => {
        if (document.activeElement?.classList.contains("session-header-title-input")) return;
        textarea.current?.focus({ preventScroll: true });
      }, 0);
    }
    wasTransitioning.current = transitioning;
  }, [transitioning]);
  useEffect(() => {
    if (focusRequest <= 0 || transitioning) return undefined;
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
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
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

  const insertAttachment = useCallback((attachment: ComposerAttachment) => {
    const currentAttachments = attachmentsRef.current;
    const policyError = attachmentPolicyError(currentAttachments, attachment);
    if (policyError) {
      setAttachmentError(policyError);
      return false;
    }
    const nextAttachments = [...currentAttachments, attachment];
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
    const element = textarea.current;
    // Chip-only attachments (images, pasted text) keep the draft untouched:
    // the chip is their sole editor representation (user: pasting left a
    // redundant "[Image #N]" / "[Pasted text #N]" token in the input).
    if (!attachment.token || attachment.chipOnly === true) {
      window.setTimeout(() => { textarea.current?.focus(); }, 0);
      historyNavigation.current = { index: -1, seed: '' };
      return true;
    }
    setDraft((current) => {
      const rawStart = element?.selectionStart ?? current.length;
      const rawEnd = element?.selectionEnd ?? rawStart;
      const start = Math.max(0, Math.min(rawStart, current.length));
      const end = Math.max(start, Math.min(rawEnd, current.length));
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leading = before && !/\s$/.test(before) ? ' ' : '';
      const trailing = after && !/^\s/.test(after) ? ' ' : ' ';
      const inserted = `${leading}${attachment.token}${trailing}`;
      const caret = before.length + inserted.length;
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      const next = `${before}${inserted}${after}`;
      draftRef.current = next;
      return next;
    });
    historyNavigation.current = { index: -1, seed: '' };
    return true;
  }, []);
  const clearAttachments = useCallback(() => {
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);
  const removeAttachments = useCallback((ids: Set<number>) => {
    if (ids.size === 0) return;
    const next = attachmentsRef.current.filter((attachment) => !ids.has(attachment.id));
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    if (transitioningRef.current) return;
    setAttachmentError('');
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachmentsRef.current.length);
    if (available === 0) {
      setAttachmentError(`Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`);
      return;
    }
    const incoming = Array.from(files);
    if (incoming.length > available) {
      setAttachmentError(`Only the first ${available} item${available === 1 ? '' : 's'} fit; remove an attachment to add more.`);
    }
    for (const file of incoming.slice(0, available)) {
      if (transitioningRef.current) return;
      try {
        // A null attachment means the session moved on mid-read; the whole
        // remaining batch belongs to a draft that no longer exists.
        const attachment = await attachmentFromFile(file, {
          id: attachmentSequence.current++,
          cancelled: () => transitioningRef.current,
        });
        if (!attachment) return;
        insertAttachment(attachment);
      } catch (reason) {
        setAttachmentError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [insertAttachment]);

  const insertProjectMentions = useCallback((paths: string[]) => {
    const mentions = paths
      .map((path) => path.replace(/\\/g, '/').replace(/^\/+/, '').trim())
      .filter((path) => path && !path.split('/').includes('..') && !/^[a-z]:/i.test(path))
      .map((path) => `@${path}`);
    if (!mentions.length) return;
    const element = textarea.current;
    setDraft((current) => {
      const rawStart = element?.selectionStart ?? current.length;
      const rawEnd = element?.selectionEnd ?? rawStart;
      const start = Math.max(0, Math.min(rawStart, current.length));
      const end = Math.max(start, Math.min(rawEnd, current.length));
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leading = before && !/\s$/.test(before) ? ' ' : '';
      const trailing = after && !/^\s/.test(after) ? ' ' : ' ';
      const inserted = `${leading}${mentions.join(' ')}${trailing}`;
      const next = `${before}${inserted}${after}`;
      const caret = before.length + inserted.length;
      draftRef.current = next;
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      return next;
    });
    historyNavigation.current = { index: -1, seed: '' };
  }, []);
  const insertAbsolutePaths = useCallback((paths: string[]) => {
    const tokens = paths
      .map((path) => String(path || "").trim())
      .filter(Boolean)
      .map((path) => /\s/.test(path) ? `"${path}"` : path);
    if (!tokens.length) return;
    const element = textarea.current;
    setDraft((current) => {
      const rawStart = element?.selectionStart ?? current.length;
      const rawEnd = element?.selectionEnd ?? rawStart;
      const start = Math.max(0, Math.min(rawStart, current.length));
      const end = Math.max(start, Math.min(rawEnd, current.length));
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leading = before && !/\s$/.test(before) ? ' ' : '';
      const trailing = after && !/^\s/.test(after) ? ' ' : ' ';
      const inserted = `${leading}${tokens.join(' ')}${trailing}`;
      const next = `${before}${inserted}${after}`;
      const caret = before.length + inserted.length;
      draftRef.current = next;
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      return next;
    });
    historyNavigation.current = { index: -1, seed: '' };
  }, []);
  const attachLocalPaths = useCallback(async (paths: string[]) => {
    const loaded = await localFilesFromPaths(window.mixdogDesktop, paths);
    if (loaded.directories.length) {
      insertAbsolutePaths(loaded.directories.map((entry) => entry.absolutePath));
    }
    if (loaded.errors.length) setAttachmentError(loaded.errors[0]);
    if (loaded.files.length) await attachFiles(loaded.files);
  }, [attachFiles, insertAbsolutePaths]);
  const attachProjectPaths = useCallback(async (projectPath: string, paths: string[]) => {
    const imagePaths = paths.filter(isSupportedComposerImagePath);
    insertProjectMentions(paths.filter((path) => !isSupportedComposerImagePath(path)));
    if (!imagePaths.length) return;
    await attachLocalPaths(absolutePathsForDragPayload({
      kind: "project",
      projectPath,
      paths: imagePaths,
    }));
  }, [attachLocalPaths, insertProjectMentions]);

  useEffect(() => {
    const target = dropTargetRef.current;
    if (!target) return;
    const containsType = (event: DragEvent, type: string) =>
      Array.from(event.dataTransfer?.types ?? []).includes(type);
    const containsFiles = (event: DragEvent) => containsType(event, 'Files');
    const containsPaths = (event: DragEvent) => Boolean(
      event.dataTransfer && dataTransferHasPathPayload(event.dataTransfer),
    );
    const containsInput = (event: DragEvent) => containsFiles(event) || containsPaths(event);
    const onDragEnter = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (transitioningRef.current) return;
      dragDepth.current += 1;
      setDraggingFiles(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = transitioningRef.current ? 'none' : 'copy';
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (dragDepth.current === 0) return;
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDraggingFiles(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!containsInput(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setDraggingFiles(false);
      if (transitioningRef.current || !event.dataTransfer) return;
      const payload = readFileDragPayload(event.dataTransfer);
      if (payload) {
        if (payload.kind === "project") {
          const source = payload.projectPath.replace(/[\\/]+/g, '/').toLocaleLowerCase();
          const targetProject = projectScope.replace(/[\\/]+/g, '/').toLocaleLowerCase();
          if (source && targetProject && source === targetProject) {
            void attachProjectPaths(payload.projectPath, payload.paths);
            return;
          }
        }
        void attachLocalPaths(absolutePathsForDragPayload(payload));
        return;
      }
      const itemFiles = Array.from(event.dataTransfer.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      void attachFiles(itemFiles.length ? itemFiles : event.dataTransfer.files);
    };
    target.addEventListener('dragenter', onDragEnter);
    target.addEventListener('dragover', onDragOver);
    target.addEventListener('dragleave', onDragLeave);
    target.addEventListener('drop', onDrop);
    return () => {
      target.removeEventListener('dragenter', onDragEnter);
      target.removeEventListener('dragover', onDragOver);
      target.removeEventListener('dragleave', onDragLeave);
      target.removeEventListener('drop', onDrop);
      dragDepth.current = 0;
    };
  }, [attachFiles, attachLocalPaths, attachProjectPaths, dropTargetRef, projectScope]);

  // Push-to-talk dictation: record locally, transcribe through the engine's
  // managed whisper.cpp runtime, and append the transcript to the draft.
  const toggleDictation = useCallback(async () => {
    if (dictationState === 'transcribing' || transitioningRef.current) return;
    const active = dictationSession.current;
    if (active) {
      try { active.recorder.stop(); } catch { /* recorder already stopped */ }
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((device) => device.kind === 'audioinput')) {
        showComposerNotice('No microphone was detected. Connect one and try again.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const session = { recorder, stream, chunks: [] as Blob[], cancelled: false, stopTimer: 0 };
      dictationSession.current = session;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstop = () => {
        void (async () => {
          window.clearTimeout(session.stopTimer);
          dictationSession.current = null;
          for (const track of session.stream.getTracks()) track.stop();
          if (session.cancelled || session.chunks.length === 0) {
            setDictationState('idle');
            return;
          }
          setDictationState('transcribing');
          try {
            const blob = new Blob(session.chunks, { type: recorder.mimeType || 'audio/webm' });
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error || new Error('Recorded audio could not be read.'));
              reader.onload = () => resolve(String(reader.result || ''));
              reader.readAsDataURL(blob);
            });
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
              capability: 'transcribeAudio',
              args: [{ data: base64, mimeType: blob.type }],
            }));
            const text = String(result?.value ?? '').trim();
            if (text) {
              setDraft((current) => current
                ? `${current}${/\s$/.test(current) ? '' : ' '}${text}`
                : text);
              window.setTimeout(() => textarea.current?.focus(), 0);
            }
          } finally {
            setDictationState('idle');
          }
        })();
      };
      recorder.start();
      // Dictation is sentence-scale; bound runaway recordings.
      session.stopTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* already stopped */ }
      }, 120_000);
      setDictationState('recording');
    } catch (reason) {
      // Raw DOMException names ("NotAllowedError") read as broken UI; map the
      // three real-world failures to actionable notices (keep the same
      // taxonomy across dictation errors).
      const name = reason instanceof DOMException ? reason.name : '';
      showComposerNotice(name === 'NotAllowedError'
        ? ((window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer
          ? 'Microphone access is blocked. Allow microphone access for this site in your browser settings and reload.'
          : 'Microphone access is blocked. Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.')
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'No microphone was detected. Connect one and try again.'
          : name === 'NotReadableError'
            ? 'The microphone is busy in another app. Close it and try again.'
            : reason instanceof Error ? reason.message : String(reason));
      setDictationState('idle');
    }
  }, [dictationState, invokeResult, showComposerNotice]);
  useEffect(() => () => {
    const session = dictationSession.current;
    if (!session) return;
    session.cancelled = true;
    try { session.recorder.stop(); } catch { /* teardown */ }
    for (const track of session.stream.getTracks()) track.stop();
  }, []);

  const restoredAttachments = useCallback((value: RecordValue, restoredText: string): {
    attachments: ComposerAttachment[];
    text: string;
  } => {
    const restored: ComposerAttachment[] = [];
    const reserved = new Set(attachmentsRef.current.map((attachment) => attachment.id));
    let textValue = restoredText;
    const uniqueId = (rawId: number) => {
      let id = rawId > 0 ? rawId : attachmentSequence.current;
      while (reserved.has(id)) id = Math.max(id + 1, attachmentSequence.current++);
      reserved.add(id);
      attachmentSequence.current = Math.max(attachmentSequence.current, id + 1);
      return id;
    };
    for (const [key, raw] of Object.entries(asRecord(value.pastedImages) || {})) {
      const image = asRecord(raw);
      if (!image || typeof image.content !== 'string') continue;
      const rawId = Number(image.id || key) || 0;
      const name = String(image.filename || `Image ${rawId || attachmentSequence.current}`);
      const namedToken = `[Image #${rawId}: ${name}]`;
      const plainToken = `[Image #${rawId}]`;
      const sourceToken = textValue.includes(namedToken) ? namedToken : textValue.includes(plainToken) ? plainToken : '';
      // Images restore as chip-only attachments (empty token). A legacy
      // bracket token in restored text is stripped rather than re-inserted.
      if (sourceToken) {
        textValue = textValue.replace(sourceToken, ' ').replace(/ {2,}/g, ' ')
          .split('\n').map((line) => line.trim()).join('\n').trim();
      }
      restored.push({ id: uniqueId(rawId), name, kind: 'image', mimeType: String(image.mediaType || 'image/png'),
        data: image.content, token: '',
        ...(typeof image.metadataText === 'string' && image.metadataText
          ? { metadataText: image.metadataText }
          : {}) });
    }
    for (const [key, raw] of Object.entries(asRecord(value.pastedTexts) || {})) {
      const text = asRecord(raw);
      if (!text || typeof text.text !== 'string') continue;
      const rawId = Number(text.id || key) || 0;
      const pastedMatch = textValue.match(new RegExp(`\\[Pasted text #${rawId}(?: \\+\\d+ lines)?\\]`));
      const fileMatch = textValue.match(new RegExp(`\\[File #${rawId}(?:: [^\\]\\r\\n]+)?\\]`));
      const source = text.source === 'file' || (!pastedMatch && Boolean(fileMatch)) ? 'file' : 'paste';
      const match = source === 'file' ? fileMatch : pastedMatch;
      if (!match) continue;
      const id = uniqueId(rawId);
      const token = id === rawId ? match[0] : match[0].replace(`#${rawId}`, `#${id}`);
      if (token !== match[0]) textValue = textValue.replace(match[0], token);
      restored.push({
        id,
        name: String(text.filename || (source === 'file' ? `File ${id}` : `Pasted text ${id}`)),
        kind: 'text',
        mimeType: String(text.mimeType || 'text/plain'),
        data: text.text,
        token,
        source,
      });
    }
    return { attachments: restored, text: textValue };
  }, []);

  const mergeRestoredAttachments = useCallback((restored: ComposerAttachment[], restoredText: string) => {
    if (!restored.length) return restoredText;
    const next = [...attachmentsRef.current];
    let nextText = restoredText;
    let firstError = '';
    for (const attachment of restored) {
      const index = next.findIndex((entry) => entry.id === attachment.id && entry.kind === attachment.kind);
      if (index >= 0) {
        next[index] = attachment;
        continue;
      }
      const policyError = attachmentPolicyError(next, attachment);
      if (policyError) {
        firstError ||= policyError;
        nextText = nextText.replace(attachment.token, '').replace(/ {2,}/g, ' ').trim();
        continue;
      }
      next.push(attachment);
    }
    if (firstError) setAttachmentError(firstError);
    attachmentsRef.current = next;
    setAttachments(next);
    return nextText;
  }, [attachmentPolicyError]);

  const restoreQueue = async (queuedId = '') => {
    if (restoring || queueRestoreInFlightRef.current) return undefined;
    // Capture the projection before the daemon round trip. A newly queued
    // prompt that arrives while restore settles must not be retired with the
    // older entries the user actually reclaimed.
    const projection = queuedRestoreProjection(queued, queuedId);
    const requestedIds = projection.ids;
    const before = {
      value: draftRef.current,
      cursor: textarea.current?.selectionStart ?? draftRef.current.length,
      selectionAnchor: null,
    };
    const optimistic = mergeQueuedRestoreDraft(projection.text, before);
    const optimisticPrefix = queuedRestorePrefix(projection.text, before.value);
    if (requestedIds.length) {
      setLocallyHiddenQueueIds((current) => [
        ...current,
        ...requestedIds.filter((id) => !current.includes(id)),
      ]);
    }
    if (optimisticPrefix) {
      draftRef.current = optimistic.value;
      setDraft(optimistic.value);
      historyNavigation.current = { index: -1, seed: '' };
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(optimistic.cursor, optimistic.cursor);
      }, 0);
    }
    const revealRequested = () => {
      if (!requestedIds.length) return;
      const ids = new Set(requestedIds);
      setLocallyHiddenQueueIds((current) => current.filter((id) => !ids.has(id)));
    };
    const reconcile = (authoritativeText = '') => {
      const current = draftRef.current;
      const currentCursor = textarea.current?.selectionStart ?? current.length;
      const authoritativePrefix = queuedRestorePrefix(authoritativeText, before.value);
      const next = replaceQueuedRestorePrefix(optimisticPrefix, authoritativePrefix, {
        value: current,
        cursor: currentCursor,
        selectionAnchor: null,
      });
      if (!next.replaced) return false;
      draftRef.current = next.value;
      setDraft(next.value);
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(next.cursor, next.cursor);
      }, 0);
      return true;
    };
    queueRestoreInFlightRef.current = true;
    setRestoring(true);
    try {
      const args = queuedId ? ['', queuedId] : [''];
      const value = await invokeCapability<RecordValue>('restoreQueued', args);
      if (!value) {
        reconcile('');
        revealRequested();
        return value;
      }
      const restored = restoredAttachments(value, String(value.text || ''));
      const queuedText = mergeRestoredAttachments(restored.attachments, restored.text);
        // Latch the projection ONLY for a restore that actually popped
        // entries. Marking an empty answer as "already restored" left
        // ArrowUp/Esc permanently disarmed for every queued message that
        // followed (user: 예약 메시지가 위쪽 화살표로 회수되지 않는다).
        const restoredCount = Number(value.count);
        const restoredAnything = Number.isFinite(restoredCount)
          ? restoredCount > 0
          : Boolean(queuedText || restored.attachments.length);
        if (!restoredAnything) {
          reconcile('');
          revealRequested();
          showComposerNotice('No queued messages to restore');
          return value;
        }
        const restoredIds = Array.isArray(value.ids)
          ? value.ids.map(String).filter(Boolean)
          : requestedIds;
        restoredQueueProjectionRef.current = queuedProjectionKey;
        reconcile(queuedText);
        historyNavigation.current = { index: -1, seed: '' };
        // The engine queue is authoritative, but Conversation also holds a
        // local optimistic twin until durable settlement. Retire that twin
        // after a successful pop so it cannot resurrect the reserved row.
        onQueuedRestored?.(restoredIds);
      return value;
    } finally {
      queueRestoreInFlightRef.current = false;
      setRestoring(false);
    }
  };

  // Queue rows: discard a queued follow-up in place. restoreQueued
  // removes the entry from the engine queue; the merged text it returns is
  // intentionally ignored so the current draft is untouched.
  const discardQueued = async (queuedId: string) => {
    if (restoring || queueRestoreInFlightRef.current || !queuedId) return;
    setLocallyHiddenQueueIds((current) =>
      current.includes(queuedId) ? current : [...current, queuedId]);
    queueRestoreInFlightRef.current = true;
    setRestoring(true);
    try {
      const value = await invokeCapability<RecordValue>('restoreQueued', ['', queuedId]);
      if (value === undefined) {
        setLocallyHiddenQueueIds((current) => current.filter((id) => id !== queuedId));
        return;
      }
      const removedIds = Array.isArray(value.ids)
        ? value.ids.map(String).filter(Boolean)
        : [queuedId];
      onQueuedRestored?.(removedIds.length ? removedIds : [queuedId]);
    } finally {
      queueRestoreInFlightRef.current = false;
      setRestoring(false);
    }
  };

  const steerQueuedNow = async (queuedId: string) => {
    if (restoring || queueRestoreInFlightRef.current || !queuedId) return;
    setLocallyHiddenQueueIds((current) =>
      current.includes(queuedId) ? current : [...current, queuedId]);
    queueRestoreInFlightRef.current = true;
    setRestoring(true);
    try {
      const value = await invokeCapability<RecordValue>('prioritizeQueued', [queuedId]);
      if (!value || Number(value.count) < 1) {
        setLocallyHiddenQueueIds((current) => current.filter((id) => id !== queuedId));
        return;
      }
      const promotedIds = Array.isArray(value.ids)
        ? value.ids.map(String).filter(Boolean)
        : [queuedId];
      onQueuedRestored?.(promotedIds.length ? promotedIds : [queuedId]);
      if (turnBusy) await abort({ restorePrompt: false });
    } finally {
      queueRestoreInFlightRef.current = false;
      setRestoring(false);
    }
  };

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
  // side) and returns its text for editing — Claude Code's "restore
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
    else if (name === 'doctor') onOpenCommandSurface('doctor');
    else if (name === 'remote') await commandCapability('claimRemote');
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
        onDraftModelSelection({ provider, model, effort, fast: nextFast });
      } else {
        const next = await invokeResult(() => window.mixdogDesktop.setFast(nextFast, sessionId || undefined));
        if (next === undefined) return false;
        applySnapshot(next);
        if (provider && model) {
          onFastPreferenceApplied?.({ provider, model, effort, fast: nextFast });
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

  const send = async (slashOverride = '') => {
    const submittedDraft = textarea.current?.value ?? draftRef.current;
    const submittedAttachments = [...attachmentsRef.current];
    const text = (slashOverride || submittedDraft).trim();
    const serializedSubmit = Boolean(draftMode || text.startsWith('/'));
    if (!hasSendablePromptContent({ text, attachments: submittedAttachments })
      || transitioningRef.current || shouldBlockPromptSubmit({
      submitting: submittingRef.current,
      draftMode,
      slashCommand: text.startsWith('/'),
    })) return;
    if (serializedSubmit) {
      submittingRef.current = true;
      setSubmitting(true);
    }
    try {
      setComposerNotice('');
      if (text.startsWith('/')) {
        if (commandBusy) {
          setAttachmentError('Wait for the current command to finish. Your command is still in the editor.');
          return;
        }
        setDraft((current) => current === submittedDraft ? '' : current);
        removeAttachments(new Set(submittedAttachments.map((attachment) => attachment.id)));
        historyNavigation.current = { index: -1, seed: '' };
        const accepted = await executeSlash(text);
        if (!accepted) {
          setDraft((current) => current ? current : submittedDraft);
          mergeRestoredAttachments(submittedAttachments, submittedDraft);
        } else {
          rememberPrompt(text);
        }
        return;
      }
      setAttachmentError('');
      // Decoded byte length of a base64 payload. The transcript preview cache
      // is keyed by (id, bytes) and the settled item's bytes come back from
      // the daemon as the decoded buffer length, so this must match exactly.
      const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4)
        - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      // Chip-only pasted text keeps its bracket token out of the editor; the
      // token joins the outgoing text here so the daemon still expands the
      // pasted payload in place and the transcript folds it back into a chip.
      const chipOnlyTextTokens = submittedAttachments
        .filter((attachment) => attachment.chipOnly === true && attachment.token
          && !submittedDraft.includes(attachment.token))
        .map((attachment) => attachment.token);
      const expandedText = chipOnlyTextTokens.length
        ? [submittedDraft.trim(), ...chipOnlyTextTokens].filter(Boolean).join('\n')
        : submittedDraft;
      const used = submittedAttachments.filter((attachment) => expandedText.includes(attachment.token));
      const pastedImages: Record<string, DesktopPromptAttachment> = {};
      const pastedTexts: Record<string, DesktopPastedText> = {};
      for (const attachment of used) {
        if (attachment.kind === 'text') {
          pastedTexts[String(attachment.id)] = {
            id: attachment.id,
            text: attachment.data,
            filename: attachment.name,
            mimeType: attachment.mimeType,
            source: attachment.source || 'file',
          };
        } else if (attachment.kind === 'image') {
          pastedImages[String(attachment.id)] = {
            id: attachment.id,
            type: 'image',
            sizeBytes: base64Bytes(attachment.data),
            mediaType: attachment.mimeType,
            filename: attachment.name,
            ...(attachment.metadataText ? { metadataText: attachment.metadataText } : {}),
          };
        }
      }
      const imageAttachments = used.filter((attachment) => attachment.kind === 'image');
      const pdfAttachments = used.filter((attachment) => attachment.kind === 'pdf');
      // Register byte-free preview sources for the transcript chips this
      // submit will produce. The transcript item itself carries metadata only.
      for (const attachment of imageAttachments) {
        registerImagePreview(attachment.id, base64Bytes(attachment.data),
          `data:${attachment.mimeType};base64,${attachment.data}`);
      }
      if (expandedText.length > MAX_SUBMIT_TEXT_LENGTH) {
        setAttachmentError('This prompt is too large to send. Remove or shorten an inline text attachment.');
        return;
      }
      const content: DesktopPromptContent = imageAttachments.length || pdfAttachments.length
        ? [
          // Image-only submits can now have an empty draft (no bracket token
          // padding the text) — skip the empty text part for provider safety.
          ...(expandedText ? [{ type: 'text' as const, text: expandedText }] : []),
          // TUI parity: each image carries its "[Image: WxH, displayed at …]"
          // metadata text part directly before the image block.
          ...imageAttachments.flatMap((attachment) => [
            ...(attachment.metadataText
              ? [{ type: 'text' as const, text: attachment.metadataText }]
              : []),
            {
              type: 'image' as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            },
          ]),
          ...pdfAttachments.map((attachment) => ({
            type: 'file' as const,
            data: attachment.data,
            mimeType: attachment.mimeType,
            filename: attachment.name,
          })),
        ]
        : expandedText;
      // First-submit session materialization can legitimately take a moment
      // (keychain/core-memory startup). Commit the editor state immediately so
      // Enter never looks ignored; a rejected submit restores the exact draft
      // and attachments without creating a session ahead of user intent.
      const committedAttachments = [...used];
      const retryKey = submissionRetryKey(expandedText, committedAttachments);
      const priorRetry = submissionRetryRef.current;
      const submissionId = priorRetry?.key === retryKey
        ? priorRetry.id
        : nextComposerSubmissionId();
      setDraft((current) => current === submittedDraft ? '' : current);
      removeAttachments(new Set(committedAttachments.map((attachment) => attachment.id)));
      historyNavigation.current = { index: -1, seed: '' };
      const restoreSubmitted = () => {
        const restoredText = mergeRestoredAttachments(committedAttachments, submittedDraft);
        setDraft((current) => {
          if (!current || current === submittedDraft) return restoredText;
          return [restoredText, current].filter(Boolean).join('\n');
        });
      };
      let accepted: unknown;
      try {
        accepted = await submit(content, {
          id: submissionId,
          ...(used.length ? { displayText: expandedText.trim() } : {}),
          ...(Object.keys(pastedImages).length ? { pastedImages } : {}),
          ...(Object.keys(pastedTexts).length ? { pastedTexts } : {}),
        });
      } catch (error) {
        submissionRetryRef.current = { key: retryKey, id: submissionId };
        restoreSubmitted();
        throw error;
      }
      if (accepted === true) {
        if (submissionRetryRef.current?.id === submissionId) submissionRetryRef.current = null;
        rememberPrompt(expandedText, committedAttachments);
      } else {
        submissionRetryRef.current = { key: retryKey, id: submissionId };
        restoreSubmitted();
      }
    } finally {
      if (serializedSubmit) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const insertNewline = (element: HTMLTextAreaElement) => {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setDraft((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
    window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + 1, start + 1);
    }, 0);
  };
  const selectMention = (path: string | undefined) => {
    if (!path || !mentionMatch) return;
    const before = draft.slice(0, mentionMatch.start);
    const after = draft.slice(mentionMatch.end);
    const inserted = `@${path}${after && /^\s/.test(after) ? '' : ' '}`;
    const next = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    setDraft(next);
    setCaretOffset(caret);
    setMentionDismissed('');
    setMentionResults([]);
    historyNavigation.current = { index: -1, seed: '' };
    window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(caret, caret);
    }, 0);
  };
  const navigateMentionPalette = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionOpen) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMentionDismissed(mentionSignature);
      return true;
    }
    if (!mentionResults.length) return false;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !paletteOwnsPromptVerticalArrow(mentionResults.length)) return false;
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention(mentionResults[mentionIndex] || mentionResults[0]);
      return true;
    }
    const last = mentionResults.length - 1;
    const moves: Record<string, (index: number) => number> = {
      ArrowDown: (index) => (index + 1) % mentionResults.length,
      ArrowUp: (index) => (index - 1 + mentionResults.length) % mentionResults.length,
      Home: () => 0,
      End: () => last,
      PageUp: (index) => Math.max(0, index - 8),
      PageDown: (index) => Math.min(last, index + 8),
    };
    const move = moves[event.key];
    if (!move) return false;
    event.preventDefault();
    setMentionIndex(move);
    return true;
  };
  const navigateSlashPalette = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashOpen || slashCommands.length === 0) return false;
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && !paletteOwnsPromptVerticalArrow(slashCommands.length)) return false;
    const last = slashCommands.length - 1;
    if (event.key === 'Tab') {
      event.preventDefault();
      setDraft(`/${paletteCommandToken(slashCommands[slashIndex])} `);
      return true;
    }
    const moves: Record<string, (index: number) => number> = {
      ArrowDown: (index) => (index + 1) % slashCommands.length,
      ArrowRight: (index) => (index + 1) % slashCommands.length,
      ArrowUp: (index) => (index - 1 + slashCommands.length) % slashCommands.length,
      ArrowLeft: (index) => (index - 1 + slashCommands.length) % slashCommands.length,
      Home: () => 0,
      End: () => last,
      PageUp: (index) => Math.max(0, index - slashCommands.length),
      PageDown: (index) => Math.min(last, index + slashCommands.length),
    };
    const move = moves[event.key];
    if (!move) return false;
    event.preventDefault();
    setSlashIndex(move);
    return true;
  };
  const navigateMessageSelector = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!selectorOpen) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setSelectorOpen(false);
      escapeClearAtRef.current = 0;
      return true;
    }
    // Typing is an implicit dismissal: the character still reaches the draft.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      setSelectorOpen(false);
      return false;
    }
    if (selectableMessages.length === 0) return false;
    if (event.key === 'Enter') {
      event.preventDefault();
      void rewindToMessage(selectableMessages[selectorIndex]?.id || '');
      return true;
    }
    const last = selectableMessages.length - 1;
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
    setSelectorIndex(move);
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Escape') escapeClearAtRef.current = 0;
    const composing = event.nativeEvent.isComposing || composingRef.current ||
      event.nativeEvent.keyCode === 229;
    // If the previous composing Enter produced no native newline, its one-shot
    // guard expires at the next real key. Plain Enter below still submits.
    if (!composing) suppressImeLineBreakRef.current = false;
    if (composing && event.key === 'Enter') {
      // Do not cancel keydown: the IME still owns candidate confirmation.
      // Keep the guard through compositionend and delayed beforeinput.
      suppressImeLineBreakRef.current = true;
    }
    // A newline chord pressed while an IME syllable is still composing is
    // swallowed by the commit: the composition ends and NOTHING breaks the
    // line (user: 개행이 안돼). Let the commit land, then insert the break the
    // user asked for — unless the platform already inserted one.
    if (composing && event.key === 'Enter' &&
      (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey)) {
      const element = event.currentTarget;
      window.setTimeout(() => {
        const caret = element.selectionStart;
        if (element.value.slice(Math.max(0, caret - 1), caret) === '\n') return;
        insertNewline(element);
      }, 0);
      return;
    }
    if (composing && (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab' ||
      event.key.startsWith('Arrow'))) {
      // Keep the key owned by the IME without cancelling its native commit.
      // Otherwise it bubbles into workbench shortcuts even though the composer
      // correctly skipped slash/mention submission.
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
      const lineStart = draft.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
      const removeStart = selectionStart === selectionEnd ? lineStart : selectionStart;
      setDraft((current) => `${current.slice(0, removeStart)}${current.slice(selectionEnd)}`);
      window.setTimeout(() => textarea.current?.setSelectionRange(removeStart, removeStart), 0);
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      insertNewline(event.currentTarget);
      return;
    }
    if (navigateMessageSelector(event)) return;
    if (navigateMentionPalette(event)) return;
    if (navigateSlashPalette(event)) return;
    if (slashOpen && slashCommands.length && event.key === 'Enter' &&
      !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const command = slashCommands[slashIndex];
      void send(`/${paletteCommandToken(command)}`);
      return;
    }
    if (event.key === 'Escape') {
      if (slashOpen) {
        event.preventDefault();
        setSlashDismissedDraft(draft);
        escapeClearAtRef.current = 0;
        return;
      }
      const element = event.currentTarget;
      const escape = classifyPromptEscape({
        interruptActive: shouldInterruptPrompt({
          turnBusy,
          pendingSubmissionId,
          draftMode,
        }),
        hasSelection: element.selectionStart !== element.selectionEnd,
        hasQueuedMessages: hasRestorableQueuedMessages(),
        hasMessages: selectableMessages.length > 0,
        value: draft || (attachments.length ? 'attachment' : ''),
        lastClearPressAt: escapeClearAtRef.current,
      });
      escapeClearAtRef.current = escape.nextClearPressAt;
      if (escape.action === 'interrupt') {
        event.preventDefault();
        void stop(Boolean(draft || attachments.length), pendingSubmissionId);
      } else if (escape.action === 'collapse-selection') {
        event.preventDefault();
        const end = element.selectionEnd;
        window.setTimeout(() => element.setSelectionRange(end, end), 0);
      } else if (escape.action === 'restore-queue') {
        event.preventDefault();
        void restoreQueue();
      } else if (escape.action === 'arm-clear') {
        event.preventDefault();
        showComposerNotice('Esc again to clear', PROMPT_ESCAPE_HINT_TIMEOUT_MS);
      } else if (escape.action === 'clear') {
        event.preventDefault();
        setDraft('');
        clearAttachments();
        showComposerNotice('');
        historyNavigation.current = { index: -1, seed: '' };
      } else if (escape.action === 'arm-select') {
        event.preventDefault();
        showComposerNotice(t("Esc again to pick a message"), PROMPT_ESCAPE_HINT_TIMEOUT_MS);
      } else if (escape.action === 'message-selector') {
        event.preventDefault();
        showComposerNotice('');
        openMessageSelector();
      }
      return;
    }
    const queueAvailable = hasRestorableQueuedMessages();
    const historyIntent = shouldNavigatePromptHistory({
      key: event.key,
      value: draft,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      historyActive: historyNavigation.current.index >= 0,
      allowNonEmpty: event.key === 'ArrowUp' && queueAvailable,
    });
    // TUI parity: ArrowUp reclaims queued follow-ups even with a draft in
    // progress (caret at start) — the engine merges queued text above the
    // current draft, exactly like the terminal's up-arrow restore.
    if (event.key === 'ArrowUp' && historyIntent && !event.altKey &&
      queueAvailable) {
      event.preventDefault();
      void restoreQueue();
      return;
    }
    if (event.key === 'ArrowUp' && historyIntent && history.length) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      if (navigation.index < 0) {
        navigation.seed = event.currentTarget.value;
        historySeedAttachments.current = attachmentsRef.current.map((attachment) => ({ ...attachment }));
      }
      navigation.index = Math.min(history.length - 1, navigation.index + 1);
      const entry = history[navigation.index];
      const value = entry?.text || '';
      const nextAttachments = (entry?.attachments || []).map((attachment) => ({ ...attachment }));
      for (const attachment of nextAttachments) {
        attachmentSequence.current = Math.max(attachmentSequence.current, attachment.id + 1);
      }
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
      draftRef.current = value;
      setDraft(value);
      window.setTimeout(() => textarea.current?.setSelectionRange(0, 0), 0);
      return;
    }
    if (event.key === 'ArrowDown' && historyIntent && historyNavigation.current.index >= 0) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      navigation.index -= 1;
      const entry: ComposerHistoryEntry = navigation.index < 0
        ? { text: navigation.seed, attachments: historySeedAttachments.current }
        : history[navigation.index];
      const value = entry?.text || '';
      const nextAttachments = (entry?.attachments || []).map((attachment) => ({ ...attachment }));
      for (const attachment of nextAttachments) {
        attachmentSequence.current = Math.max(attachmentSequence.current, attachment.id + 1);
      }
      attachmentsRef.current = nextAttachments;
      setAttachments(nextAttachments);
      draftRef.current = value;
      setDraft(value);
      window.setTimeout(() => textarea.current?.setSelectionRange(value.length, value.length), 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
        insertNewline(event.currentTarget);
      } else {
        void send();
      }
    }
  };
  const stop = async (preserveDraft = false, submissionId = '') => {
    const restorePrompt = submissionId
      ? !preserveDraft
      : shouldRestoreInterruptedPrompt({
        hasDraft: preserveDraft,
        // Use the raw editable queue projection, not the post-restore latch.
        // A just-submitted optimistic follow-up may not have reached the daemon
        // yet, but it still owns the next turn after this interrupt.
        hasQueuedMessages: Boolean(queuedProjectionKey),
      });
    const result = asRecord(await abort({
      restorePrompt,
      ...(submissionId ? { submissionId } : {}),
    }));
    if (submissionId && (result?.aborted === true || result?.restoreText)) {
      const restoredIds = Array.isArray(result.restoredSubmissionIds)
        ? result.restoredSubmissionIds.map(String).filter(Boolean)
        : [submissionId];
      onQueuedRestored?.(restoredIds.length ? restoredIds : [submissionId]);
    }
    if (result?.restoreText) {
      const restoredText = String(result.restoreText);
      const restored = restoredAttachments(result, restoredText);
      const acceptedText = mergeRestoredAttachments(restored.attachments, restored.text);
      setDraft((current) => {
        const next = [acceptedText, current].filter(Boolean).join('\n');
        draftRef.current = next;
        return next;
      });
      window.setTimeout(() => textarea.current?.focus(), 0);
    }
  };
  const hiddenQueueIdSet = new Set([
    ...(hiddenQueueIds || []).map(String),
    ...locallyHiddenQueueIds,
  ]);
  const visibleQueued = Array.isArray(queued)
    ? queued.filter((item) => {
      const id = asRecord(item)?.id;
      return id === undefined || id === null || !hiddenQueueIdSet.has(String(id));
    })
    : queued;
  const stopOnly = shouldStopComposerGeneration({
    turnBusy,
    text: draft,
    attachments,
  });
  return (
    <>
      <QueueList queued={visibleQueued} restoring={restoring}
        onEdit={(id) => void restoreQueue(id)}
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
              onClick={() => { void send(`/${paletteCommandToken(command)}`); }}>
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
          <button type="button" aria-label={t("Remove {{name}}", { name: attachment.name })} onClick={() => {
            setAttachments((current) => {
              const next = current.filter((entry) => entry.id !== attachment.id);
              attachmentsRef.current = next;
              return next;
            });
            setDraft((current) => current.replace(attachment.token, '').replace(/ {2,}/g, ' '));
          }} className="attachment-remove" data-tooltip={t("Remove")}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>)}
      </div>}
      <textarea ref={textarea} value={draft} onInput={(event) => {
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
        setComposerFocused(false);
      }}
        onPointerDown={() => { escapeClearAtRef.current = 0; }}
        onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)} onKeyDown={onKeyDown}
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
          if (text.length > 200 || text.split(/\r?\n/).length >= 3) {
            const id = attachmentSequence.current++;
            const lines = text.split('\n').length;
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
          sessionId={sessionId}
          modelDisabled={commandBusy || transitioning}
          // Effort/Fast stay live during a turn: the running turn already
          // captured its own effort/fast at turn start, so a change here lands
          // on the NEXT turn instead of being locked out. Only session-command
          // churn still disables the controls.
          tuningDisabled={commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot}
          onOpenSettings={onOpenSettings} onDraftSelection={onDraftModelSelection}
          onFastPreferenceApplied={onFastPreferenceApplied} />
        <button type="button"
          className={`composer-tool composer-mic ${dictationState !== 'idle' ? `is-${dictationState}` : ''}`.trim()}
          disabled={transitioning || dictationState === 'transcribing'}
          aria-label={dictationState === 'recording' ? t('Stop dictation') : t('Dictate with voice')}
          aria-pressed={dictationState === 'recording'}
          data-tooltip={dictationState === 'recording' ? t('Stop and transcribe')
            : dictationState === 'transcribing' ? t('Transcribing…') : t('Dictate (local Whisper)')}
          data-tooltip-side="top"
          onClick={() => void toggleDictation()}>
          {dictationState === 'transcribing' ? <ProgressSpinner className="composer-mic-spinner" size={16} /> : <Mic size={16} />}
        </button>
        <button type={stopOnly ? "button" : "submit"}
          className={`send-button${stopOnly ? " stop" : ""}`}
          onClick={stopOnly ? () => void stop() : undefined}
          disabled={stopOnly ? false
            : (!draft.trim() && !attachments.some((attachment) => !attachment.token || attachment.chipOnly === true))
              || (submitting && Boolean(draftMode)) || transitioning}
          aria-label={stopOnly ? t("Stop generation")
            : submitting ? (hasConversation ? t("Sending message") : t("Starting session"))
              : turnBusy ? t("Queue or steer active turn")
                : commandBusy ? t("Queue after current command") : t("Send message")}
          data-tooltip={stopOnly ? t("Stop")
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
