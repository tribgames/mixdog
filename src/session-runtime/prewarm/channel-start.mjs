// prewarm/channel-start.mjs — booting the channel worker: the shared start
// promise, the busy-aware scheduled start, and the one-shot boot-time
// automation autostart.
import { performance } from 'node:perf_hooks';

export function createChannelStart({
  timers,
  bootProfile,
  isCloseRequested,
  getActiveTurnCount,
  getSessionCreatePromise,
  hasActiveAutomation,
  channels,
  envFlag,
  delays,
  state,
}) {
  const { channelStartDelayMs, backgroundBusyRetryMs } = delays;

  function invokeChannelStart() {
    if (state.channelStartPromise) return state.channelStartPromise;
    const startedAt = performance.now();
    bootProfile('channels:start:begin');
    state.channelStartPromise = channels
      .start()
      .then(() => bootProfile('channels:start:ready', { ms: (performance.now() - startedAt).toFixed(1) }))
      .catch((error) =>
        bootProfile('channels:start:failed', {
          ms: (performance.now() - startedAt).toFixed(1),
          error: error?.message || String(error),
        })
      )
      .finally(() => {
        state.channelStartPromise = null;
      });
    return state.channelStartPromise;
  }

  async function onChannelStartTimer() {
    timers.channelStartTimer = null;
    if (isCloseRequested()) return;
    // Channels-module and remote toggles gate MESSAGING; automation
    // (enabled schedules/webhooks) keeps the worker boot alive — its
    // channel worker runs headless: only active automation boots it.
    const automation = await hasActiveAutomation().catch(() => false);
    if (!automation) {
      bootProfile('channels:start-disabled');
      return;
    }
    if (isCloseRequested()) return;
    if (getActiveTurnCount() > 0 || getSessionCreatePromise()) {
      bootProfile('channels:start-deferred', {
        reason: getActiveTurnCount() > 0 ? 'turn-active' : 'session-create',
      });
      scheduleChannelStart(backgroundBusyRetryMs);
      return;
    }
    void invokeChannelStart();
  }

  function scheduleChannelStart(delayMs = channelStartDelayMs) {
    if (envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
      bootProfile('channels:start-skipped');
      return;
    }
    if (timers.channelStartTimer || state.channelStartPromise || isCloseRequested()) return;
    bootProfile('channels:start-scheduled', { delayMs });
    timers.channelStartTimer = setTimeout(() => void onChannelStartTimer(), delayMs);
    timers.channelStartTimer.unref?.();
  }

  // Boot-time automation autostart. Automation decoupling (user decision):
  // enabled schedules/webhooks boot the worker on their own — no messaging
  // provider. The worker runs headless (scheduler/webhooks/voice only).
  // Unlike scheduleChannelStart this probes once at the boot delay and never
  // re-arms, so a runtime that boots busy simply leaves the worker to the
  // next scheduleChannelStart caller.
  function scheduleAutomationAutostart(delayMs) {
    timers.channelStartTimer = setTimeout(() => {
      timers.channelStartTimer = null;
      if (isCloseRequested()) return;
      void hasActiveAutomation()
        .then((active) => {
          if (!active || isCloseRequested()) return;
          bootProfile('channels:automation-autostart');
          void invokeChannelStart();
        })
        .catch(() => {
          /* automation probe is best-effort */
        });
    }, delayMs);
    timers.channelStartTimer.unref?.();
  }

  return { invokeChannelStart, scheduleChannelStart, scheduleAutomationAutostart };
}
