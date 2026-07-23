import * as fs from "fs";
import { loadConfig, createBackend } from "./config.mjs";
import { WebhookServer } from "./webhook.mjs";
import { EventPipeline } from "./event-pipeline.mjs";
import { startSnapshotWriter, stopSnapshotWriter } from "./status-snapshot.mjs";
import { initProviders } from "../../agent/orchestrator/providers/registry.mjs";
import { loadConfig as loadAgentConfig } from "../../agent/orchestrator/config.mjs";
import {
  refreshActiveInstance,
  releaseOwnedChannelLocks,
  clearActiveInstance,
} from "./runtime-paths.mjs";
// Owned-runtime lifecycle extracted from channels/index.mjs (behavior-
// preserving): bridge-ownership claim/refresh/loss, backend connect/disconnect,
// scheduler + webhook/event runtime, owner heartbeat gating, and config
// hot-reload. Owns its own in-flight flags + timers; shares config / backend /
// bridgeRuntimeConnected / webhookServer / eventPipeline with the worker via
// get/set so file-level reference semantics are preserved.
export function createOwnedRuntime({
  getConfig,
  setConfig,
  getBackend,
  setBackend,
  getBridgeRuntimeConnected,
  setBridgeRuntimeConnected,
  getWebhookServer,
  setWebhookServer,
  getEventPipeline,
  setEventPipeline,
  getChannelBridgeActive,
  instanceId,
  TERMINAL_LEAD_PID,
  forwarder,
  sendNotifyToParent,
  scheduler,
  statusState,
  logOwnership,
  currentOwnerState,
  bindPersistedTranscriptIfAny,
  cancelPendingTranscriptRearm,
  schedulePendingTranscriptRearm,
  stopServerTyping,
  wireWebhookHandlers,
  wireEventQueueHandlers,
  memoryDrainBuffer,
}) {
  let bridgeRuntimeStarting = false;
  let _ownedRuntimeStopRequested = false;
  let bridgeOwnershipRefreshInFlight = null;
  let _memoryDrainTimer = null;
  // Automation (scheduler + webhook server + relay tunnel) can outlive a
  // failed/absent messaging backend: it is tracked separately so teardown and
  // reload know it is running even while bridgeRuntimeConnected stays false.
  let automationRunning = false;
  // Promise that resolves when the current startOwnedRuntime() run fully
  // settles (bridgeRuntimeStarting -> false). reloadRuntimeConfig awaits this
  // before issuing a restart so a backend swap that lands mid-start is not
  // dropped by startOwnedRuntime's in-flight guard (lost-restart race).
  let _inFlightStart = null;
  // Daemon model: the machine-global channels daemon (singleton-owner lock in
  // src/standalone) guarantees exactly one runtime per machine, so this process
  // is the unconditional bridge owner. The OS seat lock is retired — no takeover
  // handler, no vacant-reacquire poll, no cross-process ownership-loss detection.
  function clearBridgeOwnershipTimer() {
    // No ownership timer under the daemon model; kept as a no-op so the worker
    // teardown call site stays unchanged.
  }
function shouldStartEventPipelineRuntime() {
  return getConfig().webhook?.enabled === true || (Array.isArray(getConfig().events?.rules) && getConfig().events.rules.length > 0);
}
function ensureEventPipelineRuntime() {
  if (!getEventPipeline()) {
    setEventPipeline(new EventPipeline(getConfig().events, getConfig().channelId));
    wireEventQueueHandlers(getEventPipeline().getQueue());
  }
  return getEventPipeline();
}
function ensureWebhookServerRuntime() {
  if (!getWebhookServer()) {
    setWebhookServer(new WebhookServer(getConfig().webhook));
  }
  wireWebhookHandlers();
  return getWebhookServer();
}
async function stopWebhookAndEventRuntime() {
  if (getWebhookServer()) {
    await getWebhookServer().stop();
    setWebhookServer(null);
  }
  if (getEventPipeline()) {
    getEventPipeline().stop();
    setEventPipeline(null);
  }
}
function syncOwnedWebhookAndEventRuntime({ reload = false } = {}) {
  if (shouldStartEventPipelineRuntime()) {
    const pipeline = ensureEventPipelineRuntime();
    if (reload) {
      pipeline.reloadConfig(getConfig().events, getConfig().channelId);
      wireEventQueueHandlers(pipeline.getQueue());
    }
    pipeline.start();
  } else if (getEventPipeline()) {
    getEventPipeline().stop();
    setEventPipeline(null);
  }

  if (getConfig().webhook?.enabled === true) {
    const server = ensureWebhookServerRuntime();
    if (reload) {
      // server.reloadConfig is async (it awaits the current server's
      // close() before re-listening). Chain start() onto its resolution
      // so we don't race the bound port — calling start() synchronously
      // here would re-listen before close() finishes and surface
      // EADDRINUSE on the same port.
      server.reloadConfig(getConfig().webhook, {
        autoStart: false
      }).then(() => {
        // A stopWebhookAndEventRuntime() / deactivate landing during the async
        // close()+reload window nulls out getWebhookServer() (and webhook.enabled may
        // have flipped off). Without this guard the resolved continuation would
        // re-listen and resurrect an orphan listener that no teardown tracks.
        if (getWebhookServer() !== server || getConfig().webhook?.enabled !== true) {
          try { server.stop(); } catch {}
          return;
        }
        wireWebhookHandlers();
        server.start();
      }).catch((err) => {
        process.stderr.write(`mixdog channels: webhook reload failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    } else {
      server.start();
    }
  } else if (getWebhookServer()) {
    getWebhookServer().stop();
    setWebhookServer(null);
  }
}
let _ownedRuntimeSelfHealing = false;
// Explicit restore path for an already-connected owner. The 3s ownership tick
// must not run this implicitly: re-binding status on every tick can move the
// transcript cursor to EOF, and probing the gateway during Discord's own
// reconnect window can reset a healthy reconnect loop. Keep this for explicit
// activation/reload recovery only.
async function selfHealOwnedRuntime(options = {}) {
  const shouldRestoreBinding = options.restoreBinding === true;
  const shouldResetBackend = options.resetBackend === true;
  if (!shouldRestoreBinding && !shouldResetBackend) return;
  if (_ownedRuntimeSelfHealing) return;
  _ownedRuntimeSelfHealing = true;
  try {
    if (shouldRestoreBinding) {
      await bindPersistedTranscriptIfAny().catch((e) => {
        process.stderr.write(`mixdog: self-heal bindPersistedTranscriptIfAny failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
      });
    }
    if (shouldResetBackend && typeof getBackend()?._resetClient === "function") {
      await getBackend()._resetClient().catch((e) => {
        process.stderr.write(`mixdog: self-heal getBackend() reset failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
      });
    }
    // Do NOT nudge forwardNewText() here. bindPersistedTranscriptIfAny() above
    // already forwards the same-session catch-up from the persisted cursor; an
    // extra drain risks surfacing the old tail of a freshly (re)bound transcript
    // on connect/change/rebind. Only outputs created after the new binding
    // should be forwarded, and the normal watch/poll path handles those.
  } finally {
    _ownedRuntimeSelfHealing = false;
  }
}
async function startOwnedRuntime(options = {}) {
  if (getBridgeRuntimeConnected()) {
    if (!bridgeRuntimeStarting) await selfHealOwnedRuntime(options);
    return;
  }
  if (bridgeRuntimeStarting) return;
  if (!getChannelBridgeActive()) return;
  bridgeRuntimeStarting = true;
  _ownedRuntimeStopRequested = false;
  let _settleStart;
  _inFlightStart = new Promise((r) => { _settleStart = r; });
  const settleInFlightStart = () => {
    bridgeRuntimeStarting = false;
    _inFlightStart = null;
    const done = _settleStart;
    _settleStart = null;
    done?.();
  };
  // Capture the getBackend() instance that THIS start operation will connect. A
  // reloadRuntimeConfig() hot-swap can replace the global `getBackend()` while this
  // start is still awaiting connect(); using the captured instance for both
  // connect() and the bail-path disconnect() guarantees we tear down the
  // getBackend() WE started (not the freshly-swapped one), closing the
  // both-backends-live window.
  const startingBackend = getBackend();
  // Daemon model: this runtime is the singleton bridge owner (enforced by the
  // standalone daemon's singleton-owner lock), so there is no seat to claim and
  // no cross-process contender to back off from. Just advertise metadata
  // (memory_port/pg_*/channelId/... preserved inside refreshActiveInstance);
  // active-instance.json is a pure advert. Wrapped so any throw resets
  // bridgeRuntimeStarting.
  try {
    refreshActiveInstance(instanceId, { backendReady: false });
  } catch (e) {
    settleInFlightStart();
    process.stderr.write(`mixdog: pre-connect metadata advert aborted (${e instanceof Error ? e.message : String(e)})\n`);
    return;
  }
  // Periodic buffer drain: replays memory-buffer/entry-*/ingest-*.json once the
  // memory service publishes its port. Idempotent + reentrancy-guarded inside
  // drainBuffer(); unref'd so it never holds the worker open.
  if (!_memoryDrainTimer) {
    _memoryDrainTimer = setInterval(() => { void memoryDrainBuffer().catch(() => {}); }, 5e3);
    _memoryDrainTimer.unref?.();
  }
  // Re-check after each post-connect await so a stopOwnedRuntime() landing
  // mid-start cannot be overridden by the resuming start (scheduler/snapshot/
  // webhook/binding launches below would revive owner state after stop).
  // Idempotent: stop's sync teardown already ran; re-running disconnect +
  // teardown is safe and covers both the pre-connected window (stop could
  // not disconnect an in-flight getBackend()) and the post-connected window
  // (stop did disconnect; redo to be defensive).
  const bailIfStopRequested = async () => {
    if (!_ownedRuntimeStopRequested) return false;
    try { await startingBackend.disconnect(); } catch {}
    try { releaseOwnedChannelLocks(instanceId); } catch {}
    try { clearActiveInstance(instanceId); } catch {}
    setBridgeRuntimeConnected(false);
    _ownedRuntimeStopRequested = false;
    return true;
  };
  const restoreBinding = options.restoreBinding !== false;
  const bindPersistedTranscriptTask = restoreBinding
    ? bindPersistedTranscriptIfAny().catch((e) => {
      process.stderr.write(`mixdog: bindPersistedTranscriptIfAny failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
    })
    : null;
  // Await getBackend().connect() so callers (and bindingReady) only resolve after
  // the Discord binding is real. Previously this was fire-and-forget and
  // refreshBridgeOwnership returned immediately, letting bindingReady fire
  // before getBackend() listeners were attached.
  try {
    await startingBackend.connect();
    if (await bailIfStopRequested()) {
      cancelPendingTranscriptRearm();
      try { forwarder.stopWatch(); } catch {}
      if (bindPersistedTranscriptTask) await bindPersistedTranscriptTask;
      return;
    }
    // Advertise backend readiness (metadata advert).
    try { refreshActiveInstance(instanceId, { backendReady: true }); } catch {}
    setBridgeRuntimeConnected(true);
    // Fresh confirmed connection — tell the parent to flip remote ON. Reached
    // ONLY on a not-connected -> connected transition (the top-of-fn
    // early-return skips already-connected re-ticks), so this fires exactly once
    // per connect and covers EVERY start path (boot + reload restart + activate).
    // The parent's acquired handler is idempotent (no-op when already remote),
    // so notifying post-connect — never pre-connect — means a connect FAILURE
    // below leaves the parent non-remote instead of stuck remote-with-no-bridge
    // (finding 2).
    notifyRemoteAcquired();
    // initProviders must complete before scheduler.start() — otherwise the
    // scheduler's first fire can land before the registry is populated and
    // return `Provider "<name>" not found or not enabled`. The previous
    // fire-and-forget call let scheduler.start() race ahead of init.
    try {
      const agentCfg = loadAgentConfig();
      await initProviders(agentCfg.providers || {});
    } catch (e) {
      process.stderr.write(`mixdog: initProviders failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`);
    }
    if (await bailIfStopRequested()) {
      cancelPendingTranscriptRearm();
      try { forwarder.stopWatch(); } catch {}
      if (bindPersistedTranscriptTask) await bindPersistedTranscriptTask;
      return;
    }
    // Reconnect after a degraded (automation-only) start must not double-arm
    // the scheduler/snapshot timers; the webhook/event sync is idempotent.
    if (!automationRunning) {
      scheduler.start();
      startSnapshotWriter(scheduler);
    }
    syncOwnedWebhookAndEventRuntime();
    automationRunning = true;
    if (restoreBinding) {
      if (bindPersistedTranscriptTask) await bindPersistedTranscriptTask;
      const pendingTranscriptPath = forwarder.transcriptPath;
      if (pendingTranscriptPath && !fs.existsSync(pendingTranscriptPath)) {
        // Pre-connect bind may have armed rearm while !getBridgeRuntimeConnected();
        // the first tick then exits without rescheduling. Re-arm now that we own.
        schedulePendingTranscriptRearm(statusState.read().channelId, pendingTranscriptPath);
      } else {
        void forwarder.forwardNewText().catch((err) => {
          process.stderr.write(`mixdog: post-connect forwardNewText failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    }
    process.stderr.write(`mixdog: running with ${getBackend().name} getBackend()\n`);
    logOwnership(`active owner lead=${TERMINAL_LEAD_PID} pid=${process.pid}`);
  } catch (e) {
    process.stderr.write(`mixdog: getBackend() connect failed (non-fatal, cycle1/MCP still up): ${e instanceof Error ? e.message : String(e)}\n`);
    cancelPendingTranscriptRearm();
    try { forwarder.stopWatch(); } catch {}
    if (bindPersistedTranscriptTask) await bindPersistedTranscriptTask;
    // Roll back partial owner-side state advertised before connect() ran:
    // disconnect the backend WE started (a post-connect startup step may have
    // thrown while the gateway is live), then release the channel locks + clear
    // the active-instance advert.
    try { await startingBackend.disconnect(); } catch {}
    try { releaseOwnedChannelLocks(instanceId); } catch {}
    try { clearActiveInstance(instanceId); } catch {}
    if (_memoryDrainTimer) { clearInterval(_memoryDrainTimer); _memoryDrainTimer = null; }
    // DEGRADED MODE (automation decoupling): a messaging connect failure —
    // packaged runtime without discord.js, bad token, gateway outage — must
    // not take schedules/webhooks down with it. Start the automation runtime
    // anyway; sends stay dead (bridgeRuntimeConnected=false) but session
    // runs, the webhook server, and the relay tunnel work.
    if (!_ownedRuntimeStopRequested) {
      if (automationRunning) {
        // Already degraded-started by an earlier attempt; this run was only a
        // messaging reconnect retry — the finally below settles the start.
        return;
      }
      try {
        const agentCfg = loadAgentConfig();
        await initProviders(agentCfg.providers || {});
      } catch (e2) {
        process.stderr.write(`mixdog: initProviders failed (non-fatal): ${e2 instanceof Error ? e2.message : String(e2)}\n`);
      }
      try {
        scheduler.start();
        startSnapshotWriter(scheduler);
        syncOwnedWebhookAndEventRuntime();
        automationRunning = true;
        process.stderr.write('mixdog: automation runtime up without messaging backend (degraded mode)\n');
      } catch (e3) {
        process.stderr.write(`mixdog: degraded automation start failed: ${e3 instanceof Error ? e3.message : String(e3)}\n`);
      }
    }
  } finally {
    settleInFlightStart();
  }
}
async function stopOwnedRuntime(reason) {
  // Cancel any pending transcript re-arm poll BEFORE the connected/starting
  // early-return below. Otherwise a poll armed against a not-yet-existing
  // transcript could fire after teardown and reinstall the fs.watch handle
  // (startWatch is not owner-gated), leaking a live watcher past shutdown.
  cancelPendingTranscriptRearm();
  // startOwnedRuntime() advertises owner HTTP/heartbeat/active-instance and
  // claims channel locks BEFORE awaiting getBackend().connect(). If shutdown lands
  // during that window (bridgeRuntimeStarting=true, getBridgeRuntimeConnected()
  // still false) we still need to tear that partial state down — otherwise
  // the port stays bound and active-instance.json stays stale.
  if (!getBridgeRuntimeConnected() && !bridgeRuntimeStarting && !automationRunning) return;
  // If a start is in flight (bridgeRuntimeStarting=true), signal the in-flight
  // startOwnedRuntime() to abort right after its getBackend().connect() resolves.
  // Without this the in-flight start re-marks connected and re-launches
  // scheduler/webhook/heartbeat after we tear them down here.
  if (bridgeRuntimeStarting) _ownedRuntimeStopRequested = true;
  const wasConnected = getBridgeRuntimeConnected();
  stopServerTyping();
  // Release the transcript fs.watch handle plus the forwarder's debounce/retry
  // timers on standby. Without this the watcher keeps firing scheduleWatchFlush
  // and the drain/retry timers stay live after ownership is dropped, leaking a
  // file handle + timers for the rest of the process lifetime.
  try { forwarder.stopWatch(); } catch {}
  if (_memoryDrainTimer) { clearInterval(_memoryDrainTimer); _memoryDrainTimer = null; }
  scheduler.stop();
  stopSnapshotWriter();
  await stopWebhookAndEventRuntime();
  automationRunning = false;
  releaseOwnedChannelLocks(instanceId);
  clearActiveInstance(instanceId);
  try {
    // Only disconnect the getBackend() when connect() actually completed; calling
    // disconnect() mid-connect races the connect promise.
    if (wasConnected) {
      // Drain in-flight outbound sends before disconnecting so a handoff
      // (owned=false observed → ownership lost) never cuts off a reply
      // mid-delivery. Bounded inside drainPendingSends so a wedged send can
      // not stall teardown — we still disconnect promptly.
      try { await getBackend().drainPendingSends?.(); } catch {}
      await getBackend().disconnect();
    }
  } finally {
    setBridgeRuntimeConnected(false);
    logOwnership(`standby: ${reason}`);
  }
}
function refreshBridgeOwnershipSafe(options = {}) {
  refreshBridgeOwnership(options).catch(err => process.stderr.write(`[channels] refreshBridgeOwnership rejected: ${err?.message || err}\n`));
}
// Daemon model: no ownership timer or takeover handler. Kept as a no-op so the
// worker start() call site stays unchanged.
function armBridgeOwnershipTimer() {}
// Guarded IPC send to the parent: no-ops when there is no channel or it is
// already disconnected, and swallows both the synchronous throw and the async
// error-callback path of ERR_IPC_CHANNEL_CLOSED (channel closing between the
// connected check and delivery). Log-and-continue — never crash the worker.
function sendToParent(message) {
  if (!process.send || process.connected === false) return;
  try {
    process.send(message, undefined, undefined, err => {
      if (err) process.stderr.write(`[channels] parent IPC send failed: ${err?.message || err}\n`);
    });
  } catch (err) {
    process.stderr.write(`[channels] parent IPC send threw: ${err?.message || err}\n`);
  }
}
// Tell the parent session this worker ACQUIRED the bridge so it flips remote
// mode ON (badge/transcript writer). Callers fire this only on a genuine
// not-connected -> connected transition — never on a refresh — so the parent's
// idempotent handler sees it once. Cross-process supersede is a transport-level
// concern (daemon), not emitted here.
function notifyRemoteAcquired() {
  // Sink-aware path so the daemon replays this to every TUI (the transport
  // sticky-caches 'acquired'). Raw sendToParent would reach only the node-IPC
  // spawner and be ignored.
  sendNotifyToParent('notifications/mixdog/remote', { state: 'acquired' });
}
async function refreshBridgeOwnership(options = {}) {
  // Coalesce concurrent callers onto the in-flight refresh so getBackend() tool
  // calls landing during normal login wait for the same connect attempt
  // instead of returning early and observing spurious auto-connect failure.
  if (bridgeOwnershipRefreshInFlight) return bridgeOwnershipRefreshInFlight;
  bridgeOwnershipRefreshInFlight = (async () => {
    // Daemon model: this runtime is the unconditional bridge owner, so refresh
    // just keeps the owned runtime in sync with channelBridgeActive.
    if (!getChannelBridgeActive()) {
      if (getBridgeRuntimeConnected()) await stopOwnedRuntime("bridge inactive");
      return;
    }
    // Active -> ensure the owned runtime is up (idempotent; early-returns when
    // already connected).
    await startOwnedRuntime(options);
  })();
  try {
    return await bridgeOwnershipRefreshInFlight;
  } finally {
    bridgeOwnershipRefreshInFlight = null;
  }
}

async function reloadRuntimeConfig() {
  const previousBackend = getBackend();
  const previousBackendName = previousBackend?.name || "";
  // File-watch/tool-triggered reloads must bypass the short keychain hit cache:
  // another process may have just saved or rotated the channel credential.
  setConfig(await loadConfig({ freshSecrets: true }));
  scheduler.reloadConfig(
    getConfig().nonInteractive ?? [],
    getConfig().interactive ?? [],
    // Single resolved main-channel id used for the schedule `channel` flag.
    getConfig().channelId,
    { restart: getBridgeRuntimeConnected() }
  );
  const nextBackend = createBackend(getConfig());
  const backendTypeChanged = (nextBackend?.name || "") !== previousBackendName;
  const credentialsChanged = !backendTypeChanged
    && String(nextBackend?.token || "") !== String(previousBackend?.token || "");
  const backendChanged = backendTypeChanged || credentialsChanged;
  if (backendChanged) {
    const shouldRestart = getBridgeRuntimeConnected() || bridgeRuntimeStarting;
    if (shouldRestart) await stopOwnedRuntime("getBackend() getConfig() changed");
    // A start that was in flight when stopOwnedRuntime landed was signalled to
    // bail (and disconnects the OLD backend it was connecting). Wait for it to
    // FULLY settle before issuing the fresh start below — otherwise
    // startOwnedRuntime's `if (bridgeRuntimeStarting) return` guard would drop
    // the restart and the NEW backend would never connect (lost-restart race).
    if (_inFlightStart) { try { await _inFlightStart; } catch {} }
    setBackend(nextBackend);
    // The persisted routing channelId belongs to the OLD getBackend() (e.g. a
    // Discord snowflake) and is meaningless for the new one — sending to it
    // would 400 "chat not found". There is no id mapping between platforms, so
    // CLEAR the stale binding: drop the forwarder's context + watcher and wipe
    // status.channelId/transcriptPath. The next inbound from the new getBackend()
    // rebinds the correct chat via applyTranscriptBinding(). Only done on
    // backendChanged — same-getBackend() reloads keep their binding untouched.
    // (active-instance is cleared by stopOwnedRuntime on the restart path; we
    // don't re-advertise here to avoid resurrecting a just-cleared entry.)
    if (backendTypeChanged) {
      try { forwarder.stopWatch(); } catch {}
      forwarder.channelId = "";
      forwarder.transcriptPath = "";
      try {
        statusState.update((state) => {
          state.channelId = "";
          state.transcriptPath = "";
        });
      } catch {}
    }
    // stopOwnedRuntime above tore the owned runtime down; a same-session reload
    // reconnects the NEW backend here. The in-flight start (if any) has already
    // settled above, so this start is not dropped by the in-flight guard.
    if (shouldRestart) refreshBridgeOwnershipSafe({ restoreBinding: !backendTypeChanged });
  } else if (nextBackend !== previousBackend) {
    try { await nextBackend.disconnect?.(); } catch {}
  }
  if (getBridgeRuntimeConnected() || automationRunning) {
    syncOwnedWebhookAndEventRuntime({ reload: true });
  } else {
    await stopWebhookAndEventRuntime();
  }
}
  return {
    startOwnedRuntime,
    stopOwnedRuntime,
    refreshBridgeOwnership,
    refreshBridgeOwnershipSafe,
    reloadRuntimeConfig,
    armBridgeOwnershipTimer,
    clearBridgeOwnershipTimer,
    notifyRemoteAcquired,
  };
}
