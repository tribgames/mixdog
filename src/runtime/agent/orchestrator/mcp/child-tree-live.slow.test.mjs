import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { collectDescendantProcesses } from './child-tree.mjs';

test('strict OS enumeration sees a known live child', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const descendants = await collectDescendantProcesses(process.pid, { strict: true });
    assert.ok(
      descendants.some((row) => row.pid === child.pid),
      'the independently spawned child must be observed'
    );
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});
