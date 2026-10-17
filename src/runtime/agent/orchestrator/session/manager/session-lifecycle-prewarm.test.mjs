// Creating or opening a session starts the effort judge's worker (a spawn
// request only: the session does not wait for the load).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-lifecycle-prewarm-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = join(root, 'data');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

test('createSession and resumeSession request a judge pre-warm for their session', async (t) => {
  const original = await import('./ask-turn-auto-effort.mjs');
  const calls = [];
  t.mock.module('./ask-turn-auto-effort.mjs', {
    namedExports: {
      ...original,
      prewarmSessionAutoEffort: (session, provider) => {
        calls.push({ id: session.id, provider: provider?.name });
        return true;
      },
    },
  });
  const { createSession, resumeSession } = await import(`./session-lifecycle.mjs?prewarm=${Date.now()}`);
  const { deleteSession } = await import('../store.mjs');
  const { _withRegisteredProviderForTest } = await import('../../providers/registry.mjs');
  const session = _withRegisteredProviderForTest('prewarm-test', { name: 'prewarm-test', contextWindow: 128000 }, () =>
    createSession({ provider: 'prewarm-test', model: 'fixture-model', cwd: root })
  );
  t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
  assert.deepEqual(calls, [{ id: session.id, provider: 'prewarm-test' }], 'creating a session requests it');
  await resumeSession(session.id, null);
  assert.equal(calls.length, 2, 'opening a session requests it');
  assert.equal(calls[1].id, session.id);
});
