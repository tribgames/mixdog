// A transcript read (desktop/phone opening a session) must never commit a
// running turn as a crash: it leaves a live turn and its checkpoint untouched
// and projects the checkpoint read-only, while a dead owner's turn is still
// recovered exactly once.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-recovery-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'), { recursive: true });
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { createTurnCheckpointRecorder, readTurnCheckpoint, settleTurnCheckpointWrites } = await import(
  './turn-checkpoint.mjs'
);
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');
const { runtimeState } = await import('./runtime-state.mjs');
const { projectStoredTranscript } = await import('../store-transcript-projection.mjs');

const PROMPT = 'keep working on the task';
const PARTIAL = 'partial streamed answer';
const ownerPath = join(root, 'daemon-owner.json');
const sessionPath = (id) => join(root, 'sessions', `${id}.json`);

async function storeRunningTurn(id) {
  const doc = {
    id,
    generation: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastUsedAt: 1_000,
    status: 'idle',
    owner: 'user',
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    providerState: { responseId: 'resp-live' },
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: PROMPT },
    ],
    activeTurnCheckpoint: { version: 1, turnToken: `tok-${id}`, startedAt: 1_000 },
  };
  writeFileSync(sessionPath(id), JSON.stringify(doc));
  const tracker = createTurnInterruptionTracker();
  const recorder = createTurnCheckpointRecorder({
    sessionId: id,
    generation: 1,
    turnToken: `tok-${id}`,
    startedAt: 1_000,
  });
  tracker.markProviderSendStarted();
  tracker.recordTextDelta(PARTIAL);
  recorder.record({ currentUserContent: PROMPT, turnOutgoing: doc.messages, interruption: tracker });
  await settleTurnCheckpointWrites(id);
  return doc;
}

const read = (id, doc) => projectStoredTranscript(id, doc, { includeMessages: true, itemLimit: 100 });
const shows = (projected, text) => projected.messages.some((message) => String(message.content).includes(text));

function assertUntouched(id, before) {
  assert.equal(readFileSync(sessionPath(id), 'utf8'), before, 'the stored session is not rewritten');
  assert.equal(readTurnCheckpoint(id)?.turnToken, `tok-${id}`, 'the recovery checkpoint survives');
}

test('reading a session whose turn runs in this process leaves the turn untouched', async (t) => {
  const id = 'recovery_live_local';
  const doc = await storeRunningTurn(id);
  runtimeState.set(id, { stage: 'streaming' });
  t.after(() => runtimeState.delete(id));
  const before = readFileSync(sessionPath(id), 'utf8');
  const projected = await read(id, doc);
  assertUntouched(id, before);
  assert.equal(shows(projected, PARTIAL), false, 'no process-crash finalization of the live partial');
  assert.equal(shows(projected, PROMPT), true);
});

test('reading a session whose turn a live daemon owns leaves the turn untouched', async (t) => {
  const id = 'recovery_live_foreign';
  const doc = await storeRunningTurn(id);
  writeFileSync(ownerPath, JSON.stringify({ kind: 'daemon', pid: process.ppid }));
  t.after(() => rmSync(ownerPath, { force: true }));
  const before = readFileSync(sessionPath(id), 'utf8');
  const projected = await read(id, doc);
  assertUntouched(id, before);
  assert.equal(shows(projected, PROMPT), true);
});

test('a dead owner turn is recovered once on read', async (t) => {
  const id = 'recovery_dead_owner';
  const doc = await storeRunningTurn(id);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(ownerPath, JSON.stringify({ kind: 'daemon', pid: dead }));
  t.after(() => rmSync(ownerPath, { force: true }));
  const projected = await read(id, doc);
  assert.equal(shows(projected, PARTIAL), true, 'the interrupted partial is committed');
  assert.equal(readTurnCheckpoint(id), null, 'the checkpoint is cleared after the durable save');
  const recovered = readFileSync(sessionPath(id), 'utf8');
  const stored = JSON.parse(recovered);
  assert.equal(Object.hasOwn(stored, 'activeTurnCheckpoint'), false);
  assert.equal(Object.hasOwn(stored, 'providerState'), false);
  assert.equal(stored.messages.filter((message) => String(message.content).includes(PARTIAL)).length, 1);
  const again = await read(id, JSON.parse(recovered));
  assert.equal(readFileSync(sessionPath(id), 'utf8'), recovered, 'a second read recovers nothing more');
  assert.equal(again.messages.filter((message) => String(message.content).includes(PARTIAL)).length, 1);
});
