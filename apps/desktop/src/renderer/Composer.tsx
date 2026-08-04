import { ArrowUp, Command, Mic, X } from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { DesktopCapability, DesktopModelSelection, DesktopPromptAttachment, DesktopPromptContent, DesktopSubmitOptions, EngineSnapshot } from "../shared/contract";
import { type RecordValue } from "./desktop-types";
import { t } from "./i18n";
import { ModelSelector } from "./model-controls";
import { MxIcon } from "./MxIcon";
import { ProgressSpinner } from "./ProgressSpinner";
import { shouldNavigatePromptHistory } from "./renderer-logic.mjs";
import { SLASH_COMMANDS, type CommandSurface as CommandSurfaceName, type SettingsSection } from "./slash-commands";
import { TURN_LOCKED_SLASH_COMMANDS, asRecord } from "./text-format";
import { registerImagePreview } from "./transcript-metrics";


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
} from "./composer-support";
// Attachment budget policy and file -> attachment conversion.
import { attachmentFromFile, attachmentPolicyError } from "./composer-attachments";
export {
  PROJECT_CONTEXT_LOCAL,
  PROJECT_CONTEXT_OPEN,
  ProjectContextSelector,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory
};

export const Composer = memo(function Composer({
  turnBusy,
  commandBusy,
  transitioning,
  focusRequest,
  historyScope,
  projectScope,
  hasConversation,
  promptHistoryList,
  provider,
  model,
  effort,
  fast,
  fastCapable,
  draftMode,
  onDraftModelSelection,
  queued,
  hiddenQueueIds,
  submit,
  abort,
  invokeResult,
  applySnapshot,
  onNewTask,
  onResumeSession,
  onOpenSessions,
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
  hasConversation: boolean;
  promptHistoryList?: unknown[];
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  draftMode?: boolean;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  queued?: unknown[];
  hiddenQueueIds?: Array<string | number>;
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  abort: () => Promise<unknown>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  onNewTask: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  dropTargetRef: React.RefObject<HTMLElement | null>;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
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
  const showComposerNotice = useCallback((message: string) => {
    window.clearTimeout(composerNoticeTimer.current);
    setComposerNotice(message);
    if (message) {
      composerNoticeTimer.current = window.setTimeout(() => setComposerNotice(''), 6_000);
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
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [persistedHistory, setPersistedHistory] = useState(() => readPromptHistory(historyScope));
  const activeHistoryScope = useRef(historyScope);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const slashPalette = useRef<HTMLDivElement>(null);
  const mentionPalette = useRef<HTMLDivElement>(null);
  const mentionSearchGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentSequence = useRef(1);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepth = useRef(0);
  const transitioningRef = useRef(transitioning);
  transitioningRef.current = transitioning;
  const wasTransitioning = useRef(transitioning);
  const historyNavigation = useRef({ index: -1, seed: '' });
  useLayoutEffect(() => {
    if (activeHistoryScope.current === historyScope) return;
    activeHistoryScope.current = historyScope;
    attachmentsRef.current = [];
    dragDepth.current = 0;
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
    setRestoring(false);
    setDraggingFiles(false);
    setPersistedHistory(readPromptHistory(historyScope));
    historyNavigation.current = { index: -1, seed: '' };
  }, [historyScope]);
  const history = useMemo(() => {
    const engineHistory = Array.isArray(promptHistoryList)
      ? promptHistoryList.map((entry) => typeof entry === 'string'
        ? entry : String(asRecord(entry)?.text || asRecord(entry)?.displayText || '')).filter(Boolean)
      : [];
    return [...new Set([...persistedHistory, ...engineHistory])].slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  }, [persistedHistory, promptHistoryList]);
  const rememberPrompt = useCallback((value: string) => {
    const prompt = value.trim();
    if (!prompt) return;
    setPersistedHistory((current) => {
      const next = [prompt, ...current.filter((entry) => entry !== prompt)]
        .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
      try {
        window.localStorage.setItem(promptHistoryStorageKey(historyScope), JSON.stringify(next));
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
    if (!mentionOpen) return;
    mentionPalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [mentionIndex, mentionOpen, mentionResults]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => {
    const receiveDraft = (event: Event) => {
      const text = String((event as CustomEvent<unknown>).detail || '');
      if (!text) return;
      setDraft((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`);
      historyNavigation.current = { index: -1, seed: '' };
      window.setTimeout(() => textarea.current?.focus(), 0);
    };
    window.addEventListener('mixdog:composer-draft', receiveDraft);
    return () => window.removeEventListener('mixdog:composer-draft', receiveDraft);
  }, []);

  const invokeCapability = useCallback(async <T,>(capability: DesktopCapability, args: unknown[] = []) => {
    const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<T>({ capability, args }));
    if (result?.snapshot !== undefined) applySnapshot(result.snapshot);
    return result?.value;
  }, [applySnapshot, invokeResult]);

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
    // Chip-only attachments (images) carry no bracket token: the thumbnail
    // chip is their sole representation, so the draft text stays untouched
    // (user: pasting an image left a redundant "[Image #N]" box in the input).
    if (!attachment.token) {
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
      return `${before}${inserted}${after}`;
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

  useEffect(() => {
    const target = dropTargetRef.current;
    if (!target) return;
    const containsFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      if (transitioningRef.current) return;
      dragDepth.current += 1;
      setDraggingFiles(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!containsFiles(event)) return;
      event.preventDefault();
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
      if (!containsFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDraggingFiles(false);
      if (transitioningRef.current || !event.dataTransfer) return;
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
  }, [attachFiles, dropTargetRef]);

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
        ? (document.documentElement.hasAttribute('data-mixdog-mobile')
          // The same composer serves the phone web/app shell: pointing a
          // phone user at Windows Settings reads as a broken feature.
          ? 'Microphone access is blocked. Allow microphone access for Mixdog in your phone settings and reload.'
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
      const match = textValue.match(new RegExp(`\\[Pasted text #${rawId}(?: \\+\\d+ lines)?\\]`));
      if (!match) continue;
      const id = uniqueId(rawId);
      const token = id === rawId ? match[0] : match[0].replace(`#${rawId}`, `#${id}`);
      if (token !== match[0]) textValue = textValue.replace(match[0], token);
      restored.push({ id, name: `Pasted text ${id}`, kind: 'text', mimeType: 'text/plain', data: text.text,
        token, source: 'paste' });
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

  const restoreQueue = async (currentText = draft, queuedId = '') => {
    if (restoring) return undefined;
    setRestoring(true);
    try {
      const args = queuedId ? [currentText, queuedId] : [currentText];
      const value = await invokeCapability<RecordValue>('restoreQueued', args);
      if (value) {
        const restored = restoredAttachments(value, String(value.text || currentText));
        setDraft(mergeRestoredAttachments(restored.attachments, restored.text));
        textarea.current?.focus();
      }
      return value;
    } finally {
      setRestoring(false);
    }
  };

  // Queue rows: discard a queued follow-up in place. restoreQueued
  // removes the entry from the engine queue; the merged text it returns is
  // intentionally ignored so the current draft is untouched.
  const discardQueued = async (queuedId: string) => {
    if (restoring || !queuedId) return;
    setRestoring(true);
    try {
      await invokeCapability<RecordValue>('restoreQueued', [draft, queuedId]);
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
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<T>({ capability, args }));
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
    const command = SLASH_COMMANDS.find((entry) => entry.name === rawName || entry.aliases?.includes(rawName));
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
    if (rawName === 'new') onNewTask();
    else if (name === 'resume') argument ? onResumeSession(argument) : onOpenSessions();
    else if (name === 'clear') await commandCapability('clear');
    else if (name === 'compact') await commandCapability('compact');
    else if (name === 'doctor') onOpenCommandSurface('doctor');
    else if (name === 'remote') await commandCapability('claimRemote');
    else if (name === 'model' && argument) {
      if (argument.toLowerCase() === 'refresh') {
        const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ force: true }));
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
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute(selection));
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
    const text = (slashOverride || draft).trim();
    // Chip-only image/PDF attachments carry no draft token, so an image-only
    // send legitimately has empty text.
    const chipOnlyAttachments = attachmentsRef.current.some((attachment) => !attachment.token);
    if ((!text && !chipOnlyAttachments) || submitting || transitioning) return;
    setSubmitting(true);
    try {
      setComposerNotice('');
      if (text.startsWith('/')) {
        if (commandBusy) {
          setAttachmentError('Wait for the current command to finish. Your command is still in the editor.');
          return;
        }
        const submittedDraft = draft;
        const submittedAttachments = [...attachmentsRef.current];
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
      const used = attachments.filter((attachment) => draft.includes(attachment.token));
      let expandedText = draft;
      const pastedImages: Record<string, DesktopPromptAttachment> = {};
      const pastedTexts: Record<string, { id: number; text: string }> = {};
      for (const attachment of used) {
        if (attachment.kind === 'text') {
          const safeName = attachment.name.replace(/[<>"']/g, '_');
          const expanded = attachment.source === 'paste'
            ? attachment.data
            : `<file name="${safeName}">\n${attachment.data}\n</file>`;
          expandedText = expandedText.replaceAll(attachment.token, expanded);
          pastedTexts[String(attachment.id)] = { id: attachment.id, text: attachment.data };
        } else if (attachment.kind === 'image') {
          pastedImages[String(attachment.id)] = {
            id: attachment.id,
            type: 'image',
            content: attachment.data,
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
        registerImagePreview(attachment.id, attachment.data.length,
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
      const submittedDraft = draft;
      const submittedAttachments = [...used];
      setDraft((current) => current === submittedDraft ? '' : current);
      removeAttachments(new Set(submittedAttachments.map((attachment) => attachment.id)));
      historyNavigation.current = { index: -1, seed: '' };
      const restoreSubmitted = () => {
        const restoredText = mergeRestoredAttachments(submittedAttachments, submittedDraft);
        setDraft((current) => {
          if (!current || current === submittedDraft) return restoredText;
          return [restoredText, current].filter(Boolean).join('\n');
        });
      };
      let accepted: unknown;
      try {
        accepted = await submit(content, {
          displayText: expandedText,
          ...(Object.keys(pastedImages).length ? { pastedImages } : {}),
          ...(Object.keys(pastedTexts).length ? { pastedTexts } : {}),
        });
      } catch (error) {
        restoreSubmitted();
        throw error;
      }
      if (accepted === true) {
        rememberPrompt(text);
      } else restoreSubmitted();
    } finally {
      setSubmitting(false);
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
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (composing && (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab' ||
      event.key.startsWith('Arrow'))) return;
    if (event.key === 'Enter' && event.repeat) return;
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
        setDraft('');
        setSlashDismissedDraft('');
        return;
      }
      const element = event.currentTarget;
      if (element.selectionStart !== element.selectionEnd) {
        event.preventDefault();
        const end = element.selectionEnd;
        window.setTimeout(() => element.setSelectionRange(end, end), 0);
        return;
      }
      if (draft || attachments.length) {
        event.preventDefault();
        setDraft('');
        clearAttachments();
        historyNavigation.current = { index: -1, seed: '' };
        return;
      }
      if (turnBusy) {
        event.preventDefault();
        void stop();
        return;
      }
      if (Array.isArray(queued) && queued.length) {
        event.preventDefault();
        void restoreQueue();
      }
      return;
    }
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
    });
    // TUI parity: ArrowUp reclaims queued follow-ups even with a draft in
    // progress (caret at start) — the engine merges queued text above the
    // current draft, exactly like the terminal's up-arrow restore.
    if (event.key === 'ArrowUp' && historyIntent && !event.altKey &&
      Array.isArray(queued) && queued.length) {
      event.preventDefault();
      void restoreQueue();
      return;
    }
    if (event.key === 'ArrowUp' && historyIntent && history.length) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      if (navigation.index < 0) navigation.seed = draft;
      navigation.index = Math.min(history.length - 1, navigation.index + 1);
      const value = history[navigation.index] || '';
      setDraft(value);
      window.setTimeout(() => textarea.current?.setSelectionRange(value.length, value.length), 0);
      return;
    }
    if (event.key === 'ArrowDown' && historyIntent && historyNavigation.current.index >= 0) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      navigation.index -= 1;
      const value = navigation.index < 0 ? navigation.seed : history[navigation.index] || '';
      setDraft(value);
      window.setTimeout(() => textarea.current?.setSelectionRange(value.length, value.length), 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        insertNewline(event.currentTarget);
      } else if (!event.altKey) {
        void send();
      }
    }
  };
  const stop = async () => {
    const result = asRecord(await abort());
    if (result?.restoreText) {
      const restoredText = String(result.restoreText);
      const restored = restoredAttachments(result, restoredText);
      const acceptedText = mergeRestoredAttachments(restored.attachments, restored.text);
      setDraft((current) => [acceptedText, current.trim()].filter(Boolean).join('\n'));
      window.setTimeout(() => textarea.current?.focus(), 0);
    }
  };
  const hiddenQueueIdSet = new Set((hiddenQueueIds || []).map(String));
  const visibleQueued = Array.isArray(queued)
    ? queued.filter((item) => {
      const id = asRecord(item)?.id;
      return id === undefined || id === null || !hiddenQueueIdSet.has(String(id));
    })
    : queued;
  return (
    <>
      <QueueList queued={visibleQueued} restoring={restoring}
        onEdit={(id) => void restoreQueue(draft, id)}
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
          <MxIcon name="photo" size={16} /><span>{t("Drop images, PDFs, or text files")}</span>
        </div>,
        dropTargetRef.current,
      )}
      <form className="composer" onSubmit={onSubmit}
        aria-busy={transitioning} onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest('button, input, textarea, [role="listbox"]')) textarea.current?.focus();
        }}>
      {slashOpen && (
        <div ref={slashPalette} id="composer-slash-palette" className="slash-palette" role="listbox" aria-label={t("Slash commands")}>
          <header><Command size={13} /><span>{t("Commands")}</span></header>
          {slashCommands.length ? slashCommands.map((command, index) => (
            <button type="button" role="option" aria-selected={index === slashIndex} key={command.name}
              id={`composer-slash-option-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => { void send(`/${paletteCommandToken(command)}`); }}>
              <code>{command.usage || `/${command.name}`}{command.params ? ` ${command.params}` : ''}</code>
              <span>{command.description}</span>
            </button>
          )) : <p>{t("No matching command.")}</p>}
        </div>
      )}
      {mentionOpen && (
        <div ref={mentionPalette} id="composer-mention-palette"
          className="slash-palette mention-palette" role="listbox" aria-label={t("Project files")}>
          <header><MxIcon name="open-file" size={13} /><span>{t("Files")}</span></header>
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
            : <span><MxIcon name="open-file" size={15} /></span>}
          <span data-tooltip={attachment.name}>{attachment.name}</span>
          <button type="button" aria-label={t("Remove {{name}}", { name: attachment.name })} onClick={() => {
            setAttachments((current) => {
              const next = current.filter((entry) => entry.id !== attachment.id);
              attachmentsRef.current = next;
              return next;
            });
            setDraft((current) => current.replace(attachment.token, '').replace(/ {2,}/g, ' '));
          }}><MxIcon name="close-small" size={13} /></button>
        </div>)}
      </div>}
      <textarea ref={textarea} value={draft} onInput={(event) => {
        // Perf diagnostics (MIXDOG_DESKTOP_PERF=1): keystroke→paint latency,
        // logged only when a frame is actually slow.
        if (window.mixdogDesktop?.perfLog) {
          const inputAt = performance.now();
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            const ms = performance.now() - inputAt;
            if (ms >= 25) window.mixdogDesktop?.perfLog?.(`composer-keystroke paint=${ms.toFixed(0)}ms`);
          }));
        }
        setDraft(event.currentTarget.value);
        setAttachmentError('');
        setComposerNotice('');
        setCaretOffset(event.currentTarget.selectionStart);
        setSlashDismissedDraft('');
        setMentionDismissed('');
        historyNavigation.current = { index: -1, seed: '' };
      }} onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)}
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
          const text = event.clipboardData.getData('text/plain');
          if (text.length > 200 || text.split(/\r?\n/).length >= 3) {
            const id = attachmentSequence.current++;
            const lines = text.replace(/\r\n?/g, '\n').split('\n').length;
            const inserted = insertAttachment({
              id, name: `Pasted text · ${lines} lines`, kind: 'text', mimeType: 'text/plain', data: text,
              token: `[Pasted text #${id} +${lines} lines]`, source: 'paste',
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
          modelDisabled={commandBusy || transitioning}
          // Effort/Fast stay live during a turn: the running turn already
          // captured its own effort/fast at turn start, so a change here lands
          // on the NEXT turn instead of being locked out (claude-code/codex
          // parity). Only session-command churn still disables the controls.
          tuningDisabled={commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot}
          onOpenSettings={onOpenSettings} onDraftSelection={onDraftModelSelection} />
        <button type="button"
          className={`composer-tool composer-mic ${dictationState !== 'idle' ? `is-${dictationState}` : ''}`.trim()}
          disabled={transitioning || dictationState === 'transcribing'}
          aria-label={dictationState === 'recording' ? t('Stop dictation') : t('Dictate with voice')}
          aria-pressed={dictationState === 'recording'}
          data-tooltip={dictationState === 'recording' ? t('Stop and transcribe')
            : dictationState === 'transcribing' ? t('Transcribing…') : t('Dictate (local Whisper)')}
          data-tooltip-side="top"
          onClick={() => void toggleDictation()}>
          {dictationState === 'transcribing' ? <ProgressSpinner className="composer-mic-spinner" size={15} /> : <Mic size={15} />}
        </button>
        <button type={turnBusy && !draft.trim() ? "button" : "submit"}
          className={`send-button${turnBusy && !draft.trim() ? " stop" : ""}`}
          onClick={turnBusy && !draft.trim() ? () => void stop() : undefined}
          disabled={turnBusy && !draft.trim() ? false
            : (!draft.trim() && !attachments.some((attachment) => !attachment.token))
              || submitting || transitioning}
          aria-label={turnBusy && !draft.trim() ? t("Stop generation")
            : submitting ? (hasConversation ? t("Sending message") : t("Starting session"))
              : turnBusy ? t("Queue or steer active turn")
                : commandBusy ? t("Queue after current command") : t("Send message")}
          data-tooltip={turnBusy && !draft.trim() ? t("Stop")
            : turnBusy ? t("Queue or steer · Enter")
              : commandBusy ? t("Queue after command · Enter") : t("Send · Enter")}
          data-tooltip-side="top">
          {turnBusy && !draft.trim()
            ? <MxIcon name="stop" size={15} />
            : submitting
              ? <ProgressSpinner className="composer-mic-spinner" size={15} />
              : <ArrowUp size={15} />}
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
