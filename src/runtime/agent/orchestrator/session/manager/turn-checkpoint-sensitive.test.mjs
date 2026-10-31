// The crash-recovery checkpoint of a turn never keeps a value marked
// sensitive: what was journaled before the mark is rewritten when it is
// marked, and text that streams it in across flushes never lands in pieces.
import assert from 'node:assert/strict';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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
    base: { epoch: 'e0', refs: [] },
  });
  const flush = () =>
    recorder.record({ boundary: 0, currentUserContent: prompt, turnOutgoing: outgoing, interruption: tracker });
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
  assert.equal(checkpoint.journalEpoch, 2);

  // Later records stay redacted, and the old journal never replays onto the new header.
  turn.outgoing.push({ role: 'assistant', content: `Typing ${CODE} now.` });
  turn.flush();
  await settleTurnCheckpointWrites(sessionId);
  assert.doesNotMatch(onDisk(sessionId), new RegExp(CODE));
  assert.equal(readTurnCheckpoint(sessionId).turnMessages.at(-1).content, 'Typing [redacted] now.');
});

test('a checkpoint that cannot be redacted is removed, or stops recording when it cannot be removed', async (t) => {
  // Storage faults: the header cannot be replaced and, when `unlink` is
  // false, cannot be removed either; with `journal` false only the journal
  // cannot be removed. Returns the function that ends them.
  const failing = (sessionId, { unlink, journal = true }) => {
    const headerPath = turnCheckpointPath(sessionId);
    const journalPath = turnJournalPath(sessionId);
    const realUnlink = fs.unlinkSync;
    const realJournalUnlink = fs.promises.unlink;
    const faults = [
      t.mock.method(fs, 'renameSync', () => {
        throw Object.assign(new Error('storage fault'), { code: 'EIO' });
      }),
    ];
    if (unlink === false) {
      faults.push(
        t.mock.method(fs, 'unlinkSync', (target, ...rest) => {
          if (target === headerPath) throw Object.assign(new Error('storage fault'), { code: 'EPERM' });
          return realUnlink(target, ...rest);
        })
      );
    }
    if (journal === false) {
      faults.push(
        t.mock.method(fs.promises, 'unlink', (target, ...rest) => {
          if (target === journalPath)
            return Promise.reject(Object.assign(new Error('storage fault'), { code: 'EPERM' }));
          return realJournalUnlink(target, ...rest);
        })
      );
    }
    syncBuiltinESMExports();
    return () => {
      for (const fault of faults) fault.mock.restore();
      syncBuiltinESMExports();
    };
  };
  const filesOf = (sessionId) =>
    [turnCheckpointPath(sessionId), turnJournalPath(sessionId)]
      .map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : null))
      .join('\n--\n');
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => {
    logged.push(String(chunk));
    return true;
  });

  // The rewrite fails: no checkpoint file keeps the code, and it is logged.
  const removedId = 'sess-checkpoint-failclosed-removed';
  const first = startTurn(removedId);
  first.flush();
  first.outgoing.push({ role: 'tool', toolCallId: 'M', content: `Your verification code is ${CODE}.` });
  first.tracker.recordToolResult(first.outgoing.at(-1));
  first.flush();
  await settleTurnCheckpointWrites(removedId);
  assert.match(onDisk(removedId), new RegExp(CODE));
  markFill(removedId);
  const endFault = failing(removedId, { unlink: true });
  try {
    assert.equal(first.flush(), false);
  } finally {
    endFault();
  }
  await settleTurnCheckpointWrites(removedId);
  assert.equal(existsSync(turnCheckpointPath(removedId)), false);
  assert.doesNotMatch(filesOf(removedId), new RegExp(CODE));
  assert.ok(logged.some((line) => line.includes(removedId) && /removed the checkpoint/.test(line)));
  // Storage is back: the turn records again, redacted.
  first.flush();
  await settleTurnCheckpointWrites(removedId);
  assert.doesNotMatch(onDisk(removedId), new RegExp(CODE));
  assert.equal(readTurnCheckpoint(removedId).turnMessages.at(-1).content, 'Your verification code is [redacted].');

  // The removal fails too: nothing is appended to the files afterwards.
  const keptId = 'sess-checkpoint-failclosed-kept';
  const second = startTurn(keptId);
  second.flush();
  await settleTurnCheckpointWrites(keptId);
  markFill(keptId, '771199');
  const endUnlinkFault = failing(keptId, { unlink: false });
  try {
    assert.equal(second.flush(), false);
  } finally {
    endUnlinkFault();
  }
  await settleTurnCheckpointWrites(keptId);
  const before = filesOf(keptId);
  second.outgoing.push({ role: 'assistant', content: 'after the fault' });
  assert.equal(second.flush(), false, 'the stopped recorder writes nothing');
  await settleTurnCheckpointWrites(keptId);
  assert.equal(filesOf(keptId), before);
  assert.ok(logged.some((line) => line.includes(keptId) && /no longer recording/.test(line)));

  // Only the journal cannot be removed: the plaintext stays until a later
  // flush removes it, and "removed" is logged only once both files are gone.
  const journalId = 'sess-checkpoint-failclosed-journal';
  const third = startTurn(journalId);
  third.flush();
  third.outgoing.push({ role: 'tool', toolCallId: 'M', content: `Your verification code is ${CODE}.` });
  third.tracker.recordToolResult(third.outgoing.at(-1));
  third.flush();
  await settleTurnCheckpointWrites(journalId);
  markFill(journalId);
  const endJournalFault = failing(journalId, { unlink: true, journal: false });
  const lines = () => logged.filter((line) => line.includes(journalId));
  try {
    assert.equal(third.flush(), false);
    await settleTurnCheckpointWrites(journalId);
    assert.equal(existsSync(turnCheckpointPath(journalId)), false, 'the header is gone');
    assert.match(filesOf(journalId), new RegExp(CODE), 'the journal removal failed');
    assert.ok(!lines().some((line) => /removed the checkpoint/.test(line)), 'not reported removed yet');
    assert.equal(third.flush(), false, 'nothing is recorded while the journal is owed');
    await settleTurnCheckpointWrites(journalId);
    assert.match(filesOf(journalId), new RegExp(CODE));
  } finally {
    endJournalFault();
  }
  assert.equal(third.flush(), false);
  await settleTurnCheckpointWrites(journalId);
  assert.doesNotMatch(filesOf(journalId), new RegExp(CODE), 'a later flush removed the journal');
  assert.equal(lines().filter((line) => /removed the checkpoint/.test(line)).length, 1);
  assert.equal(third.flush(), true, 'the next flush records again');
  await settleTurnCheckpointWrites(journalId);
  assert.doesNotMatch(onDisk(journalId), new RegExp(CODE));
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
    boundary: 0,
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
