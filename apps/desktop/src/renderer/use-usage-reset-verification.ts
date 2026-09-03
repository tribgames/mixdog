import { useEffect, useState } from "react";

import {
  getUsageDashboardSnapshot,
  refreshUsageDashboard,
  type UsageApi,
} from "./usage-dashboard-store";
import { nextUsageResetVerificationAt } from "./usage-reset-time";

export function useUsageResetVerification({
  api,
  resetAts,
  refreshedAt,
}: {
  api: UsageApi | undefined;
  resetAts: readonly number[];
  refreshedAt: number;
}): ReadonlySet<number> {
  const [failedResetAts, setFailedResetAts] = useState<ReadonlySet<number>>(() => new Set());
  const [, setClockRevision] = useState(0);
  const resetSignature = [...new Set(resetAts)].sort((left, right) => left - right).join("|");
  const failedSignature = [...failedResetAts].sort((left, right) => left - right).join("|");

  useEffect(() => {
    const currentResetAts = resetSignature
      ? resetSignature.split("|").map((value) => Number(value))
      : [];
    const nextResetAt = nextUsageResetVerificationAt(
      currentResetAts,
      refreshedAt,
      failedResetAts,
    );
    if (nextResetAt === null) return undefined;

    let active = true;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      const dueResetAts = currentResetAts.filter((resetAt) =>
        resetAt <= now && resetAt > refreshedAt && !failedResetAts.has(resetAt));
      if (dueResetAts.length === 0) return;

      setClockRevision((current) => current + 1);
      const beforeRefresh = getUsageDashboardSnapshot().refreshedAt;
      void refreshUsageDashboard(api, { force: true }).then(() => {
        if (!active) return;
        if (getUsageDashboardSnapshot().refreshedAt > beforeRefresh) return;
        setFailedResetAts((current) => new Set([...current, ...dueResetAts]));
      });
    }, Math.max(0, nextResetAt - Date.now()) + 25);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, failedSignature, refreshedAt, resetSignature]);

  return failedResetAts;
}
