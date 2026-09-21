// session-pending-messages.json is SHARED between the TUI steering mirror and
// the runtime/manager pending-message spool. Every TUI write passes the whole
// store through normalizePendingStore, so these tests pin the invariant that a
// TUI write is lossless for foreign rows — including the handoffAt/handoffPid
// parking stamp that lets accepted user input survive an owner crash — and
// that orphan cleanup only reaps TUI-owned (`tui_`) buckets.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-tui-steering-persist-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { appendTuiSteeringPersist, drainTuiSteeringPersist, flushTuiSteeringPersist } = await import(
  './tui-steering-persist.mjs'
);

const spoolPath = join(dataDir, 'session-pending-messages.json');
const readSpool = () => JSON.parse(readFileSync(spoolPath, 'utf8'));

// Older than the TUI restore TTL (30m) and than the runtime orphan window, so
// the pre-fix orphan sweep would have reaped this whole bucket.
const OLD_AT = Date.now() - 10 * 24 * 60 * 60 * 1000;
// Runtime-shaped rows: a parked structured row (handoffAt/handoffPid +
// content array + options) and a completion-notification row.
const foreignRows = [
  {
    id: 'pm_structured_1',
    content: [
      { type: 'text', text: 'look at this shot' },
      { type: 'image', data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png' },
    ],
    text: 'look at this shot',
    enqueuedAt: OLD_AT,
    handoffAt: OLD_AT,
    handoffPid: 4242,
    options: { mode: 'user', priority: 'next', displayText: 'look at this shot' },
  },
  {
    id: 'pm_notification_2',
    message: 'agent task finished',
    enqueuedAt: OLD_AT,
    notificationKind: 'completion_notification',
    executionId: 'exec_7',
  },
];

writeFileSync(
  spoolPath,
  `${JSON.stringify(
    {
      version: 1,
      updatedAt: OLD_AT,
      sessions: {
        sess_runtime_owner: foreignRows,
        tui_staleother: [{ id: 'ts_old', text: 'old steering', at: OLD_AT }],
      },
      sessionTouchedAt: { sess_runtime_owner: OLD_AT, tui_staleother: OLD_AT },
    },
    null,
    2
  )}\n`,
  { mode: 0o600 }
);

test.after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

test('a TUI steering append round-trips foreign runtime spool rows losslessly', async () => {
  await appendTuiSteeringPersist('leadsessionone', { text: 'steer me' });
  await flushTuiSteeringPersist();

  const store = readSpool();
  // Every field of every foreign row survives the TUI write untouched.
  assert.deepEqual(store.sessions.sess_runtime_owner, foreignRows);
  // A foreign session's touch stamp is carried, never refreshed by our write.
  assert.equal(store.sessionTouchedAt.sess_runtime_owner, OLD_AT);

  const steering = store.sessions.tui_leadsessionone;
  assert.equal(Array.isArray(steering), true);
  assert.equal(steering.length, 1);
  assert.equal(steering[0].text, 'steer me');
});

test('drain reaps only stale tui_ buckets and leaves foreign spool rows in place', async () => {
  const drained = await drainTuiSteeringPersist('leadsessionone');
  assert.deepEqual(
    drained.map((row) => row.text),
    ['steer me']
  );

  const store = readSpool();
  assert.deepEqual(store.sessions.sess_runtime_owner, foreignRows);
  assert.equal(store.sessionTouchedAt.sess_runtime_owner, OLD_AT);
  // Own bucket drained, other TUI lead session's stale bucket pruned.
  assert.equal(store.sessions.tui_leadsessionone, undefined);
  assert.equal(store.sessions.tui_staleother, undefined);
  assert.equal(store.sessionTouchedAt.tui_staleother, undefined);
});
