// closeSession's durable-barrier verdict: a record that is legitimately gone
// (never saved, or already deleted) is a clean close, while a barrier that
// really failed still reports failure and leaves the runtime intact.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-close-barrier-'));
process.env.MIXDOG_DATA_DIR = root;

const { closeSession } = await import('./session-close.mjs');
const { saveSessionAsync, deleteSession, loadSession, markSessionClosed, bumpSessionGeneration } = await import(
  '../store.mjs'
);
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { flushSessionCloseMetrics } = await import('../store/lifecycle-barriers.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await flushSessionCloseMetrics();
  rmSync(root, { recursive: true, force: true });
});

function captureStderr() {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return original.call(this, chunk, ...rest);
  };
  return {
    failures: () => lines.filter((line) => line.includes('FAILED durable lifecycle barrier')),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

const session = (id) => ({
  id,
  owner: 'agent',
  agent: 'worker',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: 'hello' }],
});

test('the barriers report an absent record through options.outcome', () => {
  const closeOutcome = { absent: false };
  assert.equal(markSessionClosed('sess_barrier_absent_mark', 'test', { outcome: closeOutcome }), null);
  assert.equal(closeOutcome.absent, true);
  const bumpOutcome = { absent: false };
  assert.equal(bumpSessionGeneration('sess_barrier_absent_bump', 'test', { outcome: bumpOutcome }), null);
  assert.equal(bumpOutcome.absent, true);
});

test('closing a session whose record never existed is a clean close, not a barrier failure', () => {
  const stderr = captureStderr();
  try {
    assert.equal(closeSession('sess_close_never_saved', 'cli-agent-close'), true);
    assert.equal(closeSession('sess_close_never_saved_detach', 'cli-agent-close', { tombstone: false }), true);
  } finally {
    stderr.restore();
  }
  assert.deepEqual(stderr.failures(), []);
});

test('closing an agent whose record was already deleted succeeds without a failure line', async () => {
  const id = 'sess_close_already_deleted';
  await saveSessionAsync(session(id));
  assert.equal(deleteSession(id), true);
  const stderr = captureStderr();
  try {
    assert.equal(closeSession(id, 'cli-agent-close'), true);
  } finally {
    stderr.restore();
  }
  assert.deepEqual(stderr.failures(), []);
  assert.equal(loadSession(id), null, 'the close never resurrects the deleted record');
});

test('re-closing an already tombstoned session stays a clean close', async () => {
  const id = 'sess_close_twice';
  await saveSessionAsync(session(id));
  assert.equal(closeSession(id, 'cli-agent-close'), true);
  const stderr = captureStderr();
  try {
    assert.equal(closeSession(id, 'cli-agent-close'), true);
  } finally {
    stderr.restore();
  }
  assert.deepEqual(stderr.failures(), []);
  assert.equal(loadSession(id)?.closed, true);
});

test('explicit deletion replaces automatic-close provenance without resetting its fence or age', async () => {
  for (const owner of ['user', 'agent']) {
    const id = `sess_delete_historical_${owner}`;
    await saveSessionAsync({ ...session(id), owner });
    const generation = markSessionClosed(id, 'idle-sweep');
    const closedAt = loadSession(id).updatedAt;
    assert.equal(markSessionClosed(id, 'desktop-session-delete'), generation);
    const deleted = loadSession(id);
    assert.equal(deleted.closedReason, 'desktop-session-delete');
    assert.equal(deleted.closed, true);
    assert.equal(deleted.updatedAt, closedAt);
    assert.equal(deleted.generation, generation);
  }
});

test('a barrier that really failed is still reported and the close is refused', () => {
  const id = 'sess_close_foreign_bytes';
  mkdirSync(join(root, 'sessions'), { recursive: true });
  // Another session's record renamed onto this path: the barrier must refuse it.
  writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify({ id: 'sess_someone_else', messages: [] }));
  const stderr = captureStderr();
  try {
    assert.equal(closeSession(id, 'cli-agent-close'), false);
  } finally {
    stderr.restore();
  }
  assert.equal(stderr.failures().length, 1);
  assert.match(stderr.failures()[0], new RegExp(`session=${id} `));
});
