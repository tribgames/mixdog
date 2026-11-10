import { spawn } from 'node:child_process';

/**
 * Async child run with spawnSync's result shape ({ status, signal, stdout,
 * stderr, error }) so the PG runtime's tar / initdb / pg_ctl steps never block
 * the event loop of the process hosting them (the daemon serves every client
 * from one loop). `timeoutMs` > 0 kills the child and reports ETIMEDOUT, like
 * spawnSync's `timeout`. Never rejects.
 */
export function runChild(file, args, { timeoutMs = 0, ...options } = {}) {
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timer = null;
    let error = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error });
    };
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnError) {
      error = spawnError;
      finish(null, null);
      return;
    }
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (childError) => {
      error ??= childError;
      finish(null, null);
    });
    // 'close' (not 'exit'): stdio is flushed, so captured output is complete.
    child.once('close', (status, signal) => finish(status, signal));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        error = Object.assign(new Error(`${file} timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' });
        try {
          child.kill();
        } catch {}
        finish(null, 'SIGTERM');
      }, timeoutMs);
    }
  });
}
