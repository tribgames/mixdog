import { useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
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
  const goalSubmitScopeRef = useRef(transcriptSessionKey);
  goalSubmitScopeRef.current = transcriptSessionKey;
  const goalSubmission = useRef<{ id: string; scope: string } | null>(null);
  const goalSubmissionId = goalSubmission.current?.scope === transcriptSessionKey ? goalSubmission.current.id : '';
  useConversationOptimisticPromptRelease({
    transcriptSessionKey,
    promotedOwnDraft,
    settledItems,
    optimisticPrompts,
    setOptimisticPrompts,
  });
  return { ...steering, reviewItems, goalSubmitScopeRef, goalSubmission, goalSubmissionId };
}
