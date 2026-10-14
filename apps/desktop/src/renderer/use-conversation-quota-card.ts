import { useRef, useState } from 'react';
import type { ComposerIslandQuotaResume } from './ComposerIsland';
import type { ComposerQuotaCardModel } from './ComposerQuotaCard';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { modelDisplayName, providerDisplayName } from './provider-display';
import { beginQuotaContinue, latestQuotaFailure, quotaDismissKey, quotaPanelVisible } from './quota-continue';

/**
 * The quota card above the composer: the latest turn stopped on an exhausted
 * provider quota and nothing has begun since. It offers resuming at the reset
 * or switching this chat to another model: the model picker applies the pick
 * in place, then the stopped turn is retried once. A reserved resume shows as
 * the island's pill once the card is closed, with the same switch.
 */
export function useConversationQuotaCard({
  draftMode,
  snapshot,
  sessionId,
  settledItems,
  settledTurnKeys,
  pendingPromptCount,
  invokeResult,
}: {
  draftMode: boolean;
  snapshot: Snapshot;
  sessionId: string;
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  pendingPromptCount: number;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
}): { quotaCard: ComposerQuotaCardModel | null; quotaResume: ComposerIslandQuotaResume | null } {
  const [dismissedQuotaTurn, setDismissedQuotaTurn] = useState('');
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);
  const live = !draftMode && Boolean(sessionId);
  const quotaFailure = live ? latestQuotaFailure(settledItems, settledTurnKeys) : null;
  const waitingResume = live ? (snapshot.quotaResume ?? null) : null;
  const waiting = waitingResume?.state === 'waiting';
  const quotaVisible =
    pendingPromptCount === 0 &&
    quotaPanelVisible({
      failure: quotaFailure,
      sessionId,
      busy: Boolean(snapshot.busy),
      dismissedKey: dismissedQuotaTurn,
    });

  // The picker applies the pick to this chat in place (the route change
  // also drops a reserved resume); once another model is applied the stopped
  // turn is retried exactly once. The pick may land long after the click and
  // before this view re-renders, so the session itself decides: it retries
  // only while the turn is still its latest failed turn with nothing
  // running, settling or queued. No picker (locked model controls): nothing
  // happens.
  const switchModel = (turnKey: string) => {
    if (switchingRef.current) return;
    const owner = sessionId;
    beginQuotaContinue(owner, () => {
      if (switchingRef.current) return;
      switchingRef.current = true;
      setSwitching(true);
      void invokeResult(() =>
        window.mixdogDesktop.invokeCapability({
          capability: 'retryFailedTurn',
          sessionId: owner,
          args: [owner, turnKey],
        })
      ).finally(() => {
        switchingRef.current = false;
        setSwitching(false);
      });
    });
  };

  let quotaCard: ComposerQuotaCardModel | null = null;
  if (quotaFailure && quotaVisible) {
    const { turnKey } = quotaFailure;
    const dismiss = () => setDismissedQuotaTurn(quotaDismissKey(sessionId, turnKey));
    const resetAt = quotaFailure.quota.resetAt;
    let onWait: (() => void) | undefined;
    if (resetAt !== null) {
      // A reservation the runtime already made only needs the card closed.
      onWait = waiting
        ? dismiss
        : () =>
            void invokeResult(() => window.mixdogDesktop.scheduleQuotaResume(sessionId)).then((scheduled) => {
              if (scheduled === true) dismiss();
            });
    }
    quotaCard = {
      provider: providerDisplayName(quotaFailure.quota.provider),
      resetAt,
      busy: switching,
      onWait,
      onSwitch: () => switchModel(turnKey),
      onDismiss: dismiss,
    };
  }

  let quotaResume: ComposerIslandQuotaResume | null = null;
  if (waiting && waitingResume && !quotaCard) {
    const resumeTurnKey = quotaFailure?.turnKey || waitingResume.turnKey;
    quotaResume = {
      model: modelDisplayName(waitingResume.model, waitingResume.provider),
      resetAt: waitingResume.resetAt,
      busy: switching,
      // Cancelling only drops the reservation: the turn stays stopped and
      // the card does not reopen.
      onCancel: () => {
        const dismissKey = quotaDismissKey(sessionId, resumeTurnKey);
        void invokeResult(() => window.mixdogDesktop.cancelQuotaResume(sessionId)).then((cancelled) => {
          if (cancelled === true) setDismissedQuotaTurn(dismissKey);
        });
      },
      onContinue: () => switchModel(resumeTurnKey),
    };
  }
  return { quotaCard, quotaResume };
}
