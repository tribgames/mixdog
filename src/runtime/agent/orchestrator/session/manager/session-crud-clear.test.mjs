import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-clear-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, saveSessionAsync } = await import('../store.mjs');
const { SUMMARY_PREFIX } = await import('../compact.mjs');
const { clearSessionMessages } = await import('./session-crud.mjs');

async function removeDataDir(dir) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 10 || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

test.after(async () => {
  drainSessionStore();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  await removeDataDir(root);
});

const storedSessions = () =>
  readdirSync(join(root, 'sessions'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(root, 'sessions', name), 'utf8')));

async function plantSession(id, messages) {
  const session = {
    id,
    provider: 'openai',
    model: 'gpt-test',
    cwd: root,
    messages,
    generation: 0,
    closed: false,
    totalInputTokens: 120,
    lastContextTokens: 77,
    providerState: { responseId: 'r1' },
    _providerPrefixGuardState: { prefix: 3 },
  };
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return session;
}

test('a plain clear keeps the system layer, resets accounting and forks the outgoing transcript', async () => {
  const id = `sess_clear_plain_${process.pid}_${Date.now()}`;
  const transcript = [
    { role: 'system', content: 'memory layer' },
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: 'hi' },
  ];
  await plantSession(id, transcript);

  const cleared = await clearSessionMessages(id);
  assert.equal(cleared.id, id);
  assert.deepEqual(cleared.messages, [{ role: 'system', content: 'memory layer' }]);
  assert.equal(cleared.totalInputTokens, 0);
  assert.equal(cleared.lastContextTokens, 0);
  assert.equal(cleared.providerState, undefined);
  assert.equal('_providerPrefixGuardState' in cleared, false);
  assert.equal(cleared.compaction.lastStage, 'auto_clear');
  assert.equal(cleared.compaction.lastClearCompactError, null);
  assert.ok(cleared.compaction.lastClearAt > 0);

  drainSessionStore();
  const fork = storedSessions().find((s) => s.id !== id && s.messages?.length === 3);
  assert.ok(fork, 'the outgoing transcript is forked into a resumable session');
  assert.deepEqual(
    fork.messages.map((m) => m.content),
    transcript.map((m) => m.content)
  );
  assert.equal(fork.closed, false);
  assert.equal(fork.totalInputTokens, 0);
});

test('a clear that carries a compact summary forward keeps it and does not fork', async () => {
  const id = `sess_clear_summary_${process.pid}_${Date.now()}`;
  const before = storedSessions().length;
  await plantSession(id, [
    { role: 'system', content: 'memory layer' },
    { role: 'user', content: `${SUMMARY_PREFIX} earlier work summary` },
  ]);

  const cleared = await clearSessionMessages(id, { compact: true, keepCompactSummary: true });
  assert.deepEqual(
    cleared.messages.map((m) => m.role),
    ['system', 'user']
  );
  assert.match(cleared.messages[1].content, /earlier work summary/);
  drainSessionStore();
  assert.equal(storedSessions().length, before + 1, 'no fork for a summary-only transcript');
});

test('clear refuses unknown and closed sessions', async () => {
  assert.equal(await clearSessionMessages('sess_clear_missing'), false);
  const id = `sess_clear_closed_${process.pid}_${Date.now()}`;
  const session = await plantSession(id, [{ role: 'user', content: 'x' }]);
  session.closed = true;
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  assert.equal(await clearSessionMessages(id), false);
});
