import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// The judge model is an external dependency; the ladder code under test is real.
const original = await import('../../../../effort-judge/judge-client.mjs');
mock.module('../../../../effort-judge/judge-client.mjs', {
  namedExports: {
    ...original,
    judgeTurn: async () => ({ probs: [0, 0, 0, 1], ms: 1 }),
    recordEffortDecision: () => {},
    effortJudgeSupportsSteps: () => true,
  },
});
const { markStepEffort, applyStepEffort } = await import('./step-auto-effort.mjs');

const ROWS = ['gpt-6.1-warn', 'gpt-6.1-quiet'].map((id) => ({
  id,
  reasoningOptions: [{ type: 'effort', values: ['none'] }],
}));

function stepState(model, base) {
  const assistant = { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] };
  const tool = { role: 'tool', toolCallId: 'c1', content: 'text' };
  const snapshot = {
    version: 1,
    provider: 'openai-oauth',
    model,
    mode: 'responses',
    initialEffort: base,
    effort: base,
  };
  return {
    assistant,
    state: {
      opts: { stepAutoEffort: { request: 'go', base }, effortConfiguration: snapshot, effort: base },
      messages: [{ role: 'user', content: 'go' }, assistant, tool],
      model,
      provider: { config: {} },
      sessionRef: { provider: 'openai-oauth' },
      sessionId: 's1',
    },
  };
}

test('a step on an empty ladder warns once per provider/model; a chosen max skips silently', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-step-warn-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  const originalWrite = process.stderr.write;
  const lines = [];
  process.env.MIXDOG_DATA_DIR = root;
  writeFileSync(join(root, 'openai-oauth-models.json'), JSON.stringify({ models: ROWS }));
  t.after(() => {
    process.stderr.write = originalWrite;
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  const step = async (model, base) => {
    const { state, assistant } = stepState(model, base);
    markStepEffort(state, assistant);
    await applyStepEffort(state);
  };
  const warnings = () => lines.filter((line) => line.startsWith('[auto-effort]'));

  await step('gpt-6.1-warn', 'medium');
  assert.deepEqual(warnings(), ['[auto-effort] no effort ladder for openai-oauth/gpt-6.1-warn; judge skipped\n']);
  await step('gpt-6.1-warn', 'medium');
  assert.equal(warnings().length, 1, 'the same provider/model warns once');

  await step('gpt-6.1-quiet', 'max');
  await step('gpt-6.1-quiet', 'ultra');
  assert.equal(warnings().length, 1, 'a chosen max/ultra skip stays silent');
});
