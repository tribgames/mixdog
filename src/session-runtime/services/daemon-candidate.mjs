// Starting one machine-daemon candidate — the step both launchers (the session
// client and the channel worker) share. The candidate runs under its own
// supervisor (native/mixdog-supervisor), which outlives this launcher, kills
// and replaces the daemon when its main thread stays frozen past the freeze
// limit, and takes the daemon down with it however it ends. The supervisor
// reports "spawned <pid>" and "ready" on its stdout, and exits with the
// daemon's status when the daemon ends on its own.
// fd 2 is a crash-capture FILE, not a pipe: a V8 fatal abort (heap OOM) is
// written by the runtime below every JS hook, and a pipe dies with its
// launcher; supervisor and daemons share it. The exit listener outlives the
// ready handoff so each daemon's code/signal is recorded against its own pid,
// boot time and ready state, replacements included. Resolves once the candidate reported ready, exited,
// failed to spawn, or the timeout elapsed; the caller then re-reads discovery
// and attaches to whoever won. The resolved `summary()` describes this boot as
// observed when called, for a caller that has to give up.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureSupervisorBinary,
  findCachedSupervisorBinary,
} from '../../runtime/agent/orchestrator/tools/supervisor-binary-fetcher.mjs';
import { withEnvProxy } from '../../runtime/shared/llm/http-agent.mjs';
import { NATIVE_TOOL_FILENAMES, packageNativeToolPath } from '../../runtime/shared/native-tool-paths.mjs';
import { beginDaemonSpawnCapture, daemonDataDir } from './daemon-crash-capture.mjs';

const LOCAL_SUPERVISOR_BUILD = fileURLToPath(
  new URL(`../../../native/mixdog-supervisor/target/release/${NATIVE_TOOL_FILENAMES.supervisor}`, import.meta.url)
);

/** The supervisor binary, resolved like every native tool: an explicit
 *  override (the desktop's bundled copy), a source checkout's release build,
 *  the package's installed copy, then the verified download cache. */
export function installedSupervisorBinary(dataDir) {
  const explicit = String(process.env.MIXDOG_SUPERVISOR_BIN || '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (existsSync(LOCAL_SUPERVISOR_BUILD)) return LOCAL_SUPERVISOR_BUILD;
  const installed = packageNativeToolPath('supervisor');
  if (existsSync(installed)) return installed;
  return findCachedSupervisorBinary(dataDir);
}

/** A daemon whose main thread answers no ping for this long is killed and
 *  replaced. MIXDOG_DAEMON_FREEZE_LIMIT_MS may only shorten it (tests). */
export const DAEMON_FREEZE_LIMIT_MS = 120_000;

export function daemonFreezeLimitMs(env = process.env) {
  const configured = Number(env.MIXDOG_DAEMON_FREEZE_LIMIT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(DAEMON_FREEZE_LIMIT_MS, Math.max(1000, Math.round(configured)))
    : DAEMON_FREEZE_LIMIT_MS;
}

export async function forkDaemonCandidate(options) {
  const dataDir = options.dataDir || daemonDataDir();
  let supervisor = installedSupervisorBinary(dataDir);
  let unavailable = null;
  if (!supervisor) {
    try {
      supervisor = await ensureSupervisorBinary(dataDir);
    } catch (error) {
      unavailable = error;
    }
  }
  return launchCandidate({ ...options, supervisor, unavailable });
}

function launchCandidate({
  supervisor,
  unavailable,
  launcher,
  entry,
  cwd,
  env,
  execArgv,
  spawnOptions = {},
  detached,
  dataDir = null,
  log,
  timeoutMs,
  onForked = null,
  onSpawned = null,
  onReady = null,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const capture = beginDaemonSpawnCapture({ launcher, dataDir, log });
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Boot diagnostics written to fd 2 reach this log exactly once, even when
      // the candidate never reached ready.
      capture.mirror();
      resolve({ summary: capture.summary });
    };
    let child;
    try {
      if (unavailable) throw unavailable;
      child = spawn(
        supervisor,
        [
          '--freeze-limit-ms',
          String(daemonFreezeLimitMs(env)),
          '--log',
          join(dataDir || daemonDataDir(), 'daemon.log'),
          '--',
          process.execPath,
          ...execArgv,
          entry,
        ],
        {
          cwd,
          stdio: ['ignore', 'pipe', capture.stderrStdio],
          // Proxy variables (the user's or the desktop's system proxy) need
          // NODE_USE_ENV_PROXY to reach the daemon's fetch.
          env: withEnvProxy(env),
          ...spawnOptions,
        }
      );
    } catch (error) {
      capture.noteSpawnError(error);
      log(`daemon spawn failed: ${error?.message || error}`);
      done();
      return;
    }
    onForked?.(child);
    // The capture follows the daemon the supervisor runs now: its first pid,
    // then each replacement's (noteReplaced). The supervisor's exit is that
    // daemon's (same code, same signal).
    const daemon = { pid: null, once: (name, listener) => child.once(name, listener), stderr: child.stderr };
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        const spawned = /^spawned (\d+)$/.exec(line);
        if (spawned) {
          const pid = Number(spawned[1]);
          onSpawned?.(pid);
          if (daemon.pid) {
            capture.noteReplaced(pid);
            continue;
          }
          daemon.pid = pid;
          capture.track(daemon, { detached, execArgv });
        } else if (line === 'ready') {
          capture.noteReady();
          if (settled) continue;
          onReady?.();
          // Still read, unreferenced, for as long as this launcher lives: every
          // replacement is recorded against its own pid.
          child.stdout.unref?.();
          try {
            child.unref?.();
          } catch {}
          try {
            child.stderr?.unref?.();
          } catch {}
          done();
        }
      }
    });
    child.once('exit', (code, signal) => {
      // A supervisor that ended before starting a daemon (bad arguments, no
      // lifetime binding, spawn failure) is the boot's whole outcome.
      if (!daemon.pid) capture.noteExit({ code, signal });
      done();
    });
    child.once('error', (error) => {
      // An async spawn failure may never emit 'exit'; the sidecar still gets it.
      capture.noteSpawnError(error);
      log(`daemon spawn error: ${error?.message || error}`);
      done();
    });
    timer = setTimeout(done, Math.max(1, timeoutMs));
    timer.unref?.();
  });
}
