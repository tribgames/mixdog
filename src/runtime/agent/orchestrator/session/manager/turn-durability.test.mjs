// Crash recovery of a turn whose session save had not landed: every unsaved
// turn comes back exactly once, and a checkpoint is never spliced onto a
// record it was not taken against.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';
const root = makeTempDirSync('turn-durability');
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_SESSION_SAVE_FAULT_HOOKS = '1';
mkdirSync(join(root, 'sessions'), { recursive: true });
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const { createTurnCheckpointRecorder, readTurnCheckpoint, recoverTurnCheckpoint, settleTurnCheckpointWrites } =
  await import('./turn-checkpoint.mjs');
const { _recoverTurnCheckpointDurably } = await import('./turn-checkpoint-recovery.mjs');
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');
const { readDurableSessionRecord, setTranscriptSnapshotHook } = await import('../store/transcript-durability.mjs');
const { setSessionSaveFault } = await import('../store.mjs');
const { createSession } = await import('./session-lifecycle.mjs');
const { askSession } = await import('./ask-session.mjs');
const { _withRegisteredProviderForTestAsync } = await import('../../providers/registry.mjs');

const sessionFile = (id) => join(root, 'sessions', `${id}.json`);
const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });
const texts = (messages) => messages.map((message) => `${message.role}:${message.content}`);

/** One turn opening at `history.length` on the durable record `history` of
 *  `epoch`; `session` (optional) is the live session it rewrites. */
function openTurn(sessionId, history, prompt, { epoch = 'e0', session = null, token = `tok-${sessionId}` } = {}) {
  const tracker = createTurnInterruptionTracker();
  const outgoing = [...history, user(prompt)];
  const recorder = createTurnCheckpointRecorder({
    session,
    sessionId,
    generation: 1,
    turnToken: token,
    startedAt: 1,
    base: { epoch, refs: history },
  });
  const flush = (extra = {}) =>
    recorder.record({
      boundary: history.length,
      currentUserContent: prompt,
      turnOutgoing: outgoing,
      interruption: tracker,
      ...extra,
    });
  flush();
  return { tracker, outgoing, recorder, flush, token };
}

const record = (id, messages, fields = {}) => ({ id, generation: 1, messages: messages.slice(), ...fields });

test('a sealed turn whose terminal save never landed comes back once, as finished', async () => {
  const id = 'durable_sealed';
  const history = [{ role: 'system', content: 'sys' }];
  const turn = openTurn(id, history, 'do it');
  turn.outgoing.push(assistant('done'));
  turn.flush({ sealed: true });
  turn.recorder.stop({ keepQueued: true });
  await settleTurnCheckpointWrites(id);
  assert.equal(readTurnCheckpoint(id).sealed, true);

  // Crash before the terminal save: disk still holds the base.
  const session = record(id, history, { transcriptEpoch: 'e0' });
  const recovery = recoverTurnCheckpoint(session, record(id, history, { transcriptEpoch: 'e0' }));
  assert.equal(recovery.recovered, true);
  assert.deepEqual(texts(session.messages), ['system:sys', 'user:do it', 'assistant:done']);
  assert.equal(session.turnCoverage, turn.token);

  // Crash after that recovery saved but before the checkpoint went: the
  // record covers the turn, so nothing is replayed again.
  const again = structuredClone(session);
  assert.equal(recoverTurnCheckpoint(again, structuredClone(session)).covered, true);
  assert.deepEqual(again.messages, session.messages);
});

test('a durable record that covers the turn deletes the checkpoint without a duplicate', async () => {
  const id = 'durable_covered';
  const history = [{ role: 'system', content: 'sys' }];
  const turn = openTurn(id, history, 'do it');
  turn.outgoing.push(assistant('done'));
  turn.flush({ sealed: true });
  await settleTurnCheckpointWrites(id);
  // The terminal save landed (with the coverage token), then the process died.
  const landed = record(id, turn.outgoing, { transcriptEpoch: 'e0', turnCoverage: turn.token });
  writeFileSync(sessionFile(id), JSON.stringify(landed));
  const session = structuredClone(landed);
  const recovery = _recoverTurnCheckpointDurably(session, id);
  assert.equal(recovery.covered, true);
  assert.equal(readTurnCheckpoint(id), null);
  assert.deepEqual(texts(session.messages), ['system:sys', 'user:do it', 'assistant:done']);
});

test('identical prompts in consecutive turns keep both turns', async () => {
  const id = 'durable_same_prompt';
  // Turn A ("continue") is durable; turn B repeats the prompt and dies mid-run.
  const durable = [{ role: 'system', content: 'sys' }, user('continue'), assistant('first answer')];
  const turn = openTurn(id, durable, 'continue', { epoch: 'e1' });
  turn.tracker.markProviderSendStarted();
  turn.tracker.recordTextDelta('second partial');
  turn.flush();
  await settleTurnCheckpointWrites(id);
  const session = record(id, durable, { transcriptEpoch: 'e1' });
  recoverTurnCheckpoint(session, record(id, durable, { transcriptEpoch: 'e1' }));
  assert.deepEqual(texts(session.messages).slice(0, 4), [
    'system:sys',
    'user:continue',
    'assistant:first answer',
    'user:continue',
  ]);
  assert.ok(session.messages.some((message) => String(message.content).includes('second partial')));
});

test('a checkpoint is kept, not spliced, when disk does not hold its base', async () => {
  const id = 'durable_wrong_base';
  const durable = [{ role: 'system', content: 'sys' }, user('continue'), assistant('first answer')];
  openTurn(id, durable, 'continue', { epoch: 'e1' });
  await settleTurnCheckpointWrites(id);
  // Disk still holds an older transcript without turn A.
  const older = [{ role: 'system', content: 'sys' }];
  const session = record(id, older, { transcriptEpoch: 'e0' });
  const recovery = recoverTurnCheckpoint(session, record(id, older, { transcriptEpoch: 'e0' }));
  assert.equal(recovery.recovered, false);
  assert.match(recovery.conflict, /base/);
  assert.deepEqual(texts(session.messages), ['system:sys']);
  assert.equal(readTurnCheckpoint(id)?.turnToken, `tok-${id}`);
});

test('compaction keeping the prompt, with its save failed, recovers the compacted context', async () => {
  const id = 'durable_compaction';
  const durable = [{ role: 'system', content: 'policy' }, user('old prompt'), assistant('old answer')];
  const live = record(id, durable, { transcriptEpoch: 'e0' });
  const turn = openTurn(id, durable, 'current', { session: live });
  const current = turn.outgoing[3];
  const unhook = setTranscriptSnapshotHook(live, () => turn.flush());
  // Pre-send compaction: [policy, old prompt, old answer, current] →
  // [summary, current]; the save that would carry it fails, so disk keeps
  // the base. The snapshot hook journals the rewrite before any save.
  turn.outgoing.splice(0, turn.outgoing.length, user('[summary]'), current);
  live.messages = turn.outgoing.slice();
  const { captureTranscriptSnapshot } = await import('../store/transcript-durability.mjs');
  captureTranscriptSnapshot(live);
  unhook();
  assert.notEqual(live.transcriptEpoch, 'e0', 'the rewrite starts a new epoch before a record carries it');
  turn.outgoing.push(assistant('after compaction'));
  turn.flush();
  await settleTurnCheckpointWrites(id);

  for (const disk of [
    record(id, durable, { transcriptEpoch: 'e0' }),
    // A pre-compaction save of this same turn.
    record(id, [...durable, user('current')], {
      transcriptEpoch: 'e0',
      activeTurnCheckpoint: { turnToken: turn.token },
    }),
  ]) {
    const session = structuredClone(disk);
    assert.equal(recoverTurnCheckpoint(session, structuredClone(disk)).recovered, true);
    assert.deepEqual(texts(session.messages).slice(0, 3), [
      'user:[summary]',
      'user:current',
      'assistant:after compaction',
    ]);
  }
});

// ── Through askSession: the next turn's gate ────────────────────────────────

const USAGE = { inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheWriteTokens: 0 };
let onSend = null;
const provider = {
  name: 'anthropic-oauth',
  contextWindow: 200_000,
  async send(_messages, _model, _tools, opts) {
    if (opts?.requestKind && opts.requestKind !== 'turn') return { content: 'Title', usage: USAGE };
    onSend?.();
    return { content: 'answer', stopReason: 'end_turn', usage: USAGE };
  },
};

test('a failed terminal save blocks the next turn with a clear error and keeps the turn recoverable', async () => {
  await _withRegisteredProviderForTestAsync('anthropic-oauth', provider, async () => {
    const session = createSession({
      provider: 'anthropic-oauth',
      model: 'claude-opus-5-5',
      cwd: root,
      skipSkills: true,
      workflow: { id: 'headless', delegatesAgents: false },
    });
    const id = session.id;
    // Every save after the provider answered fails: the terminal save too.
    onSend = () => setSessionSaveFault({ ids: id });
    try {
      await askSession(id, 'first task', null, null, null, null, {});
      onSend = null;
      await settleTurnCheckpointWrites(id);
      const checkpoint = readTurnCheckpoint(id);
      assert.equal(checkpoint?.sealed, true, 'the finished turn stays sealed in its checkpoint');
      await assert.rejects(
        askSession(id, 'second task', null, null, null, null, {}),
        (error) => error.code === 'ETURNNOTDURABLE' && /previous turn is not saved to disk/.test(error.message)
      );
      // A crash now: the disk record lacks the turn, the checkpoint brings it back once.
      const disk = readDurableSessionRecord(id);
      assert.ok(!disk.messages.some((message) => message.content === 'answer'));
      const restarted = structuredClone(disk);
      assert.equal(recoverTurnCheckpoint(restarted, disk).recovered, true);
      assert.equal(restarted.messages.filter((message) => message.content === 'answer').length, 1);
    } finally {
      onSend = null;
      setSessionSaveFault(null);
    }
    // Once a save lands, the next turn runs and the first turn is on disk once.
    await askSession(id, 'second task', null, null, null, null, {});
    const { awaitPreviousTurnDurable } = await import('./turn-durability.mjs');
    await awaitPreviousTurnDurable(id);
    const stored = readDurableSessionRecord(id);
    const said = (text) => stored.messages.filter((message) => JSON.stringify(message.content).includes(text)).length;
    assert.equal(said('first task'), 1);
    assert.equal(said('second task'), 1);
    assert.equal(stored.messages.filter((message) => message.content === 'answer').length, 2);
    assert.equal(readTurnCheckpoint(id), null);
  });
});
