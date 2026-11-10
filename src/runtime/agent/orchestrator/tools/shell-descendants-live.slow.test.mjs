import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { probeShellDescendants } from './lib/shell-descendants.mjs';

test('Windows observes a surviving child even when its stdio is ignored', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const root = spawn(
    process.execPath,
    [
      '-e',
      `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore'
    });
    child.unref();
    process.send(child.pid, () => process.exit(0));
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  const exited = once(root, 'exit');
  const [pid] = await once(root, 'message');
  try {
    await exited;
    process.kill(pid, 0);
    const observed = await probeShellDescendants({ pid: root.pid });
    assert.ok(observed?.watchPids.includes(pid));
  } finally {
    process.kill(pid);
  }
});
