import type { useConversationComposerActions } from './conversation-support';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { conversationIslandFlash, type useConversationApprovals } from './use-conversation-approvals';
import { useConversationQuotaCard } from './use-conversation-quota-card';

export type ConversationIsland = ReturnType<typeof useConversationIsland>;

/** Everything the composer dock shows around the island besides the goal:
 *  the approval card, the one-shot flash, the waiting quota resume and the
 *  quota card above the composer. */
export function useConversationIsland({
  approvals,
  draftMode,
  snapshot,
  routeSnapshot,
  settledItems,
  settledTurnKeys,
  pendingPromptCount,
  actions,
}: {
  approvals: ReturnType<typeof useConversationApprovals>;
  draftMode: boolean;
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  pendingPromptCount: number;
  actions: ReturnType<typeof useConversationComposerActions>;
}) {
  const { quotaCard, quotaResume } = useConversationQuotaCard({
    draftMode,
    snapshot,
    sessionId: String(routeSnapshot.sessionId || ''),
    chatProvider: String(routeSnapshot.sessionProvider || ''),
    chatModel: String(routeSnapshot.sessionModel || ''),
    settledItems,
    settledTurnKeys,
    pendingPromptCount,
    invokeResult: actions.composerInvokeResult,
  });
  const { approvalCard, dismissQuestion, answerQuestion, retiredApproval, answeredElsewhere, viewerDevice } = approvals;
  return {
    approval: approvalCard,
    dismissQuestion,
    answerQuestion,
    islandFlash: conversationIslandFlash(retiredApproval, answeredElsewhere, viewerDevice),
    quotaCard,
    quotaResume,
  };
}
