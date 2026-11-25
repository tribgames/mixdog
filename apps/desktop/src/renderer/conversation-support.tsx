import {
  Fragment,
  useCallback,
  useMemo,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { ArrowDown } from 'lucide-react';
import type {
  DesktopAbortOptions,
  DesktopPromptContent,
  DesktopSubmitOptions,
  SessionSnapshot,
} from '../shared/contract';
import { t } from './i18n';
import { describeError, ErrorNotice, errorWithKind } from './ErrorNotice';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { ImageRefusalActions } from './ImageRefusalActions';
import { imageRefusalOf } from './image-refusal';
import { TranscriptAssistantRow, type TranscriptAssistantRowProps } from './TranscriptAssistantRow';
import { submissionIdentity, transcriptRowArchived, turnPromptText, type TranscriptRowModel } from './transcript-rows';
import { showsResponseFooter, TranscriptResponseFooter, TranscriptRow } from './transcript-row';
import { backgroundWorkCounts, completionActivityKey, hadLiveActivity, LiveActivity } from './transcript-status';
import { dropTranscriptScrollDeviation } from './transcript-follow-rules';
import { ToolActivityGroup } from './transcript-tool-ui';
import { AskUserRecord, askUserCardKey, splitAskUser, toolCallsOf } from './ask-user-record';
import { PreviewedTurnChangesCard } from './transcript-visualize-card';
import { ToolTurnProvider } from './TurnChangesCard';
import { turnRecordOf } from './turn-changes-model';
import { desktopPromptDisplayText, pendingPromptImages, type PendingPromptItem } from './conversation-prompt-items';
import { nextComposerSubmissionId } from './composer-draft';

/** The pane-local actions the composer is handed. They are wired once and
 *  address the pane's own route through refs, so a prop change never
 *  re-creates a handler the composer holds. */
export type ConversationComposerActions = {
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  onNewTask: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenProjects: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  onClearToNewTask?: (sessionId: string) => void;
  onInherit: () => Promise<boolean>;
};

export type ToolActivityPart =
  | { tools: TranscriptItem[]; asked?: undefined }
  | { tools?: undefined; asked: TranscriptItem }
  | { tools?: undefined; asked?: undefined; waiting: true };

/** A roll-up cut after each question among its members, so the calls made
 *  after a question are a roll-up of their own; any other item as it is. */
function questionChunks(item: TranscriptItem, taken: (member: TranscriptItem) => boolean): TranscriptItem[] {
  const members = toolCallsOf(item);
  const chunks: TranscriptItem[][] = [[]];
  for (const member of members) {
    chunks.at(-1)?.push(member);
    if (taken(member)) chunks.push([]);
  }
  if (!chunks.at(-1)?.length) chunks.pop();
  if (chunks.length < 2) return [item];
  return chunks.map((chunk, at) => ({
    ...item,
    ...(at > 0 ? { id: `${String(item.id)}:${at}` } : {}),
    toolMembers: chunk,
    count: chunk.length,
    completedCount: chunk.reduce((done, member) => done + Number(member.completedCount ?? 0), 0),
  }));
}

/** A tool group's calls in call order, cut at each question it holds (also
 *  inside a roll-up): an answered one is its record, a waiting one the live
 *  card. */
export function toolActivityParts(
  items: readonly TranscriptItem[],
  hasCard: boolean,
  cardKey?: string
): ToolActivityPart[] {
  const parts: ToolActivityPart[] = [];
  let tools: TranscriptItem[] = [];
  const cut = () => {
    if (tools.length) parts.push({ tools });
    tools = [];
  };
  const taken = (member: TranscriptItem) => {
    const { asked, waiting } = splitAskUser([member], hasCard, cardKey);
    return asked.length > 0 || waiting;
  };
  for (const item of items.flatMap((entry) => questionChunks(entry, taken))) {
    const { rest, asked, waiting } = splitAskUser([item], hasCard, cardKey);
    tools.push(...rest);
    if (!asked.length && !waiting) continue;
    cut();
    for (const question of asked) parts.push({ asked: question });
    if (waiting) parts.push({ waiting: true });
  }
  cut();
  return parts;
}

/** Chromium defers a press that lands INSIDE the live selection: it waits for
 *  a drag it is no longer allowed to start, so the next drag-select is
 *  swallowed. Collapsing the selection first makes every press begin a fresh
 *  range; shift-extend, the right-click menu and text fields keep theirs. */
export function collapseSelectionOnPress(event: ReactMouseEvent<HTMLElement>) {
  if (event.button !== 0 || event.shiftKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

export function JumpToLatestButton({ visible, onJump }: { visible: boolean; onJump: () => void }) {
  return (
    <button
      type="button"
      className="jump-to-latest"
      aria-hidden={visible ? undefined : true}
      tabIndex={visible ? undefined : -1}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        // A live wheel/fling can cancel the later click. Take the tail on the
        // press itself so the jump also stops the remaining scroll frames.
        event.preventDefault();
        onJump();
      }}
      // Native keyboard activation has no pointerdown and reports detail 0.
      onClick={(event) => {
        if (event.detail === 0) onJump();
      }}
      aria-label={t('Jump to latest message')}
    >
      <ArrowDown size={16} />
    </button>
  );
}

function optimisticPromptFor(
  content: DesktopPromptContent,
  options: DesktopSubmitOptions | undefined,
  { id, queuedBehindTurn }: { id: string; queuedBehindTurn: boolean }
): PendingPromptItem {
  const submittedAt = Number(options?.submittedAt);
  const trackedSubmittedAt = Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Date.now();
  const images = pendingPromptImages(options);
  return {
    id,
    kind: 'user',
    text: desktopPromptDisplayText(content, options),
    pending: true,
    accepted: false,
    submittedAt: trackedSubmittedAt,
    at: trackedSubmittedAt,
    queuedBehindTurn,
    ...(images.length ? { images } : {}),
  };
}

export function useConversationComposerActions({
  armFollowOnSubmitRef,
  composerActions,
  draftModeRef,
  goalSubmission,
  goalSubmitScopeRef,
  queuedBehindTurnAtSubmit,
  routeSessionIdRef,
  setOptimisticPrompts,
  suppressDraftSubmitPaintHandoff,
}: {
  armFollowOnSubmitRef: { current: () => void };
  composerActions: { current: ConversationComposerActions };
  draftModeRef: { current: boolean };
  goalSubmission: { current: { id: string; scope: string } | null };
  goalSubmitScopeRef: { current: string };
  queuedBehindTurnAtSubmit: { current: boolean };
  routeSessionIdRef: { current: string };
  setOptimisticPrompts: Dispatch<SetStateAction<PendingPromptItem[]>>;
  suppressDraftSubmitPaintHandoff: { current: boolean };
}) {
  // Every handler below is wired once and reads the latest props through the
  // stable refs passed in, so none of them lists a ref's `.current` as a dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable refs and state setters, read at call time.
  const composerSubmit = useCallback(async (content: DesktopPromptContent, options?: DesktopSubmitOptions) => {
    const submissionId = String(options?.id || '').trim() || nextComposerSubmissionId();
    const optimistic = optimisticPromptFor(content, options, {
      id: submissionId,
      queuedBehindTurn: queuedBehindTurnAtSubmit.current,
    });
    const trackedSubmittedAt = optimistic.submittedAt;
    const materializingDraft = draftModeRef.current;
    if (materializingDraft) suppressDraftSubmitPaintHandoff.current = true;
    // Every idle submit closes completed goal chrome, even without a diff.
    // The goal lane decides whether its goal is complete; queued follow-ups
    // ride the active turn and must not touch the current chrome.
    if (!queuedBehindTurnAtSubmit.current) {
      goalSubmission.current = { id: submissionId, scope: goalSubmitScopeRef.current };
    }
    const showPendingRow = () => {
      setOptimisticPrompts((current) => [...current.filter((item) => item.id !== submissionId), optimistic]);
      armFollowOnSubmitRef.current();
    };
    showPendingRow();
    window.mixdogDesktop?.perfLog?.(`prompt-submit phase=renderer-queued id=${submissionId}`);
    const acceptedStartedAt = performance.now();
    // The bubble owns the failed message (and its retry); the composer treats
    // it as sent.
    const keepFailedSteer = () => {
      setOptimisticPrompts((current) =>
        current.map((item) =>
          String(item.id) === submissionId
            ? { ...item, steer: 'failed' as const, retry: { content, options: { ...options, id: submissionId } } }
            : item
        )
      );
      return true;
    };
    let accepted: unknown;
    try {
      const send = () =>
        composerActions.current.submit(content, {
          ...options,
          id: submissionId,
          submittedAt: trackedSubmittedAt,
        });
      // An idle refusal belongs to the composer that restores the draft; the
      // global invocation handler would announce it and turn it into a second refusal.
      accepted =
        optimistic.queuedBehindTurn || options?.retryFailedTurn
          ? await composerActions.current.invokeResult(send)
          : await send();
    } catch (error) {
      if (materializingDraft) suppressDraftSubmitPaintHandoff.current = false;
      if (goalSubmission.current?.id === submissionId) goalSubmission.current = null;
      if (optimistic.queuedBehindTurn) return keepFailedSteer();
      setOptimisticPrompts((current) => current.filter((item) => String(item.id) !== submissionId));
      throw error;
    }
    // A message sent behind a running turn already stands in the transcript:
    // a failed send stays there as "Not sent · Send again" (with the composer
    // cleared) instead of moving back into the editor.
    if (accepted !== true && optimistic.queuedBehindTurn) return keepFailedSteer();
    if (accepted !== true && materializingDraft) {
      suppressDraftSubmitPaintHandoff.current = false;
    }
    if (accepted !== true && goalSubmission.current?.id === submissionId) goalSubmission.current = null;
    setOptimisticPrompts((current) =>
      current.flatMap((item) => {
        if (String(item.id) !== submissionId) return [item];
        return accepted === true ? [{ ...item, accepted: true }] : [];
      })
    );
    window.mixdogDesktop?.perfLog?.(
      `prompt-submit phase=renderer-host-ack id=${submissionId}` +
        ` accepted=${accepted === true ? 1 : 0}` +
        ` wait=${(performance.now() - acceptedStartedAt).toFixed(0)}ms`
    );
    return accepted;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable refs and state setter, read at call time.
  const forwarded = useMemo(
    () => ({
      composerAbort: (options: DesktopAbortOptions = {}) =>
        composerActions.current.invokeResult(() => {
          const host = window.mixdogDesktop;
          const sessionId = routeSessionIdRef.current;
          return sessionId ? host.abortSession(sessionId, options) : { aborted: false };
        }),
      composerInvokeResult: <T,>(action: () => T | Promise<T>) => composerActions.current.invokeResult(action),
      composerQueuedRestored: (ids: string[]) => {
        if (ids.length === 0) return;
        const restored = new Set(ids);
        setOptimisticPrompts((current) => {
          const next = current.filter((item) => !restored.has(String(item.id)));
          return next.length === current.length ? current : next;
        });
      },
      composerApplySnapshot: (next: SessionSnapshot | null) => composerActions.current.applySnapshot(next),
      composerOnNewTask: () => composerActions.current.onNewTask(),
      composerOnClearToNewTask: () => {
        const sessionId = routeSessionIdRef.current;
        if (sessionId) composerActions.current.onClearToNewTask?.(sessionId);
      },
      composerOnResumeSession: (id: string) => composerActions.current.onResumeSession(id),
      composerOnOpenSessions: () => composerActions.current.onOpenSessions(),
      composerOnOpenProjects: () => composerActions.current.onOpenProjects(),
      composerOnOpenSettings: (section?: SettingsSection | null) => composerActions.current.onOpenSettings(section),
      composerOnOpenCommandSurface: (surface: CommandSurfaceName) =>
        composerActions.current.onOpenCommandSurface(surface),
      composerOnInherit: () => composerActions.current.onInherit(),
    }),
    []
  );
  return { ...forwarded, composerSubmit };
}

/** Which surface a key belongs to: the transcript takes the paging keys, and
 *  every printable keystroke lands in the composer wherever focus sits. */
export function conversationKeyDownCapture(
  event: ReactKeyboardEvent<HTMLElement>,
  {
    readOnly,
    viewport,
    onTranscriptKey,
  }: {
    readOnly: boolean;
    viewport: { current: HTMLDivElement | null };
    onTranscriptKey(input: { key: string }): void;
  }
): void {
  if (readOnly) return;
  const target = event.target as HTMLElement | null;
  if (ownsTranscriptKey(event, target)) {
    const element = viewport.current;
    if (element) {
      event.preventDefault();
      onTranscriptKey({ key: event.key });
      scrollTranscriptForKey(element, event.key);
    }
    return;
  }
  focusComposerForTyping(event, target);
}

const EDITABLE_SELECTOR = 'textarea, input, select, [contenteditable="true"]';

function ownsTranscriptKey(event: ReactKeyboardEvent<HTMLElement>, target: HTMLElement | null): boolean {
  const homeOrEnd = event.key === 'Home' || event.key === 'End';
  if (!homeOrEnd && event.key !== 'PageUp' && event.key !== 'PageDown') return false;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
  if (homeOrEnd && target?.closest(EDITABLE_SELECTOR)) return false;
  if (event.currentTarget.querySelector('[data-composer-palette-open="true"], [role="listbox"]')) return false;
  return !target?.closest('[data-scrollable]');
}

function scrollTranscriptForKey(element: HTMLDivElement, key: string): void {
  if (key === 'PageUp' || key === 'PageDown') {
    const direction = key === 'PageDown' ? 1 : -1;
    // A page is what shows above the dock: the scroller runs on under it (its shell clips that part).
    const shown = Math.min(element.clientHeight, element.parentElement?.clientHeight ?? element.clientHeight);
    element.scrollBy({ top: Math.round(shown * 0.9) * direction, behavior: 'auto' });
    return;
  }
  // An absolute target is logical: a row offset the timeline still
  // holds from a touch scroll ends with this write.
  dropTranscriptScrollDeviation(element);
  element.scrollTo({ top: key === 'Home' ? 0 : element.scrollHeight, behavior: 'auto' });
}

/** A printable key, or the IME "Process" key that starts a composition, pressed outside a field refocuses the composer before the character commits. */
function focusComposerForTyping(event: ReactKeyboardEvent<HTMLElement>, target: HTMLElement | null): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length !== 1 && event.key !== 'Process') return;
  if (!target || typeof target.closest !== 'function') return;
  if (target.closest(EDITABLE_SELECTOR)) return;
  // Structural hook, not the accessible name: the aria-label is
  // localized, so matching its English copy never found the
  // textarea outside the English UI.
  event.currentTarget
    .querySelector<HTMLTextAreaElement>('.composer-input-row textarea')
    ?.focus({ preventScroll: true });
}

/** A turn's visualize cards and whether a row already seated them. */
export type TurnCardsSeat = {
  cards: ReactNode;
  placed: boolean;
  /** The files the turn showed as visualize cards: its changes card lists none of them. */
  visualized?: readonly string[];
};

function errorRowNode(
  row: Extract<TranscriptRowModel, { _tag: 'Error' }>,
  {
    readOnly,
    retryDisabled,
    settledItems,
    settledTurnKeys,
    onRetryTurn,
    onOpenSettings,
    turnCards,
    sessionId,
  }: {
    turnCards?: TurnCardsSeat;
    /** The session whose conversation the failure belongs to: the image fixes are made on it. */
    sessionId: string;
    readOnly: boolean;
    retryDisabled: boolean;
    settledItems: readonly TranscriptItem[];
    settledTurnKeys: readonly string[];
    onRetryTurn(turnKey: string): void;
    onOpenSettings(section?: SettingsSection | null): void;
  }
): ReactNode {
  const retryKey = [...row.failures]
    .reverse()
    .find((failure) => turnPromptText(settledItems, settledTurnKeys, failure.turnKey))?.turnKey;
  const errors = row.failures.map(({ item }) =>
    errorWithKind(
      String(item?.errorDetails || item?.detail || item?.message || item?.text || item?.label || t('Failed')),
      item?.errorKind
    )
  );
  const failureKind = describeError(errors.at(-1)).kind;
  const reauth = failureKind === 'reauth' || failureKind === 'authentication';
  // A refused image send names the images and offers the local fixes beside it (never a retry of the same refusal).
  const imageRefusal = imageRefusalOf(row.failures.at(-1)?.item?.errorKind);
  // A retry of these would only repeat the same refusal. A sign-in failure
  // keeps its retry: after signing in again the same turn can run.
  const retryable = !['policy', 'entitlement', 'billing', 'service-tier'].includes(failureKind);
  let action: ReactNode;
  if (readOnly) action = undefined;
  else if (imageRefusal) action = <ImageRefusalActions refusal={imageRefusal} sessionId={sessionId} />;
  else if (reauth) {
    action = (
      <button type="button" onClick={() => onOpenSettings('providers')}>
        {t('Sign in again')}
      </button>
    );
  }
  const notice = (
    <ErrorNotice
      className="transcript-error-notice"
      errors={errors}
      action={action}
      onRetry={
        retryable && !readOnly && retryKey && !transcriptRowArchived(row) ? () => onRetryTurn(retryKey) : undefined
      }
      retryDisabled={retryDisabled}
      role="status"
    />
  );
  return row.turnChanges ? (
    <>
      {notice}
      {seatTurnCards(turnCards)}
      <PreviewedTurnChangesCard turnChanges={row.turnChanges} visualized={turnCards?.visualized} />
    </>
  ) : (
    notice
  );
}

/** One projected row as elements. Row kinds are a closed set, so this dispatch
 *  is the whole mapping from the row model to the transcript's chrome. */
export function transcriptRowNode(
  row: TranscriptRowModel,
  {
    disclosureScope,
    optimisticActivityStartedAt,
    readOnly,
    renderAssistantRow,
    retryDisabled,
    settledItems,
    settledTurnKeys,
    liveItems = settledItems,
    latestCompletion,
    snapshot,
    onRetryTurn,
    onOpenSettings,
    questionCard,
    quietTools = false,
    turnCards,
  }: {
    /** Coding mode: the turn's visualize cards, seated above its changed-files card. */
    turnCards?: TurnCardsSeat;
    /** Agent mode: no tool rows; only a question that needs the user shows. */
    quietTools?: boolean;
    disclosureScope: string;
    optimisticActivityStartedAt: number;
    readOnly: boolean;
    renderAssistantRow?: (props: TranscriptAssistantRowProps) => ReactNode;
    retryDisabled: boolean;
    /** The rows shown and their own turn keys: a row's retry and turn record are read from them. */
    settledItems: readonly TranscriptItem[];
    /** The last settled turndone; computed once per transcript, not per row. */
    latestCompletion: TranscriptItem | undefined;
    settledTurnKeys: readonly string[];
    /** The live rows, when the rows shown are a history window: the pending question's call is among them. */
    liveItems?: readonly TranscriptItem[];
    snapshot: Snapshot;
    onRetryTurn(turnKey: string): void;
    onOpenSettings(section?: SettingsSection | null): void;
    /** The pending ask_user card, shown where its tool call sits. */
    questionCard?: ReactNode;
  }
): ReactNode {
  if (row._tag === 'TurnGap') {
    return <div className="transcript-turn-gap" aria-hidden="true" />;
  }
  if (row._tag === 'Error') {
    return errorRowNode(row, {
      readOnly,
      retryDisabled,
      settledItems,
      settledTurnKeys,
      onRetryTurn,
      onOpenSettings,
      turnCards,
      sessionId: String(snapshot.sessionId || ''),
    });
  }
  if (row._tag === 'Thinking') {
    return (
      <div className="live-activity-slot" data-busy="true">
        <LiveActivity
          snapshot={snapshot}
          optimisticStartedAt={optimisticActivityStartedAt}
          turnKey={submissionIdentity(row.turnKey)}
        />
      </div>
    );
  }
  if (row._tag === 'UserMessage') {
    return <TranscriptRow item={row.item} disclosureScope={disclosureScope} attachedUser={row.attachedUser} />;
  }
  if (row._tag === 'ToolActivity') {
    // Questions leave the tool roll-up: a waiting one is the live card, an
    // answered one stays as its summary.
    // Exactly one call holds the card (askUserCardKey).
    const cardKey = questionCard
      ? askUserCardKey(liveItems, String(snapshot.toolApproval?.toolCallId ?? ''))
      : undefined;
    const parts = toolActivityParts(row.items, cardKey !== undefined, cardKey);
    const record = turnRecordOf(settledItems, settledTurnKeys, row.turnKey);
    if (parts.length === 1 && parts[0]?.tools) {
      return quietTools ? null : (
        <ToolTurnProvider {...record} visualized={turnCards?.visualized}>
          <ToolActivityGroup
            items={row.items}
            disclosureScope={disclosureScope}
            turnKey={row.turnKey}
            running={row.open === true}
          />
        </ToolTurnProvider>
      );
    }
    return (
      <ToolTurnProvider {...record} visualized={turnCards?.visualized}>
        {parts.map((part, index) => {
          if (part.tools) {
            return quietTools ? null : (
              <ToolActivityGroup
                key={`tools:${index}`}
                items={part.tools}
                disclosureScope={disclosureScope}
                turnKey={row.turnKey}
                running={row.open === true && index === parts.length - 1}
              />
            );
          }
          if (part.asked) return <AskUserRecord key={String(part.asked.id ?? `asked:${index}`)} item={part.asked} />;
          return <Fragment key={`waiting:${index}`}>{questionCard}</Fragment>;
        })}
      </ToolTurnProvider>
    );
  }
  const completionRow = row.completion ?? (row.item?.kind === 'turndone' ? row.item : undefined);
  const isLatestCompletion =
    Boolean(completionRow) &&
    !snapshot.busy &&
    Boolean(latestCompletion) &&
    (row.completion === latestCompletion || row.item === latestCompletion);
  const sessionId = String(snapshot.sessionId || '').trim();
  const turnIdentity = submissionIdentity(row.turnKey);
  const assistantProps: TranscriptAssistantRowProps = {
    item: row.item,
    live: Boolean(row.live),
    revealKey: row.key,
    // The coding transcript paces its live text; agent chat shows it whole.
    paced: !quietTools,
    completion: row.completion,
    backgroundWork: isLatestCompletion ? backgroundWorkCounts(snapshot) : undefined,
    animateComplete: hadLiveActivity(sessionId, turnIdentity),
    completionActivityKey: completionActivityKey(sessionId, turnIdentity),
    disclosureScope,
  };
  // Coding mode: a turn's status line is the last thing of the turn, so with
  // cards the footer follows them instead of sitting inside the message.
  const footerAfterCards =
    !quietTools &&
    Boolean(row.turnChanges) &&
    Boolean(row.completion) &&
    row.item?.kind === 'assistant' &&
    showsResponseFooter(row.item, row.completion);
  if (footerAfterCards) assistantProps.footerAfterCards = true;
  const assistant = renderAssistantRow ? (
    renderAssistantRow(assistantProps)
  ) : (
    <TranscriptAssistantRow {...assistantProps} />
  );
  return row.turnChanges ? (
    <>
      {assistant}
      {seatTurnCards(turnCards)}
      <PreviewedTurnChangesCard turnChanges={row.turnChanges} visualized={turnCards?.visualized} />
      {footerAfterCards && row.item && row.completion && (
        <TranscriptResponseFooter
          trailing
          item={row.item}
          completion={row.completion}
          animateComplete={assistantProps.animateComplete}
          completionActivityKey={assistantProps.completionActivityKey}
          backgroundWork={assistantProps.backgroundWork}
        />
      )}
    </>
  ) : (
    assistant
  );
}

/** The turn's visualize cards, seated once above its changed-files card. */
function seatTurnCards(turnCards?: TurnCardsSeat): ReactNode {
  if (!turnCards) return null;
  turnCards.placed = true;
  return turnCards.cards;
}
