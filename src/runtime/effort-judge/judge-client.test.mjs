import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the model refresh starts on the first judged turn, once, and not on import', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-judge-client-'));
  const saved = { dir: process.env.MIXDOG_EFFORT_JUDGE_DIR, data: process.env.MIXDOG_DATA_DIR };
  delete process.env.MIXDOG_EFFORT_JUDGE_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    for (const [key, value] of [
      ['MIXDOG_EFFORT_JUDGE_DIR', saved.dir],
      ['MIXDOG_DATA_DIR', saved.data],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  let installs = 0;
  t.mock.module('./model-install.mjs', {
    namedExports: {
      effortJudgeInstallCurrent: () => false,
      effortJudgeInstallStamped: () => false,
      installEffortJudgeModel: async () => {
        installs += 1;
        throw new Error('offline in test');
      },
    },
  });
  t.mock.method(process.stderr, 'write', () => true);
  const client = await import(`./judge-client.mjs?lazy=${Date.now()}`);
  assert.equal(installs, 0, 'importing the client downloads nothing');
  await client.judgeTurn({ request: 'first' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installs, 1, 'the first judged turn starts the refresh');
  await client.judgeTurn({ request: 'second' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installs, 1, 'later turns do not start another');
});
