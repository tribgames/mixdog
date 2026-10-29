// A turn that opens before the previous turn's save reached disk: a crash in
// it must still recover the previous turn, since the new turn's checkpoint
// replaces the previous one. Saves that landed keep the checkpoint turn-only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-unsaved-turn-'));
process.env.MIXDOG_DATA_DIR = root;
// Structural gate for the store's commit fault (a save that never lands).
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';
mkdirSync(join(root, 'sessions'), { recursive: true });

const { saveSessionAsync, setSessionSaveFault } = await import('../store.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { createTurnCheckpointRecorder, readTurnCheckpoint, recoverTurnCheckpoint, settleTurnCheckpointWrites } =
  await import('./turn-checkpoint.mjs');
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');

test.after(async () => {
  setSessionSaveFault(null);
  await settleSessionSummaryIndex();
  await (await import('../store/lifecycle-barriers.mjs')).flushSessionCloseMetrics();
  rmSync(root, { recursive: true, force: true });
});

const sessionPath = (id) => join(root, 'sessions', `${id}.json`);
const texts = (messages) => messages.map((message) => message.content);

/** Turn one completes in memory; `landed` decides whether its save reaches
 *  disk. Turn two then opens its checkpoint, and the process dies. */
async function crashInSecondTurn(id, { landed }) {
  const created = {
    id,
    generation: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    lastUsedAt: 1_000,
    status: 'idle',
    owner: 'user',
    provider: 'openai-oauth',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'system', content: 'sys' }],
  };
  writeFileSync(sessionPath(id), JSON.stringify(created));
  const live = structuredClone(created);
  live.messages.push({ role: 'user', content: 'first task' }, { role: 'assistant', content: 'done one' });
  if (landed) await saveSessionAsync(live, { expectedGeneration: 1 });
  else {
    setSessionSaveFault({ ids: [id] });
    await assert.rejects(saveSessionAsync(live, { expectedGeneration: 1 }));
    setSessionSaveFault(null);
  }
  const recorder = createTurnCheckpointRecorder({ sessionId: id, generation: 1, turnToken: `tok-${id}`, startedAt: 2_000 });
  recorder.record({
    currentUserContent: 'second task',
    turnOutgoing: [...live.messages, { role: 'user', content: 'second task' }],
    interruption: createTurnInterruptionTracker(),
  });
  await settleTurnCheckpointWrites(id);
  const header = readTurnCheckpoint(id);
  // The restarted process: only the data dir is left.
  const restarted = JSON.parse(readFileSync(sessionPath(id), 'utf8'));
  assert.equal(recoverTurnCheckpoint(restarted).recovered, true);
  return { header, recovered: texts(restarted.messages) };
}

test('a crash after a turn whose save never landed still recovers that turn', async () => {
  const { recovered } = await crashInSecondTurn('unsaved_previous_turn', { landed: false });
  assert.deepEqual(recovered.slice(0, 4), ['sys', 'first task', 'done one', 'second task']);
});

test('after a landed save the checkpoint holds only the new turn and recovery is the same', async () => {
  const { header, recovered } = await crashInSecondTurn('saved_previous_turn', { landed: true });
  assert.deepEqual(texts(header.turnMessages), ['second task']);
  assert.deepEqual(recovered.slice(0, 4), ['sys', 'first task', 'done one', 'second task']);
});
