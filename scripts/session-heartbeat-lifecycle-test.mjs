import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalDataDir = process.env.MIXDOG_DATA_DIR;
const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-heartbeat-lifecycle-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  deleteHeartbeat,
  listSessionHeartbeatMtimes,
  publishHeartbeat,
} = await import('../src/runtime/agent/orchestrator/session/store/paths-heartbeat.mjs');
const {
  _clearSessionRuntime,
  _getRuntimeEntry,
  markSessionAskStart,
  markSessionDone,
  markSessionStreamDelta,
  markSessionToolCall,
  markSessionTransportActivity,
} = await import('../src/runtime/agent/orchestrator/session/manager/runtime-liveness.mjs');

const heartbeatPath = (id) => join(dataDir, 'sessions', `${id}.hb`);

after(async () => {
  if (originalDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

test('heartbeat deletion wins over an already queued write', async () => {
  const id = `heartbeat_delete_race_${Date.now()}`;
  const write = publishHeartbeat(id, Date.now());
  const deletion = deleteHeartbeat(id);
  await Promise.all([write, deletion]);

  assert.equal(existsSync(heartbeatPath(id)), false);
  assert.equal(listSessionHeartbeatMtimes().has(id), false);

  await publishHeartbeat(id, Date.now() + 10_000);
  assert.equal(existsSync(heartbeatPath(id)), true, 'a later real turn can publish again');
  await deleteHeartbeat(id);
  assert.equal(existsSync(heartbeatPath(id)), false);
});

test('terminal sessions ignore late transport, stream, and tool callbacks', async () => {
  const id = `heartbeat_terminal_${Date.now()}`;
  await markSessionAskStart(id);
  assert.equal(existsSync(heartbeatPath(id)), true);

  await markSessionDone(id);
  assert.equal(_getRuntimeEntry(id)?.stage, 'done');
  assert.equal(existsSync(heartbeatPath(id)), false);

  markSessionTransportActivity(id);
  await markSessionStreamDelta(id, 'text');
  await markSessionToolCall(id, 'shell');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(existsSync(heartbeatPath(id)), false);
  assert.equal(listSessionHeartbeatMtimes().has(id), false,
    'desktop session catalog must not receive a working marker after completion');
  _clearSessionRuntime(id);
});

test('summary rows derive liveness from the .hb sidecar alone, never stored JSON fields', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { listStoredSessionSummaries } = await import('../src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
  const id = `heartbeat_row_source_${Date.now()}`;
  const now = Date.now();
  await mkdir(join(dataDir, 'sessions'), { recursive: true });
  // Final save shape after a completed turn: fresh lastHeartbeatAt/heartbeatAt
  // fields persisted in the JSON, but the .hb sidecar already deleted.
  await writeFile(join(dataDir, 'sessions', `${id}.json`), JSON.stringify({
    id,
    owner: 'user',
    updatedAt: now,
    lastHeartbeatAt: now,
    heartbeatAt: now,
    messages: [{ role: 'user', content: 'hello from the finished turn' }],
  }));

  const rowAfterCompletion = listStoredSessionSummaries({ refreshFromStorage: true })
    .find((row) => row.id === id);
  assert.ok(rowAfterCompletion, 'the completed session must stay listed');
  assert.equal(rowAfterCompletion.heartbeatAt, 0,
    'stored heartbeat fields must not pin the desktop working spinner after completion');

  await publishHeartbeat(id, now);
  const rowWhileWorking = listStoredSessionSummaries({ refreshFromStorage: true })
    .find((row) => row.id === id);
  assert.ok((rowWhileWorking?.heartbeatAt || 0) > 0,
    'a live .hb sidecar must surface as catalog liveness');
  await deleteHeartbeat(id);
});
