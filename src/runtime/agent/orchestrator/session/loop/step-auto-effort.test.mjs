import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// A hard judgment: one step above the base (medium → high), two for very hard.
let probs = [0, 0, 0, 1];
// Tests replace this to hold a judgment back.
let judge = async () => ({ probs, ms: 1 });
const original = await import('../../../../effort-judge/judge-client.mjs');
mock.module('../../../../effort-judge/judge-client.mjs', {
  namedExports: {
    ...original,
    judgeTurn: (input) => judge(input),
    recordEffortDecision: () => {},
    effortJudgeSupportsSteps: () => true,
  },
});

const { markStepEffort, applyStepEffort, STEP_EFFORT_GRACE_MS } = await import('./step-auto-effort.mjs');
// The loop's order: the judgment starts after the batch and is applied when the next request is projected.
const markAndApply = async (state, assistant) => {
  markStepEffort(state, assistant);
  await applyStepEffort(state);
};
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
  await markAndApply(state, assistant);
  // Very hard climbs past the declared levels: snapped to the top supported level, not its wire value.
  assert.equal(state.opts.effort, 'high');
  assert.equal(tool.meta.effortConfiguration.mode, 'custom');
  assert.equal(tool.meta.effortConfiguration.effort, 'high');

  probs = [1, 0, 0, 0];
  const next = stepState(provider, snapshot);
  await markAndApply(next.state, next.assistant);
  assert.equal(next.state.opts.effort, 'low');
});

test('a custom GPT-6 Responses step marks the snapped effort as its update and as the request effort', async () => {
  const provider = customProvider('openai-responses', ROW);
  const model = 'openai/gpt-6.1-sol';
  const session = { provider: 'custom-a', model, effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  assert.equal(snapshot.mode, 'responses');
  probs = [0, 0, 0, 1];
  const { state, tool, assistant } = stepState(provider, snapshot);
  state.model = model;
  await markAndApply(state, assistant);
  assert.equal(state.opts.effort, 'high');
  assert.deepEqual(tool.meta.effortConfiguration, { ...snapshot, effort: 'high' });
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
    await markAndApply(state, assistant);
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

const deferredJudge = () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    judge: async () => {
      await gate;
      return { probs, ms: 1 };
    },
    release,
  };
};

function nextBatch(state, id) {
  const assistant = { role: 'assistant', content: 'Next.', toolCalls: [{ id, name: 'read', arguments: {} }] };
  const tool = { role: 'tool', toolCallId: id, content: 'text' };
  state.messages.push(assistant, tool);
  return { assistant, tool };
}

test('a slow step judgment does not hold the next request; its result rides on the request after', async (t) => {
  const provider = customProvider('openai-chat', ROW);
  const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  probs = [0, 0, 0, 1];
  const first = deferredJudge();
  judge = first.judge;
  const { state, tool, assistant } = stepState(provider, snapshot);

  // Batch 1 lands: starting the judgment returns at once; the request waits
  // only the grace for it, then goes out unmarked.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  markStepEffort(state, assistant);
  assert.equal(state.stepEffort.settled, false);
  const waiting = applyStepEffort(state);
  t.mock.timers.tick(STEP_EFFORT_GRACE_MS);
  await waiting;
  t.mock.timers.reset();
  assert.equal(tool.meta, undefined);
  assert.equal(state.opts.effort, 'medium');

  // The judgment resolves while that request is in flight.
  first.release();
  await state.stepEffort.promise;
  await applyStepEffort(state);
  assert.equal(tool.meta, undefined, 'a sent request history is never rewritten');
  assert.equal(state.opts.effort, 'medium');

  // Batch 2 lands: it carries batch 1's judgment for the request after, and a new judgment starts.
  const second = deferredJudge();
  judge = second.judge;
  const next = nextBatch(state, 'c2');
  markStepEffort(state, next.assistant);
  assert.equal(next.tool.meta.effortConfiguration.effort, 'high');
  assert.equal(state.opts.effort, 'high');
  assert.equal(tool.meta, undefined);
  second.release();
  await applyStepEffort(state);
  // The second judgment resolved within the grace: it replaces the carried mark for this request.
  assert.equal(state.stepEffort.applied, true);
  assert.equal(next.tool.meta.effortConfiguration.effort, 'high');
  judge = async () => ({ probs, ms: 1 });
});

test('a judgment that resolves within the grace applies to the very next request', async (t) => {
  const provider = customProvider('openai-chat', ROW);
  const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  probs = [0, 0, 0, 1];
  const slow = deferredJudge();
  judge = slow.judge;
  const { state, tool, assistant } = stepState(provider, snapshot);
  markStepEffort(state, assistant);
  // Frozen grace timer: it is never advanced, so only the judge can settle the wait.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const waiting = applyStepEffort(state).then(() => {
    settled = true;
  });
  slow.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, 'the request settles on the judgment, without waiting out the grace');
  await waiting;
  assert.equal(tool.meta.effortConfiguration.effort, 'high');
  assert.equal(state.opts.effort, 'high');
  judge = async () => ({ probs, ms: 1 });
});

test('a judge that never answers holds a request no longer than the grace', async (t) => {
  const provider = customProvider('openai-chat', ROW);
  const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  judge = () => new Promise(() => {});
  const { state, tool, assistant } = stepState(provider, snapshot);
  markStepEffort(state, assistant);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = applyStepEffort(state);
  t.mock.timers.tick(STEP_EFFORT_GRACE_MS);
  await waiting;
  assert.equal(tool.meta, undefined);
  judge = async () => ({ probs, ms: 1 });
});

test('a step judgment that is ready when the next request is projected rides on it', async () => {
  const provider = customProvider('openai-chat', ROW);
  const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  probs = [0, 0, 0, 1];
  const { state, tool, assistant } = stepState(provider, snapshot);
  markStepEffort(state, assistant);
  await state.stepEffort.promise;
  await applyStepEffort(state);
  assert.equal(tool.meta.effortConfiguration.effort, 'high');
  assert.equal(state.opts.effort, 'high');
});

test('a busy judge queues only the newest step (latest wins); an aborted or replaced turn is never marked', async () => {
  const provider = customProvider('openai-chat', ROW);
  const session = { provider: 'custom-a', model: 'm', effort: 'medium', messages: [] };
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  probs = [0, 0, 0, 1];
  let calls = 0;
  const gate = deferredJudge();
  judge = (input) => {
    calls += 1;
    return gate.judge(input);
  };
  const { state, tool, assistant } = stepState(provider, snapshot);
  markStepEffort(state, assistant);
  const first = state.stepEffort;
  await applyStepEffort(state);
  const second = nextBatch(state, 'c2');
  markStepEffort(state, second.assistant);
  const middle = state.stepEffort;
  const third = nextBatch(state, 'c3');
  markStepEffort(state, third.assistant);
  assert.equal(calls, 1, 'one judgment runs; the newer ones wait behind it');
  assert.equal(first.superseded, true);
  assert.equal(middle.superseded, true);
  gate.release();
  await state.stepEffort.promise;
  assert.equal(calls, 2, 'the skipped middle step never reached the judge');
  assert.equal(middle.result, null);

  // Aborted before the result is applied: nothing is applied.
  const controller = new AbortController();
  state.signal = controller.signal;
  controller.abort();
  assert.ok(state.stepEffort.result, 'the judgment itself resolved');
  const effortBefore = state.opts.effort;
  await applyStepEffort(state);
  assert.equal(third.tool.meta, undefined);
  assert.equal(state.opts.effort, effortBefore);

  // A result for a message that left the transcript (compaction) is dropped.
  const gone = stepState(provider, snapshot);
  judge = async () => ({ probs, ms: 1 });
  markStepEffort(gone.state, gone.assistant);
  await gone.state.stepEffort.promise;
  gone.state.messages.length = 0;
  await applyStepEffort(gone.state);
  assert.equal(gone.tool.meta, undefined);
  assert.equal(tool.meta, undefined);
});
