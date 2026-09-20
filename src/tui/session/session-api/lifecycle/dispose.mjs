// Dispose: release presence, timers, subscriptions, approvals and OAuth flows,
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
      // Release the interactive-presence beacon so a cross-open after this
      // surface exits takes normal ownership instead of viewer-attaching to a
      // dead owner (crash paths fall back to the 2min staleness window).
      try {
        runtime.clearSessionPresence?.();
      } catch {
        /* best-effort */
      }
      clearToastTimers();
      disposeTranscriptSpill?.();
      disposeGoalContinuation?.();
      try {
        clearInterval(lifecycle.runtimePulseTimer);
      } catch {}
      for (const key of ['unsubscribeRuntimeNotifications', 'unsubscribeAgentStatus', 'unsubscribeRemoteState']) {
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
