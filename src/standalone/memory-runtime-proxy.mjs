// Standalone memory-runtime proxy: one loopback HTTP daemon per machine,
// forked by whichever proxy wins the singleton claim and shared by every
// other client. The phases live under memory-runtime-proxy/ and share one
// explicit state object (port cache, in-flight start, owned child, crash
// cache, registration).
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSingletonOwner } from '../runtime/shared/singleton-owner.mjs';
import { parsePid } from '../runtime/shared/pid-liveness.mjs';
import { rotateBoundedLog, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';
import { createMemoryProxyState } from './memory-runtime-proxy/state.mjs';
import { createDaemonDiscovery } from './memory-runtime-proxy/discovery.mjs';
import { createOwnerClaim } from './memory-runtime-proxy/owner-claim.mjs';
import { createDaemonSpawner, releaseChildHandle } from './memory-runtime-proxy/daemon-spawn.mjs';
import { createDaemonStarter } from './memory-runtime-proxy/start.mjs';
import { createClientRegistry } from './memory-runtime-proxy/client-registry.mjs';
import { createMemoryCalls } from './memory-runtime-proxy/calls.mjs';

function awaitChildExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveExit(true);
      else rejectExit(new Error(`memory runtime exited unsuccessfully (${signal || code || 'unknown'})`));
    };
    const timer = setTimeout(
      () => {
        child.off('exit', onExit);
        rejectExit(new Error(`memory runtime did not exit within ${timeoutMs}ms`));
      },
      Math.max(1, Number(timeoutMs) || 10_000)
    );
    child.once('exit', onExit);
  });
}

function createStandaloneMemoryRuntime({ entry, dataDir, cwd = process.cwd() } = {}) {
  if (!entry) throw new Error('memory runtime entry is required');
  if (!dataDir) throw new Error('memory runtime dataDir is required');

  const logPath = join(dataDir, 'memory-runtime-proxy.log');
  // One-shot bound at own-process boot: this runtime may never pass through
  // the channels-worker rotation path, so cap the log writer-side.
  rotateBoundedLog(logPath, PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES);
  const ownerPath = join(dataDir, 'memory-runtime-owner.json');
  const singletonEnabled = process.env.MIXDOG_MEMORY_SINGLETON !== '0';
  const idleTtlMs = Math.max(0, Number(process.env.MIXDOG_MEMORY_IDLE_TTL_MS) || 10 * 60_000);

  const state = createMemoryProxyState();
  const discovery = createDaemonDiscovery({ state, ownerPath, singletonEnabled });
  const ownerClaim = createOwnerClaim({ ownerPath, singletonEnabled, cwd, discovery });
  const spawner = createDaemonSpawner({ state, entry, dataDir, cwd, idleTtlMs, logPath, ownerClaim, discovery });
  const start = createDaemonStarter({ state, ownerPath, singletonEnabled, discovery, ownerClaim, spawner });
  const registry = createClientRegistry({ state, start });
  const calls = createMemoryCalls({ state, cwd, start, discovery, registry });

  // Deregister this client so a shared daemon can reap itself once no clients
  // remain, then detach. The daemon is never hard-killed here — another
  // tab/session may still be using it.
  async function stop({ waitForExit = false, timeoutMs = 10_000 } = {}) {
    const ownedChild = state.child;
    const childExit =
      waitForExit && ownedChild && ownedChild.exitCode == null ? awaitChildExit(ownedChild, timeoutMs) : null;
    await registry.deregisterClient();
    if (childExit) await childExit;
    releaseChildHandle(state.child);
    state.child = null;
    return true;
  }

  async function status() {
    const port = await discovery.findLivePort();
    const owner = readSingletonOwner(ownerPath);
    return {
      running: Boolean(port),
      port,
      mode: 'http-proxy',
      ownerPid: parsePid(owner.owner?.pid),
      ownerAlive: owner.alive,
    };
  }

  return {
    init: calls.retain,
    retain: calls.retain,
    start,
    stop,
    status,
    handleToolCall: calls.handleToolCall,
    buildSessionCoreMemoryPayload: calls.buildSessionCoreMemoryPayload,
    appendEntry: calls.appendEntry,
    ingestTranscript: calls.ingestTranscript,
    recordTraceEvents: calls.recordTraceEvents,
    moduleUrl: pathToFileURL(entry).href,
  };
}

const sharedMemoryRuntimes = new Map();

export function getStandaloneMemoryRuntime(options = {}) {
  const entry = options.entry ? resolve(options.entry) : '';
  const dataDir = options.dataDir ? resolve(options.dataDir) : '';
  const key = `${entry}\0${dataDir}`;
  let runtime = sharedMemoryRuntimes.get(key);
  if (!runtime) {
    runtime = createStandaloneMemoryRuntime(options);
    sharedMemoryRuntimes.set(key, runtime);
  }
  return runtime;
}

export async function stopStandaloneMemoryRuntimesForProcess(options = {}) {
  const failures = [];
  let stopped = 0;
  for (const [key, runtime] of [...sharedMemoryRuntimes]) {
    try {
      await runtime.stop(options);
      if (sharedMemoryRuntimes.get(key) === runtime) sharedMemoryRuntimes.delete(key);
      stopped += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'memory runtimes failed to stop');
  }
  return stopped;
}
