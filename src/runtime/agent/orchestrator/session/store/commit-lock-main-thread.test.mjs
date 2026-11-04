// While another thread holds a session's commit lock (the save worker renames
// a multi-MB record under it), a main-thread save, workspace-transition
// persist, close, detach and delete of that session wait for the release
// without holding up the event loop, and each one lands only after that
// commit has let the lock go.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-commit-lock-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));

const { saveSession, saveSessionDurably, markSessionClosed, bumpSessionGeneration, deleteSession } = await import('../store.mjs');
const { underHeldCommit } = await import('./commit-lock-holder.fixture.mjs');
const { subscribeSessionPersistence } = await import('./session-persistence-events.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');
const { persistWorkspaceSession } = await import('../../../../../session-runtime/boot/apis.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  (await import('./session-writer-claim.mjs')).releaseHeldSessionWriters();
  rmSync(root, { recursive: true, force: true });
});

const sessionFile = (id) => join(root, 'sessions', `${id}.json`);
const onDisk = (id) => JSON.parse(readFileSync(sessionFile(id), 'utf8'));
const contents = (id) => onDisk(id).messages.map((message) => message.content);

async function seed(id) {
  const session = { id, generation: 0, closed: false, messages: [{ role: 'user', content: 'first' }] };
  await saveSessionDurably(session);
  return session;
}

test('a main-thread save waits for the commit holding the lock without blocking the event loop', async () => {
  const id = 'sess_commit_lock_save';
  const session = await seed(id);
  session.messages = [...session.messages, { role: 'assistant', content: 'second' }];
  await underHeldCommit(
    id,
    () =>
      new Promise((resolve) => {
        const unsubscribe = subscribeSessionPersistence((sessionId, event) => {
          if (sessionId !== id || event !== 'landed') return;
          unsubscribe();
          resolve();
        });
        saveSession(session, { immediate: true });
      })
  );
  assert.deepEqual(contents(id), ['first', 'second']);
});

test('a workspace-transition persist waits for the commit holding the lock and is durable when it resolves', async () => {
  const id = 'sess_commit_lock_workspace';
  const session = await seed(id);
  session.cwd = join(root, 'worktree');
  session.messages = [...session.messages, { role: 'assistant', content: 'moved' }];
  await underHeldCommit(id, () => persistWorkspaceSession(session));
  // Read straight after the persist resolved: nothing else was awaited.
  assert.deepEqual(contents(id), ['first', 'moved']);
  assert.equal(onDisk(id).cwd, join(root, 'worktree'));
});

test('a close waits for the commit holding the lock without blocking the event loop', async () => {
  const id = 'sess_commit_lock_close';
  await seed(id);
  assert.equal(await underHeldCommit(id, () => markSessionClosed(id, 'test-close')), 1);
  assert.equal(onDisk(id).closed, true);
  assert.equal(onDisk(id).generation, 1);
});

test('a detach waits for the commit holding the lock without blocking the event loop', async () => {
  const id = 'sess_commit_lock_detach';
  await seed(id);
  assert.equal(await underHeldCommit(id, () => bumpSessionGeneration(id, 'test-detach')), 1);
  assert.equal(onDisk(id).closed, false);
  assert.equal(onDisk(id).generation, 1);
});

test('a delete waits for the commit holding the lock without blocking the event loop', async () => {
  const id = 'sess_commit_lock_delete';
  await seed(id);
  assert.equal(await underHeldCommit(id, () => deleteSession(id)), true);
  assert.equal(existsSync(sessionFile(id)), false);
});
