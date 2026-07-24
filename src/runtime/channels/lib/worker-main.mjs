import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { performance } from "perf_hooks";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
import { loadConfig, createBackend, loadProfileConfig, DATA_DIR } from "./config.mjs";
import { resolveVoiceRuntime } from "./voice-runtime-fetcher.mjs";
import { ensureReady, stopVoiceWhisperServer } from "./whisper-server.mjs";
import { loadConfig as loadAgentConfig } from "../../agent/orchestrator/config.mjs";
import { captureOriginalUserCwd, readLastSessionCwd } from "../../shared/user-cwd.mjs";
import { initProviders } from "../../agent/orchestrator/providers/registry.mjs";
import { Scheduler } from "./scheduler.mjs";
import { startSnapshotWriter, stopSnapshotWriter, recordFetchedMessages } from "./status-snapshot.mjs";
import { hasPending as dispatchHasPending } from "../../agent/orchestrator/dispatch-persist.mjs";
import { setListener as setActivityBusListener } from "../../agent/orchestrator/activity-bus.mjs";
import { stripSoftWarns } from "../../agent/orchestrator/tool-loop-guard.mjs";
import { WebhookServer } from "./webhook.mjs";
import { EventPipeline } from "./event-pipeline.mjs";
import { startCliWorker } from "./cli-worker-host.mjs";
import {
  OutputForwarder,
  discoverSessionBoundTranscript,
  findLatestTranscriptByMtime,
  sameResolvedPath
} from "./output-forwarder.mjs";
import { controlClaudeSession } from "./session-control.mjs";
import { JsonStateFile, ensureDir, removeFileIfExists, writeTextFile } from "./state-file.mjs";
import {
  buildModalRequestSpec,
  PendingInteractionStore
} from "./interaction-workflows.mjs";
import {
  ensureRuntimeDirs,
  makeInstanceId,
  getTurnEndPath,
  getStatusPath,
  getPermissionResultPath,
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
import { getDiscordToken } from "./config.mjs";
import { invalidateConfigReadCache } from "../../shared/config.mjs";
import { bootProfile, localTimestamp } from "./boot-profile.mjs";
import {
  isChannelsDegraded,
  logCrash,
  _isBenignCrash,
  BENIGN_CRASH_FATAL_THRESHOLD,
  BENIGN_CRASH_STREAK_WINDOW_MS,
} from "./crash-log.mjs";
import { dropTrace, preview, _dtIdxFlush } from "./index-drop-trace.mjs";
import { createVoiceTranscription } from "./voice-transcription.mjs";
import { createBackendDispatch } from "./backend-dispatch.mjs";
import { createParentBridge } from "./parent-bridge.mjs";
import { createInboundRouting } from "./inbound-routing.mjs";
import { createToolDispatch } from "./tool-dispatch.mjs";
import { createOwnerHeartbeat } from "./owner-heartbeat.mjs";
import { createTranscriptBinding } from "./transcript-binding.mjs";
import { isNetworkError, retryOnNetwork } from "./network-retry.mjs";
import { runWorkerIpc } from "./worker-ipc.mjs";
import { createInteractionHandlers } from "./interaction-handlers.mjs";
import { createInboundHandler } from "./inbound-handler.mjs";
import { createOwnedRuntime } from "./owned-runtime.mjs";
import { runWorkerBootstrap } from "./worker-bootstrap.mjs";
const memoryClientModulePath = new URL("./memory-client.mjs", import.meta.url).href;
const {
  appendEntry: memoryAppendEntry,
  ingestTranscript: memoryIngestTranscript,
  drainBuffer: memoryDrainBuffer,
} = await import(memoryClientModulePath);
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
  DATA_DIR || path.join(os.tmpdir(), "mixdog"),
  "boot.log"
);
const {
  isMixdogDebugEnabled: isMixdogDebug,
  pruneStalePluginDataLogSiblings,
  appendSessionStartCriticalLog,
  DEFAULT_STALE_LOG_SIBLING_MAX,
} = _require("../../../lib/mixdog-debug.cjs");
// One-shot log rotation at worker boot (10 MB threshold, .1 suffix overwrite).
if (isMixdogDebug()) {
  try { if (fs.statSync(_bootLogEarly).size > 10 * 1024 * 1024) fs.renameSync(_bootLogEarly, _bootLogEarly + '.1') } catch {}
  fs.appendFileSync(_bootLogEarly, `[${localTimestamp()}] bootstrap start pid=${process.pid}
`);
}
const _bootLog = path.join(DATA_DIR, "boot.log");
let config = await loadConfig();
let backend = createBackend(config);
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
    const stateFile = path.join(os.tmpdir(), "mixdog", "bridge-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ active, ts: Date.now() }));
  } catch {
  }
}
function isChannelBridgeActive() {
  return channelBridgeActive;
}
let typingChannelId = null;
const pendingSetup = new PendingInteractionStore();
function startServerTyping(channelId) {
  if (typingChannelId && typingChannelId !== channelId) {
    backend.stopTyping(typingChannelId);
  }
  typingChannelId = channelId;
  backend.startTyping(channelId);
}
function stopServerTyping() {
  if (typingChannelId) {
    backend.stopTyping(typingChannelId);
    typingChannelId = null;
  }
}
const TURN_END_FILE = getTurnEndPath(INSTANCE_ID);
const TURN_END_BASENAME = path.basename(TURN_END_FILE);
const TURN_END_DIR = path.dirname(TURN_END_FILE);
let turnEndWatcher = null;
// Config hot-reload watcher (installed by start(); torn down by stop()).
let _configWatcher = null;
let _reloadDebounce = null;
if (!_isWorkerMode) {
  removeFileIfExists(TURN_END_FILE);
  turnEndWatcher = fs.watch(TURN_END_DIR, async (_event, filename) => {
    if (filename !== TURN_END_BASENAME) return;
    try {
      const stat = fs.statSync(TURN_END_FILE);
      if (stat.size > 0) {
        stopServerTyping();
        await forwarder.forwardFinalText();
        removeFileIfExists(TURN_END_FILE);
      }
    } catch {
    }
  });
}
const STATUS_FILE = getStatusPath(INSTANCE_ID);
const statusState = new JsonStateFile(STATUS_FILE, {});
statusState.ensure();
const forwarder = new OutputForwarder({
  send: async (ch, text, opts) => {
    if (!channelBridgeActive) {
      throw new Error("send() called while channel bridge is inactive");
    }
    await backend.sendMessage(ch, text, opts);
  },
  formatOutgoing: (text) => backend.formatOutgoing ? backend.formatOutgoing(text) : text,
  recordAssistantTurn: async () => {
  },
  react: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.react(ch, mid, emoji);
  },
  removeReaction: (ch, mid, emoji) => {
    if (!channelBridgeActive) return Promise.resolve();
    return backend.removeReaction(ch, mid, emoji);
  },
  // Watchdog backstop: force the backend to tear down + rebuild a wedged
  // client so an over-budget send fails fast and the queue releases.
  resetBackend: async () => {
    if (typeof backend?._resetClient === "function") await backend._resetClient();
  }
}, statusState);
forwarder.setOnIdle(() => {
  stopServerTyping();
  void forwarder.forwardFinalText();
});
// Wire the forwarder ownership probe unconditionally. wireEventQueueHandlers()
// also sets this, but that path only runs when the event pipeline starts
// (webhook enabled or event rules present). Without an event pipeline the
// forwarder's ownerGetter stayed null and _isOwner() failed open, letting a
// non-owner process forward transcript output (duplicate Discord sends).
// The closure reads bridgeRuntimeConnected at call time as a fast-path AND;
// bridgeRuntimeConnected alone can go stale (e.g. this process lost the seat
// but has not yet observed it), so currentOwnerState().owned is re-read at
// probe time as the source of truth for ownership.
forwarder.setOwnerGetter(() => bridgeRuntimeConnected && currentOwnerState().owned);
// ── Transcript binding cluster ──────────────────────────────────────────────
// Extracted → lib/transcript-binding.mjs. Bound to live config/identity/owner
// getters so file-level reference semantics (runtime reloads, ownership flips)
// are preserved.
const {
  sessionIdFromTranscriptPath,
  getPersistedTranscriptPath,
  pickUsableTranscriptPath,
  applyTranscriptBinding,
  cancelPendingTranscriptRearm,
  schedulePendingTranscriptRearm,
  rebindTranscriptContext,
  bindPersistedTranscriptIfAny,
} = createTranscriptBinding({
  forwarder,
  statusState,
  readActiveInstance,
  refreshActiveInstance,
  instanceId: INSTANCE_ID,
  memoryIngestTranscript,
  memoryDrainBuffer,
  dropTrace,
  discoverSessionBoundTranscript,
  sameResolvedPath,
  getConfig: () => config,
  getChannelBridgeActive: () => channelBridgeActive,
  getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
  RUNTIME_ROOT,
});
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
// by startOwnedRuntime() right after backend.connect() resolves so the
// in-flight start does not revive owner state after the stop already tore
// the partial-start state down.
const ACTIVE_OWNER_STALE_MS = 1e4;
// Owner gating here is multi-process runtime coordination: only the active
// bindingReady gates all send paths until the boot-time refreshBridgeOwnership
// ({ restoreBinding: true }) call completes. Without this, scheduler/webhook
// emissions fired within the first ~few hundred ms after restart drop because
// the Discord backend binding has not yet been established.
let bindingReadyStatus = "pending";
let _bindingReadyResolve;
const bindingReady = new Promise((r) => { _bindingReadyResolve = r; });
dropTrace("bindingReady.create", { status: bindingReadyStatus });
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
// flags + ownership timer + memory-drain timer; shares config/backend/
// bridgeRuntimeConnected/webhookServer/eventPipeline with the worker via get/set.
const {
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
  getBackend: () => backend,
  setBackend: (v) => { backend = v; },
  getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
  setBridgeRuntimeConnected: (v) => { bridgeRuntimeConnected = v; },
  getWebhookServer: () => webhookServer,
  setWebhookServer: (v) => { webhookServer = v; },
  getEventPipeline: () => eventPipeline,
  setEventPipeline: (v) => { eventPipeline = v; },
  getChannelBridgeActive: () => channelBridgeActive,
  instanceId: INSTANCE_ID,
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
});
function injectAndRecord(channelId, name, content, options) {
  // Strip soft-warn marker blocks (Tool-loop / Repeated-input / legacy
  // Repeated-tool / Mixed-tool / Tool-budget / Same-file multi-chunk /
  // Bash file-lookup / Iteration / 0-match advisory) from anywhere in the
  // outbound body. Markers are
  // intentionally prepended onto tool RESULTS upstream (tool-loop-guard.mjs
  // build*Warn) so the model
  // self-corrects, but agent roles commonly echo them and we don't want them
  // surfacing in Discord / Lead channel push.
  if (typeof content === 'string') content = stripSoftWarns(content);
  // Skip-protocol guard: agents (webhook-handler / scheduler-task)
  // prefix `[meta:silent]` on the first line to opt out
  // of Lead inject for genuine no-op results (label-only events, dedup,
  // "nothing to report"). The body still goes to Discord for audit; only
  // the Lead-context inject is suppressed. See rules/agent/20-skip-protocol.md.
  if (typeof content === 'string') {
    const m = content.match(/^\s*\[meta:silent\][^\n]*\n?([\s\S]*)$/);
    if (m) {
      content = m[1];
      options = { ...(options || {}), silent_to_agent: true };
    }
  }
  const ts = new Date().toISOString();
  const now = new Date();
  const timeLabel = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = { chat_id: channelId, user: sourceLabel, user_id: "system", ts };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  // `silent_to_agent` — lifecycle status pings (worker/iter/started echoes)
  // surface on Discord but should NOT land in Lead's context window. When
  // set, skip the parent-notify hop but keep the Discord-forward + event-log
  // record. The meta flag is also propagated downstream so consumers that
  // still see the notification (e.g. Lead itself if emission changes later)
  // can recognise and drop it. Default is false → legacy behaviour preserved.
  if (options?.silent_to_agent) meta.silent_to_agent = true;
  const silent = options?.silent_to_agent === true;
  if (!silent) {
    sendNotifyToParent("notifications/claude/channel", { content, meta });
  } else {
    forwardLifecycleToDiscord(channelId, content);
  }
}

// Best-effort direct Discord emission for silent-to-agent lifecycle pings.
// Only used when the parent-notify hop is skipped, so the user still sees
// the status on Discord even though Lead will never echo it through the
// transcript-tail forwarder. Falls back to a no-op when no channel is
// resolvable — lifecycle pings are non-critical.
function forwardLifecycleToDiscord(channelId, content) {
  try {
    // Skip rather than guess: lifecycle callers pass the channelId they own;
    // falling back to statusState.channelId can route to a stale/unrelated
    // channel when the caller did not supply one intentionally.
    const target = channelId || null;
    dropTrace("send.lifecycle.entry", { channelId: target || "(none)", bindingReadyStatus, backendPresent: !!backend?.sendMessage, preview: preview(content) });
    if (!target || !backend?.sendMessage) return;
    void bindingReady.then(() =>
      backend.sendMessage(target, content)
        .then(() => dropTrace("send.lifecycle.ok", { channelId: target }))
        .catch((err) => dropTrace("send.lifecycle.err", { channelId: target, err: String(err) }))
    ).catch(() => {});
  } catch { /* best-effort */ }
}
scheduler.setInjectHandler((channelId, name, content, options) => {
  injectAndRecord(channelId, name, content, options);
});
scheduler.setSendHandler(async (channelId, text) => {
  // Skip protocol: a scheduler-task emitting `[meta:silent]` has nothing to
  // report — suppress the channel send entirely (no noise). Mirrors the
  // webhook delegate drop and injectAndRecord's silent handling.
  if (typeof text === "string" && /^\s*\[meta:silent\]/.test(text)) {
    dropTrace("send.scheduler.silent", { channelId });
    return;
  }
  dropTrace("send.scheduler.entry", { channelId, preview: preview(text) });
  await bindingReady;
  dropTrace("send.scheduler.ready", { channelId });
  try {
    await backend.sendMessage(channelId, text);
    dropTrace("send.scheduler.ok", { channelId });
  } catch (err) {
    dropTrace("send.scheduler.err", { channelId, err: String(err) });
    throw err;
  }
});
function wireWebhookHandlers() {
  if (!webhookServer) return;
  webhookServer.setEventPipeline(eventPipeline);
  // Webhook fires run as VISIBLE sessions (user decision, schedules parity):
  // no Lead inject, no Discord forward — the session row in the sidebar
  // Automations section (plus its unread dot) IS the notification surface.
  webhookServer.setBridgeDispatch(async ({ prompt, model, cwd, workflow, attachments, context }) => {
    const { runWebhookSession } = await import("../../shared/webhook-session-run.mjs");
    return runWebhookSession({
      name: context?.endpoint || "webhook",
      model: model || null,
      cwd: cwd || null,
      workflow: workflow || null,
      attachments: attachments || null,
      prompt,
    });
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
  forwarder.setOwnerGetter(() => bridgeRuntimeConnected && currentOwnerState().owned);
}
const {
  pendingPermRequests,
  refreshToolExecConsumerMarker,
} = createInteractionHandlers({
  getBackend: () => backend,
  getConfig: () => config,
  getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
  instanceId: INSTANCE_ID,
  getBridgeOwnershipSnapshot,
  refreshBridgeOwnershipSafe,
  pendingSetup,
  buildModalRequestSpec,
  loadProfileConfig,
  getDiscordToken,
  sendNotifyToParent,
  scheduler,
  controlClaudeSession,
  writeTextFile,
  TURN_END_FILE,
  getPermissionResultPath,
  TERMINAL_LEAD_PID,
  localTimestamp,
  isMixdogDebug,
  appendSessionStartCriticalLog,
  DATA_DIR,
  _bootLog,
  RUNTIME_ROOT,
});
const { isVoiceAttachment, transcribeVoice } = createVoiceTranscription({
  getConfig: () => config,
  dataDir: DATA_DIR,
});
import { TOOL_DEFS } from '../tool-defs.mjs';
// Tool dispatch in worker mode goes through the IPC `call` handler at the
// bottom of this file (parent's `callWorker` → `handleToolCall`). There is no
// orphan worker-level MCP Server: the parent (server.mjs) owns the single
// connected transport and routes CallTool through the IPC `call` path.
const BACKEND_TOOLS = /* @__PURE__ */ new Set(["reply", "fetch"]);
// ── Inbound routing / dedup / ownership helpers ─────────────────────────────
// Extracted → lib/inbound-routing.mjs. Bound to live config/identity getters.
const {
  writeChannelOwner,
  shouldDropDuplicateInbound,
  resolveInboundRoute,
} = createInboundRouting({
  getConfig: () => config,
  getInstanceId: () => INSTANCE_ID,
  getChannelOwnerPath,
});
// ── Backend-tool dispatch helpers ───────────────────────────────────────────
// Each helper dispatches through the local backend (this process is always the
// owner in opt-in remote mode). Extracted → lib/backend-dispatch.mjs. Bound to
// live config/backend getters so runtime reloads keep the original file-level
// reference semantics.
const {
  dispatchReply,
  dispatchFetch,
} = createBackendDispatch({
  getConfig: () => config,
  getBackend: () => backend,
  scheduler,
});
// ── Worker/HTTP tool-call dispatch ──────────────────────────────────────────
// handleToolCall switch + bridge auto-connect retry wrapper. Extracted →
// lib/tool-dispatch.mjs. The switch is entangled with ~8 runtime-lifecycle
// functions plus mutable owner state (channelBridgeActive/bridgeRuntimeConnected)
// and the forwarder; those are threaded as a lifecycle bag of lazy getters so
// the module reads live file-level references at call time (original closure
// semantics preserved). Used by the HTTP MCP CallTool path and the worker IPC
// `call` handler at the bottom of this file.
const {
  handleToolCall,
  handleToolCallWithBridgeRetry,
} = createToolDispatch({
  getForwarder: () => forwarder,
  BACKEND_TOOLS,
  isChannelsDegraded,
  dispatchReply,
  dispatchFetch,
  lifecycle: {
    getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
    getChannelBridgeActive: () => channelBridgeActive,
    getOwned: () => getBridgeOwnershipSnapshot().owned,
    setChannelBridgeActive: (v) => { channelBridgeActive = v; },
    writeBridgeState,
    stopServerTyping,
    notifyRemoteAcquired,
    refreshBridgeOwnership,
    bindPersistedTranscriptIfAny,
    // Lead-pushed repoint: bind the exact transcript the lead just created
    // (auto-acquire / newSession / resume / clear) instead of waiting for the
    // next inbound parent-chain steal. Idempotent + best-effort: same binding
    // path as the inbound steal (rebindTranscriptContext -> applyTranscriptBinding).
    rebindCurrentTranscript: async (transcriptPath) => {
      const cleanPath = typeof transcriptPath === "string" ? transcriptPath.trim() : "";
      if (!cleanPath) return;
      const channelId = statusState.read().channelId || config.channelId;
      if (!channelId) return;
      // Fail-closed: a malformed / not-yet-on-disk path must NEVER fall through
      // to rebindTranscriptContext's discovery loop (which would mutate the
      // binding onto a different session). Only an existing regular file binds;
      // otherwise log + return so the current binding is left untouched.
      let exists = false;
      try { exists = fs.statSync(cleanPath).isFile(); } catch { exists = false; }
      if (!exists) {
        process.stderr.write(`mixdog: rebind_current_transcript: ignoring non-existent path ${cleanPath}\n`);
        return;
      }
      // Idempotent: already bound to this exact transcript => no-op. In
      // particular do NOT re-run recoverUnsyncedTail, which is only meaningful
      // when the binding actually changes.
      if (forwarder.hasBinding() && sameResolvedPath(forwarder.transcriptPath, cleanPath)) return;
      // Binding changed: same path as the inbound steal's applyTranscriptBinding.
      applyTranscriptBinding(channelId, cleanPath, {
        persistStatus: true,
        recoverUnsyncedTail: true,
      });
    },
    stopOwnedRuntime,
    reloadRuntimeConfig,
  },
});
createInboundHandler({
  getBackend: () => backend,
  getConfig: () => config,
  getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
  getChannelBridgeActive: () => channelBridgeActive,
  instanceId: INSTANCE_ID,
  forwarder,
  scheduler,
  statusState,
  getBridgeOwnershipSnapshot,
  refreshBridgeOwnershipSafe,
  writeChannelOwner,
  shouldDropDuplicateInbound,
  resolveInboundRoute,
  isVoiceAttachment,
  transcribeVoice,
  getPersistedTranscriptPath,
  sessionIdFromTranscriptPath,
  pickUsableTranscriptPath,
  applyTranscriptBinding,
  rebindTranscriptContext,
  sendNotifyToParent,
  memoryAppendEntry,
  startServerTyping,
  stopServerTyping,
});
async function init(_sharedMcp) {
  // _sharedMcp is no longer used. Notifications now flow via IPC to the parent
  // (sendNotifyToParent above). The parameter is retained for backward
  // compatibility with any caller that still passes a Server reference.
  scheduler.setInjectHandler((channelId, name, content, options) => {
    injectAndRecord(channelId, name, content, options);
  });
}
async function start() {
  channelBridgeActive = true;
  writeBridgeState(true);
  // Daemon model: this runtime is the machine-global singleton bridge owner
  // (enforced by the standalone daemon's singleton-owner lock), so there is no
  // seat to claim and no contender to make-before-break against. Just connect
  // the owned runtime and bind the persisted transcript.
  const _bindingReadyStart = Date.now();
  try {
    await startOwnedRuntime({ restoreBinding: true });
    bindingReadyStatus = "resolved";
    dropTrace("bindingReady.resolve", { elapsedMs: Date.now() - _bindingReadyStart, status: bindingReadyStatus });
    _bindingReadyResolve(true);
  } catch (e) {
    bindingReadyStatus = "rejected";
    dropTrace("bindingReady.reject", { elapsedMs: Date.now() - _bindingReadyStart, status: bindingReadyStatus, err: String(e) });
    _bindingReadyResolve(e);
  }
  // No-op under the daemon model (kept for call-site stability): there is no
  // ownership timer — the singleton daemon guarantees exactly one owner.
  armBridgeOwnershipTimer();
  // Hot-reload config on file change (schedules/webhooks/events).
  if (!_configWatcher) {
    try {
      _configWatcher = fs.watch(path.join(DATA_DIR, "mixdog-config.json"), () => {
        // Cross-process edit landed on disk; drop this process's short-TTL raw
        // config cache synchronously so the debounced reload (and any readAll
        // in between) sees the fresh file immediately, not up to TTL stale.
        invalidateConfigReadCache();
        if (_reloadDebounce) clearTimeout(_reloadDebounce);
        _reloadDebounce = setTimeout(() => { reloadRuntimeConfig().catch(() => {}); }, 500);
      });
    } catch {}
  }
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
  if (turnEndWatcher) {
    try { turnEndWatcher.close(); } catch {}
    turnEndWatcher = null;
  }
}
// ── IPC worker mode ──────────────────────────────────────────────
// Skipped under the machine-global daemon (MIXDOG_CHANNEL_DAEMON=1): the
// daemon entry (src/standalone/channel-daemon.mjs) drives start()/stop() and
// its own HTTP+SSE transport instead of the parent node-IPC call/notify loop.
if (_isWorkerMode && process.send && process.env.MIXDOG_CHANNEL_DAEMON !== '1') {
  runWorkerIpc({
    start,
    stop,
    stopVoiceWhisperServer,
    cleanupInstanceRuntimeFiles,
    clearServerPid,
    instanceId: INSTANCE_ID,
    statusState,
    getBackend: () => backend,
    getConfig: () => config,
    pendingPermRequests,
    refreshToolExecConsumerMarker,
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
