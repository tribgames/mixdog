// Auto effort must stay applicable on every main route, even when the provider
// catalog cache is cold: a silently empty ladder skips every judgment.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { autoEffortApplicable, autoEffortBase } from './auto-effort.mjs';
import { autoEffortModel, turnEffortConfigurationMode } from './effort-configuration.mjs';
import { effortOptionsFor } from '../runtime-core/effort.mjs';

const ROUTES = [
  ['anthropic-oauth', 'claude-opus-5-5'],
  ['anthropic-oauth', 'claude-sonnet-5-5'],
  ['anthropic', 'claude-opus-5-5'],
  ['anthropic', 'claude-sonnet-5-5'],
  ['openai', 'gpt-6.1-sol'],
];

function withDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-auto-effort-routes-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

// The provider's own cached model row, as route resolution reads it.
function route(provider, model, row = null) {
  const providerImpl = { config: {}, getCachedModelInfo: (id) => (row && id === row.id ? row : null) };
  const session = { provider, model, effort: 'xhigh', modelParameters: {}, messages: [] };
  const options = effortOptionsFor(provider, autoEffortModel(provider, providerImpl, model));
  return {
    providerImpl,
    session,
    mode: turnEffortConfigurationMode(session, providerImpl),
    applicable: autoEffortApplicable({ base: autoEffortBase('xhigh'), options }),
    options,
  };
}

for (const [provider, model] of ROUTES) {
  test(`${provider}/${model} is judged with an empty catalog cache`, (t) => {
    withDataDir(t);
    const { mode, applicable, options } = route(provider, model);
    assert.ok(mode, `${provider}/${model} has an effort configuration`);
    assert.ok(applicable, `${provider}/${model} has an auto effort ladder (options: ${options.join(',') || 'none'})`);
  });
}

test('openai-oauth/gpt-6.1-sol is judged with a cached catalog row', (t) => {
  withDataDir(t);
  const { mode, applicable } = route('openai-oauth', 'gpt-6.1-sol', {
    id: 'gpt-6.1-sol',
    reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
  });
  assert.ok(mode);
  assert.ok(applicable);
});

test('openai-oauth with an empty catalog cache is not judged, and says so on stderr', async (t) => {
  withDataDir(t);
  const model = 'gpt-6.1-cold-catalog';
  const { mode, applicable, session, providerImpl } = route('openai-oauth', model);
  assert.ok(mode, 'the route still has an effort configuration');
  assert.equal(applicable, false, 'no catalog row means no ladder: the judge is skipped, not faked');

  const keys = ['MIXDOG_AUTO_EFFORT', 'MIXDOG_EFFORT_JUDGE_DIR', 'MIXDOG_EFFORT_DECISIONS_LOG'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const judgeDir = mkdtempSync(join(tmpdir(), 'mixdog-auto-effort-routes-judge-'));
  const originalWrite = process.stderr.write;
  const lines = [];
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  process.env.MIXDOG_EFFORT_JUDGE_DIR = judgeDir;
  process.env.MIXDOG_EFFORT_DECISIONS_LOG = join(judgeDir, 'decisions.jsonl');
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  t.after(() => {
    process.stderr.write = originalWrite;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(judgeDir, { recursive: true, force: true });
  });
  const { resolveTurnAutoEffort } = await import('../session/manager/ask-turn-auto-effort.mjs');
  const result = await resolveTurnAutoEffort({
    sessionId: 'cold',
    session: { ...session, effort: 'high' },
    provider: providerImpl,
    input: { prompt: 'fix the failing test' },
  });
  assert.equal(result, null);
  assert.deepEqual(
    lines.filter((line) => line.startsWith('[auto-effort]')),
    [`[auto-effort] no effort ladder for openai-oauth/${model}; judge skipped\n`]
  );
});
