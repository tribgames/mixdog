import { type ReactNode, useMemo } from 'react';
import type { DesktopPromptContent, DesktopSubmitOptions } from '../shared/contract';
import type { ConversationProps } from './conversation-pane-props';
import { transcriptRowNode } from './conversation-support';
import type { Snapshot, TranscriptItem } from './desktop-types';
import type { TranscriptRowModel } from './transcript-rows';
import { useConversationRetry } from './use-conversation-retry';

/** Renders one transcript row with the pane's retry and disclosure scope. */
export function useConversationRowRenderer({
  snapshot,
  disclosureScope,
  readOnly,
  transitioning,
  renderAssistantRow,
  onOpenSettings,
  settledItems,
  settledTurnKeys,
  optimisticActivityStartedAt,
  submit,
  questionCard,
}: {
  snapshot: Snapshot;
  disclosureScope: string;
  readOnly: boolean;
  transitioning: boolean;
  renderAssistantRow: ConversationProps['renderAssistantRow'];
  onOpenSettings: ConversationProps['onOpenSettings'];
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  optimisticActivityStartedAt: number;
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  /** The pending ask_user card; it renders in place of its tool call. */
  questionCard: ReactNode;
}) {
  const { retryTurn } = useConversationRetry(settledItems, settledTurnKeys, submit);
  const latestCompletion = useMemo(() => {
    for (let index = settledItems.length - 1; index >= 0; index -= 1) {
      if (settledItems[index]?.kind === 'turndone') return settledItems[index];
    }
    return undefined;
  }, [settledItems]);
  const retryDisabled = Boolean(snapshot.busy) || transitioning;
  const renderTranscriptRow = (row: TranscriptRowModel): ReactNode =>
    transcriptRowNode(row, {
      disclosureScope,
      optimisticActivityStartedAt,
      readOnly,
      renderAssistantRow,
      retryDisabled,
      settledItems,
      settledTurnKeys,
      latestCompletion,
      snapshot,
      onRetryTurn: retryTurn,
      onOpenSettings,
      questionCard,
    });
  return { renderTranscriptRow };
}
