import { useEffect, useRef } from 'react';

import { refreshUsageDashboardAfterAuth, type UsageApi } from '../usage-dashboard-store';

/** Only a completed flow changes credentials. Status polling, effect replay,
 *  and provider-setup retries must not trigger another usage sweep. */
export function useOAuthUsageRefresh(api: UsageApi, flowId: string, state: string): void {
  const refreshedFlow = useRef('');
  useEffect(() => {
    if (!flowId || state !== 'complete' || refreshedFlow.current === flowId) return;
    refreshedFlow.current = flowId;
    void refreshUsageDashboardAfterAuth(api).catch(() => {
      // Usage availability cannot turn a confirmed login into an auth failure.
    });
  }, [api, flowId, state]);
}
