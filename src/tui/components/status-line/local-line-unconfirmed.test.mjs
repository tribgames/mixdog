import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-l2-unconfirmed-'));
process.env.MIXDOG_DATA_DIR = root;
const { shellJobsStatusFresh } = await import('../../../runtime/shared/statusline/statusline-segments.mjs');
const { localStatusLineL2 } = await import('./local-line.mjs');

test('the TUI status line shows a held shell as termination unconfirmed, not running', async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'shell-jobs');
  mkdirSync(dir, { recursive: true });
  const write = (jobId, record) => {
    writeFileSync(join(dir, `${jobId}.json`), JSON.stringify({ ownerSessionId: 'sess-l2', ...record }));
    writeFileSync(join(dir, `${jobId}.owner-${process.pid}`), '');
  };
  write(`job_${Date.now()}_run`, { pid: process.pid, command: 'npm run dev' });
  write(`job_${Date.now()}_held`, { pid: 2_147_483_646, command: 'node server.js', terminationUnconfirmed: true });
  const closedId = `job_${Date.now()}_closed`;
  // Its root is gone, but the incomplete snapshot cannot identify survivors.
  write(closedId, {
    pid: 2_147_483_645,
    command: 'vite',
    terminationUnconfirmed: true,
    ownerSessionClosed: true,
  });
  const status = await shellJobsStatusFresh({ clientHostPid: process.pid });
  assert.deepEqual(
    status.orphaned.map((job) => job.taskId),
    [closedId],
    'a closed session’s held shell is offered to every session that sees its folder'
  );
  const plain = localStatusLineL2({ sessionId: 'sess-l2', clientHostPid: process.pid }).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR colour codes
    /\u001b\[[0-9;]*m/g,
    ''
  );
  assert.match(plain, /Running 1 Shell\b/);
  assert.match(plain, /⚠ 2 Shells termination unconfirmed · \/shells/);
});
