import { useEffect, useRef, useState, type RefObject } from 'react';
import type { DesktopModelSelection } from '../shared/contract';
import type { ComposerIslandFlash, ComposerIslandQuota, ComposerIslandQuotaResume } from './ComposerIsland';
import type { Snapshot, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { modelDisplayName, providerDisplayName } from './provider-display';
import {
  beginQuotaContinue,
  continueAfterQuota,
  latestQuotaFailure,
  quotaDismissKey,
  quotaIslandPlan,
  quotaPanelVisible,
} from './quota-continue';
import { subscribeSetupChanges } from './setup-change-refresh';

/** The latest turn stopped on an exhausted provider quota and nothing has
 *  begun since: offer leaving it stopped or continuing in another model, or
 *  show the scheduled resume. A successful continue raises a flash. */
export function useConversationQuotaIsland({
  draftMode,
  snapshot,
  quotaSessionId,
  settledItems,
  settledTurnKeys,
  pendingPromptCount,
  invokeResult,
  retryTurnRef,
  onRoutePreferenceApplied,
}: {
  draftMode: boolean;
  snapshot: Snapshot;
  quotaSessionId: string;
  settledItems: TranscriptItem[];
  settledTurnKeys: string[];
  pendingPromptCount: number;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  retryTurnRef: RefObject<(turnKey: string) => Promise<boolean>>;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
}): {
  continueFlash: ComposerIslandFlash | null;
  quotaExhausted: ComposerIslandQuota | null;
  quotaResume: ComposerIslandQuotaResume | null;
} {
  const [dismissedQuotaTurn, setDismissedQuotaTurn] = useState('');
  const [continueFlash, setContinueFlash] = useState<ComposerIslandFlash | null>(null);
  const continueFlashSequence = useRef(0);
  const quotaFailure = draftMode ? null : latestQuotaFailure(settledItems, settledTurnKeys);
  const [quotaAutoResume, setQuotaAutoResume] = useState<boolean | null>(null);
  const quotaWatched = Boolean(quotaFailure);
  useEffect(() => {
    if (!quotaWatched) return undefined;
    let live = true;
    const read = () =>
      void Promise.resolve(window.mixdogDesktop.getQuotaAutoResume?.())
        .then((enabled) => live && typeof enabled === 'boolean' && setQuotaAutoResume(enabled))
        .catch(() => {});
    read();
    const unsubscribe = subscribeSetupChanges(read);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [quotaWatched]);
  const continueQuotaInAnotherModel = (turnKey: string) => {
    // If no picker answers (model controls locked) the panel stays as is.
    beginQuotaContinue(quotaSessionId, (selection) => {
      void invokeResult(() =>
        continueAfterQuota({
          switchModel: () => window.mixdogDesktop.continueSessionInModel(quotaSessionId, selection),
          retry: () => retryTurnRef.current(turnKey),
        })
      ).then((outcome) => {
        if (outcome === undefined || outcome === 'failed') return;
        onRoutePreferenceApplied?.(selection, { modelChoice: true });
        if (outcome !== 'retried') return;
        continueFlashSequence.current += 1;
        setContinueFlash({
          key: `quota-continue:${continueFlashSequence.current}`,
          text: t('Continuing this chat in {{model}}', {
            model: modelDisplayName(selection.model, selection.provider),
          }),
        });
      });
    });
  };
  const waitingResume = draftMode || !quotaSessionId ? null : (snapshot.quotaResume ?? null);
  const quotaPlan = quotaIslandPlan({
    resume: waitingResume,
    failure: quotaFailure,
    autoResume: quotaAutoResume,
    panelVisible:
      pendingPromptCount === 0 &&
      quotaPanelVisible({
        failure: quotaFailure,
        sessionId: quotaSessionId,
        busy: Boolean(snapshot.busy),
        dismissedKey: dismissedQuotaTurn,
      }),
  });
  let quotaExhausted: ComposerIslandQuota | null = null;
  if (quotaFailure && (quotaPlan === 'panel' || quotaPlan === 'panel-schedule')) {
    quotaExhausted = {
      provider: providerDisplayName(quotaFailure.quota.provider),
      resetAt: quotaFailure.quota.resetAt,
      onDismiss: () => setDismissedQuotaTurn(quotaDismissKey(quotaSessionId, quotaFailure.turnKey)),
      onContinue: () => continueQuotaInAnotherModel(quotaFailure.turnKey),
      onSchedule:
        quotaPlan === 'panel-schedule'
          ? () => void invokeResult(() => window.mixdogDesktop.scheduleQuotaResume(quotaSessionId))
          : undefined,
    };
  }
  let quotaResume: ComposerIslandQuotaResume | null = null;
  if (quotaPlan === 'resume' && waitingResume) {
    quotaResume = {
      model: modelDisplayName(waitingResume.model, waitingResume.provider),
      resetAt: waitingResume.resetAt,
      // Cancelling only drops the reservation: the turn stays stopped and
      // the island closes rather than reopening the quota panel.
      onCancel: () => {
        const dismissKey = quotaDismissKey(quotaSessionId, quotaFailure?.turnKey || waitingResume.turnKey);
        void invokeResult(() => window.mixdogDesktop.cancelQuotaResume(quotaSessionId)).then((cancelled) => {
          if (cancelled === true) setDismissedQuotaTurn(dismissKey);
        });
      },
      onContinue: () => continueQuotaInAnotherModel(waitingResume.turnKey),
    };
  }
  return { continueFlash, quotaExhausted, quotaResume };
}
