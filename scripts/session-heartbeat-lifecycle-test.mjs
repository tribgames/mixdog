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
