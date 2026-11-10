import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, DATA_DIR } from './config.mjs';
import { resolveVoiceRuntime } from './voice-runtime-fetcher.mjs';
import { whisperThreadCount } from './voice-transcription.mjs';
import { ensureReady, stopVoiceWhisperServer } from './whisper-server.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../../shared/runtime-root.mjs';
import { Scheduler } from './scheduler.mjs';
import { renameSchedule as renameScheduleRow } from './schedules-db.mjs';
import { stripSoftWarns } from '../../agent/orchestrator/tool-loop-guard.mjs';
import { JsonStateFile } from './state-file.mjs';
import { writeJsonAtomicSync } from '../../shared/atomic-file.mjs';
import {
  makeInstanceId,
  getStatusPath,
  getTerminalLeadPid,
  cleanupInstanceRuntimeFiles,
  clearServerPid,
} from './runtime-paths.mjs';
import { createConfigReloadWatch } from './config-reload-watch.mjs';
import { bootProfile, utcTimestamp } from './boot-profile.mjs';
import { isChannelsDegraded, crashEndsProcess } from './crash-log.mjs';
import { createParentBridge } from './parent-bridge.mjs';
import { createToolDispatch } from './tool-dispatch.mjs';
import { createOwnerHeartbeat } from './owner-heartbeat.mjs';
import { runWorkerIpc } from './worker-ipc.mjs';
import { createOwnedRuntime } from './owned-runtime.mjs';
import { runWorkerBootstrap } from './worker-bootstrap.mjs';
const _require = createRequire(import.meta.url);
function _fatalCrash(label, err) {
  if (!crashEndsProcess(label, err)) return;
  Promise.resolve()
    .then(() => (typeof stop === 'function' ? stop(`fatal:${label}`) : null))
    .catch(() => {})
    .finally(() => {
      try {
        process.exitCode = 1;
      } catch {}
      process.exit(1);
    });
  // Best-effort stop() may itself hang (e.g. IPC to a dead child) — a bare
  // .finally() would then never fire and we're back to a zombie. Force the
  // exit unconditionally after a short grace window regardless of outcome.
  setTimeout(() => {
    try {
      process.exit(1);
    } catch {}
  }, 3000).unref?.();
}
// Inside the daemon host the daemon owns fatal handling: exiting from here
// would skip its shutdown (log line, PG stop, session teardown).
if (process.env.MIXDOG_DAEMON_HOST !== '1') {
  process.on('unhandledRejection', (err) => _fatalCrash('unhandled rejection', err));
  process.on('uncaughtException', (err) => _fatalCrash('uncaught exception', err));
}
if (process.env.MIXDOG_CHANNELS_NO_CONNECT) {
  process.exit(0);
}
const _isWorkerMode = process.env.MIXDOG_WORKER_MODE === '1';
const _bootLogEarly = path.join(DATA_DIR || ensurePrivateRuntimeRoot(resolveRuntimeRoot()), 'boot.log');
const {
  isMixdogDebugEnabled: isMixdogDebug,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
} = _require('../../../lib/mixdog-debug.cjs');
// One-shot log rotation at worker boot (10 MB threshold, .1 suffix overwrite).
if (isMixdogDebug()) {
  try {
    if (fs.statSync(_bootLogEarly).size > 10 * 1024 * 1024) fs.renameSync(_bootLogEarly, `${_bootLogEarly}.1`);
  } catch {}
  fs.appendFileSync(
    _bootLogEarly,
    `[${utcTimestamp()}] bootstrap start pid=${process.pid}
`
  );
}
let config = await loadConfig();
const INSTANCE_ID = makeInstanceId();
const TERMINAL_LEAD_PID = getTerminalLeadPid();
runWorkerBootstrap({
  instanceId: INSTANCE_ID,
  isWorkerMode: _isWorkerMode,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
});

// ── Parent notification helper ───────────────────────────────────────
// This worker has no MCP transport of its own. All notifications flow
// through IPC to the parent (server.mjs), which owns the single connected
// MCP `Server` instance. The parent's IPC message handler translates
// `{type:'notify', method, params}` into `server.notification({method, params})`.
const { sendNotifyToParent, handleMemoryCallResponse } = createParentBridge({
  getInstanceId: () => INSTANCE_ID,
});
let channelBridgeActive = false;
function writeBridgeState(active) {
  try {
    const stateFile = path.join(ensurePrivateRuntimeRoot(resolveRuntimeRoot()), 'bridge-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeJsonAtomicSync(stateFile, { active, ts: Date.now() }, { compact: true });
  } catch {}
}
function isChannelBridgeActive() {
  return channelBridgeActive;
}
const STATUS_FILE = getStatusPath(INSTANCE_ID);
const statusState = new JsonStateFile(STATUS_FILE, {});
statusState.ensure();
const scheduler = new Scheduler(config.schedules ?? []);
// A schedule fire is a turn in its owner bot's chat; the runner belongs to the
// session-runtime layer, so this worker entry injects it (lazy, like webhooks).
scheduler.setScheduleRunner(async (schedule, opts) => {
  const { runScheduleSession } = await import('../../../session-runtime/schedule-session-run.mjs');
  return runScheduleSession(schedule, opts);
});
let webhookServer = null;
let eventPipeline = null;
let bridgeRuntimeConnected = false;
// ── Bridge ownership snapshot + owner heartbeat ─────────────────────────────
const { logOwnership, currentOwnerState } = createOwnerHeartbeat();
// ── Owned-runtime lifecycle ─────────────────────────────────────────────────
// Live getters/setters keep shared worker state visible across lifecycle phases.
const { startAutomationRuntime, startOwnedRuntime, stopOwnedRuntime, reloadRuntimeConfig, notifyRemoteAcquired } =
  createOwnedRuntime({
    getConfig: () => config,
    setConfig: (v) => {
      config = v;
    },
    getBridgeRuntimeConnected: () => bridgeRuntimeConnected,
    setBridgeRuntimeConnected: (v) => {
      bridgeRuntimeConnected = v;
    },
    getWebhookServer: () => webhookServer,
    setWebhookServer: (v) => {
      webhookServer = v;
    },
    getEventPipeline: () => eventPipeline,
    setEventPipeline: (v) => {
      eventPipeline = v;
    },
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
function injectAndRecord(content, options) {
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
  const timeLabel = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} `;
  const sourceLabel = options?.type ? `${timeLabel}: ${options.type}` : timeLabel;
  const meta = { user: sourceLabel, user_id: 'system', ts };
  if (options?.instruction) meta.instruction = options.instruction;
  if (options?.type) meta.type = options.type;
  // `silent_to_agent` — lifecycle status pings (worker/iter/started echoes)
  // must NOT land in Lead's context window, so silent pings are dropped.
  if (options?.silent_to_agent === true) return;
  sendNotifyToParent('notifications/claude/channel', { content, meta });
}
function wireWebhookHandlers() {
  if (!webhookServer) return;
  webhookServer.setEventPipeline(eventPipeline);
  // A webhook fire is a turn in its owner bot's chat (webhook-session-run.mjs).
  webhookServer.setBridgeDispatch(async ({ prompt, skillSelection, cwd, attachments, context, signal }) => {
    const { runWebhookSession } = await import('../../../session-runtime/webhook-session-run.mjs');
    const run = await runWebhookSession({
      name: context?.endpoint || 'webhook',
      ownerAgentId: context?.owner || null,
      executorAgentId: context?.executor || null,
      cwd: cwd || null,
      attachments: attachments || null,
      event: context?.event || '',
      // The dispatch has no deadline; a caller-supplied signal still reaches the run.
      signal: signal || null,
      prompt,
      skillSelection,
    });
    return run;
  });
}
function wireEventQueueHandlers(eventQueue) {
  if (!eventQueue) return;
  eventQueue.setInjectHandler((_name, content, options) => {
    injectAndRecord(content, options);
  });
  // Defensive ownership probe: the queue tick should only run in the active
  // owner process. Non-owner instances see bridgeRuntimeConnected=false and
  // will skip the tick even if an errant start() slipped through.
  // bridgeRuntimeConnected is a fast-path AND; currentOwnerState().owned is
  // re-read at probe time so a stale-connected flag cannot mask a lost seat.
  eventQueue.setOwnerGetter(() => bridgeRuntimeConnected && currentOwnerState().owned);
}
// ── Worker/HTTP tool-call dispatch ──────────────────────────────────────────
// Runtime lifecycle dispatch only (activate_channel_bridge / reload_config):
// threaded as a lifecycle bag of lazy getters so the module reads live
// file-level references at call time. Used by the HTTP MCP CallTool path and
// the worker IPC `call` handler at the bottom of this file.
const { handleToolCall } = createToolDispatch({
  isChannelsDegraded,
  lifecycle: {
    getChannelBridgeActive: () => channelBridgeActive,
    getOwned: () => currentOwnerState().owned,
    setChannelBridgeActive: (v) => {
      channelBridgeActive = v;
    },
    writeBridgeState,
    notifyRemoteAcquired,
    startChannelBridge: () => start({ bridge: true }),
    stopOwnedRuntime,
    reloadRuntimeConfig,
    // Rename and re-arm under one reservation: the scheduler is reloaded from
    // the renamed row (timers and one-shots of the old name cleared) before
    // the name is released for fires.
    renameSchedule: (name, def, opts) =>
      scheduler.renameLocked(name, () => renameScheduleRow(name, def, opts), {
        newName: def.name,
        reload: reloadRuntimeConfig,
      }),
  },
});
// Config hot reload (started by start(); stopped by stop()).
const configReloadWatch = createConfigReloadWatch(reloadRuntimeConfig);
async function start(options = {}) {
  if (options?.bridge === false) {
    channelBridgeActive = false;
    writeBridgeState(false);
    await startAutomationRuntime();
    configReloadWatch.start();
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
  // Hot-reload config on change (schedules/webhooks/events), in both bridge
  // and automation-only daemon modes.
  configReloadWatch.start();
  // Pre-warm the whisper-server manager once at owner startup so the first
  // voice transcription does not pay cold-start cost. Non-blocking: failures
  // (e.g. runtime not installed) are swallowed; per-request ensureReady retries.
  void (async () => {
    try {
      if (config.voice?.enabled === false) return;
      const runtime = resolveVoiceRuntime(DATA_DIR);
      if (!runtime?.installed) return;
      await ensureReady({
        serverCmd: runtime.serverCmd,
        modelPath: runtime.modelPath,
        threadCount: whisperThreadCount(config),
        host: '127.0.0.1',
      });
    } catch (err) {
      try {
        process.stderr.write(`mixdog: voice.transcription pre-warm skipped: ${err}\n`);
      } catch {}
    }
  })();
}
async function stop() {
  try {
    await stopVoiceWhisperServer();
  } catch {}
  await stopOwnedRuntime('unified server stop');
  cleanupInstanceRuntimeFiles(INSTANCE_ID);
  configReloadWatch.stop();
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
    getConfig: () => config,
    handleMemoryCallResponse,
    handleToolCall,
    bootProfile,
  });
}

export { handleToolCall, isChannelBridgeActive, isChannelsDegraded, start, stop };
