import type { RefObject } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import { conversationModelMismatch } from './conversation-pane-model-mismatch';
import type { useConversationComposerActions } from './conversation-support';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { conversationIslandFlash, type useConversationApprovals } from './use-conversation-approvals';
import { useConversationQuotaIsland } from './use-conversation-quota-island';

export type ConversationIsland = ReturnType<typeof useConversationIsland>;

/** Everything the composer island shows besides the goal: the approval card,
 *  the one-shot flash, the model mismatch offer and the quota panels. */
export function useConversationIsland({
  approvals,
  draftMode,
  snapshot,
  routeSnapshot,
  routeSessionIdRef,
  settledItems,
  settledTurnKeys,
  pendingPromptCount,
  actions,
  retryTurnRef,
  onRoutePreferenceApplied,
}: {
  approvals: ReturnType<typeof useConversationApprovals>;
  draftMode: boolean;
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  routeSessionIdRef: { current: string };
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  pendingPromptCount: number;
  actions: ReturnType<typeof useConversationComposerActions>;
  retryTurnRef: RefObject<(turnKey: string) => Promise<boolean>>;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
}) {
  const { continueFlash, quotaExhausted, quotaResume } = useConversationQuotaIsland({
    draftMode,
    snapshot,
    quotaSessionId: String(routeSnapshot.sessionId || ''),
    settledItems,
    settledTurnKeys,
    pendingPromptCount,
    invokeResult: actions.composerInvokeResult,
    retryTurnRef,
    onRoutePreferenceApplied,
  });
  const { approvalCard, retiredApproval, answeredElsewhere, viewerDevice } = approvals;
  return {
    approval: approvalCard,
    islandFlash: conversationIslandFlash(retiredApproval, answeredElsewhere, continueFlash, viewerDevice),
    modelMismatch: conversationModelMismatch({
      draftMode,
      routeSnapshot,
      routeSessionIdRef,
      invokeResult: actions.composerInvokeResult,
      applySnapshot: actions.composerApplySnapshot,
      onInherit: actions.composerOnInherit,
    }),
    quotaExhausted,
    quotaResume,
  };
}
