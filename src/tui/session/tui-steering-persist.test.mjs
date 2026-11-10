// The TUI steering mirror and the runtime/manager pending-message spool share
// one per-session shard layout (session-pending/<key>.json). These tests pin
// that the one-time migration of the legacy global file is lossless for
// foreign rows — including the handoffAt/handoffPid parking stamp that lets
// accepted user input survive an owner crash — that a TUI operation touches
// only its own shard, and that sessions never contend on a shared lock.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-tui-steering-persist-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const { appendTuiSteeringPersist, dropTuiSteeringPersist, flushTuiSteeringPersist, readTuiSteeringPersist } =
  await import('./tui-steering-persist.mjs');

const spoolPath = join(dataDir, 'session-pending-messages.json');
const legacyPath = spoolPath;
const shardPath = (key) => join(dataDir, 'session-pending', `${key}.json`);
const readShard = (key) => JSON.parse(readFileSync(shardPath(key), 'utf8'));

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

test('a TUI steering append migrates the legacy spool and leaves foreign rows lossless', async () => {
  await appendTuiSteeringPersist('leadsessionone', { text: 'steer me' });
  await flushTuiSteeringPersist();

  // The legacy global file is kept as a renamed backup, never left in place.
  assert.equal(existsSync(legacyPath), false);
  assert.equal(
    readdirSync(dataDir).some((name) => name.startsWith('session-pending-messages.json.migrated-')),
    true
  );

  // Every field of every foreign row survives migration and the TUI write untouched.
  const foreign = readShard('sess_runtime_owner');
  assert.deepEqual(foreign.sessions.sess_runtime_owner, foreignRows);
  // A foreign session's touch stamp is carried, never refreshed by our write.
  assert.equal(foreign.sessionTouchedAt.sess_runtime_owner, OLD_AT);

  // The steering bucket lives in its own shard.
  const steering = readShard('tui_leadsessionone').sessions.tui_leadsessionone;
  assert.equal(Array.isArray(steering), true);
  assert.equal(steering.length, 1);
  assert.equal(steering[0].text, 'steer me');
});

test('a read touches only its own shard and keeps the rows until they are dropped', async () => {
  const foreignBefore = readFileSync(shardPath('sess_runtime_owner'), 'utf8');
  const restored = await readTuiSteeringPersist('leadsessionone');
  assert.deepEqual(
    restored.map((row) => row.text),
    ['steer me']
  );
  // A restart before the queue settles the row restores it again.
  assert.deepEqual(
    (await readTuiSteeringPersist('leadsessionone')).map((row) => row.steeringPersistId),
    restored.map((row) => row.steeringPersistId)
  );
  assert.equal(readFileSync(shardPath('sess_runtime_owner'), 'utf8'), foreignBefore);
  // Another lead session's stale bucket is the sweep's concern, not the read's.
  assert.equal(existsSync(shardPath('tui_staleother')), true);

  await dropTuiSteeringPersist('leadsessionone', restored);
  assert.equal(existsSync(shardPath('tui_leadsessionone')), false);
});

test('a row keeps the executable content and attachment links it was accepted with', async () => {
  const content = [
    { type: 'text', text: '[Image #1] what is this' },
    { type: 'image', ref: 'att_image_1', mimeType: 'image/png' },
  ];
  const entry = {
    id: 'desktop-submit-7',
    text: '[Image #1] what is this',
    content,
    pastedImages: { 1: { id: 1, ref: 'att_image_1' } },
    pastedTexts: { 2: { id: 2, ref: 'att_text_2' } },
    transcriptMeta: { device: 'Laptop', attachments: [{ kind: 'image', ref: 'att_image_1' }] },
    priority: 'now',
    onCommitted: () => {},
  };
  const appending = appendTuiSteeringPersist('attachlead', entry);
  // An edit of the live entry after acceptance never reaches the stored row.
  content[0].text = 'edited later';
  await appending;
  const [row] = await readTuiSteeringPersist('attachlead');
  assert.equal(row.submissionId, 'desktop-submit-7');
  assert.deepEqual(row.content, [
    { type: 'text', text: '[Image #1] what is this' },
    { type: 'image', ref: 'att_image_1', mimeType: 'image/png' },
  ]);
  assert.deepEqual(row.pastedImages, entry.pastedImages);
  assert.deepEqual(row.pastedTexts, entry.pastedTexts);
  assert.deepEqual(row.transcriptMeta, entry.transcriptMeta);
  assert.equal(row.priority, 'now');
  assert.equal(Object.hasOwn(row, 'onCommitted'), false);
});

test('a row of an older build gets one durable id on its first read', async () => {
  mkdirSync(join(dataDir, 'session-pending'), { recursive: true });
  const at = Date.now();
  writeFileSync(
    shardPath('tui_legacylead'),
    JSON.stringify({
      version: 1,
      updatedAt: at,
      sessions: { tui_legacylead: ['plain legacy row', { text: 'idless legacy row', at }] },
      sessionTouchedAt: { tui_legacylead: at },
    })
  );
  const first = await readTuiSteeringPersist('legacylead');
  assert.deepEqual(
    first.map((row) => row.text),
    ['plain legacy row', 'idless legacy row']
  );
  assert.ok(first.every((row) => typeof row.steeringPersistId === 'string' && row.steeringPersistId));
  const again = await readTuiSteeringPersist('legacylead');
  assert.deepEqual(
    again.map((row) => row.steeringPersistId),
    first.map((row) => row.steeringPersistId)
  );
  await dropTuiSteeringPersist('legacylead', [first[0]]);
  assert.deepEqual(
    (await readTuiSteeringPersist('legacylead')).map((row) => row.text),
    ['idless legacy row']
  );
});

test('steering operations of different sessions never contend on one lock', async () => {
  const held = `${shardPath('tui_blockedlead')}.lock`;
  mkdirSync(join(dataDir, 'session-pending'), { recursive: true });
  // A live holder (our pid, foreign token) on one session's shard lock.
  writeFileSync(held, `${process.pid} ${Date.now()} deadbeefdeadbeefdeadbeef\n`, 'utf8');
  try {
    const startedAt = Date.now();
    await appendTuiSteeringPersist('freelead', { text: 'unblocked' });
    await flushTuiSteeringPersist();
    assert.ok(Date.now() - startedAt < 1500);
    assert.equal(readShard('tui_freelead').sessions.tui_freelead[0].text, 'unblocked');
  } finally {
    rmSync(held, { force: true });
  }
});
