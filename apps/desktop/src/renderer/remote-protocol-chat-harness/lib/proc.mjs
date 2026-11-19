import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { latch } from './deadline.mjs';

/**
 * Spawns a process and keeps the last lines of its output for the hang report. `exited` resolves with
 * { code, signal } on exit. `onLine(stream, line)` sees every complete output line.
 */
export function launch(command, args, { env, cwd, onLine = () => {} } = {}) {
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const tail = [];
  const exited = latch();
  const feed = (stream) => {
    let pending = '';
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      pending += chunk;
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        tail.push(`[${stream}] ${line}`);
        if (tail.length > 40) tail.shift();
        if (process.env.HARNESS_DAEMON_LOG) appendFileSync(process.env.HARNESS_DAEMON_LOG, `[${Date.now()}] ${line}\n`);
        onLine(stream, line);
      }
    });
  };
  feed('stdout');
  feed('stderr');
  child.once('error', (error) => exited.reject(error));
  child.once('exit', (code, signal) => exited.resolve({ code, signal }));
  return {
    child,
    pid: child.pid,
    exited: exited.promise,
    tail: () => tail.join('\n') || '(no output)',
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}
