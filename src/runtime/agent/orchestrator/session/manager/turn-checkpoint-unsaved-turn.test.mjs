// Turns whose session saves never land: each new turn's checkpoint would
// replace the previous one, so a crash must still recover every earlier turn
// still missing from disk — exactly once — while each turn's checkpoint write
// stays the size of that turn, not of the growing session.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const {
  clearTurnCheckpoint,
  createTurnCheckpointRecorder,
  projectTurnCheckpointChain,
  readTurnCheckpoint,
  readTurnCheckpointChain,
  recoverTurnCheckpoint,
  settleTurnCheckpointWrites,
  turnCheckpointPath,
} = await import('./turn-checkpoint.mjs');
const { listRetainedCheckpoints } = await import('./turn-checkpoint-journal.mjs');
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');

test.after(async () => {
  setSessionSaveFault(null);
  await settleSessionSummaryIndex();
  await (await import('../store/lifecycle-barriers.mjs')).flushSessionCloseMetrics();
  rmSync(root, { recursive: true, force: true });
});

const REPLY_CHARS = 20_000;
const prompt = (k) => `task-${k}-end`;
const reply = (k) => `${'x'.repeat(REPLY_CHARS)} reply-${k}-end`;

/** A session on disk as created, and its live copy. */
function createSession(id) {
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
  writeFileSync(join(root, 'sessions', `${id}.json`), JSON.stringify(created));
  return structuredClone(created);
}

/** Opens turn `k` (its checkpoint header, retaining an uncleared previous
 *  turn) and returns what that open wrote, then runs and commits the turn.
 *  `land` decides whether the commit's save reaches disk. */
async function runTurn(live, k, { land = false, crash = false, whileRunning = null, text = prompt(k) } = {}) {
  const id = live.id;
  // Like every ask's first turn, recovery runs on the session this process
  // holds: turns it has not saved yet are not stale and stay checkpointed.
  assert.equal(recoverTurnCheckpoint(live).changed, false);
  const outgoing = [...live.messages, { role: 'user', content: text }];
  const recorder = createTurnCheckpointRecorder({ sessionId: id, generation: 1, turnToken: `tok-${k}`, startedAt: 10_000 + k });
  const tracker = createTurnInterruptionTracker();
  const before = new Set(listRetainedCheckpoints(id).map((entry) => entry.path));
  recorder.record({ currentUserContent: text, turnOutgoing: outgoing, interruption: tracker });
  const opened = {
    header: statSync(turnCheckpointPath(id)).size,
    retained: listRetainedCheckpoints(id)
      .filter((entry) => !before.has(entry.path))
      .map((entry) => statSync(entry.path).size),
  };
  if (crash) {
    await settleTurnCheckpointWrites(id);
    return opened;
  }
  await whileRunning?.();
  outgoing.push({ role: 'assistant', content: reply(k) });
  recorder.record({ currentUserContent: text, turnOutgoing: outgoing, interruption: tracker });
  recorder.stop();
  live.messages = outgoing;
  live.updatedAt = Date.now();
  if (land) await saveSessionAsync(live, { expectedGeneration: 1 });
  else await assert.rejects(saveSessionAsync(live, { expectedGeneration: 1 }));
  await settleTurnCheckpointWrites(id);
  return opened;
}

/** The process dies: the next one recovers from the data dir alone. */
function recoverAfterCrash(id) {
  const restarted = JSON.parse(readFileSync(join(root, 'sessions', `${id}.json`), 'utf8'));
  const recovery = recoverTurnCheckpoint(restarted);
  assert.equal(recovery.recovered, true);
  return restarted.messages;
}

/** Each turn's prompt and reply appear exactly once, in turn order. */
function assertEveryTurnOnce(messages, turns, { lastUnanswered }) {
  const at = (role, text) => {
    const found = messages.flatMap((message, index) =>
      message.role === role && JSON.stringify(message.content).includes(text) ? [index] : []
    );
    assert.equal(found.length, 1, `${role} ${text} appears once`);
    return found[0];
  };
  let previous = -1;
  for (let k = 1; k <= turns; k += 1) {
    const positions = [at('user', prompt(k))];
    if (!(lastUnanswered && k === turns)) positions.push(at('assistant', `reply-${k}-end`));
    for (const position of positions) {
      assert.ok(position > previous, `turn ${k} follows turn ${k - 1}`);
      previous = position;
    }
  }
}

test('with every save failing, each turn checkpoints its own size and a crash restores every turn once', async () => {
  const live = createSession('unsaved_turns');
  setSessionSaveFault({ ids: [live.id] });
  const opens = [];
  for (let k = 1; k <= 8; k += 1) opens.push(await runTurn(live, k));
  opens.push(await runTurn(live, 9, { crash: true }));
  setSessionSaveFault(null);

  // The session grew past 160 KB, yet each open wrote one small header and
  // at most the one previous turn it retained.
  assert.ok(JSON.stringify(live.messages).length > 8 * REPLY_CHARS);
  for (const [index, { header, retained }] of opens.entries()) {
    assert.ok(header < 2_000, `turn ${index + 1} header is ${header} bytes`);
    assert.equal(retained.length, index === 0 ? 0 : 1, `turn ${index + 1} retains only its predecessor`);
    for (const size of retained) assert.ok(size < 2 * REPLY_CHARS, `turn ${index} kept in ${size} bytes`);
  }
  assertEveryTurnOnce(recoverAfterCrash(live.id), 9, { lastUnanswered: true });
});

test('a landed save drops the turns it covers; a crash restores the rest once each', async () => {
  const live = createSession('partly_saved_turns');
  setSessionSaveFault({ ids: [live.id] });
  for (let k = 1; k <= 4; k += 1) await runTurn(live, k);
  // A save covering turns 1-4 lands while turn 5 runs, after turn 5 opened
  // and retained turn 4; turn 5's own save then fails.
  const afterFour = structuredClone(live);
  await runTurn(live, 5, {
    whileRunning: async () => {
      assert.equal(listRetainedCheckpoints(live.id).length, 4);
      setSessionSaveFault(null);
      await saveSessionAsync(afterFour, { expectedGeneration: 1 });
      assert.equal(clearTurnCheckpoint(live.id, 'tok-4'), true);
      assert.equal(listRetainedCheckpoints(live.id).length, 0, 'turns 1-4 are on disk now');
      assert.equal(readTurnCheckpoint(live.id).turnToken, 'tok-5', "turn 5's own checkpoint stays");
      setSessionSaveFault({ ids: [live.id] });
    },
  });
  await runTurn(live, 6);
  await runTurn(live, 7, { crash: true });
  setSessionSaveFault(null);
  assertEveryTurnOnce(recoverAfterCrash(live.id), 7, { lastUnanswered: true });
});

/** The transcript as turns: `U` for each "continue" prompt, `R<k>` for
 *  turn k's reply. */
const turnsOf = (messages) =>
  messages.flatMap((message) => {
    const text = JSON.stringify(message.content);
    if (message.role === 'user' && text.includes('continue')) return ['U'];
    const replied = message.role === 'assistant' && /reply-(\d+)-end/.exec(text);
    return replied ? [`R${replied[1]}`] : [];
  });

test('turns with the same prompt are each restored once, by position, not by text', async () => {
  const live = createSession('same_prompt_turns');
  setSessionSaveFault({ ids: [live.id] });
  await runTurn(live, 1, { text: 'continue' });
  await runTurn(live, 2, { text: 'continue' });
  await runTurn(live, 3, { text: 'continue', crash: true });
  setSessionSaveFault(null);
  // The read-only view of the record on disk (no turns yet) and the chain.
  const disk = JSON.parse(readFileSync(join(root, 'sessions', `${live.id}.json`), 'utf8'));
  assert.deepEqual(turnsOf(projectTurnCheckpointChain(disk, readTurnCheckpointChain(live.id))), [
    'U',
    'R1',
    'U',
    'R2',
    'U',
  ]);
  assert.deepEqual(turnsOf(recoverAfterCrash(live.id)), ['U', 'R1', 'U', 'R2', 'U']);
});

test('with the same prompt, a turn on disk stays and the unsaved next turn follows it', async () => {
  const live = createSession('same_prompt_one_saved');
  await runTurn(live, 1, { text: 'continue', land: true });
  clearTurnCheckpoint(live.id, 'tok-1');
  setSessionSaveFault({ ids: [live.id] });
  await runTurn(live, 2, { text: 'continue' });
  await runTurn(live, 3, { text: 'continue', crash: true });
  setSessionSaveFault(null);
  assert.deepEqual(turnsOf(recoverAfterCrash(live.id)), ['U', 'R1', 'U', 'R2', 'U']);
});

test('with the same prompt, a turn whose prompt reached disk is replaced in place, once', async () => {
  const live = createSession('same_prompt_preflight_saved');
  await runTurn(live, 1, { text: 'continue', land: true });
  clearTurnCheckpoint(live.id, 'tok-1');
  // Turn 2's prompt and active-turn marker land (its preflight save); the
  // process dies before its answer is saved.
  await runTurn(live, 2, {
    text: 'continue',
    crash: true,
  });
  const preflight = {
    ...structuredClone(live),
    messages: [...live.messages, { role: 'user', content: 'continue' }],
    activeTurnCheckpoint: { version: 1, turnToken: 'tok-2', startedAt: 10_002 },
  };
  await saveSessionAsync(preflight, { expectedGeneration: 1 });
  assert.deepEqual(turnsOf(recoverAfterCrash(live.id)), ['U', 'R1', 'U']);
});

test('turns whose saves land leave no retained checkpoint behind', async () => {
  const live = createSession('saved_turns');
  for (let k = 1; k <= 3; k += 1) {
    await runTurn(live, k, { land: true });
    clearTurnCheckpoint(live.id, `tok-${k}`);
  }
  assert.equal(listRetainedCheckpoints(live.id).length, 0);
  assert.equal(readTurnCheckpoint(live.id), null);
});
