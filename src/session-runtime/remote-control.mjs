// Remote (channel relay) lifecycle for a session: claim, release and stop.
// Remote mode is opt-in per session — only a session that turns it on boots the
// channel worker and contends for the machine-global bridge seat. Extracted
// from runtime-core, which injects the mutable session/remote state it owns.
import { startMemoryDaemonEagerly } from './memory-daemon-probe.mjs';

export function createRemoteControl({
  getSession,
  isRemoteEnabled,
  setRemoteEnabled,
  getRemoteSessionId,
  setRemoteSessionId,
  isCloseRequested,
  clearChannelStartTimer,
  remoteTransitions,
  channels,
  channelsEnabled,
  hasActiveAutomation,
  flushBackendSave,
  invokeChannelStart,
  createCurrentSession,
  ensureRemoteTranscriptWriter,
  getTranscriptPath,
  emitRemoteStateChange,
  getMemoryModule,
  bootProfile,
  envFlag,
}) {
  // Manual ON always targets the current session and explicitly overrides any
  // previous manual owner. There is no auto/claim-if-vacant path.
  function startRemote() {
    setRemoteEnabled(true);
    setRemoteSessionId(getSession()?.id || null);
    // The worker forwards transcript ingests to the memory service, so its port
    // must be live before the first ingest.
    startMemoryDaemonEagerly({ getMemoryModule, bootProfile });
    // Publish the session record + transcript file BEFORE the worker's
    // activate-time discovery polls, so forwarding binds to THIS terminal
    // instead of a stale neighbour. A no-op in lazy mode; the turn-start rebind
    // covers that case.
    ensureRemoteTranscriptWriter();
    if (envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
      bootProfile('channels:start-skipped');
      return true;
    }
    if (isCloseRequested()) return true;
    clearChannelStartTimer();
    bootProfile('channels:start-scheduled', { delayMs: 0, immediate: true });
    return remoteTransitions.run(async () => {
      try {
        // The channels-module toggle gates MESSAGING only: automation still
        // boots the worker, which runs headless when messaging is off.
        if (!channelsEnabled() && !(await hasActiveAutomation().catch(() => false))) {
          bootProfile('channels:start-disabled');
          return isRemoteEnabled();
        }
        // A backend switch may still be writing; drain it before the worker
        // reads config rather than racing a sync lock wait.
        try { await flushBackendSave(); } catch { /* best-effort */ }
        // Yield before the create/transcript/fork chain so Ink's queued render
        // and input handling are not starved by this detached chain.
        await new Promise((resolve) => setImmediate(resolve));
        // Immediate-occupancy guarantee: a freshly forked worker runs transcript
        // discovery inside its own start(), so the session must exist first.
        // Idempotent; on failure we still claim (bind resolves on first turn).
        try { await createCurrentSession('remote-start'); } catch (error) {
          bootProfile('channels:remote-session-create-failed', { error: error?.message || String(error) });
        }
        ensureRemoteTranscriptWriter();
        // Re-check after the awaits: stop/supersede or runtime close may have
        // landed mid-chain — never boot for a session that turned remote off.
        if (!isRemoteEnabled() || isCloseRequested()) return false;
        await invokeChannelStart();
        if (!isRemoteEnabled() || isCloseRequested()) return false;
        await channels.execute('activate_channel_bridge', {
          active: true,
          sessionId: getSession()?.id || getRemoteSessionId() || null,
          transcriptPath: getTranscriptPath(),
        });
        return isRemoteEnabled();
      } catch (error) {
        if (isRemoteEnabled()) {
          setRemoteEnabled(false);
          setRemoteSessionId(null);
          await channels.stop('remote-claim-failed').catch(() => {});
          emitRemoteStateChange(false, 'claim-failed');
        }
        bootProfile('channels:claim-failed', { error: error?.message || String(error) });
        return false;
      }
    });
  }

  // Explicit user OFF is a desired-state command, not a toggle retry: deactivate
  // the machine-global bridge before detaching. The promise settles only after
  // detach, keeping the desktop toggle busy until a later ON can reconnect.
  function releaseRemote(reason) {
    const releasingSessionId = getRemoteSessionId() || getSession()?.id || null;
    setRemoteEnabled(false);
    setRemoteSessionId(null);
    clearChannelStartTimer();
    return remoteTransitions.run(async () => {
      try {
        await channels.execute('activate_channel_bridge', { active: false, sessionId: releasingSessionId });
      } catch (error) {
        bootProfile('channels:release-failed', { error: error?.message || String(error) });
        emitRemoteStateChange(false, 'release-failed');
      } finally {
        await channels.stop(reason || 'remote-disabled').catch(() => {});
      }
      return false;
    });
  }

  // /remote-off and supersede: the runtime keeps running so this never blocks,
  // but the waiting stop path runs the full SIGTERM -> taskkill escalation so the
  // worker cannot linger as a zombie holding the seat.
  function stopRemote(reason) {
    setRemoteEnabled(false);
    setRemoteSessionId(null);
    clearChannelStartTimer();
    channels.stop(reason || 'remote-disabled').catch(() => {});
    return true;
  }

  return { startRemote, releaseRemote, stopRemote };
}
