import { useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { settledUserRowCount, type PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { useConversationOptimisticPromptRelease } from './use-conversation-optimistic-prompts';
import { useConversationSteering } from './use-conversation-steering';

/** Prompts submitted from this pane that the transcript has not settled yet:
 *  the steering projection, the review scope they open, the goal submission
 *  marker, and their release. */
export function useConversationPendingPrompts({
  optimisticPrompts,
  setOptimisticPrompts,
  settledItems,
  queued,
  transcriptSessionKey,
  promotedOwnDraft,
}: {
  optimisticPrompts: PendingPromptItem[];
  setOptimisticPrompts: Dispatch<SetStateAction<PendingPromptItem[]>>;
  settledItems: TranscriptItem[];
  queued: unknown;
  transcriptSessionKey: string;
  promotedOwnDraft: { current: boolean };
}) {
  // Submit-time baseline for the id-agnostic release path below.
  const settledUsers = useMemo(() => settledUserRowCount(settledItems), [settledItems]);
  const settledUsersRef = useRef(settledUsers);
  settledUsersRef.current = settledUsers;
  const steering = useConversationSteering(optimisticPrompts, settledItems, queued);
  const { transcriptPendingPromptItems } = steering;
  // An idle submit starts the next review scope on its optimistic user row,
  // not one host round-trip later when that row settles. Otherwise the prior
  // turn's review bar/reservation remains fixed above the composer while the
  // next response begins streaming.
  const reviewItems = useMemo(
    () => (transcriptPendingPromptItems.length > 0 ? [...settledItems, ...transcriptPendingPromptItems] : settledItems),
    [settledItems, transcriptPendingPromptItems]
  );
  // Close previous-turn chrome with the optimistic row. The goal owns a
  // separate snapshot lane, so its mask must survive transcript settlement;
  // the island releases it only when its own goal revision changes.
  const goalSubmitScopeRef = useRef(transcriptSessionKey);
  goalSubmitScopeRef.current = transcriptSessionKey;
  const goalSubmission = useRef<{ id: string; scope: string } | null>(null);
  const goalSubmissionId = goalSubmission.current?.scope === transcriptSessionKey ? goalSubmission.current.id : '';
  useConversationOptimisticPromptRelease({
    transcriptSessionKey,
    promotedOwnDraft,
    settledItems,
    setOptimisticPrompts,
  });
  return { ...steering, settledUsersRef, reviewItems, goalSubmitScopeRef, goalSubmission, goalSubmissionId };
}
