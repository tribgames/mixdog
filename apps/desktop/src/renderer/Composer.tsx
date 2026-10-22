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
import { shouldStopComposerGeneration } from './renderer-logic.mjs';
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
  noteComposerContent,
  persistComposerDrafts,
  stashComposerAttachments,
  stashComposerDraft,
  stashComposerTags,
  stashedComposerDraft,
  takeDraftPromotion,
  takeStashedComposerAttachments,
  takeStashedComposerTags,
} from './composer-draft';
import { useComposerDictation } from './use-composer-dictation';
import { useComposerAttachments } from './use-composer-attachments';
import { useComposerCapability } from './use-composer-capability';
import { useComposerExternalDraft } from './use-composer-external-draft';
import { useComposerPromptRestore } from './use-composer-prompt-restore';
import { useComposerSubmission } from './use-composer-submission';
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
import { isInMarkdownCode } from '../../../../src/runtime/shared/skill-mentions.mjs';
import { ComposerBanners } from './ComposerBanners';
import {
  type ComposerModelControlProps,
  ComposerFooter,
  ComposerModelControls,
  ComposerModelLine,
} from './ComposerFooter';
import { useMobileRemoteSurface } from './mobile-surface';
import { CapabilityIcon } from './CapabilityIcon';
import { shouldRemoveSelectedSkill, skillTitle, useComposerSkill } from './composer-skill';
import { VisualizeFeedbackCards } from './VisualizeFeedbackCards';
import {
  RoomAskChip,
  RoomAskPalette,
  RoomMentionChip,
  contentAsking,
  draftAskingMore,
  roomAskCandidates,
  roomAskTargets,
  roomTagCandidates,
  roomTagTargets,
  roomTaggedMembers,
  useComposerRoomMembers,
} from './composer-room-ask';
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

/** Clipboard intake: pasted files attach, and a long text paste folds into a
 *  single chip instead of flooding the draft. Rich copies (Word, Excel,
 *  browsers) carry a rendered image beside their text: any plain text means
 *  the user copied text, so the files are attached only when there is none
 *  (screenshots, files copied in Explorer). */
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
 *  the incoming one clean, restored, or with the in-flight text carried over.
 *  Every transient surface (palettes, selector, notice, drag) resets with it. */
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
}) {
  // Park the text the user typed in the tab being left, so returning to
  // that tab hands it back instead of opening empty.
  const leavingElement = textarea.current;
  stashComposerDraft(
    previousScope,
    document.activeElement === leavingElement && leavingElement ? leavingElement.value : draftRef.current
  );
  // Scope settles ASYNC after a session switch/promotion; when the user is
  // ALREADY typing in the composer, the in-flight text carries over instead
  // of being wiped (user bug: draft vanished + scroll jumped mid-sentence).
  const typingElement = textarea.current;
  const typingLive = document.activeElement === typingElement;
  // A fresh New Task pane is the exception: it ALWAYS opens clean (user:
  // 새작업 pulled the previous pane's text and attachments along).
  const freshDraft = composerScopeOpensFreshDraft(identityScope);
  // Chips attached there but not yet sent are parked with it, and the
  // incoming tab gets back the chips it parked. A New Task promoted to the
  // session ITS submission minted keeps them instead: the draft scope is never
  // revisited, so a file attached while its first send was in flight vanished
  // with it.
  const parkedAttachments = takeStashedComposerAttachments(identityScope);
  const promotingDraft = takeDraftPromotion(previousScope, identityScope);
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
  historyNavigation.current = { index: -1, seed: '' };
}

export type ComposerProps = {
  /** Opens a staged attachment in the editor pane (the transcript's file opener). */
  onOpenFile?: (project: string, rel: string, line?: number, accessToken?: string) => void;
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
   *  gauge (user: 컨텍스트는 모델 선택기 옆). */
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
  /** Agent mode: a one-line messenger bar with the agent's route shown
   *  read-only under it; `/` and `$` are plain text, and `@` tags the room
   *  member who answers. */
  agentMode?: boolean;
};

export const Composer = memo(function Composer(props: ComposerProps) {
  const {
    onOpenFile,
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
    recoveryScope,
    submissionRecoveryVersion,
    dropTargetRef,
  });
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
  // A message taken back from the transcript (✕ on an unread bubble, an
  // answer that did not go out) returns to this editor.
  const steer = useContext(SteerContext);
  useEffect(() => {
    if (!steer) return undefined;
    const handoff: typeof steer.draft.current = {
      scope: () => activeIdentityScope.current,
      recoveryScope: () => recoveryScopeRef.current,
      restore(value, { ifEmpty = false, replace = false, notice } = {}) {
        if (
          !restoreDraftHandoff(
            { draftRef, attachmentsRef, replaceAttachments, restoredAttachments, mergeRestoredAttachments, setDraft },
            value,
            { ifEmpty, replace }
          )
        )
          return false;
        history.navigation.current = { index: -1, seed: '' };
        if (notice) showComposerNotice(notice);
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
    attachmentsRef,
    replaceAttachments,
    restoredAttachments,
    mergeRestoredAttachments,
    showComposerNotice,
    history.navigation,
  ]);
  useComposerPromptRestore({ promptRestore, setDraft, draftRef, textarea, onQueuedRestored });
  const selector = useComposerMessageSelector({
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
  const palettes = useComposerPalettes({
    draft,
    projectScope,
    paneActive,
    transitioning,
    composerFocused,
    selectorOpen: selector.open,
    skills: skillCatalog.selectable,
    room: Boolean(roomMembers),
    plain: agentMode,
  });
  const { setCaretOffset, slash, mention, skillMention } = palettes;
  // Agent mode's `@` in a room: pick members, who then answer the message
  // once each in pick order (sent on the room's `/ask` path). A 1:1 thread's
  // `@` opens nothing yet.
  const [tagged, setTagged] = useState<string[]>(() => takeStashedComposerTags(identityScope));
  const taggedRef = useRef(tagged);
  taggedRef.current = tagged;
  const taggedScope = useRef(identityScope);
  const [tagDismissed, setTagDismissed] = useState('');
  // The highlighted candidate; ↑/↓ move it, Enter/Tab pick it.
  const [tagIndex, setTagIndex] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `@` query starts from the first candidate
  useEffect(() => setTagIndex(0), [mention.signature]);
  // Tags picked in the tab being left are parked with its text; the incoming
  // tab gets back the tags it parked.
  useEffect(() => {
    if (taggedScope.current === identityScope) return;
    stashComposerTags(taggedScope.current, taggedRef.current);
    taggedScope.current = identityScope;
    setTagged(takeStashedComposerTags(identityScope));
  }, [identityScope]);
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
  }, [attachmentsRef, replaceAttachments]);
  const taggedMembers = roomTaggedMembers(tagged, roomMembers);
  // An `@` inside Markdown code (a fence or inline span) is text, not a tag.
  const tagMatch =
    agentMode && roomMembers && mention.match && !isInMarkdownCode(draft, mention.match.start) ? mention.match : null;
  const tagCandidates =
    tagMatch && composerFocused && paneActive && tagDismissed !== mention.signature
      ? roomTagCandidates(tagMatch.query, roomMembers).filter((member) => !tagged.includes(member.id))
      : [];
  const tagMember = (agentId: string) => {
    const match = tagMatch;
    if (!match) return;
    const current = draftRef.current;
    const next = `${current.slice(0, match.start)}${current.slice(match.end)}`.replace(/^\s+/, '');
    draftRef.current = next;
    setDraft(next);
    setTagged((current) => (current.includes(agentId) ? current : [...current, agentId]));
    queueMicrotask(() => {
      const field = textarea.current;
      if (!field) return;
      field.focus();
      const caret = Math.min(match.start, next.length);
      field.setSelectionRange(caret, caret);
      setCaretOffset(caret);
    });
  };
  const submitTagged: typeof submit = taggedMembers.length
    ? async (content, options) => {
        const accepted = await submit(
          contentAsking(content, roomTagTargets(taggedMembers, roomMembers ?? [])),
          options
        );
        if (accepted === true) setTagged([]);
        return accepted;
      }
    : submit;
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
    switchComposerIdentity({
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
  }, [identityScope, resetAttachments, clearNotice, palettes.reset, palettes.invalidateSearch, selector.reset]);
  const placeholder =
    placeholderOverride ||
    composerPlaceholder({
      hasConversation,
      fallback: COMPOSER_PLACEHOLDERS[0],
    });
  // Autosize is CSS-native now (field-sizing: content). The old layout-effect
  // path forced TWO whole-document synchronous reflows per keystroke
  // (height:auto → scrollHeight read) — the measured source of typing lag on
  // long transcripts.
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
  // Leaving the screen (home button, app switch) is the last moment the page
  // is sure to run: the OS may kill it or a deploy may reload it afterwards.
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
  }, [identityScope]);
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

  const { send, stop } = useComposerSubmission({
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
    setAttachmentError,
    removeAttachments,
    mergeRestoredAttachments,
    restoredAttachments,
    executeSlash,
    rememberPrompt: history.rememberPrompt,
    submit: submitTagged,
    abort,
    onQueuedRestored,
    selectedSkill: skillSelection.name,
    onSkillSubmitted: skillSelection.submitted,
    sessionId,
    plainText: agentMode,
    modelMissing: !(provider && model),
  });
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
  // A live take turns the send disc into "finish and send".
  const voiceSend = dictation.dictationState === 'recording';
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is a re-check trigger for the pending voice submit even though the body does not read it
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
    const composing = composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229;
    if (
      tagCandidates.length > 0 &&
      !composing &&
      (event.key === 'Enter' ||
        event.key === 'Tab' ||
        event.key === 'Escape' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown')
    ) {
      event.preventDefault();
      event.stopPropagation();
      const count = tagCandidates.length;
      if (event.key === 'Escape') setTagDismissed(mention.signature);
      else if (event.key === 'ArrowDown') setTagIndex((index) => (index + 1) % count);
      else if (event.key === 'ArrowUp') setTagIndex((index) => (index - 1 + count) % count);
      else tagMember(tagCandidates[Math.min(tagIndex, count - 1)].id);
      return;
    }
    if (
      tagged.length > 0 &&
      event.key === 'Backspace' &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      event.preventDefault();
      setTagged((current) => current.slice(0, -1));
      return;
    }
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
  // A phone's coding composer is the two-row card: the typing band, then the
  // +, the model with its gauge, the mic and send; a bot's 1:1 chat too.
  // A group room keeps its one-line bar.
  const phoneCard = useMobileRemoteSurface() && !roomMembers;
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
      {phoneCard && !agentMode && <div className="composer-context-line">{contextBar}</div>}
      <form
        ref={paletteAnchor}
        className="composer"
        data-chat-mode={agentMode ? 'agent' : undefined}
        data-phone-card={phoneCard ? '' : undefined}
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
        {tagCandidates.length > 0 && (
          <RoomAskPalette
            anchor={paletteAnchor}
            members={tagCandidates}
            selected={Math.min(tagIndex, tagCandidates.length - 1)}
            onSelect={tagMember}
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
          {taggedMembers.map((member) => (
            <RoomMentionChip
              key={member.id}
              member={member}
              onRemove={() => setTagged((current) => current.filter((id) => id !== member.id))}
            />
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
              aria-label={t('Message Mixdog')}
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
          onAskMember={
            agentMode
              ? (agentId) => setTagged((current) => (current.includes(agentId) ? current : [...current, agentId]))
              : askMember
          }
          agentMode={agentMode}
          goalDisabled={goalDisabled}
          executeSlash={executeSlash}
          transitioning={transitioning}
          paneActive={paneActive}
          hasConversation={hasConversation}
          submitting={submitting}
          skillSelection={skillSelection}
          mention={mention}
          dictation={dictation}
          stopOnly={stopOnly}
          voiceSend={voiceSend}
          draft={draft}
          attachments={attachments}
          feedbackPending={feedbackPending}
          onStop={() => void stop()}
          sessionId={sessionId}
          onOpenSettings={onOpenSettings}
          modelControls={phoneCard ? <ComposerModelControls {...modelControlProps} /> : null}
        />
      </form>
      <ComposerModelLine
        {...modelControlProps}
        usageReadout={phoneCard ? usageReadout : (contextBar ?? usageReadout)}
        room={Boolean(roomMembers)}
        controls={!phoneCard}
      />
      {offSkills.length > 0 && !agentMode && (
        <p className="composer-skill-status" role="status">
          {t('{{name}} skill is off, so it is sent as plain text. Turn it on in Settings › Skills.', {
            name: offSkills.join(', '),
          })}
        </p>
      )}
    </>
  );
});

export { ModelSelector, WorkflowSelect, OrchestrationModeSelect } from './model-controls';
