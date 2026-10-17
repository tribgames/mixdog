import { useEffect, useState } from 'react';
import type { ComposerIslandQuotaResume } from './ComposerIsland';
import type { ComposerQuotaCardModel } from './ComposerQuotaCard';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { modelDisplayName } from './provider-display';
import { latestQuotaFailure, quotaDismissKey, quotaPanelVisible } from './quota-continue';
import { record } from './record-utils';
import { t } from './i18n';

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
 * by itself when a new turn begins. A changed model offers an immediate
 * retry without removing an existing reservation.
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
  // A changed route can resume immediately; the stopped turn still owns its reservation.
  const switchedAway = Boolean(
    stopped &&
      ((chatProvider && chatProvider !== stopped.quota.provider) ||
        (chatModel && stopped.quota.model && chatModel !== stopped.quota.model))
  );
  const quotaFailure = stopped;
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
  const exhaustedProvider =
    quotaVisible && !switchedAway && quotaFailure?.kind === 'quota_exhausted'
      ? (quotaFailure?.quota.provider ?? '')
      : '';
  const [otherAccount, setOtherAccount] = useState({ provider: '', offered: false });
  useEffect(() => {
    // Every banner reads the roster afresh: an earlier answer never outlives
    // the stop it was read for, and a failed read offers no accounts.
    setOtherAccount({ provider: '', offered: false });
    if (!exhaustedProvider) return undefined;
    let current = true;
    void Promise.resolve()
      .then(() =>
        window.mixdogDesktop.invokeCapability({ capability: 'getProviderAccounts', args: [exhaustedProvider] })
      )
      .then(
        (response) => {
          if (current)
            setOtherAccount({ provider: exhaustedProvider, offered: rosterOffersOtherAccount(response?.value) });
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
        waiting
          ? window.mixdogDesktop.cancelQuotaResume(sessionId)
          : window.mixdogDesktop.scheduleQuotaResume(sessionId)
      ).finally(() => setToggling(false));
    };
    // Only an exhausted quota resets; a plan or billing stop has nothing to resume at.
    const resettable = quotaFailure.kind === 'quota_exhausted';
    quotaCard = {
      kind: quotaFailure.kind,
      resetAt: resettable ? resetAt : null,
      otherAccount: otherAccount.provider === quotaFailure.quota.provider && otherAccount.offered,
      reserved: waiting,
      busy: toggling,
      onResume: switchedAway
        ? () => {
            if (toggling) return;
            setToggling(true);
            void invokeResult(async () => {
              const result = await window.mixdogDesktop.invokeCapability({
                capability: 'retryFailedTurn',
                sessionId,
                args: [sessionId, quotaFailure.turnKey],
              });
              if (result.value !== true) {
                throw new Error(t('Unable to resume this turn. Check its status or send a new message.'));
              }
              return result;
            }).finally(() => setToggling(false));
          }
        : undefined,
      onToggleResume: waiting || (resettable && resetAt !== null) ? toggleResume : undefined,
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
