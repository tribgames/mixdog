import React, {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type {
  DesktopAbortOptions,
  DesktopModelSelection,
  DesktopPromptContent,
  DesktopSubmitOptions,
  SessionSnapshot,
} from '../shared/contract';
import { t } from './i18n';
import { useConversationReleaseHold } from './conversation-release';
import { hasSendablePromptContent, shouldStopComposerGeneration } from './renderer-logic.mjs';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import { touchPrimaryPointer } from './surface-input-focus';
// @ts-expect-error The shared TUI module is plain ESM and has no declaration file.
import { shouldFoldPastedText } from '../../../../src/tui/paste-text-policy.mjs';

// Project-context pill, attachment budget and prompt history live in
// composer-support.tsx.
import {
  ATTACHMENT_ACCEPT,
  COMPOSER_PLACEHOLDERS,
  pastedTextFields,
  type ComposerAttachment,
} from './composer-support';
import { ComposerPastedTextDialog } from './ComposerPastedTextDialog';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { RouteSessionChoice } from './route-editor-panes';
import { SteerContext } from './steer-actions';
import {
  composerAttachmentsCarryOver,
  composerDraftAfterScopeChange,
  composerScopeOpensFreshDraft,
  dropComposerDraft,
  noteComposerContent,
  persistComposerDrafts,
  stashComposerAttachments,
  stashComposerDraft,
  stashComposerTags,
  stashedComposerDraft,
  takeDraftPromotion,
  takeStashedComposerAttachments,
} from './composer-draft';
import { useComposerDictation, withTranscript } from './use-composer-dictation';
import { useComposerAttachments } from './use-composer-attachments';
import { useComposerCapability } from './use-composer-capability';
import { useComposerExternalDraft } from './use-composer-external-draft';
import { useComposerPromptRestore } from './use-composer-prompt-restore';
import { type SubmittedDraft, useComposerSubmission } from './use-composer-submission';
import { useComposerKeyboard } from './use-composer-keyboard';
import { useComposerFocus } from './use-composer-focus';
import { restoreDraftHandoff } from './composer-attachment-restore';
import { useComposerHistory } from './use-composer-history';
import { useComposerIme } from './use-composer-ime';
import { useComposerMessageSelector } from './use-composer-message-selector';
import { useComposerNotice } from './use-composer-notice';
import { useComposerPalettes } from './use-composer-palettes';
import { createSlashExecutor } from './composer-slash-executor';
import { attachmentContextNotice } from './composer-attachments';
import { backfillAgentChatRoute } from './agent-chat-route';
import { BtwCard, useBtwCard } from './BtwCard';
import { readCachedModelCatalog } from './model-catalog-cache';
import { useAgentRoute } from './acp-agent-status';
import { modelOffersUltrafast } from './model-route-utils';
import {
  AttachmentChips,
  DictationOverlay,
  MentionPalette,
  MessageSelectorPalette,
  SkillMentionPalette,
  SlashPalette,
  composerPlaceholder,
} from './composer-surfaces';
import { disabledMentionedSkills, useComposerSkillHighlight, useSkillCatalog } from './composer-skill-mentions';
import { ComposerBanners } from './ComposerBanners';
import {
  type ComposerModelControlProps,
  ComposerFooter,
  ComposerModelControls,
  ComposerModelLine,
} from './ComposerFooter';
import { useMobileRemoteSurface } from './mobile-surface';
import { useOneLineOverflow } from './composer-card-layout';
import { CapabilityIcon } from './CapabilityIcon';
import { shouldRemoveSelectedSkill, skillTitle, useComposerSkill } from './composer-skill';
import { VisualizeFeedbackCards } from './VisualizeFeedbackCards';
import {
  RoomAskChip,
  RoomAskPalette,
  RoomMentionChip,
  draftAskingMore,
  roomAskCandidates,
  roomAskTargets,
  useComposerRoomMembers,
} from './composer-room-ask';
import { useComposerRoomTags } from './use-composer-room-tags';
import { useVisualizeFeedback, visualizeFeedbackPending } from './visualize-feedback-store';

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

type ComposerAttachmentsApi = ReturnType<typeof useComposerAttachments>;

/** Rich copies (Word, Excel, browsers) carry a rendered image beside their text, so files attach only when the clipboard holds no plain text. */
function handleComposerPaste(
  event: React.ClipboardEvent<HTMLTextAreaElement>,
  {
    attachFiles,
    attachmentSequence,
    insertAttachment,
  }: {
    attachFiles: ComposerAttachmentsApi['attachFiles'];
    attachmentSequence: ComposerAttachmentsApi['attachmentSequence'];
    insertAttachment: ComposerAttachmentsApi['insertAttachment'];
  }
) {
  const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
  const files = text.trim() ? [] : pastedFiles(event.clipboardData);
  if (files.length) {
    event.preventDefault();
    void attachFiles(files);
    return;
  }
  if (!shouldFoldPastedText(text)) return;
  const id = attachmentSequence.current++;
  const inserted = insertAttachment({
    id,
    ...pastedTextFields(id, text),
    kind: 'text',
    mimeType: 'text/plain',
    source: 'paste',
    chipOnly: true,
  });
  if (inserted) event.preventDefault();
}

/** Identity-scope transition: park the text of the pane being left, then open
 *  the incoming one with what it parked, or, when the draft left became this
 *  session, with the text it holds. Every transient surface (palettes,
 *  selector, notice, drag) resets with it. Returns whether the draft left
 *  became the incoming session. */
function switchComposerIdentity({
  identityScope,
  previousScope,
  textarea,
  draftRef,
  composingRef,
  suppressImeLineBreakRef,
  historyNavigation,
  attachmentsRef,
  resetAttachments,
  replaceAttachments,
  palettes,
  selector,
  setDraft,
  clearNotice,
  setComposerFocused,
  setDraggingFiles,
}: {
  identityScope: string;
  previousScope: string;
  textarea: { current: HTMLTextAreaElement | null };
  draftRef: { current: string };
  composingRef: { current: boolean };
  suppressImeLineBreakRef: { current: boolean };
  historyNavigation: { current: { index: number; seed: string } };
  attachmentsRef: { current: ComposerAttachment[] };
  resetAttachments(): void;
  replaceAttachments(attachments: ComposerAttachment[]): void;
  palettes: { reset(): void; invalidateSearch(): void };
  selector: { reset(): void };
  setDraft: Dispatch<SetStateAction<string>>;
  clearNotice(): void;
  setComposerFocused(focused: boolean): void;
  setDraggingFiles(dragging: boolean): void;
}): boolean {
  // Park the text the user typed in the tab being left, so returning to
  // that tab hands it back instead of opening empty. A draft that became
  // this session is never shown again: nothing is parked under it.
  const promotingDraft = takeDraftPromotion(previousScope, identityScope);
  const leavingElement = textarea.current;
  if (promotingDraft) {
    dropComposerDraft(previousScope);
  } else {
    stashComposerDraft(
      previousScope,
      document.activeElement === leavingElement && leavingElement ? leavingElement.value : draftRef.current
    );
  }
  const typingElement = textarea.current;
  const typingLive = document.activeElement === typingElement;
  // A fresh New Task pane is the exception: it ALWAYS opens clean.
  const freshDraft = composerScopeOpensFreshDraft(identityScope);
  const parkedAttachments = takeStashedComposerAttachments(identityScope);
  if (composerAttachmentsCarryOver({ freshDraft, promotingDraft, parkedCount: parkedAttachments.length })) {
    stashComposerAttachments(previousScope, []);
  } else {
    stashComposerAttachments(previousScope, attachmentsRef.current);
    resetAttachments();
    replaceAttachments(parkedAttachments);
  }
  composingRef.current = false;
  suppressImeLineBreakRef.current = false;
  palettes.invalidateSearch();
  setDraft((current) => {
    const next = composerDraftAfterScopeChange({
      currentDraft: current,
      liveDomDraft: typingElement?.value ?? current,
      typingLive,
      stashedDraft: stashedComposerDraft(identityScope),
      sameConversation: promotingDraft,
    });
    draftRef.current = next;
    return next;
  });
  clearNotice();
  setComposerFocused(false);
  palettes.reset();
  setDraggingFiles(false);
  selector.reset();
  historyNavigation.current = { index: -1, seed: '' };
  return promotingDraft;
}

export type ComposerProps = {
  /** Opens a staged attachment in the editor pane (the transcript's file opener). */
  onOpenFile?: (project: string, rel: string, line?: number, accessToken?: string) => void;
  turnBusy: boolean;
  commandBusy: boolean;
  transitioning: boolean;
  /** The session this composer belongs to is not loaded yet (the pane was just pointed at it): a send or a goal started
   *  now waits for its lane, and runs with that session's own state once the lane lands. */
  held?: boolean;
  /** The held session's lane cannot be read: what waits for it is dropped, and the draft stays as it is. */
  laneUnavailable?: boolean;
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
  /** The route's own Auto reasoning flag; absent means on. */
  autoEffort?: boolean;
  modelParameters?: Record<string, string>;
  contextPercent?: number;
  contextTokens?: number;
  draftMode?: boolean;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
  /** A conversation's workflow / delegation rows in the model menu. */
  sessionChoices?: RouteSessionChoice[];
  /** Session readout seated right after the model trigger — the context
   *  gauge. */
  modelAside?: ReactNode;
  /** The line under the card's left end: the last turn's speed and cache hit. */
  usageReadout?: ReactNode;
  /** Before the first message: the Project / Workflow / Delegation / Branch
   *  pickers. On a desktop they take the line under the card; a phone shows
   *  them in a line of their own above it. */
  contextBar?: ReactNode;
  /** Messages sent while the turn runs that the model has not read yet. */
  steerItems?: PendingPromptItem[];
  pendingSubmissionIds?: Array<string | number>;
  onQueuedRestored?: (ids: string[]) => void;
  /** A slash command sent mid-turn that the session holds for the turn's end. */
  onSlashHeld?: (text: string) => void;
  /** A prompt another device cancelled, handed back to the device that sent it. */
  promptRestore?: { id: string; ids: string[]; text: string; device: string; at: number } | null;
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
  /** /inherit carries this session into a new one in place. */
  onInherit?: () => Promise<boolean>;
  dropTargetRef: React.RefObject<HTMLElement | null>;
  /** This pane is the focused, visible one. A payload shared into the app from
   *  outside (share sheet) may only land in a composer the user can see. */
  paneActive?: boolean;
  /** Replaces the rotating placeholder (a pending question: sending answers it). */
  placeholderOverride?: string;
  /** The session panel is a column beside the pane and carries the model,
   *  route, usage and context: the composer is input, attachments and send. */
  bare?: boolean;
  /** Agent mode: a one-line messenger bar with the agent's route shown
   *  read-only under it; `/` and `$` are plain text, and `@` tags the room
   *  member who answers. */
  agentMode?: boolean;
};

// The document listener can survive many composer renders. Keep its
// lexical environment separate from submit and the rest of the pane.
function usePersistDraftOnHide(
  identityScope: string,
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  draftRef: React.RefObject<string>
) {
  useEffect(() => {
    const save = (event: Event): void => {
      if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      const element = textarea.current;
      stashComposerDraft(
        identityScope,
        document.activeElement === element && element ? element.value : draftRef.current
      );
      persistComposerDrafts();
    };
    document.addEventListener('visibilitychange', save);
    window.addEventListener('pagehide', save);
    return () => {
      document.removeEventListener('visibilitychange', save);
      window.removeEventListener('pagehide', save);
    };
  }, [identityScope, textarea, draftRef]);
}

/** A message taken back from the transcript (✕ on an unread bubble, an
 *  answer that did not go out) returns to this editor. While `held`, the
 *  transcript is the outgoing session's and this editor is not its own: none is lent. */
function useComposerSteerHandoff({
  held,
  activeIdentityScope,
  recoveryScopeRef,
  draftRef,
  attachmentsRef,
  replaceAttachments,
  restoredAttachments,
  mergeRestoredAttachments,
  setDraft,
  historyNavigation,
  textarea,
  showNotice,
  keepSubmissionId,
}: {
  held: boolean;
  activeIdentityScope: { current: string };
  recoveryScopeRef: { current: string };
  draftRef: { current: string };
  attachmentsRef: ComposerAttachmentsApi['attachmentsRef'];
  replaceAttachments: ComposerAttachmentsApi['replaceAttachments'];
  restoredAttachments: ComposerAttachmentsApi['restoredAttachments'];
  mergeRestoredAttachments: ComposerAttachmentsApi['mergeRestoredAttachments'];
  setDraft: Dispatch<SetStateAction<string>>;
  historyNavigation: { current: { index: number; seed: string } };
  textarea: { current: HTMLTextAreaElement | null };
  showNotice: (notice: string) => void;
  keepSubmissionId: (submissionId: string) => void;
}) {
  const steer = useContext(SteerContext);
  useEffect(() => {
    if (!steer || held) return undefined;
    const handoff: typeof steer.draft.current = {
      scope: () => activeIdentityScope.current,
      recoveryScope: () => recoveryScopeRef.current,
      restore(value, { ifEmpty = false, replace = false, notice, submissionId } = {}) {
        const holdsNothing = !draftRef.current.trim() && attachmentsRef.current.length === 0;
        if (
          !restoreDraftHandoff(
            { draftRef, attachmentsRef, replaceAttachments, restoredAttachments, mergeRestoredAttachments, setDraft },
            value,
            { ifEmpty, replace }
          )
        )
          return false;
        // Only a draft that is that message alone resends it; one joined to typed text is a new message.
        if (submissionId && (holdsNothing || replace)) keepSubmissionId(submissionId);
        historyNavigation.current = { index: -1, seed: '' };
        if (notice) showNotice(notice);
        window.setTimeout(() => textarea.current?.focus(), 0);
        return true;
      },
    };
    steer.draft.current = handoff;
    return () => {
      if (steer.draft.current === handoff) steer.draft.current = null;
    };
  }, [
    steer,
    held,
    activeIdentityScope,
    recoveryScopeRef,
    draftRef,
    attachmentsRef,
    replaceAttachments,
    restoredAttachments,
    mergeRestoredAttachments,
    setDraft,
    showNotice,
    historyNavigation,
    textarea,
    keepSubmissionId,
  ]);
}

export const Composer = memo(function Composer(props: ComposerProps) {
  const {
    onOpenFile,
    turnBusy,
    commandBusy,
    transitioning,
    held = false,
    laneUnavailable = false,
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
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens,
    draftMode,
    onDraftModelSelection,
    onRoutePreferenceApplied,
    sessionChoices,
    modelAside,
    usageReadout,
    contextBar,
    steerItems,
    pendingSubmissionIds,
    onQueuedRestored,
    onSlashHeld,
    promptRestore,
    userMessages,
    submit,
    abort,
    invokeResult,
    applySnapshot,
    onOpenSettings,
    dropTargetRef,
    paneActive = true,
    placeholderOverride,
    agentMode = false,
    bare = false,
  } = props;
  // A page reloaded or relaunched while a prompt was half-typed opens with it.
  const [draft, setDraft] = useState(() => stashedComposerDraft(identityScope));
  const [submitting, setSubmitting] = useState(false);
  const [submissionRecoveryVersion, setSubmissionRecoveryVersion] = useState(0);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  // A failed transport acknowledgement may still have landed in the session.
  // Reuse the same id when the exact restored payload is retried so daemon-side
  // idempotency acknowledges it instead of posting a duplicate user message.
  const submissionRetryRef = useRef<{ key: string; id: string } | null>(null);
  const { showNotice: showComposerNotice, clearNotice } = useComposerNotice();
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [composerFocused, setComposerFocused] = useState(false);
  const activeIdentityScope = useRef(identityScope);
  const recoveryScopeRef = useRef(recoveryScope);
  recoveryScopeRef.current = recoveryScope;
  const skillSelection = useComposerSkill(identityScope);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const paletteAnchor = useRef<HTMLFormElement>(null);
  const composingRef = useRef(false);
  const suppressImeLineBreakRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const escapeClearAtRef = useRef(0);
  const composerPaintSamplePending = useRef(false);
  const transitioningRef = useRef(transitioning);
  transitioningRef.current = transitioning;
  // Voice → send in one press: the take's words, joined to the draft, are sent in the commit that ends the take. The
  // editor shows them only when the send cannot go out (no model, a chip still loading, a lane not landed yet).
  const voiceSubmitRef = useRef<(text: string, take: Omit<SubmittedDraft, 'draft'>) => void>(() => {});
  const dictation = useComposerDictation({
    keysActive: paneActive,
    identityScope,
    transitioningRef,
    textarea,
    setDraft,
    invokeResult,
    showNotice: showComposerNotice,
    requestVoiceInstall: useCallback(() => onOpenSettings('voice'), [onOpenSettings]),
    onTranscriptSubmit: useCallback(
      (text: string, take: Omit<SubmittedDraft, 'draft'>) => voiceSubmitRef.current(text, take),
      []
    ),
  });
  const history = useComposerHistory({ historyScope, promptHistoryList });
  // Recoveries parked for a conversation join its draft once the identity switch below has opened that draft:
  // drained first, the switch would park them with the conversation being left.
  const [recoveryDrainScope, setRecoveryDrainScope] = useState(recoveryScope);
  const {
    attachments,
    attachmentsRef,
    pendingLoads,
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
    updatePastedText,
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
    recoveryScope: recoveryDrainScope,
    submissionRecoveryVersion,
    dropTargetRef,
  });
  useConversationReleaseHold(
    () =>
      draftRef.current.length > 0 ||
      attachmentsRef.current.length > 0 ||
      history.navigation.current.index >= 0 ||
      submissionRetryRef.current !== null
  );
  // Attachment, slash-usage and submission failures surface as error toasts;
  // the state is consumed so the same failure can raise a toast again.
  useEffect(() => {
    if (!attachmentError) return;
    showComposerNotice(attachmentError, 'error');
    setAttachmentError('');
  }, [attachmentError, setAttachmentError, showComposerNotice]);
  // Large PDF sets get one size notice before sending, again only when the
  // estimate changes.
  const attachmentNotice = attachmentContextNotice(attachments);
  const shownAttachmentNotice = useRef('');
  useEffect(() => {
    if (attachmentNotice === shownAttachmentNotice.current) return;
    shownAttachmentNotice.current = attachmentNotice;
    if (attachmentNotice) showComposerNotice(attachmentNotice, 'info');
  }, [attachmentNotice, showComposerNotice]);
  useComposerExternalDraft({
    draftRef,
    setDraft,
    textarea,
    historyNavigation: history.navigation,
    attachFiles,
    shareActive: paneActive && !transitioning,
  });
  const { invokeCapabilityResult, invokeCapability } = useComposerCapability({
    invokeResult,
    applySnapshot,
    sessionId,
  });
  // The message selector's rewind holds the editor while it runs; a scope
  // switch releases it.
  const [restoring, setRestoring] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyScope is the reset trigger; the body does not read it
  useEffect(() => setRestoring(false), [historyScope]);
  // The prompt this pane sent last that has not settled: Esc interrupts it
  // before the busy snapshot paints.
  const pendingSubmissionId =
    !draftMode && Array.isArray(pendingSubmissionIds)
      ? String(pendingSubmissionIds[pendingSubmissionIds.length - 1] || '').trim()
      : '';
  useComposerPromptRestore({
    promptRestore,
    sessionId: sessionId || '',
    setDraft,
    draftRef,
    textarea,
    onQueuedRestored,
  });
  const selector = useComposerMessageSelector({
    sessionId: sessionId || '',
    userMessages,
    restoring,
    setRestoring,
    invokeCapability,
    setDraft,
    textarea,
    historyNavigation: history.navigation,
    showNotice: showComposerNotice,
  });
  const skillCatalog = useSkillCatalog(sessionId, projectScope);
  const isEnabledSkill = useCallback((name: string) => skillCatalog.enabled.has(name), [skillCatalog]);
  // A group room's members: /ask and the + menu address one of them.
  const roomMembers = useComposerRoomMembers(sessionId);
  const askTargets = roomAskTargets(draft, roomMembers);
  const askCandidates = composerFocused && paneActive && !agentMode ? roomAskCandidates(draft, roomMembers) : [];
  const askMember = (agentId: string) => {
    const next = draftAskingMore(draftRef.current, agentId);
    draftRef.current = next;
    setDraft(next);
    queueMicrotask(() => textarea.current?.focus());
  };
  const agentRoute = useAgentRoute(provider, model);
  const palettes = useComposerPalettes({
    draft,
    projectScope,
    paneActive,
    transitioning,
    composerFocused,
    selectorOpen: selector.open,
    skills: skillCatalog.selectable,
    userMessages,
    room: Boolean(roomMembers),
    plain: agentMode,
    notApplicable: agentRoute?.notApplicable,
  });
  const { setCaretOffset, slash, mention, skillMention } = palettes;
  const tags = useComposerRoomTags({
    identityScope,
    agentMode,
    roomMembers,
    draft,
    draftRef,
    setDraft,
    textarea,
    setCaretOffset,
    mention,
    composerFocused,
    paneActive,
    submit,
  });
  const taggedRef = tags.taggedRef;
  // A composer that goes away inside the app run (pane closed or rebuilt)
  // parks what it holds exactly as a tab switch does, and a fresh one opens
  // with what its identity parked.
  useLayoutEffect(() => {
    const restored = takeStashedComposerAttachments(activeIdentityScope.current);
    if (restored.length) replaceAttachments(restored);
    return () => {
      const scope = activeIdentityScope.current;
      const element = textarea.current;
      stashComposerDraft(scope, document.activeElement === element && element ? element.value : draftRef.current);
      stashComposerAttachments(scope, attachmentsRef.current);
      stashComposerTags(scope, taggedRef.current);
    };
  }, [attachmentsRef, replaceAttachments, taggedRef]);
  const skillHighlight = useComposerSkillHighlight({
    textarea,
    text: draft,
    isSkill: isEnabledSkill,
    disabled: transitioning || agentMode,
  });
  const offSkills = disabledMentionedSkills(draft, skillCatalog);
  useComposerIme({ textarea, composingRef, suppressImeLineBreakRef, draftRef, setDraft, setCaretOffset });
  // biome-ignore lint/correctness/useExhaustiveDependencies: must switch only when identityScope changes; the other captures are read at that moment and a re-run on their identity would reset the composer
  useLayoutEffect(() => {
    if (activeIdentityScope.current === identityScope) return;
    const previousScope = activeIdentityScope.current;
    activeIdentityScope.current = identityScope;
    const promoted = switchComposerIdentity({
      identityScope,
      previousScope,
      textarea,
      draftRef,
      composingRef,
      suppressImeLineBreakRef,
      historyNavigation: history.navigation,
      attachmentsRef,
      resetAttachments,
      replaceAttachments,
      palettes,
      selector,
      setDraft,
      clearNotice,
      setComposerFocused,
      setDraggingFiles,
    });
    dictation.moveTo(identityScope, promoted);
  }, [identityScope, resetAttachments, clearNotice, palettes.reset, palettes.invalidateSearch, selector.reset]);
  useLayoutEffect(() => setRecoveryDrainScope(recoveryScope), [recoveryScope]);
  const placeholder =
    placeholderOverride ||
    composerPlaceholder({
      hasConversation,
      fallback: COMPOSER_PLACEHOLDERS[0],
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: setDraggingFiles identity is not guaranteed stable here; the effect must run only when transitioning changes
  useEffect(() => {
    if (!transitioning) return;
    setDraggingFiles(false);
  }, [transitioning]);
  useComposerFocus({ textarea, transitioning, focusRequest, paneActive });
  // Lets a message taken back tell an empty composer from one in use.
  const holdsContent = Boolean(draft.trim()) || attachments.length > 0;
  useEffect(() => {
    noteComposerContent(identityScope, holdsContent);
    return () => noteComposerContent(identityScope, false);
  }, [identityScope, holdsContent]);
  // Text sent or cleared is parked nowhere. A scope change first commits with
  // the previous scope's text, so only an emptying within one scope counts.
  const draftEmpty = !draft.trim();
  const emptiedScope = useRef(identityScope);
  useEffect(() => {
    const sameScope = emptiedScope.current === identityScope;
    emptiedScope.current = identityScope;
    if (sameScope && draftEmpty) dropComposerDraft(identityScope);
  }, [identityScope, draftEmpty]);
  // Leaving the screen (home button, app switch) is the last moment the page
  // is sure to run: the OS may kill it or a deploy may reload it afterwards.
  usePersistDraftOnHide(identityScope, textarea, draftRef);
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [addMenuRequest, setAddMenuRequest] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identityScope and paneActive are reset triggers; the effect body does not read them
  useEffect(() => setGoalDialogOpen(false), [identityScope, paneActive]);
  const [editingPasteId, setEditingPasteId] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identityScope and paneActive are reset triggers; the effect body does not read them
  useEffect(() => setEditingPasteId(null), [identityScope, paneActive]);
  const editingPaste = attachments.find((attachment) => attachment.id === editingPasteId);
  const btw = useBtwCard(sessionId, paneActive, selector.open || slash.open || mention.open || skillMention.open);
  const executeSlash = createSlashExecutor({
    draftMode,
    sessionId,
    onBtw: btw.ask,
    turnBusy,
    provider,
    model,
    agentRoute,
    effort,
    fast,
    fastCapable,
    autoEffort,
    modelParameters,
    ultrafastCapable: () =>
      modelOffersUltrafast(
        readCachedModelCatalog().models.find((entry) => entry.provider === provider && entry.model === model)
      ),
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
    openSkillMenu: () => setAddMenuRequest((request) => request + 1),
    onNewTask: props.onNewTask,
    // A bot room's thread is persistent: /clear empties it in place instead of
    // swapping the tab for a New Task.
    onClearToNewTask: agentMode ? undefined : props.onClearToNewTask,
    onResumeSession: props.onResumeSession,
    onOpenSessions: props.onOpenSessions,
    onOpenProjects: props.onOpenProjects,
    onOpenSettings,
    onOpenCommandSurface: props.onOpenCommandSurface,
    onInherit: props.onInherit,
    onSlashHeld,
  });

  // A bot chat that already runs on a model gives its still-empty bot route
  // that model (never overwriting a configured route).
  useEffect(() => {
    if (!agentMode || !sessionId || !provider || !model) return;
    void backfillAgentChatRoute(sessionId, { provider, model, ...(effort ? { effort } : {}) }).catch(() => {});
  }, [agentMode, sessionId, provider, model, effort]);

  const { send: sendNow, stop, keepSubmissionId } = useComposerSubmission({
    turnBusy,
    commandBusy,
    draftMode,
    queued: steerItems,
    recoveryScope,
    identityScope,
    textarea,
    draftRef,
    attachmentsRef,
    pendingLoads,
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
    showNotice: showComposerNotice,
    setAttachmentError,
    removeAttachments,
    mergeRestoredAttachments,
    restoredAttachments,
    executeSlash,
    rememberPrompt: history.rememberPrompt,
    submit: tags.submitTagged,
    abort,
    onQueuedRestored,
    selectedSkill: skillSelection.name,
    onSkillSubmitted: skillSelection.submitted,
    sessionId,
    plainText: agentMode,
    modelMissing: !(provider && model),
  });
  useComposerSteerHandoff({
    held,
    activeIdentityScope,
    recoveryScopeRef,
    draftRef,
    attachmentsRef,
    replaceAttachments,
    restoredAttachments,
    mergeRestoredAttachments,
    setDraft,
    historyNavigation: history.navigation,
    textarea,
    showNotice: showComposerNotice,
    keepSubmissionId,
  });
  // What is started before the session's lane lands (a send, a goal) waits for the landing and then runs with that
  // session's own state; it is dropped when the composer leaves the session first or its lane cannot be read.
  const heldRef = useRef(held);
  heldRef.current = held;
  const laneUnavailableRef = useRef(laneUnavailable);
  laneUnavailableRef.current = laneUnavailable;
  const landings = useRef<Array<{ scope: string; settle(landed: boolean): void }>>([]);
  const afterLanding = useCallback((): Promise<boolean> => {
    if (!heldRef.current) return Promise.resolve(true);
    if (laneUnavailableRef.current) return Promise.resolve(false);
    return new Promise((settle) => landings.current.push({ scope: activeIdentityScope.current, settle }));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identityScope settles what waits for a session the composer left; the body reads it through the ref
  useEffect(() => {
    const scope = activeIdentityScope.current;
    const waiting = held && !laneUnavailable;
    const settled = landings.current.filter((entry) => !waiting || entry.scope !== scope);
    if (!settled.length) return;
    landings.current = landings.current.filter((entry) => !settled.includes(entry));
    for (const entry of settled) entry.settle(!held && entry.scope === scope);
  }, [held, laneUnavailable, identityScope]);
  const sendNowRef = useRef(sendNow);
  sendNowRef.current = sendNow;
  // The send waiting for the landing is for the draft as it was: an edit or clear drops it.
  const waitingSend = useRef<{ draft: string; attachments: ComposerAttachment[] } | null>(null);
  const send = useCallback(
    async (slash = '', source: Parameters<typeof sendNow>[1] = 'form-submit', submitted?: SubmittedDraft) => {
      if (!heldRef.current) return sendNow(slash, source, submitted);
      // Words not in the editor yet wait there, where an edit drops the send.
      submitted?.settle(false);
      const waiting = { draft: submitted?.draft ?? draftRef.current, attachments: attachmentsRef.current };
      waitingSend.current = waiting;
      if (!(await afterLanding()) || waitingSend.current !== waiting) return;
      waitingSend.current = null;
      return sendNowRef.current(slash, source);
    },
    [sendNow, afterLanding, attachmentsRef]
  );
  useEffect(() => {
    const waiting = waitingSend.current;
    if (waiting && (waiting.draft !== draft || waiting.attachments !== attachments)) waitingSend.current = null;
  }, [draft, attachments]);
  // Pins and picks queued from the session's visualize panel make a message
  // sendable on their own.
  const feedbackPending = visualizeFeedbackPending(useVisualizeFeedback(sessionId));
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send('', 'form-submit');
  };
  const { selectMention, selectSkillMention, onKeyDown } = useComposerKeyboard({
    draft: {
      value: draft,
      set: setDraft,
      ref: draftRef,
      textarea,
      setCaretOffset,
    },
    slash,
    mention,
    skillMention,
    selector,
    history: {
      entries: history.entries,
      navigation: history.navigation,
      seedAttachments: history.seedAttachments,
      attachmentsRef,
      replaceAttachments,
    },
    runtime: {
      turnBusy,
      draftMode,
      pendingSubmissionId,
      attachments,
      escapeClearAt: escapeClearAtRef,
      showNotice: showComposerNotice,
    },
    ime: {
      composing: composingRef,
      suppressLineBreak: suppressImeLineBreakRef,
    },
    actions: {
      send,
      stop,
      clearAttachments,
    },
  });
  // A dictation in flight owns the send disc even during a running turn, so
  // the take is sent into the turn instead of the press interrupting it.
  const stopOnly =
    dictation.dictationState === 'idle' &&
    !feedbackPending &&
    shouldStopComposerGeneration({
      turnBusy,
      text: draft,
      attachments,
    });
  // What the send disc needs of the draft: queued visualize feedback or any
  // sendable text/attachment. A boolean, so typing re-renders the disc only
  // when it flips.
  const sendable = feedbackPending || hasSendablePromptContent({ text: draft, attachments });
  // A live take turns the send disc into "finish and send".
  const voiceSend = dictation.dictationState === 'recording';
  voiceSubmitRef.current = (text, take) =>
    void send('', 'voice-submit', { ...take, draft: withTranscript(draftRef.current, text) }).finally(() =>
      take.settle(false)
    );

  const onTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    sampleKeystrokePaint(composerPaintSamplePending);
    const value = event.currentTarget.value;
    draftRef.current = value;
    setDraft(value);
    escapeClearAtRef.current = 0;
    clearNotice();
    setCaretOffset(event.currentTarget.selectionStart);
    if (slash.dismissed) slash.setDismissed('');
    if (mention.dismissed) mention.setDismissed('');
    if (skillMention.dismissed) skillMention.setDismissed('');
    history.navigation.current = { index: -1, seed: '' };
  };
  const onTextareaBlur = () => {
    composingRef.current = false;
    suppressImeLineBreakRef.current = false;
    setComposerFocused(false);
  };
  const onTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
    const removeSkill = shouldRemoveSelectedSkill({
      selected: skillSelection.name,
      key: event.key,
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
      composing,
      repeat: event.repeat,
      modified: event.ctrlKey || event.metaKey || event.altKey,
    });
    if (removeSkill) {
      event.preventDefault();
      event.stopPropagation();
      skillSelection.select('');
      return;
    }
    if (tags.handleKeyDown(event, composing)) return;
    onKeyDown(event);
  };
  const onTextareaPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    handleComposerPaste(event, { attachFiles, attachmentSequence, insertAttachment });
  };
  const focusTextareaFromForm = (event: React.MouseEvent<HTMLFormElement>) => {
    if (touchPrimaryPointer()) return;
    const target = event.target as HTMLElement;
    if (!target.closest('button, input, textarea, [role="listbox"]')) textarea.current?.focus();
  };
  const goalDisabled = turnBusy || commandBusy || submitting;
  const goalDisabledRef = useRef(goalDisabled);
  goalDisabledRef.current = goalDisabled;
  const executeSlashRef = useRef(executeSlash);
  executeSlashRef.current = executeSlash;
  // A goal started before the lane lands starts once it has, if the session's own state still takes one. One goal at
  // most waits: a later start replaces it, and the replaced start answers with the outcome of the one that replaced it.
  const waitingGoal = useRef<{ replacedBy?: Promise<boolean> } | null>(null);
  const startGoal = useCallback(
    (command: string): Promise<boolean> => {
      const slot: { replacedBy?: Promise<boolean> } = {};
      const start = afterLanding().then((landed) => {
        if (slot.replacedBy) return slot.replacedBy;
        if (waitingGoal.current === slot) waitingGoal.current = null;
        return landed && !goalDisabledRef.current && executeSlashRef.current(command);
      });
      if (waitingGoal.current) waitingGoal.current.replacedBy = start;
      waitingGoal.current = slot;
      return start;
    },
    [afterLanding]
  );
  const phone = useMobileRemoteSurface() && !roomMembers;
  const oneLineOverflows = useOneLineOverflow(paletteAnchor, !phone && !roomMembers);
  const card = !roomMembers && (phone || oneLineOverflows);
  const modelControlProps: ComposerModelControlProps = {
    modelAside,
    agentMode,
    transitioning,
    commandBusy,
    paneActive,
    provider,
    model,
    effort,
    fast,
    fastCapable,
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens,
    sessionId,
    invokeResult,
    applySnapshot,
    onOpenSettings,
    onDraftModelSelection,
    onRoutePreferenceApplied,
    sessionChoices,
  };
  return (
    <>
      <ComposerBanners draggingFiles={draggingFiles} transitioning={transitioning} dropTarget={dropTargetRef.current} />
      {btw.card && <BtwCard card={btw.card} onClose={btw.close} onRetry={btw.retry} />}
      {/* The phone's pickers line keeps its height after the first message,
          so the card below it never moves when the chat starts. */}
      {phone && !agentMode && <div className="composer-context-line">{contextBar}</div>}
      <form
        ref={paletteAnchor}
        className="composer"
        data-composer-session-id={sessionId || undefined}
        data-chat-mode={agentMode ? 'agent' : undefined}
        data-card={card ? '' : undefined}
        onSubmit={onSubmit}
        data-composer-palette-open={
          selector.open || slash.open || mention.open || skillMention.open ? 'true' : undefined
        }
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
            onSelect={(usage) => {
              // /btw needs a question (and /ask a member): complete the command instead of sending it bare.
              if (usage !== '/btw' && usage !== '/ask') return void send(usage);
              draftRef.current = `${usage} `;
              setDraft(`${usage} `);
              textarea.current?.focus();
            }}
          />
        )}
        {askCandidates.length > 0 && !slash.open && (
          <RoomAskPalette anchor={paletteAnchor} members={askCandidates} onSelect={askMember} />
        )}
        {tags.candidates.length > 0 && (
          <RoomAskPalette
            anchor={paletteAnchor}
            members={tags.candidates}
            selected={tags.selected}
            onSelect={tags.pick}
          />
        )}
        {mention.open && (
          <MentionPalette
            anchor={paletteAnchor}
            panel={mention.palette}
            items={mention.items}
            loading={mention.loading}
            index={mention.index}
            setIndex={mention.setIndex}
            onSelect={selectMention}
          />
        )}
        {skillMention.open && (
          <SkillMentionPalette
            anchor={paletteAnchor}
            panel={skillMention.palette}
            results={skillMention.results}
            available={skillMention.available}
            query={skillMention.match?.query || ''}
            index={skillMention.index}
            setIndex={skillMention.setIndex}
            onSelect={selectSkillMention}
            onOpenSkillSettings={() => onOpenSettings('skills')}
          />
        )}
        {attachments.length > 0 && (
          <AttachmentChips
            attachments={attachments}
            onRemove={removeAttachment}
            onEdit={(attachment) => setEditingPasteId(attachment.id)}
            onError={setAttachmentError}
            onOpenFile={onOpenFile}
          />
        )}
        <VisualizeFeedbackCards sessionId={sessionId} />
        {editingPaste && (
          <ComposerPastedTextDialog
            anchor={textarea}
            text={editingPaste.data}
            onSave={(text) => updatePastedText(editingPaste, text)}
            onClose={() => setEditingPasteId(null)}
            returnFocus={() => textarea.current?.focus()}
          />
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
          {askTargets.length > 0 && <RoomAskChip members={askTargets} />}
          {tags.members.map((member) => (
            <RoomMentionChip key={member.id} member={member} onRemove={() => tags.remove(member.id)} />
          ))}
          {skillSelection.name && (
            <span className="composer-selected-skill">
              <button type="button" onClick={() => textarea.current?.focus()} title={skillSelection.name}>
                <CapabilityIcon name={skillSelection.name} />
                <span>{skillTitle(skillSelection.name)}</span>
              </button>
            </span>
          )}
          <div className="composer-text-field">
            {skillHighlight.layer}
            {/* Autosize is CSS-native (field-sizing: content). Resetting the height and reading scrollHeight in a
                layout effect forced two whole-document synchronous reflows per keystroke on long transcripts. */}
            {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the textarea drives the slash/mention popup and reports whether it is open */}
            <textarea
              ref={textarea}
              className={skillHighlight.active ? 'has-skill-mentions' : undefined}
              value={draft}
              onChange={onTextareaChange}
              onFocus={() => setComposerFocused(true)}
              onBlur={onTextareaBlur}
              onPointerDown={() => {
                escapeClearAtRef.current = 0;
              }}
              onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)}
              onKeyDown={onTextareaKeyDown}
              onPaste={onTextareaPaste}
              rows={1}
              placeholder={placeholder}
              disabled={transitioning}
              aria-controls={palettes.paletteId}
              aria-expanded={slash.open || mention.open || skillMention.open}
              aria-activedescendant={palettes.activeDescendant}
              aria-label={t('Write a message')}
            />
          </div>
        </div>
        <ComposerFooter
          attachAccept={ATTACHMENT_ACCEPT}
          fileInput={fileInput}
          onFilesChosen={(files) => void attachFiles(files)}
          textarea={textarea}
          paletteAnchor={paletteAnchor}
          recoveryScope={recoveryScope}
          projectScope={projectScope}
          goalDialogOpen={goalDialogOpen}
          setGoalDialogOpen={setGoalDialogOpen}
          addMenuRequest={addMenuRequest}
          roomMembers={roomMembers}
          onAskMember={agentMode ? tags.add : askMember}
          agentMode={agentMode}
          goalDisabled={goalDisabled}
          executeSlash={executeSlash}
          startGoal={startGoal}
          transitioning={transitioning}
          paneActive={paneActive}
          hasConversation={hasConversation}
          submitting={submitting}
          skillSelection={skillSelection}
          mention={mention}
          dictation={dictation}
          stopOnly={stopOnly}
          voiceSend={voiceSend}
          sendable={sendable}
          onStop={() => void stop()}
          sessionId={sessionId}
          onOpenSettings={onOpenSettings}
          modelControls={card && !bare ? <ComposerModelControls {...modelControlProps} /> : null}
        />
      </form>
      {!bare && (
        <ComposerModelLine
          {...modelControlProps}
          usageReadout={usageReadout}
          pickers={phone ? undefined : contextBar}
          room={Boolean(roomMembers)}
          card={card}
        />
      )}
      {offSkills.length > 0 && !agentMode && (
        <p className="composer-skill-status" role="status">
          {t('{{name}} skill is off, so it is sent as plain text. Turn it on in Settings → Skills.', {
            name: offSkills.join(', '),
          })}
        </p>
      )}
    </>
  );
});

export { WorkflowSelect, OrchestrationModeSelect } from './model-controls';
