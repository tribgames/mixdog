// Machine-global BACKEND daemon entry — the single mixdog backend process.
//
// One process per machine hosts the whole backend: the channels runtime
// (worker-main), the memory runtime, and the session ENGINE pool. It exposes
// two local front doors — channel-daemon-transport.mjs (pointer-routed channel
// calls) and engine-daemon-transport.mjs (broadcast engine frames) — so the
// terminal TUI and the desktop app are views over ONE writer instead of each
// booting its own engine and arbitrating ownership on disk.
// Spawned (or attached-to) by createStandaloneChannelWorker; ownership is a
// pid-verified singleton lock (singleton-owner.mjs) — NOT the try-once
// active-instance lock that starved under 6 contending workers. A stale daemon
// (dead owner pid) is reclaimed by the next claim; a live peer that wins the
// race makes this process exit(0) so the spawner attaches to the winner.
//
// Boot order matters: MIXDOG_CHANNEL_DAEMON must be set BEFORE importing the
// channels runtime so worker-main skips its parent-IPC loop (runWorkerIpc) and
// lets this entry own start()/stop() + the transport.
process.env.MIXDOG_CHANNEL_DAEMON = '1';
process.env.MIXDOG_WORKER_MODE = process.env.MIXDOG_WORKER_MODE || '1';
// This process IS the engine host: its own createEngineSession() must build
// REAL engines, never a proxy back into itself.
process.env.MIXDOG_ENGINE_DAEMON_HOST = '1';

// V8 compile cache: the daemon is a standalone child entry (not via cli.mjs);
// caching compiled bytecode across restarts removes the channels+memory
// runtime parse cost from every daemon boot. Best-effort.
try {
  const { enableCompileCache } = await import('node:module');
  enableCompileCache?.();
} catch { /* launch-speed optimization only */ }

import os from 'node:os';
import path from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { claimSingletonOwner, releaseSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { setChannelNotifySink } from '../runtime/channels/lib/parent-bridge.mjs';
import { setOwnerContext } from '../runtime/channels/lib/runtime-paths.mjs';
import { safeIpcSend } from '../runtime/shared/safe-ipc-send.mjs';
import { createChannelDaemonTransport } from './channel-daemon-transport.mjs';
import { installEngineDaemonLocalBridge } from './engine-daemon-local-bridge.mjs';
import { createEngineDaemonTransport } from './engine-daemon-transport.mjs';
import { createEngineDaemonService } from './engine-daemon-service.mjs';
import { createStandaloneMemoryRuntime } from './memory-runtime-proxy.mjs';

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog');
}

const RUNTIME_ROOT = runtimeRoot();
const DATA_DIR = process.env.MIXDOG_DATA_DIR ? path.resolve(process.env.MIXDOG_DATA_DIR) : RUNTIME_ROOT;
const CWD = process.cwd();
const DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'channel-daemon.json');
// Engine views discover the SAME process through their own endpoint: one
// daemon, two front doors (channel routing is pointer-targeted, engine frames
// are broadcast — they must not share a router).
const ENGINE_DISCOVERY_PATH = path.join(RUNTIME_ROOT, 'engine-daemon.json');
// Owner-election lock, separate from the channels seat/bridge state. Reused
// pid-verified claim primitive with real claim-lock retry inside.
const OWNER_PATH = path.join(DATA_DIR, 'channel-daemon-owner.json');
// Memory runtime is folded into the daemon: the ONE machine-global process is
// responsible for starting BOTH the channels runtime and the memory runtime.
// The memory proxy is spawn-or-attach + singleton (memory-runtime-owner lock)
// and advertises memory_port to active-instance.json exactly as before, so
// external readers / memory-client.mjs discovery is UNCHANGED.
const MEMORY_ENTRY = fileURLToPath(new URL('../runtime/memory/index.mjs', import.meta.url));

// The spawning TUI mirrors our stderr into this file ONLY until it sees our
// 'ready' message; after that its pipe consumer dies on parent exit and later
// lines would be lost. So once ready we append here ourselves (fileLogging on),
// keyed to the SAME ready event the spawner detaches on — no loss, no dup.
const LOG_PATH = path.join(DATA_DIR, 'channels-worker-standalone.log');
let fileLogging = false;
function log(line) {
  const text = `[backend-daemon] ${line}`;
  // Exactly ONE sink per line: before ready the spawner mirrors our stderr into
  // the log, so write stderr only; after ready we own the file, so write the
  // file only — never both (no duplicate around the ready handoff).
  if (!fileLogging) {
    try { process.stderr.write(`${text}\n`); } catch {}
    return;
  }
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
}

// Redirect raw process.stderr/stdout writes and console.* from ANY module in
// this process to the daemon log file. Installed at the ready boundary (same
// point fileLogging flips) so pre-ready lines still reach the spawner mirror.
function installDaemonLogRedirect() {
  if (process.env.MIXDOG_DAEMON_ALLOW_STDERR === '1') return;
  const file = (chunk) => {
    try {
      const text = String(chunk ?? '').trimEnd();
      if (text) {
        mkdirSync(path.dirname(LOG_PATH), { recursive: true });
        appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`);
      }
    } catch { /* logging must never fail the daemon */ }
  };
  const patch = (stream) => {
    stream.write = ((chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      file(chunk);
      if (typeof done === 'function') { try { done(); } catch {} }
      return true;
    });
  };
  patch(process.stderr);
  patch(process.stdout);
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    console[m] = (...args) => file(`[console.${m}] ${args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ')}`);
  }
}

let channels = null;
let transport = null;
let engineTransport = null;
let engineService = null;
let localEngineBridge = null;
let uninstallLocalEngineBridge = null;
let memoryRuntime = null;
let shuttingDown = false;
let shutdownRecheckTimer = null;

async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (shutdownRecheckTimer) {
    clearTimeout(shutdownRecheckTimer);
    shutdownRecheckTimer = null;
  }
  log(`shutting down (${reason})`);
  try { setChannelNotifySink(null); } catch {}
  try { await engineService?.stop?.(reason); } catch (e) { log(`engine.stop failed: ${e?.message || e}`); }
  try { await localEngineBridge?.close?.(reason); } catch (e) { log(`local engine bridge.close failed: ${e?.message || e}`); }
  try { uninstallLocalEngineBridge?.(); } catch {}
  uninstallLocalEngineBridge = null;
  try { await engineTransport?.stop?.(); } catch (e) { log(`engine transport.stop failed: ${e?.message || e}`); }
  try { await channels?.stop?.(); } catch (e) { log(`channels.stop failed: ${e?.message || e}`); }
  // Detach the memory client (never hard-kills the shared memory daemon).
  try { await memoryRuntime?.stop?.(); } catch (e) { log(`memory.stop failed: ${e?.message || e}`); }
  try { await transport?.stop?.(); } catch (e) { log(`transport.stop failed: ${e?.message || e}`); }
  try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {}
  process.exit(code);
}

/** One process, two front doors (channels + engines): an idle side must never
 *  evict a busy one, so every self-shutdown trigger checks BOTH registries. */
function maybeSelfShutdown(reason) {
  const channelClients = transport?.clientCount ?? 0;
  const engineClients = engineTransport?.clientCount ?? 0;
  const remoteClients = engineService?.externalClientCount ?? 0;
  if (channelClients > 0 || engineClients > 0 || remoteClients > 0) {
    if (shutdownRecheckTimer) {
      clearTimeout(shutdownRecheckTimer);
      shutdownRecheckTimer = null;
    }
    log(`shutdown deferred (${reason}): channels=${channelClients} engines=${engineClients} remote=${remoteClients}`);
    return;
  }
  // A turn in flight outlives every view — closing the app or the terminal is
  // not a reason to abandon work the daemon is still running.
  const busyEngines = engineService?.busyCount ?? 0;
  if (busyEngines > 0) {
    log(`shutdown deferred (${reason}): ${busyEngines} engine(s) still working`);
    if (!shutdownRecheckTimer) {
      shutdownRecheckTimer = setTimeout(() => {
        shutdownRecheckTimer = null;
        maybeSelfShutdown('busy engines settled');
      }, 1_000);
      shutdownRecheckTimer.unref?.();
    }
    return;
  }
  void shutdown(reason);
}

async function main() {
  const startedAt = performance.now();
  try { mkdirSync(RUNTIME_ROOT, { recursive: true }); } catch {}

  // Pid-verified singleton claim (claimSingletonOwner reclaims a dead-pid owner
  // file and refuses only a LIVE peer). Loser exits so the spawner attaches to
  // the winner instead of running a second daemon.
  const claim = claimSingletonOwner(OWNER_PATH, { kind: 'channel-runtime-daemon', pid: process.pid, meta: { cwd: CWD } });
  if (!claim.owned) {
    log(`live peer holds owner lock (pid=${claim.owner?.pid}) — exiting for attach`);
    process.exit(0);
  }
  process.on('exit', () => { try { releaseSingletonOwner(OWNER_PATH, process.pid); } catch {} });
  process.on('mixdog:turn-timing', (row = {}) => {
    const ms = (value) => Number.isFinite(value) ? Math.round(value) : -1;
    log(
      `turn timing status=${row.status || 'unknown'} session=${row.sessionId || '-'}`
      + ` e2e=${ms(row.endToEndTtftMs)}ms runtime=${ms(row.ttftMs)}ms`
      + ` queue=${ms(row.queueMs)}ms route=${ms(row.routeMs)}ms`
      + ` preflight=${ms(row.preflightMs)}ms mcp=${ms(row.mcpMs)}ms`
      + ` provider=${ms(row.providerMs)}ms`,
    );
  });

  // The channels runtime is imported AFTER the daemon env is set so worker-main
  // skips runWorkerIpc; that import also triggers its boot side effects
  // (config/backend). It is now deferred past the ready handshake: an engine
  // view attaching to this same process must not wait out the channels graph,
  // and every channels call awaits this promise anyway.
  let channelsReady = null;
  function ensureChannels() {
    if (!channelsReady) {
      channelsReady = import('../runtime/channels/index.mjs').then((module) => {
        channels = module;
        return module;
      });
    }
    return channelsReady;
  }

  // Channels bring automation with them (schedules, webhook listener + tunnel,
  // optional messaging backend). A daemon spawned by a TUI starts them exactly
  // as before; a daemon spawned for ENGINE views stays dormant until a channels
  // client actually registers, so an app-only backend runs no tunnels.
  let channelsStarted = false;
  function startChannels() {
    if (channelsStarted) return;
    channelsStarted = true;
    const messaging = String(process.env.MIXDOG_REMOTE_INTENT || '') === 'explicit';
    void ensureChannels().then((module) => module.start({ messaging }))
      .catch((e) => log(`channels.start failed (non-fatal): ${e?.message || e}`));
  }

  // Accepted owner controls refresh active-instance context. The transport
  // admits rebind only for the current manual owner.
  const POINTER_TOOLS = new Set(['activate_channel_bridge', 'rebind_current_transcript']);
  const handleCall = async (name, args, ctx) => {
    const module = await ensureChannels();
    if (ctx && POINTER_TOOLS.has(name)) {
      try { setOwnerContext({ leadPid: ctx.leadPid, cwd: ctx.cwd }); } catch {}
    }
    return module.handleToolCallWithBridgeRetry(name, args || {});
  };
  transport = createChannelDaemonTransport({
    handleCall,
    // If a manual owner disappears without sending OFF, deactivate the backend.
    // No survivor is selected or rebound.
    dispatchControl: (name, args, ctx) => handleCall(name, args, ctx),
    discoveryPath: DISCOVERY_PATH,
    log,
    // Self-shutdown when the last attached TUI leaves (reuses the SSE/client
    // registry as the liveness signal — mirrors the memory daemon grace).
    onClientsEmpty: () => { maybeSelfShutdown('no live channel clients'); },
    // First channels client in: bring the channels runtime up (see startChannels).
    onClientRegistered: () => { startChannels(); },
  });
  setChannelNotifySink((method, params) => transport.notify(method, params));
  const { port, token } = await transport.start();

  // ── Engine front door ───────────────────────────────────────────────────────
  // Session engines live in THIS process too, so the terminal TUI and the
  // desktop app share ONE writer instead of arbitrating ownership on disk. The
  // engine module is the whole runtime graph, so it is imported when the first
  // engine client registers — early enough to overlap user think time, while a
  // channels-only spawn still never pays for it.
  const localEngineClients = new Map();
  let nextLocalEngineClient = 0;
  localEngineBridge = {
    attach({ onFrame = () => {}, onFatal = () => {} } = {}) {
      const clientToken = `daemon_local_${process.pid}_${++nextLocalEngineClient}`;
      let closed = false;
      localEngineClients.set(clientToken, { onFrame, onFatal });
      return {
        call(name, args = {}, options = {}) {
          if (closed) throw new Error('engine daemon local bridge is closed');
          return engineService.handleCall(name, args, {
            clientToken,
            ...(options?.callId ? { callId: String(options.callId) } : {}),
          });
        },
        async close(reason = 'local engine view closed') {
          if (closed) return;
          closed = true;
          localEngineClients.delete(clientToken);
          try { engineService.releaseClient(clientToken); } catch {}
          log(`${reason} (${clientToken})`);
        },
      };
    },
    publish(frame, targetTokens = null) {
      const targets = targetTokens ? new Set(targetTokens) : null;
      for (const [clientToken, client] of localEngineClients) {
        if (targets && !targets.has(clientToken)) continue;
        try { client.onFrame(frame); } catch {}
      }
    },
    async close(reason = 'daemon shutdown') {
      for (const [clientToken, client] of localEngineClients) {
        try { client.onFatal(reason); } catch {}
        try { engineService.releaseClient(clientToken); } catch {}
      }
      localEngineClients.clear();
    },
  };
  uninstallLocalEngineBridge = installEngineDaemonLocalBridge(localEngineBridge);
  const engineDaemonClientModule = () => import('./engine-daemon-client.mjs');
  const desktopRuntime = {
    async createRemoteEngineSession(options) {
      return (await engineDaemonClientModule()).createRemoteEngineSession(options);
    },
    async callDaemonSession(options) {
      return (await engineDaemonClientModule()).callDaemonSession(options);
    },
    loadProjects: () => import('./projects.mjs'),
    loadSessionStore: () => import('../runtime/agent/orchestrator/session/store-summary-reader.mjs'),
    loadStatuslineSegments: () => import('../ui/statusline-segments.mjs'),
    loadConfig: () => import('../runtime/shared/config.mjs'),
    loadCommitCompletion: () => import(
      '../runtime/agent/orchestrator/agent-runtime/commit-message-completion.mjs'
    ),
    async executeCodeGraphTool(name, args, cwd) {
      const graph = await import('../runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
      return graph.executeCodeGraphTool(name, args, cwd);
    },
  };
  let engineModulePromise = null;
  let engineRuntimePrewarmStarted = false;
  function loadEngineModule() {
    if (!engineModulePromise) {
      engineModulePromise = import('../tui/engine.mjs').catch((error) => {
        engineModulePromise = null;
        throw error;
      });
    }
    return engineModulePromise;
  }
  function prewarmEngineRuntime() {
    if (engineRuntimePrewarmStarted) return;
    engineRuntimePrewarmStarted = true;
    void loadEngineModule()
      .then((engineModule) => {
        engineModule.preloadSessionRuntimeModule?.();
        engineModule.preloadKeychainSecrets?.();
        log('engine runtime/keychain prewarm started');
      })
      .catch((error) => {
        engineRuntimePrewarmStarted = false;
        log(`engine runtime/keychain prewarm failed (non-fatal): ${error?.message || error}`);
      });
  }
  engineService = createEngineDaemonService({
    createEngine: async (options) => {
      const engineModule = await loadEngineModule();
      return engineModule.createEngineSession(options);
    },
    desktopRuntime,
    onFrame: (frame, targetTokens) => {
      localEngineBridge?.publish(frame, targetTokens);
      engineTransport?.broadcast(frame, targetTokens);
    },
    onExternalClientsChanged: () => { maybeSelfShutdown('remote clients changed'); },
    log,
  });
  engineTransport = createEngineDaemonTransport({
    // ctx carries the CLIENT token: the engine pool refcounts views across
    // processes with it, so a terminal exiting cannot destroy the engine a
    // desktop window is still streaming.
    handleCall: (name, args, ctx) => engineService.handleCall(name, args, ctx),
    discoveryPath: ENGINE_DISCOVERY_PATH,
    log,
    // `busy` is what stops a newer install from draining a daemon that is
    // mid-turn: work outlives views AND installs.
    getStatus: () => ({ engines: engineService.size, busy: engineService.busyCount }),
    onClientsEmpty: () => { maybeSelfShutdown('no live engine views'); },
    onClientRegistered: () => { prewarmEngineRuntime(); },
    onClientDropped: (token) => { try { engineService.releaseClient(token); } catch {} },
  });
  const engineEndpoint = await engineTransport.start();
  log(`engine front door on 127.0.0.1:${engineEndpoint.port}`);

  // Ready handshake for the spawner FIRST (mirrors the memory daemon's ready
  // port). Transport is already listening; signal ready before the heavy
  // Discord connect so the spawner's ready wait never blocks on backend I/O.
  // Take over file logging from the spawner at the ready boundary. No rotate
  // here: the spawner already bounds the file at its own boot (channel-worker
  // rotateBoundedLog), and rotating now would race other processes' buffered
  // appends into the same log.
  fileLogging = true;
  // Global stderr/console redirect: runtime modules hosted in this daemon
  // (session sweeps, scheduler, inbound handlers, providers…) write raw
  // process.stderr lines. With the current pipe stdio those bytes die with the
  // spawner, and a daemon inherited from an older spawn path prints them into
  // whatever terminal originally launched it — the "[session-sweep] …" text
  // observed inside the TUI composer. Route EVERY stderr/console line to the
  // daemon log so no spawn mode can ever reach a user terminal.
  installDaemonLogRedirect();
  // Guard the ready handshake against a dead/closing parent pipe. process.send
  // delivery is async: if the spawner TUI already exited, the write fails with
  // an async 'error' (EPIPE) that a sync try/catch cannot catch — it would
  // surface as uncaughtException and (pre-fix) flip the daemon degraded
  // forever. process.connected gates the obvious-dead case; the send callback
  // swallows the async delivery error so it never reaches uncaughtException.
  if (process.connected && process.send) {
    safeIpcSend(process, { type: 'ready', port, token });
  }
  log(`ready port=${port} pid=${process.pid} in ${(performance.now() - startedAt).toFixed(0)}ms`);

  // Boot messaging only for an explicit manual remote request. Automation may
  // spawn the shared daemon with no remote intent; keep schedules/webhooks live
  // without connecting the channel backend until a manual Remote ON arrives.
  // Legacy `auto` intent is deliberately ignored.
  // A TUI-spawned daemon keeps the historical eager start (its channels client
  // is already on the way). An engine-spawned one waits for a real channels
  // client — see the transport's onClientRegistered hook.
  if (process.env.MIXDOG_DAEMON_SPAWNED_FOR !== 'engine') startChannels();

  // Fold memory startup in: eagerly ensure the memory runtime is up under the
  // daemon's lifecycle (spawn-or-attach singleton). Fire-and-forget — memory
  // boot is heavy (DB/embeddings) and must NOT delay the ready handshake below
  // (the spawner's ready wait would time out); the proxy publishes memory_port
  // to active-instance.json when ready and memory-client buffers until then.
  // Isolated test roots opt out (MIXDOG_DAEMON_SKIP_MEMORY=1): spinning a
  // throwaway Postgres cluster per test run is pure cost, and a hard-killed
  // daemon would orphan it.
  if (process.env.MIXDOG_DAEMON_SKIP_MEMORY === '1') {
    log('memory runtime skipped (MIXDOG_DAEMON_SKIP_MEMORY=1)');
    return;
  }
  try {
    memoryRuntime = createStandaloneMemoryRuntime({ entry: MEMORY_ENTRY, dataDir: DATA_DIR, cwd: CWD });
    void memoryRuntime.start().catch((e) => log(`memory.start failed (non-fatal): ${e?.message || e}`));
  } catch (e) { log(`memory.start setup failed (non-fatal): ${e?.message || e}`); }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') void shutdown('IPC shutdown');
});

main().catch((err) => {
  log(`fatal boot error: ${err?.stack || err?.message || err}`);
  void shutdown('fatal boot error', 2);
});
