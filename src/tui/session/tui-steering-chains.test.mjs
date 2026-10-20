// Per-session steering persistence chains: sessions must not wait on each
// other, ordering holds within a session, flush awaits all, idle keys release.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-tui-steering-chain-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  appendTuiSteeringPersist,
  readTuiSteeringPersist,
  dropTuiSteeringPersist,
  flushTuiSteeringPersist,
  _steeringPersistChainCount,
} = await import('./tui-steering-persist.mjs');
const { withFileLock } = await import('../../runtime/shared/atomic-file.mjs');
const { pendingMessagesPath } = await import('../../runtime/agent/orchestrator/session/manager/pending-spool-path.mjs');

test.after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

const pending = (p) => {
  let done = false;
  p.then(() => {
    done = true;
  });
  return () => done;
};
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('a blocked session does not delay another; flush awaits all; keys released', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const held = withFileLock(`${pendingMessagesPath('tui_slowA')}.lock`, () => gate);
  await tick(50);

  const a = appendTuiSteeringPersist('slowA', { text: 'a1' });
  const aDone = pending(a);
  const b = appendTuiSteeringPersist('fastB', { text: 'b1' });
  await b;
  await tick();
  assert.equal(aDone(), false, 'A still blocked while B acknowledged');
  assert.equal(_steeringPersistChainCount(), 1);

  const flush = flushTuiSteeringPersist();
  const flushDone = pending(flush);
  await tick();
  assert.equal(flushDone(), false, 'flush waits for blocked session');

  release();
  await held;
  await flush;
  assert.equal(aDone(), true);
  assert.equal(_steeringPersistChainCount(), 0);
});

test('per-session order: append -> drop -> read', async () => {
  const e1 = { text: 'one' };
  const e2 = { text: 'two' };
  const p = [
    appendTuiSteeringPersist('ordS', e1),
    appendTuiSteeringPersist('ordS', e2),
    dropTuiSteeringPersist('ordS', [e1]),
    readTuiSteeringPersist('ordS'),
  ];
  const results = await Promise.all(p);
  assert.deepEqual(
    results[3].map((r) => r.text),
    ['two']
  );
  await flushTuiSteeringPersist();
  assert.equal(_steeringPersistChainCount(), 0);
});
