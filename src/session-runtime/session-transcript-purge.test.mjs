// Deleting a session removes its conversation transcript and the memory ingest
// offsets keyed by it — per id, never a folder scan — and nothing else.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { deleteSession, saveSession } = await import('../runtime/agent/orchestrator/session/store.mjs');
const mgr = await import('../runtime/agent/orchestrator/session/manager.mjs');
const { _sessionSummary, _writeSummaryIndex, settleSummaryIndexWrites } = await import(
  '../runtime/agent/orchestrator/session/store-summary-index.mjs'
);
const { createTranscriptWriter } = await import('../runtime/shared/transcript-writer.mjs');
const { cwdToProjectSlug } = await import('../runtime/shared/transcript-writer/transcript-file.mjs');
const { drainPathSync } = await import('../runtime/shared/buffered-appender.mjs');
const { registerTranscriptPurgeHook } = await import('./session-transcript-purge.mjs');

const roots = [];
const previous = { home: process.env.MIXDOG_HOME, data: process.env.MIXDOG_DATA_DIR };
test.after(async () => {
  // A delete queues its summary-index removal: let it land before the
  // folders it writes into are removed.
  await settleSummaryIndexWrites();
  for (const [key, value] of [
    ['MIXDOG_HOME', previous.home],
    ['MIXDOG_DATA_DIR', previous.data],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function useHome() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-transcript-purge-'));
  roots.push(root);
  mkdirSync(join(root, 'data', 'sessions'), { recursive: true });
  process.env.MIXDOG_HOME = root;
  process.env.MIXDOG_DATA_DIR = join(root, 'data');
  return root;
}

const record = (id, cwd) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  updatedAt: 10,
  cwd,
  messages: [{ role: 'user', content: `hello ${id}` }],
});

const transcriptOf = (home, cwd, id) => join(home, 'projects', cwdToProjectSlug(cwd), `${id}.jsonl`);

function writeTranscript(home, cwd, id, text = 'hi') {
  const writer = createTranscriptWriter({ mixdogHome: home, sessionId: id, cwd });
  writer.appendUser(text);
  drainPathSync(writer.transcriptPath);
  return writer;
}

test('deleting a session removes its transcript and ingest offsets, and only its own', async () => {
  const home = useHome();
  const cwd = join(home, 'project');
  const forgotten = [];
  const unregister = registerTranscriptPurgeHook({
    forgetOffsets: async (paths) => {
      forgotten.push(...paths);
    },
  });
  try {
    const doomed = writeTranscript(home, cwd, 'sess_doomed');
    writeFileSync(`${doomed.transcriptPath}.1`, 'rotated generation\n');
    const sibling = writeTranscript(home, cwd, 'sess_sibling');
    const otherProject = writeTranscript(home, join(home, 'elsewhere'), 'sess_doomed_other');
    saveSession(record('sess_doomed', cwd), { sync: true });
    saveSession(record('sess_sibling', cwd), { sync: true });

    assert.equal(deleteSession('sess_doomed'), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(existsSync(doomed.transcriptPath), false, 'the transcript is gone');
    assert.equal(existsSync(`${doomed.transcriptPath}.1`), false, 'so is its rotated generation');
    assert.deepEqual(forgotten, [doomed.transcriptPath], 'offsets are dropped for exactly that file');
    assert.equal(existsSync(sibling.transcriptPath), true, 'a sibling session in the same project is untouched');
    assert.equal(existsSync(otherProject.transcriptPath), true);

    doomed.appendUser('late line from the still-running session');
    doomed.ensureTranscriptFile();
    drainPathSync(doomed.transcriptPath);
    assert.equal(existsSync(doomed.transcriptPath), false, 'the deleted session cannot recreate it');
  } finally {
    unregister();
  }
});

test("a transcript this process never wrote is found through the session's recorded folder", async () => {
  const home = useHome();
  const cwd = join(home, 'older-project');
  const forgotten = [];
  const unregister = registerTranscriptPurgeHook({
    forgetOffsets: async (paths) => {
      forgotten.push(...paths);
    },
  });
  try {
    // Left by an earlier daemon lifetime: no writer of this process knows it.
    const path = transcriptOf(home, cwd, 'sess_old');
    const siblingPath = transcriptOf(home, cwd, 'sess_old_sibling');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{"type":"user"}\n');
    writeFileSync(siblingPath, '{"type":"user"}\n');
    const records = [record('sess_old', cwd), record('sess_old_sibling', cwd)];
    for (const item of records) writeFileSync(join(home, 'data', 'sessions', `${item.id}.json`), JSON.stringify(item));
    _writeSummaryIndex(records.map(_sessionSummary).filter(Boolean));
    mgr.listSessions();

    assert.equal(deleteSession('sess_old'), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(existsSync(path), false);
    assert.equal(existsSync(siblingPath), true);
    assert.deepEqual(forgotten, [path]);
  } finally {
    unregister();
  }
});

test('an unremovable transcript or a failing offsets request never breaks the delete', async () => {
  const home = useHome();
  const cwd = join(home, 'project');
  const unregister = registerTranscriptPurgeHook({
    forgetOffsets: async () => {
      throw new Error('memory runtime is not available');
    },
  });
  try {
    saveSession(record('sess_unlucky', cwd), { sync: true });
    // A directory where the transcript file should be: unlink fails.
    mkdirSync(transcriptOf(home, cwd, 'sess_unlucky'), { recursive: true });

    assert.equal(deleteSession('sess_unlucky'), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(existsSync(join(home, 'data', 'sessions', 'sess_unlucky.json')), false);
  } finally {
    unregister();
  }
});
