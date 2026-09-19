import { X } from 'lucide-react';
import { ErrorNotice, errorSummary } from './ErrorNotice';
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  DesktopAbortOptions,
  DesktopCapability,
  DesktopModelSelection,
  DesktopPromptContent,
  DesktopSubmitOptions,
  SessionSnapshot,
} from '../shared/contract';
import { t } from './i18n';
import { ModelSelector } from './model-controls';
import { MxIcon } from './MxIcon';
import { shouldStopComposerGeneration } from './renderer-logic.mjs';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import { touchPrimaryPointer } from './surface-input-focus';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { pastedTextLineCount, shouldFoldPastedText } from '../../../../src/tui/paste-text-policy.mjs';

// Project-context pill, attachment budget, prompt history and the queued
// follow-up list live in composer-support.tsx.
import {
  COMPOSER_PLACEHOLDERS,
  PROJECT_CONTEXT_LOCAL,
  ProjectContextSelector,
  QueueList,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory,
} from './composer-support';
import {
  composerDraftAfterScopeChange,
  composerScopeOpensFreshDraft,
  stashComposerDraft,
  stashedComposerDraft,
} from './composer-draft';
import { useComposerDictation } from './use-composer-dictation';
import { useComposerAttachments } from './use-composer-attachments';
import { useComposerShareIntake } from './use-composer-share-intake';
import { useComposerQueue } from './use-composer-queue';
import { useComposerSubmission } from './use-composer-submission';
import { useComposerKeyboard } from './use-composer-keyboard';
import { useComposerFocus } from './use-composer-focus';
import { useComposerHistory } from './use-composer-history';
import { useComposerIme } from './use-composer-ime';
import { useComposerMessageSelector } from './use-composer-message-selector';
import { useComposerNotice } from './use-composer-notice';
import { useComposerPalettes } from './use-composer-palettes';
import { createSlashExecutor } from './composer-slash-executor';
import {
  AttachmentChips,
  DictationButton,
  DictationOverlay,
  MentionPalette,
  MessageSelectorPalette,
  SendButton,
  SlashPalette,
  composerPlaceholder,
} from './composer-surfaces';
import { ComposerAddMenu } from './ComposerAddMenu';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { CapabilityIcon } from './CapabilityIcon';
import { shouldRemoveSelectedSkill, skillTitle, useComposerSkill } from './composer-skill';
export {
  PROJECT_CONTEXT_LOCAL,
  ProjectContextSelector,
  promptHistoryStorageKey,
  queuedFollowupPreview,
  readPromptHistory,
};

const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.md,.mdx,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.cc,.c,.h,.hh,.hpp,.sh,.zsh,.ps1,.bat,.cmd,.sql,.css,.scss,.sass,.html,.htm,.vue,.svelte,.env,.ini,.conf,.cfg,.gql,.graphql';

// Perf diagnostics (MIXDOG_DESKTOP_PERF=1): keystroke→paint latency, logged
// only when a frame is actually slow.
function sampleKeystrokePaint(pending: MutableRefObject<boolean>) {
  if (!window.mixdogDesktop?.perfLog || pending.current) return;
  pending.current = true;
  const inputAt = performance.now();
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      pending.current = false;
      const ms = performance.now() - inputAt;
      if (ms >= 25) window.mixdogDesktop?.perfLog?.(`composer-keystroke paint=${ms.toFixed(0)}ms`);
    })
  );
}

function pastedFiles(clipboard: DataTransfer): File[] {
  const itemFiles = Array.from(clipboard.items || [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  return itemFiles.length ? itemFiles : Array.from(clipboard.files);
}

type ComposerProps = {
  turnBusy: boolean;
  commandBusy: boolean;
  transitioning: boolean;
  focusRequest: number;
  historyScope: string;
  /** Which conversation this composer paints — the session id, or
   *  `draft:<draftId>` for a New Task pane. State resets key on THIS, not on
   *  historyScope: staging a project on the SAME draft keeps the in-flight
   *  text, while pressing New task mints a new identity that opens clean. */
  identityScope: string;
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
  /** Session readout seated right after the model trigger — the context
   *  gauge (user: 컨텍스트는 모델 선택기 옆). */
  modelAside?: ReactNode;
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
};

export const Composer = memo(function Composer(props: ComposerProps) {
  const {
    turnBusy,
    commandBusy,
    transitioning,
    focusRequest,
    historyScope,
    identityScope,
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
    modelAside,
    queued,
    hiddenQueueIds,
    pendingSubmissionIds,
    onQueuedRestored,
    userMessages,
    submit,
    abort,
    invokeResult,
    applySnapshot,
    onOpenSettings,
    dropTargetRef,
    paneActive = true,
  } = props;
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submissionRecoveryVersion, setSubmissionRecoveryVersion] = useState(0);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  // A failed transport acknowledgement may still have landed in the session.
  // Reuse the same id when the exact restored payload is retried so daemon-side
  // idempotency acknowledges it instead of posting a duplicate user message.
  const submissionRetryRef = useRef<{ key: string; id: string } | null>(null);
  const { notice: composerNotice, showNotice: showComposerNotice, clearNotice } = useComposerNotice();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [composerFocused, setComposerFocused] = useState(false);
  const activeIdentityScope = useRef(identityScope);
  const skillSelection = useComposerSkill(identityScope);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const paletteAnchor = useRef<HTMLFormElement>(null);
  const composingRef = useRef(false);
  const suppressImeLineBreakRef = useRef(false);
  // True while the current Shift hold has already produced a character ('?' is
  // Shift+/), so the Enter that follows is a send, not a newline chord.
  const shiftLatchRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const escapeClearAtRef = useRef(0);
  const composerPaintSamplePending = useRef(false);
  const transitioningRef = useRef(transitioning);
  transitioningRef.current = transitioning;
  // Voice → send in one press. The transcript reaches the draft through a
  // state update, and `send` reads the textarea, so the intent is parked here
  // and fired by the effect below on the commit that carries the words.
  const voiceSubmitPending = useRef(false);
  const dictation = useComposerDictation({
    transitioningRef,
    textarea,
    setDraft,
    invokeResult,
    showNotice: showComposerNotice,
    requestVoiceInstall: useCallback(() => onOpenSettings('voice'), [onOpenSettings]),
    onTranscriptSubmit: useCallback(() => {
      voiceSubmitPending.current = true;
    }, []),
  });
  const history = useComposerHistory({ historyScope, promptHistoryList });
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
    historyNavigation: history.navigation,
    transitioningRef,
    projectScope,
    recoveryScope,
    submissionRecoveryVersion,
    dropTargetRef,
  });
  // A shared link or note arrives as text: it JOINS the draft instead of
  // replacing whatever the user already typed.
  const appendSharedText = useCallback(
    (text: string) => {
      setDraft((current) => {
        const next = current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text;
        draftRef.current = next;
        return next;
      });
      window.setTimeout(() => {
        textarea.current?.focus();
      }, 0);
    },
    [draftRef, setDraft, textarea]
  );
  useComposerShareIntake({
    active: paneActive && !transitioning,
    attachFiles,
    appendText: appendSharedText,
  });
  const invokeCapabilityResult = useCallback(
    async <T,>(capability: DesktopCapability, args: unknown[] = []) => {
      // Every command this composer issues belongs to the session IT paints —
      // the queue ×/Edit, /clear, /compact. Focus decides nothing.
      const result = await invokeResult(() =>
        window.mixdogDesktop.invokeCapability<T>({
          capability,
          args,
          ...(sessionId ? { sessionId } : {}),
        })
      );
      // Session commands already publish through the ordered session lane.
      // Their unversioned reply snapshot can arrive after a newer live frame;
      // replaying it here resurrected /compact's finished command spinner.
      if (!sessionId && result?.snapshot !== undefined) applySnapshot(result.snapshot);
      return result;
    },
    [applySnapshot, invokeResult, sessionId]
  );
  const invokeCapability = useCallback(
    async <T,>(capability: DesktopCapability, args: unknown[] = []) =>
      (await invokeCapabilityResult<T>(capability, args))?.value,
    [invokeCapabilityResult]
  );
  const queue = useComposerQueue({
    queued,
    hiddenQueueIds,
    pendingSubmissionIds,
    draftMode,
    turnBusy,
    draftRef,
    setDraft,
    textarea,
    composingRef,
    historyNavigation: history.navigation,
    invokeCapability,
    abort,
    restoredAttachments,
    mergeRestoredAttachments,
    showNotice: showComposerNotice,
    onQueuedRestored,
    scope: historyScope,
  });
  const selector = useComposerMessageSelector({
    userMessages,
    restoring: queue.restoring,
    setRestoring: queue.setRestoring,
    invokeCapability,
    setDraft,
    textarea,
    historyNavigation: history.navigation,
    showNotice: showComposerNotice,
  });
  const palettes = useComposerPalettes({
    draft,
    projectScope,
    paneActive,
    transitioning,
    composerFocused,
    selectorOpen: selector.open,
  });
  const { setCaretOffset, slash, mention } = palettes;
  useComposerIme({ textarea, composingRef, suppressImeLineBreakRef, draftRef, setDraft, setCaretOffset });
  useLayoutEffect(() => {
    if (activeIdentityScope.current === identityScope) return;
    const previousScope = activeIdentityScope.current;
    activeIdentityScope.current = identityScope;
    // Park the text the user typed in the tab being left, so returning to
    // that tab hands it back instead of opening empty.
    const leavingElement = textarea.current;
    stashComposerDraft(
      previousScope,
      document.activeElement === leavingElement && leavingElement ? leavingElement.value : draftRef.current
    );
    resetAttachments();
    composingRef.current = false;
    suppressImeLineBreakRef.current = false;
    palettes.invalidateSearch();
    // Scope settles ASYNC after a session switch/promotion; when the user is
    // ALREADY typing in the composer, the in-flight text carries over instead
    // of being wiped (user bug: draft vanished + scroll jumped mid-sentence).
    const typingElement = textarea.current;
    const typingLive = document.activeElement === typingElement;
    // A fresh New Task pane is the exception: it ALWAYS opens clean (user:
    // 새작업 pulled the previous pane's text and attachments along).
    const freshDraft = composerScopeOpensFreshDraft(identityScope);
    setDraft((current) => {
      // A remote snapshot can change scope in the same turn as a native input
      // event. The DOM already owns the newest character while React state may
      // still be one commit behind, so preserve the focused DOM value instead
      // of briefly writing the stale controlled value back into the textarea.
      const next = composerDraftAfterScopeChange({
        currentDraft: current,
        liveDomDraft: typingElement?.value ?? current,
        freshDraft,
        typingLive,
        stashedDraft: stashedComposerDraft(identityScope),
      });
      draftRef.current = next;
      return next;
    });
    clearNotice();
    setComposerFocused(false);
    palettes.reset();
    setDraggingFiles(false);
    selector.reset();
    history.navigation.current = { index: -1, seed: '' };
  }, [identityScope, resetAttachments, clearNotice, palettes.reset, palettes.invalidateSearch, selector.reset]);
  const placeholder = composerPlaceholder({
    hasConversation,
    turnBusy,
    commandBusy,
    fallback: COMPOSER_PLACEHOLDERS[0],
  });
  // Autosize is CSS-native now (field-sizing: content). The old layout-effect
  // path forced TWO whole-document synchronous reflows per keystroke
  // (height:auto → scrollHeight read) — the measured source of typing lag on
  // long transcripts.
  useEffect(() => {
    if (!transitioning) return;
    setDraggingFiles(false);
  }, [transitioning]);
  useComposerFocus({ textarea, transitioning, focusRequest, paneActive });
  useEffect(() => {
    const receiveDraft = (event: Event) => {
      const text = String((event as CustomEvent<unknown>).detail || '');
      if (!text) return;
      setDraft((current) => {
        const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`;
        draftRef.current = next;
        return next;
      });
      history.navigation.current = { index: -1, seed: '' };
      window.setTimeout(() => textarea.current?.focus(), 0);
    };
    window.addEventListener('mixdog:composer-draft', receiveDraft);
    return () => window.removeEventListener('mixdog:composer-draft', receiveDraft);
  }, []);

  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  useEffect(() => setGoalDialogOpen(false), [identityScope, paneActive]);
  const executeSlash = createSlashExecutor({
    draftMode,
    sessionId,
    turnBusy,
    provider,
    model,
    effort,
    fast,
    fastCapable,
    modelParameters,
    onDraftModelSelection,
    onRoutePreferenceApplied,
    invokeResult,
    invokeCapabilityResult,
    applySnapshot,
    submit,
    setAttachmentError,
    clearNotice,
    showNotice: showComposerNotice,
    openGoalDialog: () => setGoalDialogOpen(true),
    onNewTask: props.onNewTask,
    onClearToNewTask: props.onClearToNewTask,
    onResumeSession: props.onResumeSession,
    onOpenSessions: props.onOpenSessions,
    onOpenProjects: props.onOpenProjects,
    onOpenSettings,
    onOpenCommandSurface: props.onOpenCommandSurface,
  });

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
    historyNavigation: history.navigation,
    setDraft,
    setSubmitting,
    setSubmissionRecoveryVersion,
    clearNotice,
    setAttachmentError,
    removeAttachments,
    mergeRestoredAttachments,
    restoredAttachments,
    executeSlash,
    rememberPrompt: history.rememberPrompt,
    submit,
    abort,
    onQueuedRestored,
    selectedSkill: skillSelection.name,
    onSkillSubmitted: skillSelection.submitted,
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send('', 'form-submit');
  };
  const { selectMention, onKeyDown, onKeyUp } = useComposerKeyboard({
    draft: {
      value: draft,
      set: setDraft,
      ref: draftRef,
      textarea,
      setCaretOffset,
    },
    slash,
    mention,
    selector,
    history: {
      entries: history.entries,
      navigation: history.navigation,
      seedAttachments: history.seedAttachments,
      attachmentsRef,
      replaceAttachments,
    },
    queue: {
      pendingSubmissionId: queue.pendingSubmissionId,
      hasRestorableMessages: queue.hasRestorableQueuedMessages,
      restore: (source) => {
        void queue.restoreQueue('', source);
      },
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
  const voiceSend = !stopOnly && dictation.dictationState === 'recording';
  useEffect(() => {
    if (!voiceSubmitPending.current || dictation.dictationState !== 'idle') return;
    voiceSubmitPending.current = false;
    void send('', 'voice-submit');
  }, [dictation.dictationState, draft, send]);

  const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    sampleKeystrokePaint(composerPaintSamplePending);
    const value = event.currentTarget.value;
    draftRef.current = value;
    setDraft(value);
    escapeClearAtRef.current = 0;
    if (attachmentError) setAttachmentError('');
    if (composerNotice) clearNotice();
    setCaretOffset(event.currentTarget.selectionStart);
    if (slash.dismissed) slash.setDismissed('');
    if (mention.dismissed) mention.setDismissed('');
    history.navigation.current = { index: -1, seed: '' };
  };
  const onTextareaBlur = () => {
    composingRef.current = false;
    suppressImeLineBreakRef.current = false;
    shiftLatchRef.current = false;
    setComposerFocused(false);
  };
  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const removeSkill = shouldRemoveSelectedSkill({
      selected: skillSelection.name,
      key: event.key,
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
      composing: composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229,
      repeat: event.repeat,
      modified: event.ctrlKey || event.metaKey || event.altKey,
    });
    if (removeSkill) {
      event.preventDefault();
      event.stopPropagation();
      skillSelection.select('');
      return;
    }
    onKeyDown(event);
  };
  const onTextareaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = pastedFiles(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      void attachFiles(files);
      return;
    }
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    if (!shouldFoldPastedText(text)) return;
    const id = attachmentSequence.current++;
    const lines = pastedTextLineCount(text);
    const inserted = insertAttachment({
      id,
      name: `Pasted text · ${lines} lines`,
      kind: 'text',
      mimeType: 'text/plain',
      data: text,
      token: `[Pasted text #${id} +${lines} lines]`,
      source: 'paste',
      chipOnly: true,
    });
    if (inserted) event.preventDefault();
  };
  const focusTextareaFromForm = (event: React.MouseEvent<HTMLFormElement>) => {
    if (touchPrimaryPointer()) return;
    const target = event.target as HTMLElement;
    if (!target.closest('button, input, textarea, [role="listbox"]')) textarea.current?.focus();
  };
  const goalDisabled = turnBusy || commandBusy || submitting;
  return (
    <>
      <QueueList
        queued={queue.visibleQueued}
        restoring={queue.restoring}
        onEdit={(id) => void queue.restoreQueue(id, 'queue-row')}
        onSteer={(id) => void queue.steerQueuedNow(id)}
        onRemove={(id) => void queue.discardQueued(id)}
      />
      {/* Error/notice banners float ABOVE the input card (user-flagged: they
          previously rendered inside the pill and read as composer content). */}
      {attachmentError && <ErrorNotice error={attachmentError} onDismiss={() => setAttachmentError('')} />}
      {composerNotice && (
        <p className="composer-notice" role="status">
          <span>{errorSummary(composerNotice)}</span>
          <button
            type="button"
            className="composer-banner-close"
            aria-label={t('Dismiss notice')}
            onClick={() => showComposerNotice('')}
          >
            <X size={14} />
          </button>
        </p>
      )}
      {draggingFiles &&
        !transitioning &&
        dropTargetRef.current &&
        createPortal(
          <div className="task-drop-overlay" role="status">
            <MxIcon name="photo" size={16} />
            <span>{t('Drop files or paths')}</span>
          </div>,
          dropTargetRef.current
        )}
      <form
        ref={paletteAnchor}
        className="composer"
        onSubmit={onSubmit}
        data-composer-palette-open={selector.open || slash.open || mention.open ? 'true' : undefined}
        aria-busy={transitioning}
        onMouseDown={focusTextareaFromForm}
      >
        {selector.open && (
          <MessageSelectorPalette
            anchor={paletteAnchor}
            panel={selector.palette}
            messages={selector.messages}
            index={selector.index}
            setIndex={selector.setIndex}
            onSelect={(id) => void selector.rewindToMessage(id)}
          />
        )}
        {slash.open && (
          <SlashPalette
            anchor={paletteAnchor}
            panel={slash.palette}
            commands={slash.commands}
            index={slash.index}
            setIndex={slash.setIndex}
            onSelect={(usage) => void send(usage)}
          />
        )}
        {mention.open && (
          <MentionPalette
            anchor={paletteAnchor}
            panel={mention.palette}
            results={mention.results}
            loading={mention.loading}
            index={mention.index}
            setIndex={mention.setIndex}
            onSelect={selectMention}
          />
        )}
        {attachments.length > 0 && (
          <AttachmentChips attachments={attachments} onRemove={removeAttachment} onError={setAttachmentError} />
        )}
        {dictation.dictationState !== 'idle' && (
          <DictationOverlay
            state={dictation.dictationState}
            levelRef={dictation.dictationLevelRef}
            elapsedMs={dictation.recordingElapsedMs}
            onCancel={() => dictation.cancelDictation()}
          />
        )}
        <div className="composer-input-row">
          {skillSelection.name && (
            <span className="composer-selected-skill">
              <button type="button" onClick={() => textarea.current?.focus()} title={skillSelection.name}>
                <CapabilityIcon name={skillSelection.name} />
                <span>{skillTitle(skillSelection.name)}</span>
              </button>
            </span>
          )}
          <textarea
            ref={textarea}
            value={draft}
            onChange={onTextareaChange}
            onFocus={() => setComposerFocused(true)}
            onBlur={onTextareaBlur}
            onPointerDown={() => {
              escapeClearAtRef.current = 0;
            }}
            onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)}
            onKeyDown={onTextareaKeyDown}
            onKeyUp={onKeyUp}
            onPaste={onTextareaPaste}
            rows={1}
            placeholder={placeholder}
            disabled={transitioning}
            aria-controls={palettes.paletteId}
            aria-expanded={slash.open || mention.open}
            aria-activedescendant={palettes.activeDescendant}
            aria-label={t('Message Mixdog')}
          />
        </div>
        <div className="composer-footer">
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept={ATTACHMENT_ACCEPT}
            onChange={(event) => {
              if (event.currentTarget.files) void attachFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          {goalDialogOpen && (
            <ComposerGoalDialog
              anchor={textarea}
              disabled={goalDisabled}
              onStart={executeSlash}
              onClose={() => setGoalDialogOpen(false)}
              returnFocus={() => textarea.current?.focus()}
            />
          )}
          <ComposerAddMenu
            key={identityScope}
            anchor={paletteAnchor}
            sessionId={sessionId}
            disabled={transitioning || !paneActive}
            goalDisabled={goalDisabled}
            onAttach={() => fileInput.current?.click()}
            onSkill={(name) => {
              skillSelection.select(name);
              mention.setDismissed(mention.signature);
              queueMicrotask(() => textarea.current?.focus());
            }}
            onGoal={executeSlash}
            onMore={() => onOpenSettings('skills')}
          />
          <ModelSelector
            provider={provider}
            model={model}
            effort={effort}
            fast={fast}
            fastCapable={fastCapable}
            modelParameters={modelParameters}
            contextPercent={contextPercent}
            sessionId={sessionId}
            // Model writes are queued by the session API. A preceding write must
            // not disable the next selection while its acknowledgement travels.
            modelDisabled={transitioning}
            // Effort/Fast stay live during a turn: the running turn already
            // captured its own effort/fast at turn start, so a change here lands
            // on the NEXT turn instead of being locked out. Only session-command
            // churn still disables the controls.
            tuningDisabled={commandBusy || transitioning}
            invokeResult={invokeResult}
            applySnapshot={applySnapshot}
            onOpenSettings={onOpenSettings}
            onDraftSelection={onDraftModelSelection}
            onRoutePreferenceApplied={onRoutePreferenceApplied}
          />
          {modelAside && <span className="composer-model-aside">{modelAside}</span>}
          <span className="composer-primary-actions">
            {/* The mic appears only once the voice runtime is installed
            (Extensions → Voice transcription): an uninstalled feature never
            advertises itself in the composer. */}
            {dictation.dictationInstalled && (
              <DictationButton
                state={dictation.dictationState}
                disabled={transitioning || dictation.dictationState === 'transcribing'}
                onToggle={() => void dictation.toggleDictation()}
              />
            )}
            <SendButton
              stopOnly={stopOnly}
              voiceSend={voiceSend}
              submitting={submitting}
              turnBusy={turnBusy}
              commandBusy={commandBusy}
              transitioning={transitioning}
              hasConversation={hasConversation}
              dictationState={dictation.dictationState}
              draft={draft}
              attachments={attachments}
              onStop={() => void stop()}
              onStopDictationAndSend={() => void dictation.stopDictationAndSend()}
            />
          </span>
        </div>
      </form>
    </>
  );
});

// The terminal picker's normalizeModelOptions is the authority for WHICH
// models surface (family grouping/limits, recency ordering). The desktop
// modal only owns presentation. Shapes differ: desktop uses `model`, the
// TUI uses `id`.

export {
  ModelSelector,
  WorkflowSelect,
  OrchestrationModeSelect,
  providerSetupEntries,
  providerSetupState,
} from './model-controls';
