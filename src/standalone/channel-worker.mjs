// Standalone channel worker: the TUI/session-runtime side of the machine-global
// channel daemon. Owns start/execute/stop; the pieces live under
// ./channel-worker/:
//   client-heartbeat — this process's liveness file for the daemon's sweep
//   daemon-spawn     — launching a daemon when discovery finds none
//   daemon-attach    — the one live attachment, with re-attach on loss
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendBuffered } from '../runtime/shared/buffered-appender.mjs';
import { ensurePrivateRuntimeRoot, resolveRuntimeRoot } from '../runtime/shared/runtime-root.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';
import { readChannelDiscovery } from './channel-client.mjs';
import { createClientHeartbeat, pruneStaleChannelClientHeartbeats } from './channel-worker/client-heartbeat.mjs';
import { createDaemonAttachment } from './channel-worker/daemon-attach.mjs';
import { daemonEnv, spawnDaemonCandidate } from './channel-worker/daemon-spawn.mjs';

export { pruneStaleChannelClientHeartbeats };

const CHANNEL_TOOLS = new Set(['activate_channel_bridge', 'reload_config', 'rebind_current_transcript']);
const CALL_RETRIES = 3;

function logLine(path, line) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendBuffered(path, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export function createStandaloneChannelWorker({
  rootDir,
  dataDir,
  cwd = process.cwd(),
  leadPid = null,
  getSessionId = () => null,
  onNotify,
} = {}) {
  if (!rootDir) throw new Error('channels runtime rootDir is required');
  if (!dataDir) throw new Error('channels runtime dataDir is required');

  const proxyId = randomUUID();
  let nextCallId = 1;
  let stopPromise = null;
  const logPath = join(dataDir, 'daemon.log');
  rotateBoundedLog(logPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
  const log = (line) => logLine(logPath, line);

  const runtimeDir = ensurePrivateRuntimeRoot(resolveRuntimeRoot());
  const heartbeat = createClientHeartbeat({ clientDir: join(runtimeDir, 'channel-clients'), cwd });
  heartbeat.start();

  // A session runtime may outlive the process that first spawned the machine
  // daemon. That process may be gone after daemon recovery, so callers that
  // own a live runtime can override the inherited identity.
  const daemonLeadPid = Number(leadPid) || Number(process.env.MIXDOG_SUPERVISOR_PID) || process.pid;
  const discoveryPath = join(runtimeDir, 'daemon.json');
  const attachment = createDaemonAttachment({
    discoverChannel: () => readChannelDiscovery(discoveryPath),
    spawnDaemon: () =>
      spawnDaemonCandidate({
        cwd,
        env: daemonEnv({ rootDir, dataDir, runtimeDir, leadPid: daemonLeadPid }),
        dataDir,
        log,
      }),
    leadPid: daemonLeadPid,
    cwd,
    getSessionId,
    onNotify,
    log,
  });

  function status() {
    return {
      running: Boolean(attachment.current()),
      pid: attachment.pid(),
      pending: 0,
      mode: 'daemon',
    };
  }

  function start() {
    if (stopPromise) return stopPromise.then(() => start());
    attachment.resume();
    heartbeat.start();
    return attachment.ensureAttached().then(() => status());
  }

  async function execute(name, args = {}, { timeoutMs = 120_000 } = {}) {
    if (!CHANNEL_TOOLS.has(name)) throw new Error(`unknown channel tool: ${name}`);
    await start();
    let lastError = null;
    // callId is stable across retries so the daemon dedups a retried transport
    // failure to a single side-effect.
    const callId = `ch_${proxyId}_${nextCallId++}`;
    for (let attempt = 0; attempt < CALL_RETRIES; attempt += 1) {
      const daemon = await attachment.ensureAttached();
      try {
        return await daemon.call(name, args || {}, { timeoutMs, callId });
      } catch (error) {
        if (!error?.daemonTransportError) throw error;
        lastError = error;
        attachment.invalidate('transport failure', daemon);
        await delay(200 * (attempt + 1));
      }
    }
    throw lastError || new Error('channel service call failed');
  }

  /** Resolves true when a live client was detached, false when there was none. */
  function stop(reason = 'standalone shutdown', options = {}) {
    attachment.requestStop();
    heartbeat.stop();
    if (stopPromise) return stopPromise;
    const { client, inFlightAttach } = attachment.detach();
    stopPromise = Promise.all([
      client
        ? client
            .close(reason, { preserveRemoteIntent: options.preserveRemoteIntent === true })
            .then(() => true)
            .catch(() => true)
        : Promise.resolve(false),
      Promise.resolve(inFlightAttach).catch(() => null),
    ])
      .then(([detached]) => detached)
      .finally(() => {
        stopPromise = null;
      });
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
