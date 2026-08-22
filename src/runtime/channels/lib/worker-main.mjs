import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
import { loadConfig, createProvider, loadProfileConfig, DATA_DIR } from "./config.mjs";
import { resolveVoiceRuntime } from "./voice-runtime-fetcher.mjs";
import { ensureReady, stopVoiceWhisperServer } from "./whisper-server.mjs";
import { loadConfig as loadAgentConfig } from "../../agent/orchestrator/config.mjs";
import { captureOriginalUserCwd, readLastSessionCwd } from "../../shared/user-cwd.mjs";
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from "../../shared/runtime-root.mjs";
import { initProviders } from "../../agent/orchestrator/providers/registry.mjs";
import { Scheduler } from "./scheduler.mjs";
import { startSnapshotWriter, stopSnapshotWriter } from "./status-snapshot.mjs";
import { hasPending as dispatchHasPending } from "../../agent/orchestrator/dispatch-persist.mjs";
import { setListener as setActivityBusListener } from "../../agent/orchestrator/activity-bus.mjs";
import { stripSoftWarns } from "../../agent/orchestrator/tool-loop-guard.mjs";
import { WebhookServer } from "./webhook.mjs";
import { EventPipeline } from "./event-pipeline.mjs";
import { startCliWorker } from "./cli-worker-host.mjs";
import { JsonStateFile, ensureDir, removeFileIfExists, writeTextFile } from "./state-file.mjs";
import {
  ensureRuntimeDirs,
  makeInstanceId,
  getStatusPath,
  getChannelOwnerPath,
  getActiveOwnerPid,
  getTerminalLeadPid,
  readActiveInstance,
  refreshActiveInstance,
  cleanupStaleRuntimeFiles,
  probeActiveOwner,
  cleanupInstanceRuntimeFiles,
  releaseOwnedChannelLocks,
  clearActiveInstance,
  notePreviousServerIfAny,
  writeServerPid,
  clearServerPid,
  RUNTIME_ROOT
} from "./runtime-paths.mjs";
import { invalidateConfigReadCache } from "../../shared/config.mjs";
import { bootProfile, utcTimestamp } from "./boot-profile.mjs";
import {
  isChannelsDegraded,
  logCrash,
  _isBenignCrash,
  BENIGN_CRASH_FATAL_THRESHOLD,
  BENIGN_CRASH_STREAK_WINDOW_MS,
} from "./crash-log.mjs";
import { dropTrace, preview, _dtIdxFlush } from "./index-drop-trace.mjs";
import { createParentBridge } from "./parent-bridge.mjs";
import { createToolDispatch } from "./tool-dispatch.mjs";
import { createOwnerHeartbeat } from "./owner-heartbeat.mjs";
import { isNetworkError, retryOnNetwork } from "./network-retry.mjs";
import { runWorkerIpc } from "./worker-ipc.mjs";
import { createOwnedRuntime } from "./owned-runtime.mjs";
import { runWorkerBootstrap } from "./worker-bootstrap.mjs";
// Zombie-Lead repro (2026-07-02): logCrash-then-survive left a worker alive
// after an unhandled rejection whose async state was already corrupted
// (observed: EPERM on active-instance.json rename retry), so it spun
// forever doing nothing useful — a zombie Lead. Fatal-exit on repeat.
let _benignCrashStreak = 0;
let _lastBenignCrashAt = 0;
function _fatalCrash(label, err) {
  logCrash(label, err);
  const benign = _isBenignCrash(err);
  if (benign) {
    const now = Date.now();
    _benignCrashStreak = (now - _lastBenignCrashAt) <= BENIGN_CRASH_STREAK_WINDOW_MS
      ? _benignCrashStreak + 1
      : 1;
    _lastBenignCrashAt = now;
    if (_benignCrashStreak < BENIGN_CRASH_FATAL_THRESHOLD) return;
  } else {
    _benignCrashStreak = 0;
  }
  Promise.resolve()
    .then(() => (typeof stop === "function" ? stop(`fatal:${label}`) : null))
    .catch(() => {})
    .finally(() => {
      try { process.exitCode = 1; } catch {}
      process.exit(1);
    });
  // Best-effort stop() may itself hang (e.g. IPC to a dead child) — a bare
  // .finally() would then never fire and we're back to a zombie. Force the
  // exit unconditionally after a short grace window regardless of outcome.
  setTimeout(() => { try { process.exit(1); } catch {} }, 3000).unref?.();
}
process.on("unhandledRejection", (err) => _fatalCrash("unhandled rejection", err));
process.on("uncaughtException", (err) => _fatalCrash("uncaught exception", err));
if (process.env.MIXDOG_CHANNELS_NO_CONNECT) {
  process.exit(0);
}
const _isWorkerMode = process.env.MIXDOG_WORKER_MODE === '1'
const _bootLogEarly = path.join(
  DATA_DIR || ensurePrivateRuntimeRoot(resolveRuntimeRoot()),
  "boot.log"
);
const {
  isMixdogDebugEnabled: isMixdogDebug,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
} = _require("../../../lib/mixdog-debug.cjs");
// One-shot log rotation at worker boot (10 MB threshold, .1 suffix overwrite).
if (isMixdogDebug()) {
  try { if (fs.statSync(_bootLogEarly).size > 10 * 1024 * 1024) fs.renameSync(_bootLogEarly, _bootLogEarly + '.1') } catch {}
  fs.appendFileSync(_bootLogEarly, `[${utcTimestamp()}] bootstrap start pid=${process.pid}
`);
}
let config = await loadConfig();
let provider = createProvider(config);
const INSTANCE_ID = makeInstanceId();
const TERMINAL_LEAD_PID = getTerminalLeadPid();
runWorkerBootstrap({
  instanceId: INSTANCE_ID,
  isWorkerMode: _isWorkerMode,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
});
const INSTRUCTIONS = "";

// ── Parent notification helper ───────────────────────────────────────
// This worker has no MCP transport of its own. All notifications flow
// through IPC to the parent (server.mjs), which owns the single connected
// MCP `Server` instance. The parent's IPC message handler translates
// `{type:'notify', method, params}` into `server.notification({method, params})`.
//
// Before v0.6.7 the worker had its own orphan `Server` instance that was
// never `connect()`ed to any transport, so `.notification()` silently
// threw 'Not connected' inside the SDK and every call was dropped by an
// outer `.catch(() => {})`. That regression is what this path replaces.
const {
  sendNotifyToParent,
  callMemoryAction,
  handleMemoryCallResponse,
} = createParentBridge({ getInstanceId: () => INSTANCE_ID });
let channelBridgeActive = false;
function writeBridgeState(active) {
  try {
    const stateFile = path.join(ensurePrivateRuntimeRoot(resolveRuntimeRoot()), "bridge-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ active, ts: Date.now() }));
  } catch {
  }
}
function isChannelBridgeActive() {
  return channelBridgeActive;
}
// Config hot-reload watcher (installed by start(); torn down by stop()).
let _configWatcher = null;
let _reloadDebounce = null;
const STATUS_FILE = getStatusPath(INSTANCE_ID);
const statusState = new JsonStateFile(STATUS_FILE, {});
statusState.ensure();
const scheduler = new Scheduler(
  config.nonInteractive ?? [],
  config.interactive ?? [],
  // Single resolved main-channel id used for the schedule `channel` flag.
  config.channelId
);
// Register the pending-dispatch probe so the scheduler treats an in-flight
// bridge dispatch as "active" regardless of user-inbound silence.
scheduler.setPendingCheck(() => {
  try {
    return dispatchHasPending(DATA_DIR);
  } catch {
    return false;
  }
});
// Bridge the orchestrator-side activity notifier into the scheduler so
// events like `addPending` can bump lastActivity without importing the
// scheduler instance directly (avoids module cycles).
setActivityBusListener(() => scheduler.noteActivity());
let webhookServer = null;
let eventPipeline = null;
let bridgeRuntimeConnected = false;
// Stop-requested signal: set by stopOwnedRuntime() when it runs during the
// startOwnedRuntime() in-flight window (bridgeRuntimeStarting=true). Checked
// by startOwnedRuntime() right after provider.connect() resolves so the
// in-flight start does not revive owner state after the stop already tore
// the partial-start state down.
const ACTIVE_OWNER_STALE_MS = 1e4;
// ── Bridge ownership snapshot + owner heartbeat ─────────────────────────────
// Extracted → lib/owner-heartbeat.mjs. Owns its own heartbeat timer + last-note
// dedup; bound to live identity + active-instance primitives.
const {
  logOwnership,
  currentOwnerState,
  getBridgeOwnershipSnapshot,
} = createOwnerHeartbeat();
// ── Owned-runtime lifecycle ─────────────────────────────────────────────────
// Extracted -> lib/owned-runtime.mjs. Owns its own start/stop/refresh in-flight
// flags + ownership timer + memory-drain timer; shares config/provider/
// bridgeRuntimeConnected/webhookServer/eventPipeline with the worker via get/set.
const {
  startAutomationRuntime,
  startOwnedRuntime,
  stopOwnedRuntime,
  refreshBridgeOwnership,
  refreshBridgeOwnershipSafe,
  reloadRuntimeConfig,
  armBridgeOwnershipTimer,
  clearBridgeOwnershipTimer,
  notifyRemoteAcquired,
} = createOwnedRuntime({
  getConfig: () => config,
  setConfig: (v) => { config = v; },
  getProvider: () => provider,
  setProvider: (v) => { provider = v; },
  getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
  setBridgeRuntimeConnected: (v) => { bridgeRuntimeConnected = v; },
  getWebhookServer: () => webhookServer,
  setWebhookServer: (v) => { webhookServer = v; },
  getEventPipeline: () => eventPipeline,
  setEventPipeline: (v) => { eventPipeline = v; },
  getChannelBridgeActive: () => channelBridgeActive,
  instanceId: INSTANCE_ID,
  TERMINAL_LEAD_PID,
  sendNotifyToParent,
  scheduler,
  statusState,
  logOwnership,
  currentOwnerState,
  wireWebhookHandlers,
  wireEventQueueHandlers,
});
function injectAndRecord(channelId, name, content, options) {
  // Strip soft-warn marker blocks (Tool-loop / Repeated-input / legacy
  // Repeated-tool / Mixed-tool / Tool-budget / Same-file multi-chunk /
  // Bash file-lookup / Iteration / 0-match advisory) from anywhere in the
  // outbound body. Markers are
  // intentionally prepended onto tool RESULTS upstream (tool-loop-guard.mjs
  // build*Warn) so the model
  // self-corrects, but agent roles commonly echo them and we don't want them
  // surfacing in the Lead channel push.
  if (typeof content === 'string') content = stripSoftWarns(content);
  const ts = new Date().toISOString();
  const now = new Date();
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = { chat_id: channelId, user: sourceLabel, user_id: "system", ts };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  // `silent_to_agent` — lifecycle status pings (worker/iter/started echoes)
  // must NOT land in Lead's context window. The channel relay that used to
  // surface them is retired, so silent pings are dropped entirely.
  if (options?.silent_to_agent === true) return;
  sendNotifyToParent("notifications/claude/channel", { content, meta });
}
scheduler.setInjectHandler((channelId, name, content, options) => {
  injectAndRecord(channelId, name, content, options);
});
// Interactive schedule fires may only inject while this process
// actually holds the live bridge seat; otherwise the scheduler falls back to
// the visible-session run so the fire is never lost.
scheduler.setInjectReadyCheck(() => bridgeRuntimeConnected && currentOwnerState().owned);
scheduler.setSendHandler(async () => {
  // Channel delivery is retired: schedule results surface in the app session
  // (parent notify / Automations row) only.
});
function wireWebhookHandlers() {
  if (!webhookServer) return;
  webhookServer.setEventPipeline(eventPipeline);
  // Webhook fires run as sessions (schedules parity); the Automations
  // session row is the only surface (channel relay retired).
  webhookServer.setBridgeDispatch(async ({ prompt, model, cwd, workflow, attachments, delivery, context, signal }) => {
    const { runWebhookSession } = await import("../../shared/webhook-session-run.mjs");
    const run = await runWebhookSession({
      name: context?.endpoint || "webhook",
      model: model || null,
      cwd: cwd || null,
      workflow: workflow || null,
      attachments: attachments || null,
      delivery: delivery || null,
      // Dispatch-timeout cancellation only works if the signal reaches the run.
      signal: signal || null,
      prompt,
    });
    return run;
  });
}
function wireEventQueueHandlers(eventQueue) {
  if (!eventQueue) return;
  eventQueue.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
  // Defensive ownership probe: the queue tick should only run in the active
  // owner process. Non-owner instances see bridgeRuntimeConnected=false and
  // will skip the tick even if an errant start() slipped through.
  // bridgeRuntimeConnected is a fast-path AND; currentOwnerState().owned is
  // re-read at probe time so a stale-connected flag cannot mask a lost seat.
  eventQueue.setOwnerGetter(() => bridgeRuntimeConnected && currentOwnerState().owned);
}
// Inbound messaging, provider interaction handlers, and channel voice-message
// transcription are DELETED with Discord/Telegram (user decision: PWA replaces
// channels). The headless provider emits no events, so nothing wires here.
import { TOOL_DEFS } from '../tool-defs.mjs';
// Tool dispatch in worker mode goes through the IPC `call` handler at the
// bottom of this file (parent's `callWorker` → `handleToolCall`). There is no
// orphan worker-level MCP Server: the parent (server.mjs) owns the single
// connected transport and routes CallTool through the IPC `call` path.
// ── Worker/HTTP tool-call dispatch ──────────────────────────────────────────
// Runtime lifecycle dispatch only (activate_channel_bridge / reload_config):
// threaded as a lifecycle bag of lazy getters so the module reads live
// file-level references at call time. Used by the HTTP MCP CallTool path and
// the worker IPC `call` handler at the bottom of this file.
const {
  handleToolCall,
  handleToolCallWithBridgeRetry,
} = createToolDispatch({
  isChannelsDegraded,
  lifecycle: {
    getChannelBridgeActive: () => channelBridgeActive,
    getOwned: () => getBridgeOwnershipSnapshot().owned,
    setChannelBridgeActive: (v) => { channelBridgeActive = v; },
    writeBridgeState,
    notifyRemoteAcquired,
    refreshBridgeOwnership,
    startChannelBridge: () => start({ messaging: true }),
    stopOwnedRuntime,
    reloadRuntimeConfig,
  },
});
async function init(_sharedMcp) {
  // _sharedMcp is no longer used. Notifications now flow via IPC to the parent
  // (sendNotifyToParent above). The parameter is retained for backward
  // compatibility with any caller that still passes a Server reference.
  scheduler.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
}
function ensureConfigWatcher() {
  if (_configWatcher) return;
  try {
    _configWatcher = fs.watch(path.join(DATA_DIR, "mixdog-config.json"), () => {
      invalidateConfigReadCache();
      if (_reloadDebounce) clearTimeout(_reloadDebounce);
      _reloadDebounce = setTimeout(() => { reloadRuntimeConfig().catch(() => {}); }, 500);
    });
  } catch {}
}
async function start(options = {}) {
  if (options?.messaging === false) {
    channelBridgeActive = false;
    writeBridgeState(false);
    await startAutomationRuntime();
    ensureConfigWatcher();
    return;
  }
  channelBridgeActive = true;
  writeBridgeState(true);
  // Daemon model: this runtime is the machine-global singleton bridge owner
  // (enforced by the standalone daemon's singleton-owner lock), so there is no
  // seat to claim and no contender to make-before-break against. Just connect
  // the owned runtime.
  try {
    await startOwnedRuntime();
  } catch {
    // Non-fatal: owned-runtime start errors degrade to automation-only mode.
  }
  // No-op under the daemon model (kept for call-site stability): there is no
  // ownership timer — the singleton daemon guarantees exactly one owner.
  armBridgeOwnershipTimer();
  // Hot-reload config on file change (schedules/webhooks/events).
  // Cross-process edits invalidate the raw config cache before the debounced
  // reload so both messaging and automation-only daemon modes stay current.
  ensureConfigWatcher();
  // Pre-warm the whisper-server manager once at owner startup so the first
  // voice transcription does not pay cold-start cost. Non-blocking: failures
  // (e.g. runtime not installed) are swallowed; per-request ensureReady retries.
  void (async () => {
    try {
      if (config.voice?.enabled === false) return;
      const runtime = resolveVoiceRuntime(DATA_DIR);
      if (!runtime?.installed) return;
      const _cpuCount = (() => { try { return os.cpus().length; } catch { return 2; } })();
      const threadCount = config.voice?.transcription?.threadCount ?? Math.max(1, Math.ceil(_cpuCount / 4));
      await ensureReady({ serverCmd: runtime.serverCmd, modelPath: runtime.modelPath, threadCount, host: '127.0.0.1' });
    } catch (err) {
      try { process.stderr.write(`mixdog: voice.transcription pre-warm skipped: ${err}\n`); } catch {}
    }
  })();
}
async function stop() {
  try { await stopVoiceWhisperServer(); } catch {}
  await stopOwnedRuntime("unified server stop");
  cleanupInstanceRuntimeFiles(INSTANCE_ID);
  clearBridgeOwnershipTimer();
  if (_reloadDebounce) { clearTimeout(_reloadDebounce); _reloadDebounce = null; }
  if (_configWatcher) { try { _configWatcher.close(); } catch {} _configWatcher = null; }
}
// ── IPC worker mode ──────────────────────────────────────────────
// Skipped under the machine-global host (MIXDOG_DAEMON_HOST=1): the daemon
// entry (src/standalone/daemon.mjs) drives start()/stop() and
// its own HTTP+SSE transport instead of the parent node-IPC call/notify loop.
if (_isWorkerMode && process.send && process.env.MIXDOG_DAEMON_HOST !== '1') {
  runWorkerIpc({
    start,
    stop,
    stopVoiceWhisperServer,
    cleanupInstanceRuntimeFiles,
    clearServerPid,
    instanceId: INSTANCE_ID,
    statusState,
    getProvider: () => provider,
    getConfig: () => config,
    handleMemoryCallResponse,
    handleToolCallWithBridgeRetry,
    bootProfile,
  });
}

export {
  TOOL_DEFS,
  handleToolCall,
  handleToolCallWithBridgeRetry,
  init,
  INSTRUCTIONS as instructions,
  isChannelBridgeActive,
  isChannelsDegraded,
  start,
  stop
};
