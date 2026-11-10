import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneStaleChannelClientHeartbeats } from '../session-runtime/services/channel-worker.mjs';
import { createClientHeartbeat } from '../session-runtime/services/channel-worker/client-heartbeat.mjs';

test('channel client sweep removes rows whose pid is dead or unreadable, whatever their age', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-channel-heartbeat-test-'));
  try {
    writeFileSync(join(root, '1.json'), JSON.stringify({ pid: 1, updatedAt: 1 }));
    writeFileSync(join(root, '2.json'), JSON.stringify({ pid: 2 }));
    writeFileSync(join(root, '3.json'), JSON.stringify({ pid: 3, updatedAt: Date.now() }));
    writeFileSync(join(root, '4.json'), 'not json');

    const removed = pruneStaleChannelClientHeartbeats(root, { pidAlive: (pid) => pid !== 3 });

    assert.equal(removed, 2);
    assert.equal(existsSync(join(root, '1.json')), true);
    assert.equal(existsSync(join(root, '2.json')), true);
    assert.equal(existsSync(join(root, '3.json')), false);
    assert.equal(existsSync(join(root, '4.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a client file is written once, is never rewritten on a timer, and outlives all but the last holder', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-channel-heartbeat-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intervals = t.mock.method(globalThis, 'setInterval');
  const file = join(root, `${process.pid}.json`);
  const first = createClientHeartbeat({ clientDir: root, cwd: '/a' });
  const second = createClientHeartbeat({ clientDir: root, cwd: '/b' });
  first.start();
  second.start();
  assert.equal(intervals.mock.callCount(), 0, 'no periodic rewrite');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  first.stop();
  assert.equal(existsSync(file), true, 'another runtime of this process still holds it');
  second.stop();
  assert.equal(existsSync(file), false);
});
