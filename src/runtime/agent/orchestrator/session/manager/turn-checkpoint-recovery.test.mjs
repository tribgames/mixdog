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
    transcriptEpoch: 'e0',
    activeTurnCheckpoint: { version: 1, turnToken: `tok-${id}`, startedAt: 1_000 },
  };
  writeFileSync(sessionPath(id), JSON.stringify(doc));
  const tracker = createTurnInterruptionTracker();
  const recorder = createTurnCheckpointRecorder({
    sessionId: id,
    generation: 1,
    turnToken: `tok-${id}`,
    startedAt: 1_000,
    base: { epoch: 'e0', refs: doc.messages.slice(0, 1) },
  });
  tracker.markProviderSendStarted();
  tracker.recordTextDelta(PARTIAL);
  recorder.record({ boundary: 1, currentUserContent: PROMPT, turnOutgoing: doc.messages, interruption: tracker });
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

test('the daemon owner sweeps orphan checkpoint journals when it starts, in worker mode; other processes do not', async (t) => {
  const { existsSync } = await import('node:fs');
  const { removeOrphanTurnJournals, turnJournalPath } = await import('./turn-checkpoint-journal.mjs');
  const { startIdleCleanup, stopIdleCleanup } = await import('./idle-cleanup.mjs');
  const { sweepOrphanTurnJournals } = await import('./turn-checkpoint-recovery.mjs');
  // The environment daemon.mjs gives its own process.
  const saved = { worker: process.env.MIXDOG_WORKER_MODE, host: process.env.MIXDOG_DAEMON_HOST };
  process.env.MIXDOG_WORKER_MODE = '1';
  process.env.MIXDOG_DAEMON_HOST = '1';
  t.after(() => {
    stopIdleCleanup();
    rmSync(ownerPath, { force: true });
    for (const [name, value] of [
      ['MIXDOG_WORKER_MODE', saved.worker],
      ['MIXDOG_DAEMON_HOST', saved.host],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const orphan = (id) => {
    writeFileSync(
      turnJournalPath(id),
      `${JSON.stringify({ t: 'h', turnToken: 'gone', s: 0 })}\nverification code 682419\n`
    );
    return turnJournalPath(id);
  };

  // Another live process owns the daemon record: this one leaves the journal.
  const foreign = orphan('startup_sweep_foreign');
  writeFileSync(ownerPath, JSON.stringify({ kind: 'daemon', pid: process.ppid }));
  assert.equal(await sweepOrphanTurnJournals(), 0);
  assert.ok(existsSync(foreign));

  // This process owns it (the daemon claims before its session runtime starts):
  // starting the session runtime's cleanup sweeps the journal of a session
  // that is never reopened.
  writeFileSync(ownerPath, JSON.stringify({ kind: 'daemon', pid: process.pid }));
  startIdleCleanup();
  const deadline = Date.now() + 5000;
  while (existsSync(foreign) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(foreign), false);

  // No live owner at all (an inline `mixdog exec` run): it sweeps, but a live
  // turn's journal (header written first) is left alone.
  rmSync(ownerPath, { force: true });
  const inline = orphan('startup_sweep_inline');
  const live = createTurnCheckpointRecorder({
    sessionId: 'startup_sweep_live',
    generation: 1,
    turnToken: 'tok-startup_sweep_live',
    startedAt: 1,
    base: { epoch: 'e0', refs: [] },
  });
  live.record({
    boundary: 0,
    currentUserContent: PROMPT,
    turnOutgoing: [{ role: 'user', content: PROMPT }],
    interruption: createTurnInterruptionTracker(),
  });
  assert.ok((await sweepOrphanTurnJournals()) >= 1);
  assert.equal(existsSync(inline), false);
  assert.equal(readTurnCheckpoint('startup_sweep_live')?.turnToken, 'tok-startup_sweep_live');
  assert.ok(existsSync(turnJournalPath('startup_sweep_live')));

  // The header check and the delete are one step under the session's
  // checkpoint lock, exclusive with a turn's header publish plus journal open.
  const { checkpointLockPath } = await import('./turn-checkpoint-journal.mjs');
  const { withFileLockSync } = await import('../../../../shared/file-lock.mjs');
  const racing = orphan('startup_sweep_racing');
  // A turn in another process holds the lock (publishing its header and
  // opening its journal): the sweep skips the session and never waits.
  withFileLockSync(checkpointLockPath('startup_sweep_racing'), () => {
    const startedAt = Date.now();
    assert.equal(removeOrphanTurnJournals(), 0);
    assert.ok(Date.now() - startedAt < 150, 'the sweep did not wait for the lock');
    assert.ok(existsSync(racing), 'the held session was skipped');
  });
  // The reverse: the sweep holds the lock; a turn opening meanwhile is not
  // failed or stalled for long by it, and its checkpoint is recoverable.
  const opening = createTurnCheckpointRecorder({
    sessionId: 'startup_sweep_racing',
    generation: 1,
    turnToken: 'tok-startup_sweep_racing',
    startedAt: 1,
    base: { epoch: 'e0', refs: [] },
  });
  withFileLockSync(checkpointLockPath('startup_sweep_racing'), () => {
    const startedAt = Date.now();
    opening.record({
      boundary: 0,
      currentUserContent: PROMPT,
      turnOutgoing: [{ role: 'user', content: PROMPT }],
      interruption: createTurnInterruptionTracker(),
    });
    assert.ok(Date.now() - startedAt < 2000, 'the turn is bounded by the lock wait');
  });
  assert.equal(readTurnCheckpoint('startup_sweep_racing')?.turnToken, 'tok-startup_sweep_racing');
  // Header published: the journal is no longer an orphan.
  assert.equal(removeOrphanTurnJournals(), 0);
  assert.ok(existsSync(racing));
});
