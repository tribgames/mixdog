import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_EFFORT_LEVELS,
  customEffortLevels,
  resolveCustomReasoning,
  snapCustomEffort,
} from './custom-reasoning.mjs';
import { applyCompatProviderChatOptions } from './openai-compat-options.mjs';
import { sendCompatChat } from './openai-compat-chat-send.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { toOpenAIMessages } from './openai-compat-wire.mjs';
import { buildAnthropicApiRequest } from './anthropic-api-request.mjs';
import { setModelEffortCapabilities } from './anthropic-effort.mjs';
import { coerceEffortFor, effortOptionsFor } from '../runtime-core/effort.mjs';

function row(levels, customReasoning = {}, extra = {}) {
  return {
    id: 'm1',
    provider: 'custom-x',
    hidden: false,
    manual: true,
    supportsReasoning: Array.isArray(levels) && levels.length > 0,
    ...(levels ? { reasoningOptions: [{ type: 'effort', values: levels }], reasoningLevels: levels } : {}),
    customReasoning: { wireFormat: 'standard', wireValues: {}, replay: false, ...customReasoning },
    ...extra,
  };
}

test('snapping table: exact keep, none only when supported, never promote', () => {
  const cases = [
    // [supported, requested, expected]
    [['low', 'medium', 'high'], 'medium', 'medium'],
    [['low', 'medium', 'high'], 'max', 'high'],
    [['low', 'medium', 'high'], 'xhigh', 'high'],
    [['low', 'medium', 'high'], 'ultra', 'high'],
    [['low', 'medium', 'high'], 'minimal', null],
    [['low', 'medium', 'high'], 'none', null],
    [['none', 'low', 'high'], 'none', 'none'],
    [['none', 'low', 'high'], 'medium', 'low'],
    [['none', 'low', 'high'], 'minimal', null],
    [['none', 'high'], 'low', null],
    [['high', 'max'], 'low', null],
    [['high', 'max'], 'xhigh', 'high'],
    [['high', 'max'], 'ultra', 'max'],
    [['minimal', 'max'], 'high', 'minimal'],
    [['max'], 'max', 'max'],
    [['ultra'], 'max', 'max'],
    [['none'], 'high', null],
    [['none'], 'none', 'none'],
    [[], 'high', null],
    [null, 'high', null],
    [['low', 'high'], null, null],
    [['low', 'high'], '', null],
    [['low', 'high'], 'auto', null],
    [['low', 'high'], 'bogus', null],
  ];
  for (const [supported, requested, expected] of cases) {
    assert.equal(snapCustomEffort(supported, requested), expected, `${JSON.stringify(supported)} ${requested}`);
    if (supported !== null) {
      assert.equal(
        resolveCustomReasoning({ protocol: 'openai-chat', model: row(supported), effort: requested }).level,
        expected
      );
    }
  }
  // Exhaustive invariant: the snapped level is supported and never stronger.
  for (let mask = 0; mask < 1 << CUSTOM_EFFORT_LEVELS.length; mask++) {
    const supported = CUSTOM_EFFORT_LEVELS.filter((_, i) => mask & (1 << i));
    for (const requested of CUSTOM_EFFORT_LEVELS) {
      const level = snapCustomEffort(supported, requested);
      if (level === null) continue;
      assert.ok(supported.includes(level));
      assert.ok(CUSTOM_EFFORT_LEVELS.indexOf(level) <= CUSTOM_EFFORT_LEVELS.indexOf(requested));
      if (requested !== 'none') assert.notEqual(level, 'none');
    }
  }
});

test('levels: reasoningOptions wins over reasoningLevels, [] means none, missing is unknown', () => {
  assert.deepEqual(
    customEffortLevels({ reasoningOptions: [{ type: 'effort', values: ['high', 'low'] }], reasoningLevels: ['max'] }),
    ['low', 'high']
  );
  assert.deepEqual(customEffortLevels({ reasoningLevels: ['max', 'ultra', 'none'] }), ['none', 'max']);
  assert.deepEqual(customEffortLevels({ reasoningOptions: [{ type: 'effort', values: [] }] }), []);
  assert.equal(customEffortLevels({}), null);
  const none = resolveCustomReasoning({ protocol: 'openai-chat', model: row(undefined), effort: 'high' });
  assert.deepEqual(none, { level: null, fields: {}, thinking: null, replay: false });
  const unset = resolveCustomReasoning({ protocol: 'openai-chat', model: row(['low', 'high']), effort: undefined });
  assert.deepEqual(unset.fields, {});
  assert.equal(unset.level, null);
});

test('wire value mapping applies after snapping', () => {
  const model = row(['low', 'high'], { wireValues: { high: 'HIGH_WIRE', max: 'MAX_WIRE' } });
  const r = resolveCustomReasoning({ protocol: 'openai-chat', model, effort: 'max' });
  assert.equal(r.level, 'high');
  assert.deepEqual(r.fields, { reasoning_effort: 'HIGH_WIRE' });
  assert.deepEqual(resolveCustomReasoning({ protocol: 'openai-chat', model, effort: 'medium' }).fields, {
    reasoning_effort: 'low',
  });
});

test('protocol and wireFormat serialization', () => {
  const levels = ['none', 'low', 'high'];
  const std = row(levels);
  const ds = row(levels, { wireFormat: 'deepseek', wireValues: { high: 'max' } });
  assert.deepEqual(resolveCustomReasoning({ protocol: 'openai-chat', model: std, effort: 'high' }), {
    level: 'high',
    fields: { reasoning_effort: 'high' },
    thinking: 'on',
    replay: false,
  });
  assert.deepEqual(resolveCustomReasoning({ protocol: 'openai-chat', model: std, effort: 'none' }).fields, {
    reasoning_effort: 'none',
  });
  assert.deepEqual(resolveCustomReasoning({ protocol: 'openai-chat', model: ds, effort: 'high' }).fields, {
    thinking: { type: 'enabled' },
    reasoning_effort: 'max',
  });
  const dsOff = resolveCustomReasoning({ protocol: 'openai-chat', model: ds, effort: 'none' });
  assert.deepEqual(dsOff.fields, { thinking: { type: 'disabled' } });
  assert.equal(dsOff.thinking, 'off');
  assert.deepEqual(resolveCustomReasoning({ protocol: 'openai-responses', model: std, effort: 'low' }).fields, {
    reasoning: { effort: 'low' },
  });
  assert.deepEqual(resolveCustomReasoning({ protocol: 'anthropic', model: std, effort: 'high' }).fields, {
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  });
  assert.deepEqual(resolveCustomReasoning({ protocol: 'anthropic', model: std, effort: 'none' }).fields, {
    thinking: { type: 'disabled' },
  });
  // DeepSeek wire format is Chat-only: other protocols get nothing.
  for (const protocol of ['openai-responses', 'anthropic']) {
    assert.deepEqual(resolveCustomReasoning({ protocol, model: ds, effort: 'high' }), {
      level: null,
      fields: {},
      thinking: null,
      replay: false,
    });
  }
});

test('replay eligibility: flag, thinking off, reasoner ids, non-chat, explicit false over catalog', () => {
  const on = row(['none', 'high'], { wireFormat: 'deepseek', replay: true });
  assert.equal(resolveCustomReasoning({ protocol: 'openai-chat', model: on, effort: 'high' }).replay, true);
  assert.equal(resolveCustomReasoning({ protocol: 'openai-chat', model: on, effort: undefined }).replay, true);
  assert.equal(resolveCustomReasoning({ protocol: 'openai-chat', model: on, effort: 'none' }).replay, false);
  assert.equal(
    resolveCustomReasoning({ protocol: 'openai-chat', model: { ...on, id: 'My-Reasoner-1' }, effort: 'high' }).replay,
    false
  );
  assert.equal(
    resolveCustomReasoning({ protocol: 'openai-responses', model: row(['high'], { replay: true }), effort: 'high' })
      .replay,
    false
  );
  const explicitFalse = row(['high'], { replay: false }, { reasoningContentField: 'reasoning_content' });
  assert.equal(resolveCustomReasoning({ protocol: 'openai-chat', model: explicitFalse, effort: 'high' }).replay, false);
});

test('toOpenAIMessages custom replay: stored reasoning, tool-call padding, no padding without tool calls', () => {
  const history = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'ok' },
    { role: 'assistant', content: '', reasoningContent: '', toolCalls: [{ id: 'c2', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'c2', content: 'ok' },
    {
      role: 'assistant',
      content: '',
      reasoningContent: 'thought',
      toolCalls: [{ id: 'c3', name: 't', arguments: {} }],
    },
    { role: 'tool', toolCallId: 'c3', content: 'ok' },
    { role: 'assistant', content: 'done' },
    { role: 'assistant', content: 'done2', reasoningContent: '' },
  ];
  const assistants = (msgs) => msgs.filter((m) => m.role === 'assistant');
  const replayed = assistants(toOpenAIMessages(history, 'custom-x', { customReplay: true }));
  assert.deepEqual(
    replayed.map((m) => (Object.hasOwn(m, 'reasoning_content') ? m.reasoning_content : undefined)),
    [' ', ' ', 'thought', undefined, undefined]
  );
  // Explicit false wins even when the catalog-derived flag says replay.
  const off = assistants(toOpenAIMessages(history, 'custom-x', { customReplay: false, replaysReasoningContent: true }));
  assert.ok(off.every((m) => !Object.hasOwn(m, 'reasoning_content')));
  // First-party DeepSeek keeps the exact stored value (no padding).
  const ds = assistants(toOpenAIMessages(history, 'deepseek', { replaysReasoningContent: true }));
  assert.deepEqual(
    ds.map((m) => (Object.hasOwn(m, 'reasoning_content') ? m.reasoning_content : undefined)),
    [undefined, '', 'thought', undefined, '']
  );
  const xai = assistants(toOpenAIMessages(history, 'xai'));
  assert.equal(xai[0].reasoning_content, undefined);
  assert.equal(xai[2].reasoning_content, 'thought');
});

test('chat options: custom branch uses the model row; first-party branches unchanged', () => {
  const ds = row(['none', 'low', 'high'], { wireFormat: 'deepseek' });
  assert.deepEqual(applyCompatProviderChatOptions({ model: 'm1' }, 'custom-x', { effort: 'xhigh' }, {}, ds), {
    model: 'm1',
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(applyCompatProviderChatOptions({ model: 'm1' }, 'custom-x', { effort: 'minimal' }, {}, ds), {
    model: 'm1',
  });
  assert.deepEqual(applyCompatProviderChatOptions({ model: 'm1' }, 'custom-x', { effort: 'high' }, {}, null), {
    model: 'm1',
  });
  assert.deepEqual(applyCompatProviderChatOptions({ model: 'x' }, 'deepseek', { effort: 'medium' }), {
    model: 'x',
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  assert.deepEqual(applyCompatProviderChatOptions({ model: 'x' }, 'openrouter', { effort: 'none' }), {
    model: 'x',
    reasoning: { enabled: false },
  });
});

function compatFixture(name, info) {
  const requests = [];
  const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
    name,
    config: { preconnect: false },
    nativePdf: false,
    getCachedModelInfo: (id) => (info && info.id === id ? info : null),
    client: {
      chat: {
        completions: {
          create: async (params) => {
            requests.push(structuredClone(params));
            return (async function* () {
              yield {
                choices: [{ index: 0, delta: { content: 'done', reasoning_content: 'r' }, finish_reason: 'stop' }],
              };
            })();
          },
        },
      },
      responses: {
        create: async (params) => {
          requests.push(structuredClone(params));
          return (async function* () {
            yield {
              type: 'response.completed',
              response: {
                id: 'resp',
                model: params.model,
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
              },
            };
          })();
        },
      },
    },
  });
  return { provider, requests };
}

const toolHistory = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
  { role: 'tool', toolCallId: 'c1', content: 'ok' },
];

test('sendCompatChat: custom provider resolves from its row and replays with padding', async () => {
  const info = row(['none', 'high'], { wireFormat: 'deepseek', replay: true });
  const { provider, requests } = compatFixture('custom-x', info);
  const result = await sendCompatChat(provider, toolHistory, 'm1', [], { effort: 'max' });
  assert.deepEqual(requests[0].thinking, { type: 'enabled' });
  assert.equal(requests[0].reasoning_effort, 'high');
  assert.equal(requests[0].messages.find((m) => m.role === 'assistant').reasoning_content, ' ');
  assert.equal(result.reasoningContent, 'r');

  const off = compatFixture('custom-x', info);
  await sendCompatChat(off.provider, toolHistory, 'm1', [], { effort: 'none' });
  assert.deepEqual(off.requests[0].thinking, { type: 'disabled' });
  assert.equal(
    Object.hasOwn(
      off.requests[0].messages.find((m) => m.role === 'assistant'),
      'reasoning_content'
    ),
    false
  );
});

test('sendCompatResponses: custom provider snaps without promotion', async () => {
  const info = row(['high', 'max'], { wireValues: { max: 'ultra-wire' } });
  const a = compatFixture('custom-r', info);
  await sendCompatResponses(a.provider, [{ role: 'user', content: 'hi' }], 'm1', [], { effort: 'ultra' });
  assert.deepEqual(a.requests[0].reasoning, { effort: 'ultra-wire' });
  const b = compatFixture('custom-r', info);
  await sendCompatResponses(b.provider, [{ role: 'user', content: 'hi' }], 'm1', [], { effort: 'low' });
  assert.equal(Object.hasOwn(b.requests[0], 'reasoning'), false);
});

async function anthropicRequest(name, modelInfo, effort, model = 'claude-opus-5') {
  return buildAnthropicApiRequest({
    name,
    config: {},
    messages: [{ role: 'user', content: 'hi' }],
    useModel: model,
    tools: [],
    opts: { effort },
    fastModeLatched: false,
    modelInfo,
  });
}

test('anthropic custom vs first-party with the same model id stay isolated', async () => {
  try {
    // A custom row (even if it reached the index writer) must not change first-party capability.
    setModelEffortCapabilities([
      { id: 'claude-opus-5', provider: 'custom-a', reasoningOptions: [{ type: 'effort', values: [] }] },
    ]);
    const first = await anthropicRequest('anthropic', null, 'high');
    assert.equal(first.params.thinking?.type, 'adaptive');
    assert.deepEqual(first.params.output_config, { effort: 'high' });
    assert.match(first.requestHeaders['anthropic-beta'], /effort-2025-11-24/);

    // Custom row declaring no reasoning: nothing sent despite the Claude id.
    const noneRow = { ...row([]), id: 'claude-opus-5', provider: 'custom-a' };
    const custom = await anthropicRequest('custom-a', noneRow, 'high');
    assert.equal(Object.hasOwn(custom.params, 'thinking'), false);
    assert.equal(Object.hasOwn(custom.params, 'output_config'), false);
    // No row-driven beta and no first-party base betas: no beta header at all.
    assert.equal(custom.requestHeaders, null);
    assert.equal(Object.hasOwn(custom.params, 'fallbacks'), false);

    // First-party index says only `low`; the custom row's own levels still win.
    setModelEffortCapabilities([{ id: 'claude-opus-5', reasoningOptions: [{ type: 'effort', values: ['low'] }] }]);
    const richRow = { ...row(['low', 'medium', 'xhigh'], { wireValues: { xhigh: 'x-wire' } }), id: 'claude-opus-5' };
    const rich = await anthropicRequest('custom-a', richRow, 'max');
    assert.deepEqual(rich.params.thinking, { type: 'adaptive' });
    assert.deepEqual(rich.params.output_config, { effort: 'x-wire' });
    assert.match(rich.requestHeaders['anthropic-beta'], /effort-2025-11-24/);
    const disabled = await anthropicRequest('custom-a', { ...row(['none', 'low']), id: 'claude-opus-5' }, 'none');
    assert.deepEqual(disabled.params.thinking, { type: 'disabled' });
    assert.equal(Object.hasOwn(disabled.params, 'output_config'), false);
    // A non-Claude id on a custom anthropic endpoint still gets its declared reasoning.
    const other = await anthropicRequest('custom-a', { ...row(['high']), id: 'glm-x' }, 'high', 'glm-x');
    assert.deepEqual(other.params.output_config, { effort: 'high' });
  } finally {
    setModelEffortCapabilities([]);
  }
});

test('effort.mjs: custom rows are authoritative and never promote; first-party unchanged', () => {
  assert.deepEqual(effortOptionsFor('custom-x', { ...row([]), family: 'opus' }), []);
  assert.deepEqual(effortOptionsFor('custom-x', { ...row(undefined), family: 'opus' }), []);
  assert.deepEqual(effortOptionsFor('custom-x', row(['high', 'low', 'ultra'])), ['low', 'high', 'max']);
  assert.equal(coerceEffortFor('custom-x', row(['high', 'max']), 'low'), null);
  assert.equal(coerceEffortFor('custom-x', row(['low', 'high']), 'xhigh'), 'high');
  assert.equal(coerceEffortFor('custom-x', row(['low', 'high']), 'none'), null);
  assert.equal(coerceEffortFor('custom-x', row(['none', 'high']), 'none'), 'none');
  // First-party fallback still promotes minimal → low.
  assert.equal(coerceEffortFor('anthropic', { family: 'opus' }, 'minimal'), 'low');
  assert.deepEqual(effortOptionsFor('anthropic', { family: 'opus', reasoningLevels: [] }), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
});
