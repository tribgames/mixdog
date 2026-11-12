// Creating or opening a session does not start the effort judge's worker: it
// loads on a judged turn and unloads when idle, as the embedding model does.
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

test('createSession and resumeSession start no effort judge on a route Auto effort can judge', async (t) => {
  const original = await import('../../../../effort-judge/judge-client.mjs');
  let starts = 0;
  t.mock.module('../../../../effort-judge/judge-client.mjs', {
    namedExports: {
      ...original,
      prewarmEffortJudge: () => {
        starts += 1;
        return true;
      },
    },
  });
  const savedMode = process.env.MIXDOG_AUTO_EFFORT;
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  t.after(() => {
    if (savedMode === undefined) delete process.env.MIXDOG_AUTO_EFFORT;
    else process.env.MIXDOG_AUTO_EFFORT = savedMode;
  });
  const { createSession, resumeSession } = await import(`./session-lifecycle.mjs?prewarm=${Date.now()}`);
  const { deleteSession } = await import('../store.mjs');
  const { _withRegisteredProviderForTest } = await import('../../providers/registry.mjs');
  const session = _withRegisteredProviderForTest('anthropic-oauth', { name: 'anthropic-oauth', contextWindow: 200000 }, () =>
    createSession({ provider: 'anthropic-oauth', model: 'claude-opus-5-5', cwd: root })
  );
  t.after(() => deleteSession(session.id, { deferSummaryUpdate: true }));
  await resumeSession(session.id, null);
  assert.equal(starts, 0, 'neither creating nor opening the session starts the judge');
});
