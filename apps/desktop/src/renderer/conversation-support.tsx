import {
  useCallback,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type {
  DesktopAbortOptions,
  DesktopPromptContent,
  DesktopSubmitOptions,
  SessionSnapshot,
} from '../shared/contract';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { TranscriptAssistantRow, type TranscriptAssistantRowProps } from './TranscriptAssistantRow';
import { turnPromptText, type TranscriptRowModel } from './transcript-rows';
import { TranscriptRow } from './transcript-row';
import { LiveActivity } from './transcript-status';
import { ToolActivityGroup } from './transcript-tool-ui';
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

export function useConversationComposerActions({
  armFollowOnSubmitRef,
  composerActions,
  draftModeRef,
  goalSubmission,
  goalSubmitScopeRef,
  queuedBehindTurnAtSubmit,
  routeSessionIdRef,
  setOptimisticPrompts,
  settledUsersRef,
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
  settledUsersRef: { current: number };
  suppressDraftSubmitPaintHandoff: { current: boolean };
}) {
  const composerSubmit = useCallback(async (content: DesktopPromptContent, options?: DesktopSubmitOptions) => {
    const submittedAt = Number(options?.submittedAt);
    const trackedSubmittedAt = Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Date.now();
    const submissionId = String(options?.id || '').trim() || nextComposerSubmissionId();
    const images = pendingPromptImages(options);
    const optimistic: PendingPromptItem = {
      id: submissionId,
      kind: 'user',
      text: desktopPromptDisplayText(content, options),
      pending: true,
      accepted: false,
      submittedAt: trackedSubmittedAt,
      queuedBehindTurn: queuedBehindTurnAtSubmit.current,
      settledUserBaseline: settledUsersRef.current,
      ...(images.length ? { images } : {}),
    };
    const materializingDraft = draftModeRef.current;
    if (materializingDraft) suppressDraftSubmitPaintHandoff.current = true;
    // Every idle submit closes completed goal chrome, even without a diff.
    // The goal lane decides whether its goal is complete; queued follow-ups
    // ride the active turn and must not touch the current chrome.
    if (!queuedBehindTurnAtSubmit.current) {
      goalSubmission.current = { id: submissionId, scope: goalSubmitScopeRef.current };
    }
    setOptimisticPrompts((current) => [...current.filter((item) => item.id !== submissionId), optimistic]);
    window.mixdogDesktop?.perfLog?.(`prompt-submit phase=renderer-queued id=${submissionId}`);
    armFollowOnSubmitRef.current();
    const acceptedStartedAt = performance.now();
    let accepted: unknown;
    try {
      accepted = await composerActions.current.invokeResult(() =>
        composerActions.current.submit(content, {
          ...options,
          id: submissionId,
          submittedAt: trackedSubmittedAt,
        })
      );
    } catch (error) {
      if (materializingDraft) suppressDraftSubmitPaintHandoff.current = false;
      if (goalSubmission.current?.id === submissionId) goalSubmission.current = null;
      setOptimisticPrompts((current) => current.filter((item) => String(item.id) !== submissionId));
      throw error;
    }
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
  const composerAbort = useCallback(
    (options: DesktopAbortOptions = {}) =>
      composerActions.current.invokeResult(() => {
        const host = window.mixdogDesktop;
        const sessionId = routeSessionIdRef.current;
        return sessionId ? host.abortSession(sessionId, options) : { aborted: false };
      }),
    []
  );
  const composerInvokeResult = useCallback(
    <T,>(action: () => T | Promise<T>) => composerActions.current.invokeResult(action),
    []
  );
  const composerQueuedRestored = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const restored = new Set(ids);
    setOptimisticPrompts((current) => {
      const next = current.filter((item) => !restored.has(String(item.id)));
      return next.length === current.length ? current : next;
    });
  }, []);
  const composerApplySnapshot = useCallback(
    (next: SessionSnapshot | null) => composerActions.current.applySnapshot(next),
    []
  );
  const composerOnNewTask = useCallback(() => composerActions.current.onNewTask(), []);
  // A session pane's /clear · /new addresses ITS OWN session (pane-local
  // route), never the globally focused one.
  const composerOnClearToNewTask = useCallback(() => {
    const sessionId = routeSessionIdRef.current;
    if (sessionId) composerActions.current.onClearToNewTask?.(sessionId);
  }, []);
  const composerOnResumeSession = useCallback((id: string) => composerActions.current.onResumeSession(id), []);
  const composerOnOpenSessions = useCallback(() => composerActions.current.onOpenSessions(), []);
  const composerOnOpenProjects = useCallback(() => composerActions.current.onOpenProjects(), []);
  const composerOnOpenSettings = useCallback(
    (section?: SettingsSection | null) => composerActions.current.onOpenSettings(section),
    []
  );
  const composerOnOpenCommandSurface = useCallback(
    (surface: CommandSurfaceName) => composerActions.current.onOpenCommandSurface(surface),
    []
  );
  const composerOnInherit = useCallback(() => composerActions.current.onInherit(), []);
  return {
    composerAbort,
    composerApplySnapshot,
    composerInvokeResult,
    composerOnClearToNewTask,
    composerOnNewTask,
    composerOnInherit,
    composerOnOpenCommandSurface,
    composerOnOpenProjects,
    composerOnOpenSessions,
    composerOnOpenSettings,
    composerOnResumeSession,
    composerQueuedRestored,
    composerSubmit,
  };
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
  const transcriptKey =
    event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'Home' || event.key === 'End';
  const target = event.target as HTMLElement | null;
  const editingHomeOrEnd =
    (event.key === 'Home' || event.key === 'End') &&
    Boolean(target?.closest('textarea, input, select, [contenteditable="true"]'));
  const paletteOpen = Boolean(
    event.currentTarget.querySelector('[data-composer-palette-open="true"], [role="listbox"]')
  );
  const nestedScroller = target?.closest<HTMLElement>('[data-scrollable]');
  if (
    transcriptKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !editingHomeOrEnd &&
    !paletteOpen &&
    !nestedScroller
  ) {
    const element = viewport.current;
    if (element) {
      event.preventDefault();
      onTranscriptKey({ key: event.key });
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        const direction = event.key === 'PageDown' ? 1 : -1;
        element.scrollBy({ top: Math.round(element.clientHeight * 0.9) * direction, behavior: 'auto' });
      } else {
        element.scrollTo({ top: event.key === 'Home' ? 0 : element.scrollHeight, behavior: 'auto' });
      }
    }
    return;
  }
  // Typing must always land in the composer: a printable key (or the
  // IME "Process" key starting a Korean composition) pressed while
  // focus sits on the transcript or tool chrome refocuses the input
  // BEFORE the character/composition commits, so keystrokes are never
  // silently dropped (user: 간헐적으로 채팅 입력이 안 됨).
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length !== 1 && event.key !== 'Process') return;
  if (!target || typeof target.closest !== 'function') return;
  if (target.closest('textarea, input, select, [contenteditable="true"]')) return;
  // Structural hook, not the accessible name: the aria-label is
  // localized, so matching its English copy never found the
  // textarea outside the English UI.
  event.currentTarget
    .querySelector<HTMLTextAreaElement>('.composer-input-row textarea')
    ?.focus({ preventScroll: true });
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
    snapshot,
    onRetryTurn,
  }: {
    disclosureScope: string;
    optimisticActivityStartedAt: number;
    readOnly: boolean;
    renderAssistantRow?: (props: TranscriptAssistantRowProps) => ReactNode;
    retryDisabled: boolean;
    settledItems: readonly TranscriptItem[];
    settledTurnKeys: readonly string[];
    snapshot: Snapshot;
    onRetryTurn(turnKey: string): void;
  }
): ReactNode {
  if (row._tag === 'TurnGap') {
    return <div className="transcript-turn-gap" aria-hidden="true" />;
  }
  if (row._tag === 'Error') {
    const retryKey = [...row.failures]
      .reverse()
      .find((failure) => turnPromptText(settledItems, settledTurnKeys, failure.turnKey))?.turnKey;
    return (
      <ErrorNotice
        className="transcript-error-notice"
        errors={row.failures.map(
          ({ item }) => item?.errorDetails || item?.detail || item?.message || item?.text || item?.label || t('Failed')
        )}
        onRetry={!readOnly && retryKey ? () => onRetryTurn(retryKey) : undefined}
        retryDisabled={retryDisabled}
        role="status"
      />
    );
  }
  if (row._tag === 'Thinking') {
    return (
      <div className="live-activity-slot" data-busy="true">
        <LiveActivity snapshot={snapshot} optimisticStartedAt={optimisticActivityStartedAt} />
      </div>
    );
  }
  if (row._tag === 'UserMessage') {
    return <TranscriptRow item={row.item} disclosureScope={disclosureScope} attachedUser={row.attachedUser} />;
  }
  if (row._tag === 'ToolActivity') {
    return <ToolActivityGroup items={row.items} disclosureScope={disclosureScope} />;
  }
  const assistantProps: TranscriptAssistantRowProps = {
    item: row.item,
    live: Boolean(row.live),
    completion: row.completion,
    disclosureScope,
  };
  return renderAssistantRow ? renderAssistantRow(assistantProps) : <TranscriptAssistantRow {...assistantProps} />;
}
