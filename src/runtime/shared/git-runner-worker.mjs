// Worker-thread body for git-runner.mjs. Starting a child process is a
// synchronous native call (CreateProcess on Windows, amplified by on-access
// scanning), so git children are spawned here instead of on the host event
// loop. Each request resolves to { code, stdout, stderr } or an error with the
// same codes the in-process runner used (ETIMEDOUT, EMAXBUFFER, spawn errors).
import { spawn } from 'node:child_process';
import { serveWorkerRequests } from './worker-requests.mjs';

function runGit({ args, cwd, input, env, timeoutMs, maxBytes }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasInput = (typeof input === 'string' || ArrayBuffer.isView(input)) && input.length > 0;
    const child = spawn('git', args, {
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
    const timer = setTimeout(() => {
      const error = new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      try {
        child.kill();
      } catch {}
      finish(error);
    }, timeoutMs);
    const collect = (chunks, chunk) => {
      const next = Buffer.from(chunk);
      outputBytes += next.length;
      if (outputBytes > maxBytes) {
        const error = new Error(`git ${args.join(' ')} exceeded ${maxBytes} output bytes`);
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
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      // A failed stdin write only matters when git otherwise reported success.
      if (stdinError && result.code === 0) {
        finish(stdinError);
        return;
      }
      finish(null, result);
    });
    if (child.stdin) {
      // A short-lived git command can close before stdin is flushed. Keep
      // that transport race inside this promise instead of an unhandled EPIPE.
      child.stdin.on('error', (error) => {
        stdinError = error;
      });
      child.stdin.end(input);
    }
  });
}

serveWorkerRequests(runGit);
