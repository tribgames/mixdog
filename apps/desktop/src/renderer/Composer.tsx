import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { MxIcon } from "./MxIcon";
import type { DesktopCapability, DesktopModelOption, DesktopModelSelection, DesktopPromptAttachment, DesktopPromptContent, DesktopProjectSummary, DesktopSessionSummary, DesktopSubmitOptions, DesktopUpdaterState, EngineSnapshot } from "../shared/contract";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { imagePreviewCache, imagePreviewKey, registerImagePreview, lastVisibleTranscriptItemIndex, estimatedTranscriptRowHeight, TRANSCRIPT_VIRTUALIZE_THRESHOLD, TRANSCRIPT_VIRTUAL_OVERSCAN } from "./transcript-metrics";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { OpenSelect } from "./OpenSelect";
import { ModelPicker } from "./ModelPicker";
import { modelDisplayName } from "./provider-display";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache";
import { SLASH_COMMANDS, type CommandSurface as CommandSurfaceName, type SettingsSection } from "./slash-commands";
import { acquireModalLayer } from "./modal-layer";
import { applyDesktopTheme, applyDesktopThemePreference, clearDesktopThemePreference, getDesktopThemePreference } from "./desktop-theme";
import { TurnReviewBar } from "./TurnReview";
import { providerSetupEntries, providerSetupState, WorkflowSelect, ModelSelector } from "./model-controls";


export const PROJECT_CONTEXT_LOCAL = "__mixdog_local__";
export const PROJECT_CONTEXT_OPEN = "__mixdog_open__";

export function ProjectContextSelector({ projects, activePath, activeLabel, disabled, onClear, onSelect, onChoose }: {
  projects: DesktopProjectSummary[];
  activePath: string;
  activeLabel: string;
  disabled: boolean;
  onClear(): void;
  onSelect(path: string): void;
  onChoose(): void;
}) {
  const normalized = activePath.replace(/[\\/]+/g, "/").toLocaleLowerCase();
  const known = projects.some((project) =>
    project.path.replace(/[\\/]+/g, "/").toLocaleLowerCase() === normalized);
  const options = [
    { value: PROJECT_CONTEXT_LOCAL, label: "No project" },
    ...(!activePath || known ? [] : [{ value: activePath, label: activeLabel || displayProject(activePath).name || "Project" }]),
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || displayProject(project.path).name || "Project",
    })),
    { value: PROJECT_CONTEXT_OPEN, label: "Open folder…" },
  ];
  const value = activePath || PROJECT_CONTEXT_LOCAL;
  return <div className="composer-context-bar">
    <div className="composer-project-context">
      <Folder size={13} />
      <OpenSelect className="project-context-select" ariaLabel="Project context"
        value={value} displayValue={activeLabel || "Project"} disabled={disabled}
        options={options} onChange={(next) => {
          if (next === PROJECT_CONTEXT_OPEN) onChoose();
          else if (next === PROJECT_CONTEXT_LOCAL) {
            if (activePath) onClear();
          } else if (next !== activePath) onSelect(next);
        }} />
    </div>
  </div>;
}

type ComposerAttachment = {
  id: number;
  name: string;
  kind: 'image' | 'text' | 'pdf';
  mimeType: string;
  data: string;
  token: string;
  source?: 'file' | 'paste';
  metadataText?: string;
};

const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_INLINE_FILE_BYTES = 750_000;
const MAX_INLINE_TEXT_TOTAL = 850_000;
const MAX_INLINE_IMAGE_BASE64_TOTAL = 30_000_000;
// PDFs attach as provider document blocks, 20 MiB per file.
const MAX_PDF_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SUBMIT_TEXT_LENGTH = 950_000;
const MAX_PERSISTED_PROMPT_HISTORY = 100;
const PROMPT_HISTORY_STORAGE_PREFIX = 'mixdog.desktop.prompt-history.v1:';
const COMPOSER_PLACEHOLDERS = [
  // One quiet line (user decision): no rotating tips, no syntax lecture.
  'Ask anything…',
] as const;

export function promptHistoryStorageKey(scope: string) {
  return `${PROMPT_HISTORY_STORAGE_PREFIX}${encodeURIComponent(scope || 'new-task')}`;
}

// Text sniffing: accept any file whose first 4 KB contains no
// NUL byte and a low control-character ratio, instead of trusting only the
// extension whitelist (.env, .ini, extension-less logs, …).
async function fileLooksLikeText(file: File): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (bytes.length === 0) return true;
    let control = 0;
    for (const byte of bytes) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    return control / bytes.length <= 0.3;
  } catch {
    return false;
  }
}

export function readPromptHistory(scope: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(promptHistoryStorageKey(scope)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry] : [])
      .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  } catch {
    return [];
  }
}

export function queuedFollowupPreview(entry: unknown) {
  return queueText(entry).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "[Attachment]";
}

function QueueList({ queued, restoring, onEdit, onRemove }: {
  queued?: unknown[];
  restoring: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const itemsId = useId();
  if (!Array.isArray(queued) || queued.length === 0) return null;
  const label = `${queued.length} queued follow-up${queued.length === 1 ? "" : "s"}`;
  const preview = queuedFollowupPreview(queued[0]);
  return (
    <section className="queue-list" data-collapsed={collapsed ? "true" : "false"}
      aria-label={label}>
      <button type="button" className="queue-summary" aria-expanded={!collapsed}
        aria-controls={itemsId} onClick={() => setCollapsed((value) => !value)}>
        <strong>{label}</strong>
        {collapsed && <span className="queue-collapsed-preview">{preview}</span>}
        <ChevronDown className="queue-chevron" size={15} aria-hidden="true" />
      </button>
      {!collapsed && <div className="queue-items" id={itemsId} role="list">
        {queued.map((entry, index) => {
          const id = String(asRecord(entry)?.id || "");
          const text = queuedFollowupPreview(entry);
          return <div className="queue-item" role="listitem" key={id || index}>
            <span className="queue-item-text" title={text}>{text}</span>
            <small>Next boundary</small>
            <button type="button" className="queue-edit" disabled={restoring || !id}
              onClick={() => onEdit(id)} aria-label={`Edit queued follow-up: ${text}`}>
              {restoring ? "Editing…" : "Edit"}
            </button>
            <button type="button" className="queue-remove" disabled={restoring || !id}
              onClick={() => onRemove(id)} aria-label={`Remove queued follow-up: ${text}`}
              data-tooltip="Remove">
              <X size={13} />
            </button>
          </div>;
        })}
      </div>}
    </section>
  );
}

export const Composer = memo(function Composer({
  turnBusy,
  commandBusy,
  transitioning,
  focusRequest,
  historyScope,
  projectScope,
  hasConversation,
  hasProjectContext,
  promptHistoryList,
  provider,
  model,
  effort,
  fast,
  fastCapable,
  workflow,
  starter,
  queued,
  submit,
  abort,
  invokeResult,
  applySnapshot,
  onNewTask,
  onStartProject,
  onResumeSession,
  onOpenProjects,
  onOpenSessions,
  onOpenSettings,
  onOpenCommandSurface,
}: {
  turnBusy: boolean;
  commandBusy: boolean;
  transitioning: boolean;
  focusRequest: number;
  historyScope: string;
  projectScope: string;
  hasConversation: boolean;
  hasProjectContext: boolean;
  promptHistoryList?: unknown[];
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  workflow?: RecordValue | null;
  starter: { id: number; text: string } | null;
  queued?: unknown[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  abort: () => Promise<unknown>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  onNewTask: () => void;
  onStartProject: (path: string) => void;
  onResumeSession: (id: string) => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
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
    : turnBusy ? 'Steer the active turn or queue a follow-up…'
      : commandBusy ? 'Queue a message after the current command…'
        : COMPOSER_PLACEHOLDERS[0];
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
    if (!starter) return;
    setDraft(starter.text);
    historyNavigation.current = { index: -1, seed: '' };
    textarea.current?.focus();
  }, [starter]);
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

  const attachmentPolicyError = useCallback((
    currentAttachments: ComposerAttachment[],
    attachment: ComposerAttachment,
  ) => {
    if (currentAttachments.length >= MAX_COMPOSER_ATTACHMENTS) {
      return `Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`;
    }
    const textTotal = currentAttachments.reduce((sum, item) =>
      sum + (item.kind === 'text' ? item.data.length : 0), 0) +
      (attachment.kind === 'text' ? attachment.data.length : 0);
    if (textTotal > MAX_INLINE_TEXT_TOTAL) {
      return 'Inline text attachments are too large together. Keep the total under 850 KB.';
    }
    const imageTotal = currentAttachments.reduce((sum, item) =>
      sum + (item.kind === 'image' || item.kind === 'pdf' ? item.data.length : 0), 0) +
      (attachment.kind === 'image' || attachment.kind === 'pdf' ? attachment.data.length : 0);
    if (imageTotal > MAX_INLINE_IMAGE_BASE64_TOTAL) {
      return 'Attached images and PDFs are too large together. Remove one or use smaller files.';
    }
    return '';
  }, []);
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
  }, [attachmentPolicyError]);
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
        const id = attachmentSequence.current++;
        const displayName = file.name || (file.type.startsWith('image/') ? 'Pasted image' : 'Pasted file');
        if (file.type.startsWith('image/')) {
          if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type) || file.size > 12_000_000) {
            throw new Error(`${displayName}: use PNG, JPEG, GIF, or WebP under 12 MB.`);
          }
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`${displayName}: could not read image.`));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(file);
          });
          if (transitioningRef.current) return;
          const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
          // TUI parity: route the attachment through the engine's optional-
          // sharp resize pipeline so desktop submits the same downscaled
          // payload the terminal client would. Hosts without the capability
          // (older engines, test stubs) keep the legacy raw attach.
          let imageData = data;
          let imageMime = file.type;
          let metadataText = '';
          const invokeResize = window.mixdogDesktop?.invokeCapability;
          if (typeof invokeResize === 'function') {
            try {
              const result = await invokeResize<RecordValue>({
                capability: 'resizeImage',
                args: [{ data, mimeType: file.type, filename: displayName }],
              });
              const value = asRecord(result?.value);
              if (typeof value?.data === 'string' && value.data) {
                imageData = value.data;
                imageMime = String(value.mimeType || file.type);
                metadataText = String(value.metadataText || '');
              }
            } catch (reason) {
              const message = reason instanceof Error ? reason.message : String(reason);
              // Real resize failures (e.g. oversized image without sharp)
              // block the attach exactly like the TUI paste path does.
              if (!/does not support|capability is unavailable/i.test(message)) {
                throw new Error(`${displayName}: ${message}`);
              }
            }
          }
          if (transitioningRef.current) return;
          insertAttachment({ id, name: displayName, kind: 'image', mimeType: imageMime, data: imageData,
            ...(metadataText ? { metadataText } : {}),
            token: '' });
          continue;
        }
        const mimeKind = (file.type || '').split(';', 1)[0].trim().toLowerCase();
        if (mimeKind === 'application/pdf' || /\.pdf$/i.test(displayName)) {
          if (file.size > MAX_PDF_FILE_BYTES) {
            throw new Error(`${displayName}: PDFs must be under 20 MB.`);
          }
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`${displayName}: could not read PDF.`));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(file);
          });
          if (transitioningRef.current) return;
          insertAttachment({ id, name: displayName, kind: 'pdf', mimeType: 'application/pdf',
            data: dataUrl.slice(dataUrl.indexOf(',') + 1), token: `[PDF #${id}: ${displayName}]` });
          continue;
        }
        const textLike = mimeKind.startsWith('text/') ||
          /^application\/(?:json|ld\+json|toml|x-toml|yaml|x-yaml|xml)$/.test(mimeKind) ||
          mimeKind.endsWith('+json') || mimeKind.endsWith('+xml') ||
          /\.(?:md|mdx|txt|json|jsonl|ya?ml|toml|xml|csv|tsv|[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|cs|cpp|cc|c|h|hh|hpp|sh|zsh|ps1|bat|cmd|sql|css|scss|sass|html|htm|vue|svelte|log|env|ini|conf|cfg|gql|graphql)$/i.test(displayName) ||
          await fileLooksLikeText(file);
        if (!textLike || file.size > MAX_INLINE_FILE_BYTES) {
          throw new Error(`${displayName}: attach images, PDFs, or text files under 750 KB.`);
        }
        const text = await file.text();
        if (transitioningRef.current) return;
        if (text.length > MAX_INLINE_FILE_BYTES) {
          throw new Error(`${displayName}: inline text is too large after decoding.`);
        }
        insertAttachment({ id, name: displayName, kind: 'text', mimeType: file.type || 'text/plain', data: text,
          token: `[File #${id}: ${displayName}]`, source: 'file' });
      } catch (reason) {
        setAttachmentError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [insertAttachment]);

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
        ? 'Microphone access is blocked. Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.'
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
    else if (name === 'project') argument ? onStartProject(argument) : onOpenProjects();
    else if (name === 'resume') argument ? onResumeSession(argument) : onOpenSessions();
    else if (name === 'quit') {
      const quit = window.mixdogDesktop.quit;
      if (typeof quit === 'function') await invokeResult(() => quit());
      else window.close();
    }
    else if (name === 'clear') await commandCapability('clear');
    else if (name === 'compact') await commandCapability('compact');
    else if (name === 'doctor') onOpenCommandSurface('doctor');
    else if (name === 'remote') await commandCapability('claimRemote');
    else if (name === 'settings') onOpenSettings(null);
    else if (name === 'fast') {
      const value = argument.toLowerCase();
      const enabled = value
        ? ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value) ? true
          : ['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value) ? false : null
        : !fast;
      if (enabled === null) {
        setAttachmentError('Usage: /fast [on|off]');
        return false;
      }
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled));
      if (next === undefined) return false;
      applySnapshot(next);
    } else if (name === 'autoclear') {
      const value = argument.toLowerCase();
      if (!value) onOpenSettings('autoclear');
      else if (value === 'status') {
        const status = asRecord(await commandCapability('getAutoClear'));
        if (invocationFailed) return false;
        if (!status) showComposerNotice('Auto-clear unavailable.');
        else showComposerNotice(`Auto-clear ${status.enabled ? 'on' : 'off'} · idle ${formatIdleDuration(status.idleMs)}`);
      }
      else if (['on', 'enable', 'enabled'].includes(value)) await commandCapability('setAutoClear', [{ enabled: true }]);
      else if (['off', 'disable', 'disabled'].includes(value)) await commandCapability('setAutoClear', [{ enabled: false }]);
      else await commandCapability('setAutoClear', [{ duration: argument }]);
    } else if (name === 'effort') {
      if (argument) await commandCapability('setEffort', [argument]);
      else onOpenCommandSurface('effort');
    } else if (name === 'workflow') {
      if (argument) await commandCapability('setWorkflow', [argument]);
      else onOpenSettings('workflow');
    } else if (name === 'outputstyle') {
      if (!argument) onOpenSettings('output-style');
      else if (['status', 'current', 'show'].includes(argument.toLowerCase())) {
        const status = asRecord(await commandCapability('getOutputStyle'));
        if (invocationFailed) return false;
        const current = asRecord(status?.current);
        showComposerNotice(`Output style: ${String(current?.label || current?.id || status?.configured || 'Default')}`);
      }
      else await commandCapability('setOutputStyle', [argument]);
    } else if (name === 'theme') {
      if (!argument) onOpenSettings('theme');
      else {
        const themes = await commandCapability<unknown[]>('listThemes') || [];
        const normalized = argument.toLowerCase();
        if (['status', 'current', 'show'].includes(normalized)) {
          const value = await commandCapability<unknown>('getTheme');
          if (invocationFailed) return false;
          const current = typeof value === 'string' ? value : String(asRecord(value)?.id || 'default');
          const entry = themes.map(asRecord).find((theme) => String(theme?.id || '') === current);
          showComposerNotice(`Theme: ${String(entry?.label || current || 'default')}`);
          return true;
        }
        const theme = themes.map(asRecord).find((entry) =>
          String(entry?.id || '').toLowerCase() === normalized || String(entry?.label || '').toLowerCase() === normalized);
        if (!theme) {
          setAttachmentError(`Theme not found: ${argument}`);
          return false;
        }
        await commandCapability('setTheme', [theme.id, { persist: true }]);
        if (invocationFailed) return false;
        clearDesktopThemePreference();
        applyDesktopTheme(theme.id);
      }
    }
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
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute({
        provider: model.provider,
        model: model.model,
      }));
      if (next === undefined) return false;
      applySnapshot(next);
    } else if (name === 'model') {
      onOpenSettings('model');
    } else if (name === 'search') {
      if (argument) {
        setAttachmentError('/search sets the search provider/model; the search tool uses that model when called.');
      }
      onOpenSettings('search');
    } else if (name === 'agents') {
      if (argument.toLowerCase() === 'refresh') {
        const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ force: true }));
        if (models === undefined) return false;
      }
      onOpenCommandSurface('agents');
    } else if (name === 'usage') {
      if (['refresh', '--refresh', '-r', 'true'].includes(argument.toLowerCase())) {
        await commandCapability('getUsageDashboard', [{ refresh: true }]);
      }
      onOpenCommandSurface('usage');
    } else if (name === 'memory' && argument) {
      const parts = argument.split(/\s+/).filter(Boolean);
      const input: RecordValue = { action: parts[0] || 'status' };
      for (const part of parts.slice(1)) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        const key = part.slice(0, separator);
        const rawValue = part.slice(separator + 1);
        const numeric = Number(rawValue);
        input[key] = rawValue && Number.isFinite(numeric) ? numeric : rawValue;
      }
      await commandCapability('memoryControl', [input]);
    } else if (name === 'memory') onOpenCommandSurface('memory');
    else if (command.surface) onOpenCommandSurface(command.surface);
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
      const accepted = await submit(content, {
        displayText: expandedText,
        ...(Object.keys(pastedImages).length ? { pastedImages } : {}),
        ...(Object.keys(pastedTexts).length ? { pastedTexts } : {}),
      });
      setDraft((current) => draftAfterSubmission(current, draft, accepted));
      if (accepted === true) {
        rememberPrompt(text);
        removeAttachments(new Set(used.map((attachment) => attachment.id)));
        historyNavigation.current = { index: -1, seed: '' };
      }
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
    if (event.key === 'ArrowUp' && historyIntent && !event.altKey && !draft.trim() &&
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
  return (
    <>
      <QueueList queued={queued} restoring={restoring}
        onEdit={(id) => void restoreQueue(draft, id)}
        onRemove={(id) => void discardQueued(id)} />
      {/* Error/notice banners float ABOVE the input card (user-flagged: they
          previously rendered inside the pill and read as composer content). */}
      {(attachmentError) && <p className="composer-error" role="alert">{attachmentError}</p>}
      {composerNotice && <p className="composer-notice" role="status">{composerNotice}</p>}
      <form className={`composer ${draggingFiles && !transitioning ? 'dragging-files' : ''}`} onSubmit={onSubmit}
        aria-busy={transitioning} onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest('button, input, textarea, [role="listbox"]')) textarea.current?.focus();
        }} onDragEnter={(event) => {
          if (transitioning || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingFiles(true);
        }} onDragOver={(event) => {
          if (transitioning || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }} onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDraggingFiles(false);
        }} onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDraggingFiles(false);
          if (transitioning) return;
          const itemFiles = Array.from(event.dataTransfer.items)
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          void attachFiles(itemFiles.length ? itemFiles : event.dataTransfer.files);
        }}>
      {draggingFiles && !transitioning && <div className="composer-drop-overlay" role="status">
        <MxIcon name="photo" size={16} /><span>Drop images, PDFs, or text files</span>
      </div>}
      {slashOpen && (
        <div ref={slashPalette} id="composer-slash-palette" className="slash-palette" role="listbox" aria-label="Slash commands">
          <header><Command size={13} /><span>Commands</span></header>
          {slashCommands.length ? slashCommands.map((command, index) => (
            <button type="button" role="option" aria-selected={index === slashIndex} key={command.name}
              id={`composer-slash-option-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => { void send(`/${paletteCommandToken(command)}`); }}>
              <code>{command.usage || `/${command.name}`}{command.params ? ` ${command.params}` : ''}</code>
              <span>{command.description}</span>
            </button>
          )) : <p>No matching command.</p>}
        </div>
      )}
      {mentionOpen && (
        <div ref={mentionPalette} id="composer-mention-palette"
          className="slash-palette mention-palette" role="listbox" aria-label="Project files">
          <header><MxIcon name="open-file" size={13} /><span>Files</span></header>
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
          }) : <p role="status">{mentionLoading ? 'Searching project files…' : 'No matching files.'}</p>}
        </div>
      )}
      {attachments.length > 0 && <div className="composer-attachments" aria-label="Attachments">
        {attachments.map((attachment) => <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
          {attachment.kind === 'image'
            ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
            : <span><MxIcon name="open-file" size={15} /></span>}
          <span data-tooltip={attachment.name}>{attachment.name}</span>
          <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => {
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
        aria-label="Message Mixdog" />
      <div className="composer-footer">
        <input ref={fileInput} type="file" hidden multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.md,.mdx,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.cc,.c,.h,.hh,.hpp,.sh,.zsh,.ps1,.bat,.cmd,.sql,.css,.scss,.sass,.html,.htm,.vue,.svelte,.env,.ini,.conf,.cfg,.gql,.graphql"
          onChange={(event) => { if (event.currentTarget.files) void attachFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
        <button type="button" className="composer-tool" disabled={transitioning} aria-label="Attach files" data-tooltip="Attach images, PDFs, or text files" data-tooltip-side="top"
        onClick={() => fileInput.current?.click()}><MxIcon name="plus" size={16} /></button>
        <ModelSelector provider={provider} model={model} effort={effort} fast={fast} fastCapable={fastCapable}
          modelDisabled={commandBusy || transitioning}
          tuningDisabled={turnBusy || commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot}
          onOpenSettings={onOpenSettings} />
        <WorkflowSelect workflow={workflow}
          disabled={turnBusy || commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot} />
        <button type="button"
          className={`composer-tool composer-mic ${dictationState !== 'idle' ? `is-${dictationState}` : ''}`.trim()}
          disabled={transitioning || dictationState === 'transcribing'}
          aria-label={dictationState === 'recording' ? 'Stop dictation' : 'Dictate with voice'}
          aria-pressed={dictationState === 'recording'}
          data-tooltip={dictationState === 'recording' ? 'Stop and transcribe'
            : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate (local Whisper)'}
          data-tooltip-side="top"
          onClick={() => void toggleDictation()}>
          {dictationState === 'transcribing' ? <LoaderCircle className="composer-mic-spinner" size={15} /> : <Mic size={15} />}
        </button>
        {turnBusy && !draft.trim() ? (
          <button type="button" className="send-button stop" onClick={() => void stop()}
            aria-label="Stop generation" data-tooltip="Stop" data-tooltip-side="top">
            <MxIcon name="stop" size={16} />
          </button>
        ) : (
          <button className="send-button"
            disabled={(!draft.trim() && !attachments.some((attachment) => !attachment.token)) || submitting || transitioning}
            aria-label={turnBusy ? "Queue or steer active turn" : commandBusy ? "Queue after current command" : "Send message"}
            data-tooltip={turnBusy ? "Queue or steer · Enter" : commandBusy ? "Queue after command · Enter" : "Send · Enter"}
            data-tooltip-side="top">
            <ArrowUp size={15} />
          </button>
        )}
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

export { providerSetupEntries, providerSetupState, workflowOptionsCache, WorkflowSelect, ModelSelector } from "./model-controls";
