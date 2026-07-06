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
  scheduler,
  statusState,
  logOwnership,
  currentOwnerState,
  acquireSeat,
  closeSeatServer,
  isSeatHeld,
  onTakeover,
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
  let _seatTakeoverRegistered = false;
  let _vacantReacquireTimer = null;
  // Ownership loss is push-based now: the seat lock invokes our onTakeover
  // handler when a contender sends an explicit takeover message, and the OS
  // auto-releases the pipe/socket on crash. No fs.watch on active-instance.json
  // and no 3s ownership poll — both retired with the file-heuristic model.
  function registerSeatTakeoverOnce() {
    if (_seatTakeoverRegistered) return;
    _seatTakeoverRegistered = true;
    onTakeover(async () => {
      // A newer session explicitly took the seat. Tear the owned runtime down
      // (the seat lock closes the listener afterwards) and drop remote mode.
      if (getBridgeRuntimeConnected() || bridgeRuntimeStarting) {
        await stopOwnedRuntime("ownership lost (seat taken over)");
      }
      notifyRemoteSuperseded();
    });
  }
  function clearBridgeOwnershipTimer() {
    // Only the standby reacquire poll survives under the seat-lock model (the 3s
    // ownership poll + active-instance fs.watch are gone). Stop it on shutdown.
    stopVacantReacquirePoll();
  }
  function stopVacantReacquirePoll() {
    if (_vacantReacquireTimer) { clearInterval(_vacantReacquireTimer); _vacantReacquireTimer = null; }
  }
  // Standby reacquire: after an auto-start (claim-if-vacant) backed off from a
  // LIVE holder, poll modestly so a LATER holder crash is reclaimed without
  // explicit user action. Never steals a live holder (force:false, try-once),
  // and stops the instant it wins. Unref'd so it never keeps the worker alive.
  function armVacantReacquirePoll() {
    if (_vacantReacquireTimer) return;
    _vacantReacquireTimer = setInterval(() => {
      void (async () => {
        if (!getChannelBridgeActive() || isSeatHeld() || getBridgeRuntimeConnected() || bridgeRuntimeStarting) return;
        let got = false;
        try { got = await acquireSeat({ force: false, timeoutMs: 0 }); } catch { got = false; }
        if (!got) return;
        stopVacantReacquirePoll();
        registerSeatTakeoverOnce();
        logOwnership("standby reclaim (vacant seat acquired)");
        await startOwnedRuntime({ restoreBinding: true });
      })();
    }, 15e3);
    _vacantReacquireTimer.unref?.();
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
    // Nudge the forwarder to drain anything the rebind/reconnect surfaced.
    void forwarder.forwardNewText().catch(() => {});
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
  // Capture the getBackend() instance that THIS start operation will connect. A
  // reloadRuntimeConfig() hot-swap can replace the global `getBackend()` while this
  // start is still awaiting connect(); using the captured instance for both
  // connect() and the bail-path disconnect() guarantees we tear down the
  // getBackend() WE started (not the freshly-swapped one), closing the
  // both-backends-live window.
  const startingBackend = getBackend();
  const claimAfterReady = options.claimAfterReady === true;
  // Auto-start intent: claim the seat ONLY if it is vacant/stale (never steal a
  // live owner). Threaded from worker start() (MIXDOG_REMOTE_INTENT=auto).
  const claimIfVacant = options.claimIfVacant === true;
  // Seat acquisition IS the ownership claim (OS-enforced singleton). Acquiring
  // == successfully listen()ing on the pipe/socket, so at most one process ever
  // holds it. This replaces the old pre-connect active-instance CAS dance:
  //   - boot (claimAfterReady) / reload (reclaim): acquire the seat here.
  //     claimIfVacant (auto-start) backs off silently when a LIVE holder is
  //     present (force:false); explicit /remote + last-wins force-take it via
  //     the seat lock's takeover message (force:true).
  //   - refresh/owned path: only proceed if we ALREADY hold the seat (never
  //     re-steal — the seat lock, not a file re-read, is the authority).
  // Wrapped so ANY throw in the pre-connect claim resets bridgeRuntimeStarting.
  const reclaim = options.reclaim === true;
  try {
    if (claimAfterReady || reclaim) {
      const acquired = await acquireSeat({ force: !claimIfVacant });
      if (!acquired) {
        bridgeRuntimeStarting = false;
        if (claimIfVacant) {
          logOwnership("autostart backoff (live owner holds seat)");
          // Keep a bounded standby poll running so a later holder crash frees
          // the seat and this session reclaims it without explicit action.
          armVacantReacquirePoll();
        } else {
          logOwnership("seat acquire failed");
        }
        return;
      }
      registerSeatTakeoverOnce();
      stopVacantReacquirePoll();
      logOwnership(claimIfVacant
        ? "boot claim (seat acquired, claim-if-vacant)"
        : (reclaim ? "reclaim (seat acquired)" : "boot claim (seat acquired, last-wins)"));
    } else if (!isSeatHeld()) {
      // Refresh/owned path with no seat held: not ours to start.
      bridgeRuntimeStarting = false;
      return;
    }
    // Advertise metadata (memory_port/pg_*/channelId/... preserved inside
    // refreshActiveInstance). active-instance.json is a pure advert now; the
    // seat lock is the ownership authority, so no CAS guard is needed.
    refreshActiveInstance(instanceId, { backendReady: false });
    if (!isSeatHeld()) {
      bridgeRuntimeStarting = false;
      return;
    }
  } catch (e) {
    bridgeRuntimeStarting = false;
    process.stderr.write(`mixdog: pre-connect seat claim aborted (${e instanceof Error ? e.message : String(e)})\n`);
    return;
  }
  // Ensure the seat-lock takeover handler is registered so a superseding
  // session tears us down promptly (replaces the old 3s ownership poll).
  armBridgeOwnershipTimer();
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
    try { await closeSeatServer(); } catch {}
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
    // Post-connect seat check. The seat was acquired BEFORE connect; a takeover
    // during the (multi-second) connect window would have closed our listener
    // via onTakeover. If we no longer hold the seat we LOST it — disconnect the
    // backend WE connected and drop remote (no active-instance clear; the newer
    // owner holds the seat).
    if (!isSeatHeld()) {
      try { await startingBackend.disconnect(); } catch {}
      try { await closeSeatServer(); } catch {}
      try { releaseOwnedChannelLocks(instanceId); } catch {}
      if (_memoryDrainTimer) { clearInterval(_memoryDrainTimer); _memoryDrainTimer = null; }
      setBridgeRuntimeConnected(false);
      cancelPendingTranscriptRearm();
      try { forwarder.stopWatch(); } catch {}
      if (bindPersistedTranscriptTask) await bindPersistedTranscriptTask;
      notifyRemoteSuperseded();
      return;
    }
    // Advertise backend readiness (metadata advert; seat lock is authority).
    try { refreshActiveInstance(instanceId, { backendReady: true }); } catch {}
    setBridgeRuntimeConnected(true);
    // Fresh confirmed ownership — tell the parent it holds the seat so it flips
    // remote ON. Reached ONLY on a not-connected -> connected transition (the
    // top-of-fn early-return skips already-connected re-ticks), so this fires
    // exactly once per acquire and covers EVERY win path, not just boot:
    //   - explicit/auto boot claim (claimAfterReady),
    //   - the deferred claim when a bridge timer's refreshBridgeOwnership()
    //     claims a seat vacated by a departing owner (finding 1).
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
    scheduler.start();
    startSnapshotWriter(scheduler);
    syncOwnedWebhookAndEventRuntime();
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
    // disconnect the backend WE started FIRST (a post-connect startup step may
    // have thrown while the gateway is live), then release the seat LAST so no
    // contender can acquire + connect a second gateway while ours is still up.
    try { await startingBackend.disconnect(); } catch {}
    try { releaseOwnedChannelLocks(instanceId); } catch {}
    try { clearActiveInstance(instanceId); } catch {}
    if (_memoryDrainTimer) { clearInterval(_memoryDrainTimer); _memoryDrainTimer = null; }
    try { await closeSeatServer(); } catch {}
  } finally {
    bridgeRuntimeStarting = false;
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
  if (!getBridgeRuntimeConnected() && !bridgeRuntimeStarting) return;
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
  // Release the OS seat lock LAST — only after the backend has drained and
  // disconnected — so a contender can never acquire + connect a second gateway
  // while ours is still live (double-owner). Idempotent: a takeover-message
  // teardown runs this via stopOwnedRuntime, then the seat lock's own close is
  // a no-op.
  try { await closeSeatServer(); } catch {}
}
function refreshBridgeOwnershipSafe(options = {}) {
  refreshBridgeOwnership(options).catch(err => process.stderr.write(`[channels] refreshBridgeOwnership rejected: ${err?.message || err}\n`));
}
// Ownership-loss detection is push-based under the seat-lock model: the OS
// releases the pipe/socket on holder crash, and an explicit takeover message
// invokes onTakeover. This entry point (called from worker-main start() and
// startOwnedRuntime) now just guarantees that handler is registered — no poll
// timer, no active-instance fs.watch.
function armBridgeOwnershipTimer() {
  registerSeatTakeoverOnce();
}
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
// Tell the parent session that this worker LOST the bridge seat to a newer
// remote session (last-wins). The parent flips its remote mode OFF entirely —
// exactly one session holds remote; losers fully release, no handover.
function notifyRemoteSuperseded() {
  sendToParent({ type: 'notify', method: 'notifications/mixdog/remote', params: { state: 'superseded' } });
}
// Symmetric to notifyRemoteSuperseded: tell the parent session this worker
// ACQUIRED the bridge seat so it flips remote mode ON (badge/transcript writer).
// Guarded by process.send so a manually-forked worker with no IPC parent is a
// no-op instead of crashing. Callers fire this only on a genuine claim
// transition (boot make-before-break, activate when not already owned) — never
// on a heartbeat refresh — so the parent's idempotent handler sees it once.
function notifyRemoteAcquired() {
  sendToParent({ type: 'notify', method: 'notifications/mixdog/remote', params: { state: 'acquired' } });
}
async function refreshBridgeOwnership(options = {}) {
  // Coalesce concurrent callers onto the in-flight refresh so getBackend() tool
  // calls landing during normal login wait for the same connect attempt
  // instead of returning early and observing spurious auto-connect failure.
  if (bridgeOwnershipRefreshInFlight) return bridgeOwnershipRefreshInFlight;
  bridgeOwnershipRefreshInFlight = (async () => {
    // Ownership authority is the OS seat lock, not active-instance.json.
    if (!getChannelBridgeActive()) {
      if (getBridgeRuntimeConnected()) await stopOwnedRuntime("bridge inactive");
      return;
    }
    // We hold the seat -> ensure the owned runtime is up (idempotent).
    if (isSeatHeld()) {
      await startOwnedRuntime(options);
      return;
    }
    // We do NOT hold the seat but the runtime still thinks it is live — a
    // takeover slipped past the push handler; tear down and drop remote.
    if (getBridgeRuntimeConnected() || bridgeRuntimeStarting) {
      await stopOwnedRuntime("ownership lost (seat released)");
      notifyRemoteSuperseded();
      return;
    }
    // Explicit (re)claim only: activation (/remote), reload restart, or the
    // auto-connect retry. Default force-takeover; claimIfVacant backs off from a
    // live holder. Periodic/defensive nudges pass no claim flag and never steal.
    if (options.claim) {
      await startOwnedRuntime({ ...options, reclaim: true });
    }
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
  setConfig(loadConfig());
  scheduler.reloadConfig(
    getConfig().nonInteractive ?? [],
    getConfig().interactive ?? [],
    // Single resolved main-channel id used for the schedule `channel` flag.
    getConfig().channelId,
    { restart: getBridgeRuntimeConnected() }
  );
  const nextBackend = createBackend(getConfig());
  const backendChanged = (nextBackend?.name || "") !== previousBackendName;
  if (backendChanged) {
    const shouldRestart = getBridgeRuntimeConnected() || bridgeRuntimeStarting;
    if (shouldRestart) await stopOwnedRuntime("getBackend() getConfig() changed");
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
    try { forwarder.stopWatch(); } catch {}
    forwarder.channelId = "";
    forwarder.transcriptPath = "";
    try {
      statusState.update((state) => {
        state.channelId = "";
        state.transcriptPath = "";
      });
    } catch {}
    // stopOwnedRuntime above released the seat; a same-session reload must
    // re-acquire it (claim: force-takeover) to resume owning the bridge.
    if (shouldRestart) refreshBridgeOwnershipSafe({ restoreBinding: false, claim: true });
  } else if (nextBackend !== previousBackend) {
    try { await nextBackend.disconnect?.(); } catch {}
  }
  if (getBridgeRuntimeConnected()) {
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
    notifyRemoteSuperseded,
  };
}
