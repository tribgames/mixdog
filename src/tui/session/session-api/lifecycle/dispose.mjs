// Dispose: release timers, subscriptions, approvals and OAuth flows,
// persist steering, then close the runtime — once.
import { flushTuiSteeringPersist } from '../../tui-steering-persist.mjs';

export function createDisposeAction(bag, { oauthFlows }) {
  const {
    runtime,
    flags,
    lifecycle,
    listeners,
    disposeEmit,
    clearToastTimers,
    disposeTranscriptSpill,
    disposeGoalContinuation,
    denyAllToolApprovals,
  } = bag;

  return {
    dispose: async (reason = 'cli-react-exit', options = {}) => {
      if (flags.disposed) return;
      disposeEmit?.();
      flags.disposed = true;
      clearToastTimers();
      disposeTranscriptSpill?.();
      disposeGoalContinuation?.();
      bag.disposeQuotaResume?.();
      try {
        clearInterval(lifecycle.runtimePulseTimer);
      } catch {}
      for (const key of [
        'unsubscribeRuntimeNotifications',
        'unsubscribeAgentStatus',
        'unsubscribeRemoteState',
        'unsubscribeCompletionWakeGate',
        'unsubscribeGitHeadWatch',
        'unsubscribeWorktreeSetup',
      ]) {
        try {
          lifecycle[key]?.();
        } catch {}
        lifecycle[key] = null;
      }
      denyAllToolApprovals('runtime closing');
      oauthFlows.cancelAll();
      await flushTuiSteeringPersist();
      await runtime.close(reason, options);
      listeners.clear();
    },
  };
}
