import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// A hard judgment: one step above the base (medium → high), two for very hard.
let probs = [0, 0, 0, 1];
const original = await import('../../../../effort-judge/judge-client.mjs');
mock.module('../../../../effort-judge/judge-client.mjs', {
  namedExports: {
    ...original,
    judgeTurn: async () => ({ probs, ms: 1 }),
    recordEffortDecision: () => {},
    effortJudgeSupportsSteps: () => true,
  },
});

const { markStepEffort } = await import('./step-auto-effort.mjs');
const { prepareTurnEffortConfiguration } = await import('../../providers/effort-configuration.mjs');
const { resolveTurnAutoEffort, turnStepAutoEffort } = await import('../manager/ask-turn-auto-effort.mjs');
const { resolveCustomReasoning } = await import('../../providers/custom-reasoning.mjs');

const customProvider = (protocol, row) => ({
  config: {},
  customConfig: { protocol },
  getCachedModelInfo: (id) => ({ id, ...row }),
});
const ROW = {
  reasoningLevels: ['low', 'medium', 'high'],
  customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' }, replay: false },
};

function stepState(provider, snapshot) {
  const assistant = { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] };
  const tool = { role: 'tool', toolCallId: 'c1', content: 'text' };
  return {
    assistant,
    tool,
    state: {
      opts: { stepAutoEffort: { request: 'go', base: 'medium' }, effortConfiguration: snapshot, effort: 'medium' },
      messages: [{ role: 'user', content: 'go' }, assistant, tool],
      model: 'm',
      provider,
      sessionRef: { provider: 'custom-a' },
      sessionId: 's1',
    },
  };
}

test('a custom step sends the judged effort, snapped by the custom resolver, as the next request effort', async () => {
  const provider = customProvider('openai-chat', ROW);
  const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  assert.equal(snapshot.mode, 'custom');
  probs = [0, 0, 0, 1];
  const { state, tool, assistant } = stepState(provider, snapshot);
  await markStepEffort(state, assistant);
  // Very hard climbs past the declared levels: snapped to the top supported level, not its wire value.
  assert.equal(state.opts.effort, 'high');
  assert.equal(tool.meta.effortConfiguration.mode, 'custom');
  assert.equal(tool.meta.effortConfiguration.effort, 'high');

  probs = [1, 0, 0, 0];
  const next = stepState(provider, snapshot);
  await markStepEffort(next.state, next.assistant);
  assert.equal(next.state.opts.effort, 'low');
});

test('turn auto effort judges custom Chat/Responses routes with levels and skips the rest', async (t) => {
  const saved = process.env.MIXDOG_AUTO_EFFORT;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_AUTO_EFFORT;
    else process.env.MIXDOG_AUTO_EFFORT = saved;
  });
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  probs = [0, 0, 1, 0];
  const ask = (protocol, row) =>
    resolveTurnAutoEffort({
      sessionId: 's1',
      session: { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] },
      provider: customProvider(protocol, row),
      input: { prompt: 'fix the failing build' },
    });
  for (const protocol of ['openai-chat', 'openai-responses']) {
    const resolved = await ask(protocol, ROW);
    assert.equal(resolved.effort, 'high');
    assert.equal(resolved.applied, true);
  }
  assert.equal(await ask('openai-chat', { reasoningLevels: [] }), null);
  assert.equal(await ask('openai-chat', {}), null);
  assert.equal(await ask('anthropic', ROW), null);
});

test('per-step auto effort runs end to end on custom Chat/Responses routes with levels, off elsewhere', async (t) => {
  const saved = process.env.MIXDOG_AUTO_EFFORT;
  t.after(() => {
    if (saved === undefined) delete process.env.MIXDOG_AUTO_EFFORT;
    else process.env.MIXDOG_AUTO_EFFORT = saved;
  });
  process.env.MIXDOG_AUTO_EFFORT = 'on';
  // The same chain prepareAskTurn runs: turn judgment → effort configuration → step gate.
  const turn = async (protocol, row) => {
    const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
    const provider = customProvider(protocol, row);
    probs = [0, 0, 1, 0];
    const autoEffort = await resolveTurnAutoEffort({
      sessionId: 's1',
      session,
      provider,
      input: { prompt: 'fix the failing build' },
    });
    const effortConfiguration = prepareTurnEffortConfiguration(
      session,
      provider,
      autoEffort?.applied ? autoEffort.effort : undefined
    );
    return { provider, effortConfiguration, step: turnStepAutoEffort(autoEffort, effortConfiguration) };
  };
  for (const protocol of ['openai-chat', 'openai-responses']) {
    const { provider, effortConfiguration, step } = await turn(protocol, ROW);
    assert.deepEqual(step, { request: 'fix the failing build', base: 'medium' }, protocol);
    const { state, assistant } = stepState(provider, effortConfiguration);
    state.opts.stepAutoEffort = step;
    probs = [0, 0, 0, 1];
    await markStepEffort(state, assistant);
    assert.equal(state.opts.effort, 'high', protocol);
    // The next request of the turn serializes that level with the row's wire value.
    const { fields } = resolveCustomReasoning({
      protocol,
      model: provider.getCachedModelInfo('m'),
      effort: state.opts.effort,
    });
    assert.deepEqual(fields, protocol === 'openai-chat' ? { reasoning_effort: 'H' } : { reasoning: { effort: 'H' } });
  }
  for (const [protocol, row] of [
    ['anthropic', ROW],
    ['openai-chat', {}],
    ['openai-chat', { reasoningLevels: [] }],
  ]) {
    const { effortConfiguration, step } = await turn(protocol, row);
    assert.equal(effortConfiguration, null, protocol);
    assert.equal(step, null, protocol);
  }
});
