/**
 * integrations.mjs — the session object's account/integration surface:
 * provider authentication (OAuth flows, API keys, usage auth), usage
 * dashboards, turn review diffs, onboarding, channel setup, and the
 * webhook / schedule automation entries.
 */
import { createHash } from 'node:crypto';
import { createApiHelpers } from './shared.mjs';

export function createSessionIntegrationsApi(bag, { oauthFlows }) {
  const { runtime, getState, set, pushNotice, routeState, resetStatsAndSyncContext } = bag;
  const { withCommandLock, refreshRouteStats } = createApiHelpers({
    getState,
    set,
    resetStatsAndSyncContext,
    routeState,
  });
  const requireRuntimeMethod = (name, unavailable) => {
    if (typeof runtime[name] !== 'function') throw new Error(unavailable);
    return runtime[name].bind(runtime);
  };
  // A runtime automation call announced by one notice.
  const announced =
    (call, notice) =>
    async (...args) => {
      const result = await call(...args);
      pushNotice(notice(result, ...args), 'info');
      return result;
    };

  return {
    getUsageDashboard: async (options = {}) => {
      return await runtime.getUsageDashboard?.(options);
    },
    getUsageStats: async (options = {}) => {
      return await runtime.getUsageStats?.(options);
    },
    consumeCodexRateLimitResetCredit: async (options = {}) => {
      // Desktop capability parity: without this delegation the session runtime
      // surface rejects the sidebar's reset-credit invoke as unsupported even
      // though the session runtime implements it.
      return await requireRuntimeMethod('consumeCodexRateLimitResetCredit', 'Codex reset is unavailable')(options);
    },
    getTurnReviewDiff: async (options = {}) => {
      const { known, summary, ...reviewOptions } = options || {};
      let review = (await runtime.getTurnReviewDiff?.(reviewOptions)) ?? {
        supported: false,
        files: [],
        patch: '',
      };
      // A collapsed bar shows files and line counts only. A Git-backed review
      // carries those per file, so its patch text (tens of KB mid-turn) is
      // left out until the bar is opened; other kinds count from the patch.
      if (summary === true && (review.snapshotKind === 'worktree' || review.snapshotKind === 'scoped') && review.patch) {
        review = { ...review, patch: '', patchOmitted: true };
      }
      // The review bar re-reads every few seconds during a turn; an unchanged
      // review answers with its tag instead of re-sending every patch. The tag
      // covers what is sent, so a summary and a full review never share one.
      const etag = createHash('sha256').update(JSON.stringify(review)).digest('hex').slice(0, 32);
      return known === etag ? { unchanged: true, etag } : { ...review, etag };
    },
    getSessionReviewDiff: async () => {
      return (await runtime.getSessionReviewDiff?.()) ?? { supported: false, files: [], patch: '' };
    },
    revertTurnReview: async (checkpointId) => {
      return await requireRuntimeMethod('revertTurnReview', 'Turn review revert is unavailable')(checkpointId);
    },
    revertTurnReviewFile: async (file, checkpointId) => {
      return await requireRuntimeMethod('revertTurnReviewFile', 'Turn review revert is unavailable')(
        file,
        checkpointId
      );
    },
    getOnboardingStatus: () => {
      return runtime.getOnboardingStatus?.() || { completed: true, workflowRoutes: {} };
    },
    skipOnboarding: () => {
      // Completed-marking only; no route/agent/provider writes.
      return runtime.skipOnboarding?.() || null;
    },
    completeOnboarding: withCommandLock(async (payload = {}) => {
      const result = await runtime.completeOnboarding?.(payload);
      refreshRouteStats();
      pushNotice('first-run setup saved', 'info');
      return result;
    }),
    loginOAuthProvider: withCommandLock(
      async (provider) => {
        const result = await runtime.loginOAuthProvider(provider);
        pushNotice(`provider oauth ok: ${result.provider}`, 'info');
        return true;
      },
      { busyResult: false }
    ),
    getProviderAccounts: (provider) => runtime.getProviderAccounts(provider),
    updateProviderAccounts: (provider, change) => runtime.updateProviderAccounts(provider, change),
    beginOAuthProviderLogin: async (provider, options) => {
      if (getState().commandBusy) throw new Error('command busy');
      set({ commandBusy: true });
      try {
        const result = oauthFlows.register(await runtime.beginOAuthProviderLogin(provider, options));
        pushNotice(`provider oauth started: ${result.provider}`, 'info');
        return result;
      } finally {
        set({ commandBusy: false });
      }
    },
    getOAuthProviderLoginStatus: (flowId) => oauthFlows.status(flowId),
    completeOAuthProviderLogin: async (flowId, code) => oauthFlows.complete(flowId, code),
    cancelOAuthProviderLogin: async (flowId) => oauthFlows.cancel(flowId),
    saveProviderApiKey: (provider, secret) => {
      const result = runtime.saveProviderApiKey(provider, secret);
      pushNotice(`provider api key saved: ${result.provider}`, 'info');
      return true;
    },
    saveOpenCodeGoUsageAuth: (opts) => {
      runtime.saveOpenCodeGoUsageAuth(opts);
      pushNotice('OpenCode Go usage auth saved', 'info');
      return true;
    },
    saveOpenAIUsageSessionKey: (secret) => {
      runtime.saveOpenAIUsageSessionKey(secret);
      pushNotice('OpenAI usage auth saved', 'info');
      return true;
    },
    authenticateProvider: withCommandLock(
      async (provider, secret) => {
        const result = await runtime.authenticateProvider(provider, secret);
        pushNotice(`provider auth ok: ${result.provider} (${result.type})`, 'info');
        return true;
      },
      { busyResult: false }
    ),
    forgetProviderAuth: (provider, accountId) => {
      const result = runtime.forgetProviderAuth(provider, accountId);
      pushNotice(`provider auth forgotten: ${result.provider}`, 'info');
      return true;
    },
    getChannelSetup: () => {
      return runtime.getChannelSetup();
    },
    getChannelWorkerStatus: () => runtime.getChannelWorkerStatus?.(),
    setWebhookConfig: announced(
      (patch) => runtime.setWebhookConfig(patch),
      () => 'webhook config updated'
    ),
    saveSchedule: announced(
      (entry) => runtime.saveSchedule(entry),
      (result) => `schedule saved: ${result.name}`
    ),
    deleteSchedule: announced(
      (name) => runtime.deleteSchedule(name),
      (_result, name) => `schedule deleted: ${name}`
    ),
    setScheduleEnabled: announced(
      (name, enabled) => runtime.setScheduleEnabled(name, enabled),
      (_result, name, enabled) => `schedule ${enabled ? 'enabled' : 'disabled'}: ${name}`
    ),
    runScheduleNow: announced(
      (name) => runtime.runScheduleNow(name),
      (_result, name) => `schedule ran: ${name}`
    ),
    saveWebhook: announced(
      (entry) => runtime.saveWebhook(entry),
      (result) => `webhook saved: ${result.name}`
    ),
    deleteWebhook: announced(
      (name) => runtime.deleteWebhook(name),
      (_result, name) => `webhook deleted: ${name}`
    ),
    setWebhookEnabled: announced(
      (name, enabled) => runtime.setWebhookEnabled(name, enabled),
      (_result, name, enabled) => `webhook ${enabled ? 'enabled' : 'disabled'}: ${name}`
    ),
  };
}
