import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  getUsageResetVerificationState,
  subscribeUsageResetVerification,
  type UsageResetVerificationState,
} from './usage-dashboard-store';
import { nextUsageResetVerificationAt } from './usage-reset-time';

const MAX_RESET_UI_TICK_MS = 24 * 86_400_000;

export function useUsageResetVerification({ resetAts }: { resetAts: readonly number[] }): UsageResetVerificationState {
  const state = useSyncExternalStore(subscribeUsageResetVerification, getUsageResetVerificationState);
  const [clockRevision, setClockRevision] = useState(0);
  const resetSignature = [...new Set(resetAts)].sort((left, right) => left - right).join('|');

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSignature tracks distinct reset timestamps and clockRevision reschedules intermediate >24d wakeups
  useEffect(() => {
    const currentResetAts = resetSignature ? resetSignature.split('|').map((value) => Number(value)) : [];
    const now = Date.now();
    const nextResetAt = nextUsageResetVerificationAt(currentResetAts, now);
    if (nextResetAt === null) return undefined;
    const delay = Math.min(nextResetAt - now + 25, MAX_RESET_UI_TICK_MS);

    const timer = window.setTimeout(() => {
      setClockRevision((current) => current + 1);
    }, delay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [clockRevision, resetSignature]);

  return state;
}
