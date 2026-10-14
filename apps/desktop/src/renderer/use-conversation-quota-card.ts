import { useEffect, useState } from 'react';
import type { ComposerIslandQuotaResume } from './ComposerIsland';
import type { ComposerQuotaCardModel } from './ComposerQuotaCard';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { modelDisplayName } from './provider-display';
import { latestQuotaFailure, quotaDismissKey, quotaPanelVisible } from './quota-continue';
import { record } from './record-utils';

/** The account roster says the user picks the account by hand and another
 *  signed-in account is there to pick (getProviderAccounts' pool shape;
 *  a roster without `policy` maps auto off to manual). */
export function rosterOffersOtherAccount(value: unknown): boolean {
  const pool = record(value);
  const policy = pool.policy ?? (pool.auto === false ? 'manual' : 'limit');
  if (policy !== 'manual' || !Array.isArray(pool.accounts)) return false;
  return pool.accounts.some((account) => {
    const row = record(account);
    return row.id !== pool.selectedId && row.authenticated === true && row.reauthRequired !== true;
  });
}

/**
 * The quota banner above the composer: the latest turn stopped on an
 * exhausted provider quota and nothing has begun since. Its resume button
 * toggles the reservation at the reset (spinning while reserved). It leaves
 * by itself when a new turn begins or when the chat already runs on another
 * model than the exhausted one.
 */
export function useConversationQuotaCard({
  draftMode,
  snapshot,
  sessionId,
  chatProvider = '',
  chatModel = '',
  settledItems,
  settledTurnKeys,
  pendingPromptCount,
  invokeResult,
}: {
  draftMode: boolean;
  snapshot: Snapshot;
  sessionId: string;
  /** The route this chat runs on now; '' when unknown. */
  chatProvider?: string;
  chatModel?: string;
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  pendingPromptCount: number;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
}): { quotaCard: ComposerQuotaCardModel | null; quotaResume: ComposerIslandQuotaResume | null } {
  const [dismissedQuotaTurn, setDismissedQuotaTurn] = useState('');
  const [toggling, setToggling] = useState(false);
  const live = !draftMode && Boolean(sessionId);
  const stopped = live ? latestQuotaFailure(settledItems, settledTurnKeys) : null;
  // A chat already switched to another model has left the stop behind: its
  // next turn runs on that model.
  const switchedAway = Boolean(
    stopped &&
      ((chatProvider && chatProvider !== stopped.quota.provider) ||
        (chatModel && stopped.quota.model && chatModel !== stopped.quota.model))
  );
  const quotaFailure = switchedAway ? null : stopped;
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

  // Whether the exhausted provider's roster offers switching accounts.
  const exhaustedProvider = quotaVisible ? (quotaFailure?.quota.provider ?? '') : '';
  const [otherAccount, setOtherAccount] = useState({ provider: '', offered: false });
  useEffect(() => {
    // Every banner reads the roster afresh: an earlier answer never outlives
    // the stop it was read for, and a failed read offers no accounts.
    setOtherAccount({ provider: '', offered: false });
    if (!exhaustedProvider) return undefined;
    let current = true;
    void Promise.resolve()
      .then(() => window.mixdogDesktop.invokeCapability({ capability: 'getProviderAccounts', args: [exhaustedProvider] }))
      .then(
        (response) => {
          if (current) setOtherAccount({ provider: exhaustedProvider, offered: rosterOffersOtherAccount(response?.value) });
        },
        () => {
          if (current) setOtherAccount({ provider: '', offered: false });
        }
      );
    return () => {
      current = false;
    };
  }, [exhaustedProvider]);

  let quotaCard: ComposerQuotaCardModel | null = null;
  if (quotaFailure && quotaVisible) {
    const resetAt = quotaFailure.quota.resetAt;
    // One toggle: reserve the resume at the reset, or drop the reservation
    // (the runtime may already have made one on its own). The banner stays.
    const toggleResume = () => {
      if (toggling) return;
      setToggling(true);
      void invokeResult(() =>
        waiting ? window.mixdogDesktop.cancelQuotaResume(sessionId) : window.mixdogDesktop.scheduleQuotaResume(sessionId)
      ).finally(() => setToggling(false));
    };
    quotaCard = {
      resetAt,
      otherAccount: otherAccount.provider === quotaFailure.quota.provider && otherAccount.offered,
      reserved: waiting,
      busy: toggling,
      onToggleResume: resetAt === null ? undefined : toggleResume,
    };
  }

  // The island's waiting pill only when the banner is not showing the stop.
  let quotaResume: ComposerIslandQuotaResume | null = null;
  if (waiting && waitingResume && !quotaCard) {
    const resumeTurnKey = quotaFailure?.turnKey || waitingResume.turnKey;
    quotaResume = {
      model: modelDisplayName(waitingResume.model, waitingResume.provider),
      resetAt: waitingResume.resetAt,
      // Cancelling only drops the reservation: the turn stays stopped and
      // the banner does not reopen.
      onCancel: () => {
        const dismissKey = quotaDismissKey(sessionId, resumeTurnKey);
        void invokeResult(() => window.mixdogDesktop.cancelQuotaResume(sessionId)).then((cancelled) => {
          if (cancelled === true) setDismissedQuotaTurn(dismissKey);
        });
      },
    };
  }
  return { quotaCard, quotaResume };
}
