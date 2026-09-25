// Forking one machine-daemon candidate — the step both launchers (the session
// client and the channel worker) share. fd 2 is a crash-capture FILE, not a
// pipe: a V8 fatal abort (heap OOM) is written by the runtime below every JS
// hook, and a pipe dies with its launcher. The exit listener outlives the
// ready handoff so the daemon's code/signal is recorded against its pid, boot
// time and ready state. Resolves once the candidate reported ready, exited,
// failed to spawn, or the timeout elapsed; the caller then re-reads discovery
// and attaches to whoever won.
import { fork } from 'node:child_process';
import { beginDaemonSpawnCapture } from './daemon-crash-capture.mjs';

export function forkDaemonCandidate({
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
      resolve();
    };
    let child;
    try {
      child = fork(entry, [], {
        cwd,
        execArgv,
        stdio: ['ignore', 'ignore', capture.stderrStdio, 'ipc'],
        env,
        ...spawnOptions,
      });
    } catch (error) {
      capture.noteSpawnError(error);
      log(`daemon spawn failed: ${error?.message || error}`);
      done();
      return;
    }
    onForked?.(child);
    capture.track(child, { detached, execArgv });
    child.once('message', (message) => {
      if (message?.type !== 'ready') return;
      capture.noteReady();
      onReady?.();
      try {
        child.disconnect?.();
      } catch {}
      try {
        child.unref?.();
      } catch {}
      try {
        child.stderr?.unref?.();
      } catch {}
      done();
    });
    child.once('exit', done);
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
