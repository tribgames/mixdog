import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFile } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendBuffered } from '../runtime/shared/buffered-appender.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../runtime/shared/runtime-root.mjs';
import { detachedSpawnOpts } from '../runtime/shared/spawn-flags.mjs';
import { scrubLoaderVars } from '../runtime/agent/orchestrator/tools/env-scrub.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';
import { attachChannel, readChannelDiscovery, probeChannelHealth } from './channel-client.mjs';

const CHANNEL_TOOLS = new Set([
  'activate_channel_bridge',
  'reload_config',
  'rebind_current_transcript',
]);

const WORKER_PRELOAD = fileURLToPath(new URL('./channel-worker-preload.cjs', import.meta.url));

function daemonEntry() {
  return process.env.MIXDOG_DAEMON_ENTRY
    ? resolve(process.env.MIXDOG_DAEMON_ENTRY)
    : fileURLToPath(new URL('./daemon.mjs', import.meta.url));
}

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendBuffered(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

const CHANNEL_WORKER_EXIT_CLEANUPS = new Set();
let channelWorkerExitHookInstalled = false;

function registerChannelWorkerExitCleanup(cleanup) {
  if (typeof cleanup !== 'function') return () => {};
  CHANNEL_WORKER_EXIT_CLEANUPS.add(cleanup);
  if (!channelWorkerExitHookInstalled) {
    channelWorkerExitHookInstalled = true;
    process.once('exit', () => {
      for (const fn of CHANNEL_WORKER_EXIT_CLEANUPS) {
        try { fn(); } catch {}
      }
      CHANNEL_WORKER_EXIT_CLEANUPS.clear();
    });
  }
  return () => { CHANNEL_WORKER_EXIT_CLEANUPS.delete(cleanup); };
}

export function createStandaloneChannelWorker({
  rootDir,
  dataDir,
  cwd = process.cwd(),
  leadPid = null,
  onNotify,
} = {}) {
  if (!rootDir) throw new Error('channels runtime rootDir is required');
  if (!dataDir) throw new Error('channels runtime dataDir is required');

  let daemonClient = null;
  let daemonPid = null;
  let attachPromise = null;
  let attachGeneration = 0;
  let stopPromise = null;
  let stopRequested = false;
  let nextCallId = 1;
  const proxyId = randomUUID();
  const logPath = join(dataDir, 'daemon.log');
  rotateBoundedLog(logPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);

  const runtimeDir = ensurePrivateRuntimeRoot(resolveRuntimeRoot());
  const clientDir = join(runtimeDir, 'channel-clients');
  const clientPath = join(clientDir, `${process.pid}.json`);
  let clientHeartbeatTimer = null;
  let clientHeartbeatExitCleanup = null;
  let clientDirReady = false;

  function writeClientHeartbeat() {
    try {
      if (!clientDirReady) {
        mkdirSync(clientDir, { recursive: true });
        clientDirReady = true;
      }
      writeFile(clientPath, JSON.stringify({
        pid: process.pid,
        cwd,
        updatedAt: Date.now(),
      }), () => {});
    } catch {}
  }

  function stopClientHeartbeat() {
    if (clientHeartbeatExitCleanup) {
      const unregister = clientHeartbeatExitCleanup;
      clientHeartbeatExitCleanup = null;
      unregister();
    }
    if (clientHeartbeatTimer) {
      clearInterval(clientHeartbeatTimer);
      clientHeartbeatTimer = null;
    }
    try { rmSync(clientPath, { force: true }); } catch {}
  }

  function startClientHeartbeat() {
    if (clientHeartbeatTimer) return;
    writeClientHeartbeat();
    clientHeartbeatTimer = setInterval(writeClientHeartbeat, 5_000);
    clientHeartbeatTimer.unref?.();
    clientHeartbeatExitCleanup ||= registerChannelWorkerExitCleanup(stopClientHeartbeat);
  }

  startClientHeartbeat();

  function status() {
    return {
      running: Boolean(daemonClient),
      pid: daemonPid,
      pending: 0,
      mode: 'daemon',
    };
  }

  // Daemon-hosted session shards inherit the PID of the process that first
  // spawned the machine daemon. That process may be gone after daemon recovery,
  // so callers that own a live runtime can override the inherited identity.
  const daemonLeadPid = Number(leadPid)
    || Number(process.env.MIXDOG_SUPERVISOR_PID)
    || process.pid;
  const discoveryPath = join(runtimeDir, 'daemon.json');
  const discoverChannel = () => readChannelDiscovery(discoveryPath);
  const daemonDelay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

  function invalidateDaemonClient(reason = 'invalidate', expected = null) {
    if (expected && daemonClient !== expected) return;
    attachGeneration += 1;
    const client = daemonClient;
    daemonClient = null;
    attachPromise = null;
    daemonPid = null;
    if (client) { try { client.close(reason); } catch {} }
  }

  function daemonEnv() {
    const env = { ...process.env };
    scrubLoaderVars(env);
    return {
      ...env,
      MIXDOG_ROOT: rootDir,
      MIXDOG_DATA_DIR: dataDir,
      MIXDOG_RUNTIME_ROOT: runtimeDir,
      MIXDOG_STANDALONE: '1',
      MIXDOG_WORKER_MODE: '1',
      MIXDOG_DAEMON_HOST: '1',
      MIXDOG_CLI_OWNED: '0',
      MIXDOG_SUPERVISOR_PID: String(daemonLeadPid),
      MIXDOG_QUIET_SESSION_LOG: process.env.MIXDOG_QUIET_SESSION_LOG ?? '1',
    };
  }

  function spawnDaemonCandidate() {
    return new Promise((resolveSpawn) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolveSpawn();
      };
      let daemon;
      try {
        daemon = fork(daemonEntry(), [], {
          cwd,
          execArgv: ['--require', WORKER_PRELOAD],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: daemonEnv(),
          ...detachedSpawnOpts,
        });
      } catch (error) {
        logLine(logPath, `daemon spawn failed: ${error?.message || error}`);
        done();
        return;
      }
      const mirrorStderr = (chunk) => {
        const text = String(chunk || '').trimEnd();
        if (text) logLine(logPath, text);
      };
      daemon.stderr?.on('data', mirrorStderr);
      daemon.once('message', (message) => {
        if (message?.type !== 'ready') return;
        try { daemon.stderr?.off?.('data', mirrorStderr); } catch {}
        try { daemon.disconnect?.(); } catch {}
        try { daemon.unref?.(); } catch {}
        try { daemon.stderr?.unref?.(); } catch {}
        done();
      });
      daemon.once('exit', done);
      daemon.once('error', (error) => {
        logLine(logPath, `daemon spawn error: ${error?.message || error}`);
        done();
      });
      const timer = setTimeout(done, 20_000);
      timer.unref?.();
    });
  }

  function attachCancelledError() {
    const error = new Error('channel service attach superseded');
    error.daemonAttachCancelled = true;
    return error;
  }

  async function doAttach(discovery, generation) {
    let client = null;
    let fatalDuringAttach = false;
    client = await attachChannel({
      discovery,
      leadPid: daemonLeadPid,
      cwd,
      onNotify: (message) => { try { onNotify?.(message); } catch {} },
      onFatal: () => {
        fatalDuringAttach = true;
        invalidateDaemonClient('sse fatal', client);
        if (!stopRequested) void ensureDaemonAttached().catch(() => {});
      },
      log: (line) => logLine(logPath, line),
    });
    if (stopRequested || generation !== attachGeneration || fatalDuringAttach) {
      await client.close('attach superseded');
      const error = attachCancelledError();
      if (fatalDuringAttach && !stopRequested && generation === attachGeneration) {
        error.daemonDiscoveryStale = true;
      }
      throw error;
    }
    daemonClient = client;
    daemonPid = discovery.pid;
    return client;
  }

  async function ensureDaemonAttached() {
    if (stopRequested) throw attachCancelledError();
    if (daemonClient) return daemonClient;
    if (attachPromise) return attachPromise;
    const generation = attachGeneration;
    const promise = (async () => {
      const deadline = Date.now() + 30_000;
      let authRejections = 0;
      for (let attempt = 0; ; attempt += 1) {
        if (stopRequested || generation !== attachGeneration) throw attachCancelledError();
        let discovery = discoverChannel();
        if (discovery) {
          const health = await probeChannelHealth({
            port: discovery.port,
            token: discovery.token,
            timeoutMs: attempt === 0 ? 800 : 2_000,
          });
          if (stopRequested || generation !== attachGeneration) throw attachCancelledError();
          if (Number(health?.pid) === Number(discovery.pid)) {
            try {
              return await doAttach(discovery, generation);
            } catch (error) {
              if (!error?.daemonDiscoveryStale) throw error;
              if (error?.daemonAuthRejected) authRejections += 1;
              if (authRejections >= 5 || Date.now() >= deadline) {
                throw new Error('channel service repeatedly rejected discovery authentication');
              }
              await daemonDelay(Math.min(200 * (2 ** authRejections), 2_000));
              continue;
            }
          }
        }
        await spawnDaemonCandidate();
        discovery = discoverChannel();
        if (discovery) {
          const health = await probeChannelHealth({
            port: discovery.port,
            token: discovery.token,
            timeoutMs: 3_000,
          });
          if (Number(health?.pid) === Number(discovery.pid)) {
            try { return await doAttach(discovery, generation); }
            catch (error) {
              if (!error?.daemonDiscoveryStale) throw error;
            }
          }
        }
        if (Date.now() >= deadline) throw new Error('channel service did not become ready');
        await daemonDelay(200);
      }
    })();
    attachPromise = promise;
    try { return await promise; }
    finally { if (attachPromise === promise) attachPromise = null; }
  }

  function start() {
    if (stopPromise) return stopPromise.then(() => start());
    stopRequested = false;
    startClientHeartbeat();
    return ensureDaemonAttached().then(() => status());
  }

  async function execute(name, args = {}, { timeoutMs = 120_000 } = {}) {
    if (!CHANNEL_TOOLS.has(name)) throw new Error(`unknown channel tool: ${name}`);
    await start();
    let lastError = null;
    const callId = `ch_${proxyId}_${nextCallId++}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const daemon = await ensureDaemonAttached();
      try {
        return await daemon.call(name, args || {}, { timeoutMs, callId });
      } catch (error) {
        if (!error?.daemonTransportError) throw error;
        lastError = error;
        invalidateDaemonClient('transport failure', daemon);
        await daemonDelay(200 * (attempt + 1));
      }
    }
    throw lastError || new Error('channel service call failed');
  }

  function stop(reason = 'standalone shutdown') {
    stopRequested = true;
    stopClientHeartbeat();
    if (stopPromise) return stopPromise;
    const inFlightAttach = attachPromise;
    attachGeneration += 1;
    const client = daemonClient;
    daemonClient = null;
    attachPromise = null;
    daemonPid = null;
    stopPromise = Promise.all([
      client ? client.close(reason).then(() => true).catch(() => true) : Promise.resolve(false),
      Promise.resolve(inFlightAttach).catch(() => null),
    ]).then(([detached]) => detached).finally(() => { stopPromise = null; });
    return stopPromise;
  }

  return {
    start,
    execute,
    stop,
    status,
    isChannelTool: (name) => CHANNEL_TOOLS.has(name),
  };
}
