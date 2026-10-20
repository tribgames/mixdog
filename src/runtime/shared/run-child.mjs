// One child process run to completion, its output collected — the body of
// the off-thread runners (git-runner-worker.mjs, process-runner-worker.mjs).
// Starting a child process is a synchronous native call (CreateProcess on
// Windows, amplified by on-access scanning and seconds long under load), so
// those workers spawn here instead of on the host event loop.
// Resolves to { code, stdout, stderr }; rejects with code ETIMEDOUT after
// timeoutMs (the child is killed), EMAXBUFFER once stdout+stderr exceed
// maxBytes, or the spawn error itself.
import { spawn } from 'node:child_process';

/** Kills `child` with everything it started. On Windows a plain kill ends only
 *  the child itself: `git` there is a launcher whose git.exe (and the alias,
 *  hook or filter it runs) would live on, still holding the output pipes. */
export function killChildTree(child) {
  if (process.platform === 'win32' && child.pid && child.exitCode === null) {
    const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
    const fallback = () => {
      try {
        child.kill();
      } catch {}
    };
    spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .once('error', fallback)
      .once('exit', (code) => {
        if (code !== 0) fallback();
      });
    return;
  }
  try {
    child.kill();
  } catch {}
}

export function runChild({ command, args, cwd, input, env, timeoutMs, maxBytes, stdoutEncoding = 'utf8' }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasInput = (typeof input === 'string' || ArrayBuffer.isView(input)) && input.length > 0;
    const child = spawn(command, args, {
      cwd,
      ...(env ? { env } : {}),
      windowsHide: true,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let stdinError = null;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    // timeoutMs 0: no deadline (the caller's own work bounds the child).
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            const error = new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            killChildTree(child);
            finish(error);
          }, timeoutMs)
        : null;
    const collect = (chunks, chunk) => {
      const next = Buffer.from(chunk);
      outputBytes += next.length;
      if (outputBytes > maxBytes) {
        const error = new Error(`${command} ${args.join(' ')} exceeded ${maxBytes} output bytes`);
        error.code = 'EMAXBUFFER';
        try {
          child.kill();
        } catch {}
        finish(error);
        return;
      }
      chunks.push(next);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const result = {
        code: Number(code ?? 1),
        // 'base64' keeps non-UTF-8 bytes (a replayable patch) intact across the thread hop.
        stdout: Buffer.concat(stdout).toString(stdoutEncoding === 'base64' ? 'base64' : 'utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      // A failed stdin write only matters when the child otherwise reported success.
      if (stdinError && result.code === 0) {
        finish(stdinError);
        return;
      }
      finish(null, result);
    });
    if (child.stdin) {
      // A short-lived child can close before stdin is flushed. Keep that
      // transport race inside this promise instead of an unhandled EPIPE.
      child.stdin.on('error', (error) => {
        stdinError = error;
      });
      child.stdin.end(input);
    }
  });
}
