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
  probeActiveOwner,
  RUNTIME_ROOT,
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
  claimBridgeOwnership,
  startOwnerHeartbeat,
  stopOwnerHeartbeat,
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
  let bridgeOwnershipTimer = null;
  let _memoryDrainTimer = null;
  // Event-driven ownership signal: an fs.watch on the runtime dir fires the
  // ownership refresh the instant active-instance.json changes (a newer owner
  // claims, or the owner releases/clears it), instead of waiting up to 3s for
  // the poll tick. This shrinks the double-owner window on takeover (the old
  // owner observes owned=false and tears down in ms) and signals ownership
  // loss to contenders immediately on release. The 3s timer stays as fallback.
  let activeInstanceWatcher = null;
  let _activeInstanceWatchDebounce = null;
  function armActiveInstanceWatcher() {
    if (activeInstanceWatcher) return;
    try {
      activeInstanceWatcher = fs.watch(RUNTIME_ROOT, { persistent: false }, (_event, filename) => {
        if (filename && filename !== 'active-instance.json') return;
        // Coalesce the burst of events an atomic rename/truncate emits.
        if (_activeInstanceWatchDebounce) return;
        _activeInstanceWatchDebounce = setTimeout(() => {
          _activeInstanceWatchDebounce = null;
          refreshBridgeOwnershipSafe();
        }, 50);
        _activeInstanceWatchDebounce.unref?.();
      });
      // fs.watch emits 'error' (and an unhandled one CRASHES the worker) when
      // the watched dir is removed or the handle is invalidated (common on
      // Windows). Close the dead handle and fall back to the 3s poll, which is
      // still armed — the event signal is a latency optimization, never the
      // sole ownership mechanism.
      activeInstanceWatcher.on('error', (err) => {
        process.stderr.write(`[ownership] active-instance watch error, falling back to poll: ${err?.message || err}\n`);
        clearActiveInstanceWatcher();
      });
      activeInstanceWatcher.unref?.();
    } catch { activeInstanceWatcher = null; }
  }
  function clearActiveInstanceWatcher() {
    if (_activeInstanceWatchDebounce) { clearTimeout(_activeInstanceWatchDebounce); _activeInstanceWatchDebounce = null; }
    if (activeInstanceWatcher) { try { activeInstanceWatcher.close(); } catch {} activeInstanceWatcher = null; }
  }
  function clearBridgeOwnershipTimer() {
    if (bridgeOwnershipTimer) {
      clearInterval(bridgeOwnershipTimer);
      bridgeOwnershipTimer = null;
    }
    clearActiveInstanceWatcher();
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
  // Single-holder correctness: the seat is claimed BEFORE getBackend().connect(),
  // never after. The old make-before-break (claim-after-ready) boot left two
  // gateways connected and contending during the multi-second connect window;
  // claiming first makes the previous owner observe owned=false on its next
  // tick and drain+disconnect, so at most one gateway ever serves.
  //   - boot (claimAfterReady): last-wins acquire — this new remote session
  //     takes the seat outright.
  //   - refresh/owned-path: CAS onlyIfOwned — abort fast if the seat moved.
  // backendReady=false marks the partial state until getBackend().connect() succeeds.
  // Wrapped so ANY throw in the pre-connect claim (lock contention/error)
  // resets bridgeRuntimeStarting — otherwise a transient lock error would
  // leave it stuck true and permanently block every future ownership attempt.
  try {
    if (claimAfterReady) {
      if (claimIfVacant) {
        // Auto-start claim-if-vacant. Probe first: a live owner other than us
        // holds the seat -> back off SILENTLY (no claim, no acquire notify) so
        // this session stays non-remote. Then claim atomically via the
        // onlyIfVacant CAS (guards the probe->write TOCTOU: a live owner landing
        // in that gap aborts the write, leaving the seat untouched).
        const probe = probeActiveOwner();
        if (probe.status === 'live' && probe.state?.instanceId && probe.state.instanceId !== instanceId) {
          bridgeRuntimeStarting = false;
          logOwnership("autostart backoff (live owner holds seat)");
          return;
        }
        const casResult = refreshActiveInstance(instanceId, { backendReady: false }, { onlyIfVacant: true, timeoutMs: 0 });
        if (casResult?.instanceId !== instanceId) {
          bridgeRuntimeStarting = false;
          logOwnership("autostart backoff (seat claimed by newer owner)");
          return;
        }
        logOwnership("boot claim (pre-connect, claim-if-vacant)");
      } else {
        refreshActiveInstance(instanceId, { backendReady: false });
        logOwnership("boot claim (pre-connect, last-wins)");
      }
    } else {
      // Try-once (timeoutMs:0): a refresh-path re-acquire must never block on
      // the active-instance lock. Contention throws → caught below and treated
      // as "seat busy, abort this attempt"; the next 3s tick retries.
      const casResult = refreshActiveInstance(instanceId, { backendReady: false }, { onlyIfOwned: true, timeoutMs: 0 });
      // A successful CAS write always sets instanceId to ours; any other result
      // (aborted write returning the stale/foreign/missing prior state) means the
      // seat was not ours to claim — abort here rather than relying on the timer.
      if (casResult?.instanceId !== instanceId) {
        bridgeRuntimeStarting = false;
        return;
      }
    }
    // A newer session can claim between our write and this read. If we no longer
    // own the seat, abort fast WITHOUT starting heartbeat/getBackend()/scheduler/
    // webhook/ngrok — ancillary runtime starts only past a confirmed-owned claim.
    if (!currentOwnerState().owned) {
      bridgeRuntimeStarting = false;
      return;
    }
  } catch (e) {
    bridgeRuntimeStarting = false;
    process.stderr.write(`mixdog: pre-connect seat claim aborted (${e instanceof Error ? e.message : String(e)})\n`);
    return;
  }
  // Arm ownership-loss detection BEFORE getBackend().connect() so a session that is
  // superseded during the (multi-second) connect window is torn down: the 3s
  // tick observes a newer owner and flips _ownedRuntimeStopRequested, and
  // bailIfStopRequested below disconnects the getBackend() WE connected.
  armBridgeOwnershipTimer();
  // Heartbeat is ownership-gated; safe to arm now that we hold the seat.
  startOwnerHeartbeat();
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
    try { stopOwnerHeartbeat(); } catch {}
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
    // Post-connect ownership confirm (CAS). The seat was claimed BEFORE
    // connect; a newer session may have superseded us during the connect
    // window (the 3s tick would already be tearing us down). onlyIfOwned:
    // never re-steal here. If the CAS aborts we LOST the seat — disconnect the
    // getBackend() WE connected and mark the bridge runtime not connected (do NOT
    // clear active-instance; the newer owner holds it).
    let ownConfirm;
    try {
      ownConfirm = refreshActiveInstance(instanceId, { backendReady: true }, { onlyIfOwned: true });
    } catch { ownConfirm = null; }
    if (ownConfirm?.instanceId !== instanceId) {
      try { await startingBackend.disconnect(); } catch {}
      try { stopOwnerHeartbeat(); } catch {}
      try { releaseOwnedChannelLocks(instanceId); } catch {}
      if (_memoryDrainTimer) { clearInterval(_memoryDrainTimer); _memoryDrainTimer = null; }
      setBridgeRuntimeConnected(false);
      cancelPendingTranscriptRearm();
      try { forwarder.stopWatch(); } catch {}
      if (bindPersistedTranscriptTask) await bindPersistedTranscriptTask;
      notifyRemoteSuperseded();
      return;
    }
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
    // heartbeat and active-instance entry.
    try { stopOwnerHeartbeat(); } catch {}
    try { releaseOwnedChannelLocks(instanceId); } catch {}
    try { clearActiveInstance(instanceId); } catch {}
    if (_memoryDrainTimer) { clearInterval(_memoryDrainTimer); _memoryDrainTimer = null; }
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
  stopOwnerHeartbeat();
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
}
function refreshBridgeOwnershipSafe(options = {}) {
  refreshBridgeOwnership(options).catch(err => process.stderr.write(`[channels] refreshBridgeOwnership rejected: ${err?.message || err}\n`));
}
// Ownership-loss / re-acquire detection timer. Armed BEFORE getBackend().connect()
// (from startOwnedRuntime) so a session superseded during the connect window is
// torn down promptly, and re-armed idempotently on every start path.
function armBridgeOwnershipTimer() {
  if (bridgeOwnershipTimer) return;
  bridgeOwnershipTimer = setInterval(() => {
    refreshBridgeOwnershipSafe();
  }, 3e3);
  bridgeOwnershipTimer.unref?.();
  // Arm the event-driven signal alongside the poll fallback.
  armActiveInstanceWatcher();
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
    // Opt-in remote, single-owner, last-wins. Only a remote session with an
    // active bridge participates. If this instance is the active owner (its
    // instanceId is the one advertised in active-instance.json) it ensures
    // the owned runtime is up. If a newer remote session has since claimed
    // ownership (last-wins overwrite), this instance is no longer owner and
    // quietly tears its getBackend() down on the next tick. No proxy, no steal.
    if (!getChannelBridgeActive()) {
      if (getBridgeRuntimeConnected()) await stopOwnedRuntime("bridge inactive");
      return;
    }
    // Non-blocking ownership probe (read-only, no lock): distinguishes a live
    // owner from a genuinely empty/stale seat from an INDETERMINATE read (a
    // concurrent atomic rename yields partial content). "Locked/unreadable =
    // busy/unknown owner, never claimable" — skip the tick on 'unknown' so we
    // never claim a seat we merely failed to read (double-owner guard).
    const probe = probeActiveOwner();
    if (probe.status === 'unknown') return;
    const owned = probe.status === 'live' && probe.state?.instanceId === instanceId;
    if (owned) {
      // Try-once CAS refresh (timeoutMs:0): on lock contention treat as busy
      // and skip the metadata touch — never block the tick. We still own, so
      // ensure/keep the owned runtime up.
      try { refreshActiveInstance(instanceId, undefined, { onlyIfOwned: true, timeoutMs: 0 }); } catch {}
      await startOwnedRuntime(options);
      return;
    }
    if (probe.status === 'live' && probe.state.instanceId && probe.state.instanceId !== instanceId) {
      // A different live remote session holds the seat (last-wins: we lost).
      // Go quiet (disconnect if connected) and tell the parent to drop remote
      // mode entirely (single-holder, no handover). Notify UNCONDITIONALLY —
      // a loser whose getBackend() never connected must still drop its Remote
      // indicator; the parent handler is idempotent.
      // Also cover the STARTING phase: a worker stuck in getBackend().connect() must
      // get _ownedRuntimeStopRequested set (stopOwnedRuntime does this while
      // bridgeRuntimeStarting) so bailIfStopRequested tears it down promptly
      // once connect() resolves — otherwise the superseded connect lingers.
      if (getBridgeRuntimeConnected() || bridgeRuntimeStarting) {
        await stopOwnedRuntime("ownership lost (newer remote session)");
      }
      notifyRemoteSuperseded();
      return;
    }
    // Empty (absent) or stale (dead owner) seat — claim it. Try-once
    // (timeoutMs:0): a contended lock means a concurrent claimant is mid-write,
    // so treat as busy and skip this tick rather than block.
    let claimed = false;
    try { claimed = claimBridgeOwnership("no active owner", { timeoutMs: 0 }); } catch { claimed = false; }
    if (claimed) {
      await startOwnedRuntime(options);
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
    if (shouldRestart) refreshBridgeOwnershipSafe({ restoreBinding: false });
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
