import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveTurnAutoEffort } from './ask-turn-auto-effort.mjs';

const ENV_KEYS = ['MIXDOG_AUTO_EFFORT', 'MIXDOG_EFFORT_JUDGE_DIR', 'MIXDOG_EFFORT_DECISIONS_LOG', 'MIXDOG_DATA_DIR'];

// A cached catalog row that declares no usable ladder (only `none`): the route
// still has an effort configuration, but Auto effort has nothing to move along.
const ROWS = ['gpt-6.1-warn', 'gpt-6.1-quiet'].map((id) => ({
  id,
  reasoningOptions: [{ type: 'effort', values: ['none'] }],
}));

test('an empty ladder warns once per provider/model, whatever effort was chosen', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-auto-effort-warn-'));
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalWrite = process.stderr.write;
  const lines = [];
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  process.env.MIXDOG_EFFORT_JUDGE_DIR = root;
  process.env.MIXDOG_EFFORT_DECISIONS_LOG = join(root, 'decisions.jsonl');
  process.env.MIXDOG_DATA_DIR = root;
  writeFileSync(join(root, 'openai-oauth-models.json'), JSON.stringify({ models: ROWS }));
  t.after(() => {
    process.stderr.write = originalWrite;
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  });
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  const run = (model, effort) =>
    resolveTurnAutoEffort({
      sessionId: `${model}-${effort}`,
      session: { provider: 'openai-oauth', model, effort, messages: [] },
      provider: { config: {} },
      input: { prompt: 'fix the failing test' },
    });
  const warnings = () => lines.filter((line) => line.startsWith('[auto-effort]'));

  assert.equal(await run('gpt-6.1-warn', 'high'), null);
  assert.deepEqual(warnings(), ['[auto-effort] no effort ladder for openai-oauth/gpt-6.1-warn; judge skipped\n']);
  assert.equal(await run('gpt-6.1-warn', 'high'), null);
  assert.equal(warnings().length, 1, 'the same provider/model warns once');

  // The base is the setting, not the chosen effort, so a saved max/ultra on an
  // empty ladder warns once per model like any other level.
  for (const effort of ['max', 'ultra']) assert.equal(await run('gpt-6.1-quiet', effort), null);
  assert.deepEqual(warnings(), [
    '[auto-effort] no effort ladder for openai-oauth/gpt-6.1-warn; judge skipped\n',
    '[auto-effort] no effort ladder for openai-oauth/gpt-6.1-quiet; judge skipped\n',
  ]);
});
