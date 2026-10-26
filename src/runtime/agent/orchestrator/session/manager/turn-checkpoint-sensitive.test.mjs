// The crash-recovery checkpoint of a turn never keeps a value marked
// sensitive: what was journaled before the mark is rewritten when it is
// marked, and text that streams it in across flushes never lands in pieces.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-sensitive-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const saves = [];
const ingests = [];
mock.module('../store.mjs', {
  namedExports: {
    ...(await import('../store.mjs')),
    saveSessionAsync: async (session, opts) => {
      saves.push({ session, opts });
    },
  },
});
mock.module('../../../../session-search/session-search-ingest.mjs', {
  namedExports: {
    ...(await import('../../../../session-search/session-search-ingest.mjs')),
    ingestSessionTurn: (session) => ingests.push(session),
  },
});

const { createTurnCheckpointRecorder, readTurnCheckpoint, settleTurnCheckpointWrites } = await import(
  './turn-checkpoint.mjs'
);
const { turnCheckpointPath, turnJournalPath } = await import('./turn-checkpoint-journal.mjs');
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');
const { createTurnCheckpointScheduler } = await import('./ask-turn-state.mjs');
const { rememberSensitiveValues } = await import('../sensitive-values.mjs');

const CODE = '682419';
const markFill = (sessionId, text = CODE) =>
  rememberSensitiveValues(sessionId, [
    { name: 'browser', arguments: { action: 'fill', input: { ref: 'p1-s1-e3', text, sensitive: true } } },
  ]);
const onDisk = (sessionId) =>
  readFileSync(turnCheckpointPath(sessionId), 'utf8') + readFileSync(turnJournalPath(sessionId), 'utf8');

function startTurn(sessionId) {
  const tracker = createTurnInterruptionTracker();
  const prompt = 'Finish the sign-up.';
  const outgoing = [{ role: 'user', content: prompt }];
  const recorder = createTurnCheckpointRecorder({
    sessionId,
    generation: 1,
    turnToken: `tok-${sessionId}`,
    startedAt: 1,
  });
  const flush = () => recorder.record({ currentUserContent: prompt, turnOutgoing: outgoing, interruption: tracker });
  return { tracker, outgoing, flush };
}

test('records journaled before a value is marked are rewritten without it', async () => {
  const sessionId = 'sess-checkpoint-rewrite';
  const turn = startTurn(sessionId);
  turn.flush();
  turn.outgoing.push({ role: 'tool', toolCallId: 'M', content: `Your verification code is ${CODE}.` });
  turn.tracker.recordToolResult(turn.outgoing.at(-1));
  turn.flush();
  await settleTurnCheckpointWrites(sessionId);
  assert.match(onDisk(sessionId), new RegExp(CODE), 'the mail result was journaled as read');

  markFill(sessionId);
  turn.flush();
  await settleTurnCheckpointWrites(sessionId);
  assert.doesNotMatch(onDisk(sessionId), new RegExp(CODE), 'header and journal no longer hold it');
  const checkpoint = readTurnCheckpoint(sessionId);
  assert.equal(checkpoint.turnMessages.at(-1).content, 'Your verification code is [redacted].');
  assert.equal(checkpoint.journalEpoch, 1);

  // Later records stay redacted, and the old journal never replays onto the new header.
  turn.outgoing.push({ role: 'assistant', content: `Typing ${CODE} now.` });
  turn.flush();
  await settleTurnCheckpointWrites(sessionId);
  assert.doesNotMatch(onDisk(sessionId), new RegExp(CODE));
  assert.equal(readTurnCheckpoint(sessionId).turnMessages.at(-1).content, 'Typing [redacted] now.');
});

test('a value streamed across flushes is journaled only once it is whole, and redacted', async () => {
  const sessionId = 'sess-checkpoint-stream';
  markFill(sessionId);
  const turn = startTurn(sessionId);
  turn.flush();
  turn.tracker.recordTextDelta('The code was 68');
  turn.flush();
  turn.tracker.recordTextDelta('24');
  turn.flush();
  turn.tracker.recordTextDelta('19, entered.');
  turn.flush();
  await settleTurnCheckpointWrites(sessionId);
  const disk = onDisk(sessionId);
  for (const piece of ['68', '6824', CODE]) assert.doesNotMatch(disk, new RegExp(`was ${piece}`), piece);
  assert.equal(readTurnCheckpoint(sessionId).interruption.partialAssistantContent, 'The code was [redacted], entered.');
});

test('marking a value during a turn rewrites its checkpoint at once and resaves the session and its search rows', async () => {
  const sessionId = 'sess-checkpoint-scheduler';
  const prompt = 'Finish the sign-up.';
  const session = { id: sessionId, messages: [{ role: 'user', content: prompt }] };
  const turn = {
    session,
    outgoing: [
      { role: 'user', content: prompt },
      { role: 'tool', toolCallId: 'M', content: `Code: ${CODE}` },
    ],
    userTurnContent: prompt,
  };
  const interruption = createTurnInterruptionTracker();
  const checkpoint = createTurnCheckpointScheduler({
    sessionId,
    generation: 4,
    turnToken: 'tok-scheduler',
    startedAt: 1,
    turn,
    interruption,
  });
  checkpoint.schedule(true);
  await settleTurnCheckpointWrites(sessionId);
  assert.match(onDisk(sessionId), new RegExp(CODE));

  markFill(sessionId);
  await settleTurnCheckpointWrites(sessionId);
  assert.doesNotMatch(onDisk(sessionId), new RegExp(CODE), 'rewritten before the call runs, with no other flush');
  assert.deepEqual(
    saves.map(({ session: saved, opts }) => [saved, opts]),
    [[session, { expectedGeneration: 4 }]]
  );
  assert.deepEqual(ingests, [session]);

  checkpoint.stop();
  markFill(sessionId, '771199');
  assert.equal(saves.length, 1, 'a finished turn no longer listens');
});
