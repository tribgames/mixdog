import assert from 'node:assert/strict';
import test from 'node:test';
import { localStatusLineL2 } from './local-line.mjs';

test('the TUI status line shows a held shell as termination unconfirmed, not running', () => {
  const now = Date.now();
  // The thread's strip as the core publishes it: the running job and two held with their termination unconfirmed.
  const shellJobs = {
    count: 3,
    elapsedLabel: '',
    jobs: [
      { taskId: 'job_run', command: 'npm run dev', cwd: '', startedAt: now - 5_000 },
      { taskId: 'job_held', command: 'node server.js', cwd: '', startedAt: now - 4_000, terminationUnconfirmed: true },
      { taskId: 'job_closed', command: 'vite', cwd: '', startedAt: now - 3_000, terminationUnconfirmed: true },
    ],
    finished: [],
  };
  const plain = localStatusLineL2({ shellJobs }, now).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR colour codes
    /\u001b\[[0-9;]*m/g,
    ''
  );
  assert.match(plain, /Running 1 Shell\b/);
  assert.match(plain, /⚠ 2 Shells termination unconfirmed · \/shells/);
});
