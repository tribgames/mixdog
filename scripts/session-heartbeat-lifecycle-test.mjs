import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('a child agent heartbeat keeps its lead session observable without exposing the child row', async () => {
  const { listStoredSessionSummaries } = await import('../src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
  const suffix = Date.now();
  const parentId = `heartbeat_agent_parent_${suffix}`;
  const childId = `heartbeat_agent_child_${suffix}`;
  const now = Date.now();
  const sessionsDir = join(dataDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const parent = {
    id: parentId,
    owner: 'user',
    updatedAt: now,
    messages: [{ role: 'user', content: 'parent conversation' }],
  };
  const child = {
    id: childId,
    owner: 'agent',
    ownerSessionId: parentId,
    agent: 'reviewer',
    updatedAt: now,
    messages: [{ role: 'user', content: 'background review' }],
  };
  await Promise.all([
    writeFile(join(sessionsDir, `${parentId}.json`), JSON.stringify(parent)),
    writeFile(join(sessionsDir, `${childId}.json`), JSON.stringify(child)),
  ]);
  await publishHeartbeat(childId, now);

  const scanned = listStoredSessionSummaries({ refreshFromStorage: true });
  assert.ok((scanned.find((row) => row.id === parentId)?.agentHeartbeatAt || 0) > 0);
  assert.equal(scanned.some((row) => row.id === childId), false,
    'agent children must remain hidden from the desktop session catalog');

  await writeFile(join(dataDir, 'session-summaries.json'), JSON.stringify({
    version: 2,
    rows: [
      { ...parent, preview: 'parent conversation', messageCount: 1 },
      { ...child, preview: 'background review', messageCount: 1 },
    ],
  }));
  const indexed = listStoredSessionSummaries({ rebuildIfMissing: false });
  assert.ok((indexed.find((row) => row.id === parentId)?.agentHeartbeatAt || 0) > 0,
    'the warm summary-index path must project the same child liveness');

  await deleteHeartbeat(childId);
  const settled = listStoredSessionSummaries({ rebuildIfMissing: false });
  assert.equal(Number(settled.find((row) => row.id === parentId)?.agentHeartbeatAt) || 0, 0);
});
