import { useRef, useState } from 'react';
import { useConversationPaneComposerActions } from './conversation-pane-composer-actions';
import type { ConversationProps } from './conversation-pane-props';
import { promptWaitsBehindActiveTurn, type PendingPromptItem } from './conversation-prompt-items';
import { useConversationComposerActions } from './conversation-support';
import type { TranscriptItem } from './desktop-types';
import { useConversationPendingPrompts } from './use-conversation-pending-prompts';

export type ConversationSubmission = ReturnType<typeof useConversationSubmission>;

type SubmissionPaneProps = Pick<
  ConversationProps,
  | 'snapshot'
  | 'routeSnapshot'
  | 'sessionAddress'
  | 'submit'
  | 'invokeResult'
  | 'applySnapshot'
  | 'onNewTask'
  | 'onResumeSession'
  | 'onOpenSessions'
  | 'onOpenProjects'
  | 'onOpenSettings'
  | 'onOpenCommandSurface'
  | 'onClearToNewTask'
  | 'onInheritSession'
>;

/** The composer's pane-local actions and the optimistic prompts they submit. */
export function useConversationSubmission(
  pane: SubmissionPaneProps,
  {
    draftMode,
    settledItems,
    transcriptSessionKey,
    promotedOwnDraft,
    routeSessionIdRef,
    armFollow,
    suppressDraftSubmitPaintHandoff,
  }: {
    draftMode: boolean;
    settledItems: TranscriptItem[];
    transcriptSessionKey: string;
    promotedOwnDraft: { current: boolean };
    routeSessionIdRef: { current: string };
    armFollow: () => void;
    suppressDraftSubmitPaintHandoff: { current: boolean };
  }
) {
  const [optimisticPrompts, setOptimisticPrompts] = useState<PendingPromptItem[]>([]);
  const draftModeRef = useRef(draftMode);
  draftModeRef.current = draftMode;
  const composerActions = useConversationPaneComposerActions({
    actions: {
      submit: pane.submit,
      invokeResult: pane.invokeResult,
      applySnapshot: pane.applySnapshot,
      onNewTask: pane.onNewTask,
      onResumeSession: pane.onResumeSession,
      onOpenSessions: pane.onOpenSessions,
      onOpenProjects: pane.onOpenProjects,
      onOpenSettings: pane.onOpenSettings,
      onOpenCommandSurface: pane.onOpenCommandSurface,
      onClearToNewTask: pane.onClearToNewTask,
    },
    sessionAddress: pane.sessionAddress,
    routeSnapshot: pane.routeSnapshot,
    onInheritSession: pane.onInheritSession,
  });
  // TUI parity: a prompt only reads as "Queued" when it actually waits behind
  // an active turn. An idle submit — including a draft's first prompt, whose
  // atomic RPC spans session materialization — renders as a normal user row.
  const queuedBehindTurnAtSubmit = useRef(false);
  queuedBehindTurnAtSubmit.current = promptWaitsBehindActiveTurn(draftMode, pane.snapshot);
  const pending = useConversationPendingPrompts({
    optimisticPrompts,
    setOptimisticPrompts,
    settledItems,
    queued: pane.snapshot.queued,
    transcriptSessionKey,
    promotedOwnDraft,
  });
  // Submit re-arms follow. The new row is an append, so virtual-core's
  // followOnAppend is the only end write.
  const armFollowOnSubmitRef = useRef(armFollow);
  armFollowOnSubmitRef.current = armFollow;
  const actions = useConversationComposerActions({
    armFollowOnSubmitRef,
    composerActions,
    draftModeRef,
    goalSubmission: pending.goalSubmission,
    goalSubmitScopeRef: pending.goalSubmitScopeRef,
    queuedBehindTurnAtSubmit,
    routeSessionIdRef,
    setOptimisticPrompts,
    settledUsersRef: pending.settledUsersRef,
    suppressDraftSubmitPaintHandoff,
  });
  return { ...pending, actions };
}
