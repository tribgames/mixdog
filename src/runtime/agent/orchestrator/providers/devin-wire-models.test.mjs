import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVIN_ENUMS, decodeDevinMessage, encodeDevinMessage } from './devin-wire-protobuf.mjs';
import { DEVIN_GET_CLI_MODEL_CONFIGS_PATH, fetchDevinModels, normalizeDevinModels } from './devin-wire-models.mjs';

const { DisplayOption } = DEVIN_ENUMS;

function config(uid, { label = uid, features, displayOption, isModelRouter, harnessUids, ...rest } = {}) {
  const modelInfo = {};
  if (features) modelInfo.modelFeatures = features;
  if (displayOption !== undefined) modelInfo.displayOption = displayOption;
  if (isModelRouter !== undefined) modelInfo.isModelRouter = isModelRouter;
  if (harnessUids) modelInfo.harnessUids = harnessUids;
  if (rest.maxOutputTokens) modelInfo.maxOutputTokens = rest.maxOutputTokens;
  delete rest.maxOutputTokens;
  return { modelUid: uid, label, ...(Object.keys(modelInfo).length ? { modelInfo } : {}), ...rest };
}

// Round-trip through the wire so fixtures match what discovery decodes.
const wireConfigs = (configs) =>
  decodeDevinMessage(
    'GetCliModelConfigsResponse',
    encodeDevinMessage('GetCliModelConfigsResponse', { clientModelConfigs: configs })
  ).clientModelConfigs;

const fixtures = wireConfigs([
  config('gpt-x-high', {
    label: 'GPT X High',
    maxTokens: 400_000,
    maxOutputTokens: 128_000,
    description: '  Frontier model ',
    features: {
      supportsImages: true,
      supportsToolCalls: true,
      supportsThinking: true,
      supportsParallelToolCalls: true,
    },
  }),
  config('gpt-x-low', { label: 'GPT X Low', features: { supportsToolCalls: true, supportsThinking: true } }),
  config('gpt-x-high', { label: 'duplicate loses' }),
  config('retired', { disabled: true }),
  config('quick-review', { displayOption: DisplayOption.QUICK_REVIEW }),
  config('internal-default', { displayOption: DisplayOption.INTERNAL_DEFAULT }),
  config('arena-visible', { displayOption: DisplayOption.NORMAL }),
  config('adaptive', { label: 'Adaptive', displayOption: DisplayOption.MODEL_ROUTER }),
  config('fusion', { isModelRouter: true, harnessUids: ['fusion'] }),
  config('fusion-gpt-x-high-sidekick-swe-2', { isModelRouter: true, harnessUids: ['fusion'] }),
  config('labelled-thinking', { label: 'Claude Thinking', supportsImages: true }),
  config('labelled-off', { label: 'Claude High (No Thinking)' }),
  config('features-say-no', { label: 'Max Reasoning', features: { supportsThinking: false } }),
  config('swe-1-6', { label: 'SWE-1.6', features: { supportsImages: true, supportsToolCalls: true } }),
  config('swe-1-6-slow', { label: 'SWE-1.6 Slow', features: { supportsImages: true, supportsToolCalls: true } }),
  config('', { label: 'no uid' }),
]);

test('normalization keeps each enabled, visible uid, routers included', () => {
  const rows = normalizeDevinModels(fixtures);
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      'adaptive',
      'arena-visible',
      'features-say-no',
      'fusion',
      'gpt-x-high',
      'gpt-x-low',
      'labelled-off',
      'labelled-thinking',
      'swe-1-6',
      'swe-1-6-slow',
    ]
  );
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(byId['gpt-x-high'], {
    id: 'gpt-x-high',
    name: 'GPT X High',
    description: 'Frontier model',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsVision: true,
    supportsTools: true,
    supportsParallelToolCalls: true,
    reasoning: true,
    supportsReasoning: true,
    uid: 'gpt-x-high',
  });
  assert.deepEqual(byId['gpt-x-low'], {
    id: 'gpt-x-low',
    name: 'GPT X Low',
    description: '',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsVision: false,
    supportsTools: true,
    supportsParallelToolCalls: false,
    reasoning: true,
    supportsReasoning: true,
    uid: 'gpt-x-low',
  });
  // A harness-less router needs AssignModel and gets safe defaults.
  assert.deepEqual(byId.adaptive, {
    id: 'adaptive',
    name: 'Adaptive',
    description: '',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsVision: false,
    supportsTools: true,
    supportsParallelToolCalls: false,
    reasoning: false,
    supportsReasoning: false,
    uid: 'adaptive',
    router: true,
  });
  // A harness-backed composite chats on its own uid.
  assert.equal(byId.fusion.router, undefined);
  assert.equal(byId.fusion.uid, 'fusion');
  // A Fusion pairing would run only its lead, so it is not listed.
  assert.equal(byId['fusion-gpt-x-high-sidekick-swe-2'], undefined);
  // No features: label heuristic for reasoning, top-level image flag, tools assumed.
  assert.equal(byId['labelled-thinking'].reasoning, true);
  assert.equal(byId['labelled-thinking'].supportsVision, true);
  assert.equal(byId['labelled-thinking'].supportsTools, true);
  assert.equal(byId['labelled-off'].reasoning, false);
  // Features outrank the label.
  assert.equal(byId['features-say-no'].reasoning, false);
  assert.equal(byId['features-say-no'].supportsTools, false);
  // Backend drops images for this lane despite the flag.
  assert.equal(byId['swe-1-6'].supportsVision, false);
  assert.equal(byId['swe-1-6-slow'].supportsVision, false);
});

function discoveryServer(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const metadata = decodeDevinMessage('GetCliModelConfigsRequest', init.body).metadata;
    calls.push({ url, metadata, redirect: init.redirect });
    const configs = handler(metadata);
    return new Response(encodeDevinMessage('GetCliModelConfigsResponse', { clientModelConfigs: configs }));
  };
  return { calls, fetchFn };
}

test('discovery uses the native identity with the session token and returns raw configs', async () => {
  const { calls, fetchFn } = discoveryServer(() => [config('glm-5'), config('swe-1-6')]);
  const configs = await fetchDevinModels({ sessionToken: 'tok', fetchFn, baseUrl: 'https://devin.test/' });
  assert.deepEqual(
    configs.map((entry) => entry.modelUid),
    ['glm-5', 'swe-1-6']
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://devin.test${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`);
  assert.equal(calls[0].metadata.apiKey, 'devin-session-token$tok');
  assert.equal(calls[0].metadata.ideName, 'chisel');
  assert.equal(calls[0].metadata.ideVersion, '0.0.0-dev');
  assert.deepEqual(calls[0].metadata.supportedModelDisplays, [3, 4, 6, 7, 8]);
  assert.equal(calls[0].redirect, 'error');
});

const uids = (configs) => configs.map((entry) => entry.modelUid);
const isLegacy = (metadata) => metadata.ideName === 'windsurf';

test('a seed-only native catalog falls back to the legacy identity with the raw key', async () => {
  const { calls, fetchFn } = discoveryServer((metadata) =>
    isLegacy(metadata)
      ? [config('swe-1-6'), config('swe-1-6-fast'), config('glm-5')]
      : [config('swe-1-6'), config('swe-1-6-fast')]
  );
  assert.deepEqual(uids(await fetchDevinModels({ sessionToken: 'legacy-key', fetchFn })), [
    'swe-1-6',
    'swe-1-6-fast',
    'glm-5',
  ]);
  assert.deepEqual(
    calls.map((call) => call.metadata),
    [
      { ...calls[0].metadata, ideName: 'chisel', apiKey: 'devin-session-token$legacy-key' },
      {
        apiKey: 'legacy-key',
        ideName: 'windsurf',
        ideVersion: '3.2.23',
        extensionName: 'windsurf',
        extensionVersion: '1.48.2',
        locale: 'en',
      },
    ]
  );
});

test('the legacy catalog wins only when native failed or it is strictly larger', async () => {
  // Legacy not larger: the native seed stays.
  let server = discoveryServer((metadata) => (isLegacy(metadata) ? [config('glm-5')] : [config('swe-1-6')]));
  assert.deepEqual(uids(await fetchDevinModels({ sessionToken: 't', fetchFn: server.fetchFn })), ['swe-1-6']);
  // Native empty (or only unusable configs): legacy is asked; empty legacy keeps native.
  server = discoveryServer((metadata) => (isLegacy(metadata) ? [] : [config('retired', { disabled: true })]));
  assert.deepEqual(uids(await fetchDevinModels({ sessionToken: 't', fetchFn: server.fetchFn })), ['retired']);
  assert.equal(server.calls.length, 2);
  // Native failure: any legacy answer wins, even an empty one.
  const failing = (legacyConfigs) => async (_url, init) => {
    const metadata = decodeDevinMessage('GetCliModelConfigsRequest', init.body).metadata;
    if (!isLegacy(metadata)) return new Response('{"code":"unauthenticated"}', { status: 401 });
    return new Response(encodeDevinMessage('GetCliModelConfigsResponse', { clientModelConfigs: legacyConfigs }));
  };
  assert.deepEqual(uids(await fetchDevinModels({ sessionToken: 't', fetchFn: failing([config('glm-5')]) })), ['glm-5']);
  assert.deepEqual(uids(await fetchDevinModels({ sessionToken: 't', fetchFn: failing([]) })), []);
  // Both fail: the native error surfaces.
  const bothFail = async () => new Response('{"code":"unauthenticated","message":"expired"}', { status: 401 });
  await assert.rejects(fetchDevinModels({ sessionToken: 't', fetchFn: bothFail }), { code: 'unauthenticated' });
  // A full native catalog makes exactly one request.
  server = discoveryServer(() => [config('glm-5'), config('swe-1-6')]);
  await fetchDevinModels({ sessionToken: 't', fetchFn: server.fetchFn });
  assert.equal(server.calls.length, 1);
  await assert.rejects(fetchDevinModels({ sessionToken: '', fetchFn: server.fetchFn }), { code: 'unauthenticated' });
});

test('a caller abort stops discovery without falling back', async () => {
  const controller = new AbortController();
  controller.abort();
  const { calls, fetchFn } = discoveryServer(() => [config('glm-5')]);
  await assert.rejects(fetchDevinModels({ sessionToken: 't', fetchFn, signal: controller.signal }), {
    code: 'aborted',
  });
  assert.equal(calls.length, 0);
});

test('discovery shares one 5 s deadline and reports it as a retryable timeout', async (t) => {
  let calls = 0;
  // Fire the deadline on the next turn instead of waiting it out; the requested span is recorded.
  const spans = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    spans.push(ms);
    const controller = new AbortController();
    setImmediate(() => controller.abort(new DOMException('timed out', 'TimeoutError')));
    return controller.signal;
  });
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      calls++;
      if (init.signal.aborted) return reject(new DOMException('timed out', 'TimeoutError'));
      init.signal.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
    });
  await assert.rejects(fetchDevinModels({ sessionToken: 't', fetchFn: hang }), {
    code: 'unavailable',
    retryable: true,
    message: /timed out after 5000 ms/,
  });
  assert.deepEqual(spans, [5000]);
  // The legacy attempt runs on the already-expired deadline and never reaches fetch.
  assert.equal(calls, 1);
});

test('a router keeps its uid against later duplicates', () => {
  const rows = normalizeDevinModels(
    wireConfigs([
      config('dup', { displayOption: DisplayOption.MODEL_ROUTER }),
      config('dup', { label: 'later concrete duplicate' }),
      config('hidden', { displayOption: DisplayOption.QUICK_REVIEW }),
      config('hidden', { label: 'visible after hidden' }),
    ])
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.name, row.router]),
    [
      ['dup', 'dup', true],
      ['hidden', 'visible after hidden', undefined],
    ]
  );
});

const byIdOf = (configs, options) =>
  Object.fromEntries(normalizeDevinModels(wireConfigs(configs), options).map((row) => [row.id, row]));
const reasons = { features: { supportsThinking: true, supportsToolCalls: true } };
const familyMeta = (label, entries, isDefaultModelInFamily = false) => ({
  modelFamilyMetadata: {
    modelFamilyLabel: label,
    entries: Object.entries(entries).map(([key, [order, name]]) => ({ key, value: { order, name } })),
    isDefaultModelInFamily,
  },
});

test('server-declared families collapse into one model with an effort axis', () => {
  const rows = byIdOf([
    config('nova-low', { ...reasons, maxTokens: 100_000, ...familyMeta('Nova 2', { Effort: [0, 'Low'] }) }),
    config('nova-high', {
      ...reasons,
      maxTokens: 300_000,
      supportsImages: true,
      features: { supportsThinking: true, supportsToolCalls: true, supportsImages: true },
      ...familyMeta('Nova 2', { 'Reasoning Effort': [1, 'High'] }, true),
    }),
    config('nova-none', { ...reasons, ...familyMeta('Nova 2', { Effort: [2, 'None'] }) }),
    // Fast mode and 1M context are separate lanes, not axes.
    config('nova-high-fast', {
      ...reasons,
      ...familyMeta('Nova 2', { Effort: [0, 'High'], 'Fast Mode': [1, 'On'] }),
    }),
    config('nova-x-high-1m', {
      ...reasons,
      ...familyMeta('Nova 2', { Effort: [0, 'X High'], '1M Context': [1, 'On'] }),
    }),
    // Thinking axis: order 0 is the off route even with a "High" effort label.
    config('claude-z-high', { ...reasons, ...familyMeta('Claude Z', { Effort: [0, 'High'], Thinking: [0, 'Off'] }) }),
    config('claude-z-high-thinking', {
      ...reasons,
      ...familyMeta('Claude Z', { Effort: [0, 'High'], Thinking: [1, 'On'] }),
    }),
    // A family with no effort axis leaves its members alone.
    config('plain-a', familyMeta('Plain', { Size: [0, 'A'] })),
  ]);
  assert.deepEqual(Object.keys(rows).sort(), ['claude-z', 'nova-2', 'nova-2-1m', 'nova-2-fast', 'plain-a']);
  assert.deepEqual(rows['nova-2'], {
    id: 'nova-2',
    name: 'Nova 2',
    description: '',
    // Widest member limits, union of modalities.
    contextWindow: 300_000,
    maxOutputTokens: 64_000,
    supportsVision: true,
    // Non-limit fields come from the first (default) member.
    supportsTools: true,
    supportsParallelToolCalls: false,
    supportsReasoning: true,
    reasoning: true,
    uid: 'nova-high',
    reasoningLevels: ['none', 'low', 'high'],
    effortUids: { none: 'nova-none', low: 'nova-low', high: 'nova-high' },
    defaultEffort: 'high',
  });
  assert.deepEqual(rows['nova-2-fast'].effortUids, { high: 'nova-high-fast' });
  assert.equal(rows['nova-2-fast'].requiresEffort, true);
  assert.equal(rows['nova-2-fast'].name, 'Nova 2 Fast');
  assert.equal(rows['nova-2-1m'].name, 'Nova 2 1M');
  assert.deepEqual(rows['nova-2-1m'].reasoningLevels, ['xhigh']);
  assert.deepEqual(rows['claude-z'].effortUids, { none: 'claude-z-high', high: 'claude-z-high-thinking' });
  assert.equal(rows['claude-z'].uid, 'claude-z-high');
  assert.equal(rows['plain-a'].reasoningLevels, undefined);
});

test('the reviewed family table collapses siblings that ship no family metadata', () => {
  const rows = byIdOf([
    config('gpt-5-6-sol-none', reasons),
    config('gpt-5-6-sol-low', reasons),
    config('gpt-5-6-sol-high', reasons),
    config('gemini-3-7-flash-low', reasons),
    config('gemini-3-7-flash-medium', reasons),
    config('MODEL_PRIVATE_11', { label: 'Haiku', ...reasons }),
    config('swe-1-7', reasons),
  ]);
  assert.deepEqual(Object.keys(rows).sort(), ['claude-haiku-4-5', 'gemini-3-7-flash', 'gpt-5-6-sol', 'swe-1-7']);
  const sol = rows['gpt-5-6-sol'];
  assert.equal(sol.name, 'GPT-5.6 Sol');
  assert.equal(sol.uid, 'gpt-5-6-sol-none');
  assert.deepEqual(sol.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  // Tiers the account does not serve run on the default uid.
  assert.deepEqual(sol.effortUids, {
    none: 'gpt-5-6-sol-none',
    low: 'gpt-5-6-sol-low',
    medium: 'gpt-5-6-sol-none',
    high: 'gpt-5-6-sol-high',
    xhigh: 'gpt-5-6-sol-none',
    max: 'gpt-5-6-sol-none',
  });
  assert.equal(sol.requiresEffort, undefined);
  const flash = rows['gemini-3-7-flash'];
  assert.equal(flash.uid, 'gemini-3-7-flash-medium');
  assert.equal(flash.defaultEffort, 'medium');
  assert.equal(flash.requiresEffort, true);
  assert.deepEqual(flash.reasoningLevels, ['minimal', 'low', 'medium', 'high']);
  // A single-uid rename has no effort surface.
  assert.equal(rows['claude-haiku-4-5'].uid, 'MODEL_PRIVATE_11');
  assert.equal(rows['claude-haiku-4-5'].name, 'Claude Haiku 4.5');
  assert.equal(rows['claude-haiku-4-5'].reasoningLevels, undefined);
  // A family member that is its own family id.
  assert.equal(rows['swe-1-7'].uid, 'swe-1-7');
  assert.deepEqual(rows['swe-1-7'].effortUids, { medium: 'swe-1-7', max: 'swe-1-7' });
});

test('the reviewed default member re-points a server-declared family default', () => {
  const lane = (uid, effort) => config(uid, { ...reasons, ...familyMeta('Grok 4.6', { Effort: [0, effort] }) });
  const rows = byIdOf([lane('grok-4-6-low', 'Low'), lane('grok-4-6-medium', 'Medium'), lane('grok-4-6-high', 'High')]);
  assert.equal(rows['grok-4-6'].uid, 'grok-4-6-medium');
  assert.equal(rows['grok-4-6'].defaultEffort, undefined);
});

test('live X / X-thinking twins pair unless priced differently or claimed', () => {
  const priced = (input) => ({
    modelDimensions: [{ label: 'Input', value: input, denominator: '1M tokens', kind: 1 }],
  });
  const rows = byIdOf([
    config('model-q', { label: 'Model Q', ...priced(1) }),
    config('model-q-thinking', priced(1)),
    config('model-r', priced(1)),
    config('model-r-thinking', priced(2)),
    config('model-s', priced(0)),
    config('model-s-reasoning-pro', priced(3)),
    config('model-s-pro', priced(3)),
  ]);
  assert.deepEqual(Object.keys(rows).sort(), ['model-q', 'model-r', 'model-r-thinking', 'model-s', 'model-s-pro']);
  assert.deepEqual(rows['model-q'].reasoningLevels, ['none', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(rows['model-q'].effortUids, {
    none: 'model-q',
    minimal: 'model-q-thinking',
    low: 'model-q-thinking',
    medium: 'model-q-thinking',
    high: 'model-q-thinking',
  });
  assert.equal(rows['model-q'].uid, 'model-q');
  assert.equal(rows['model-q'].name, 'Model Q');
  // Infix token pairs with its bare twin.
  assert.equal(rows['model-s-pro'].effortUids.high, 'model-s-reasoning-pro');
});

test('thinking pairs of every model class use the same fallback effort ladder', () => {
  // Classes whose reviewed ladders differ elsewhere (Claude, GPT, Gemini, Qwen,
  // DeepSeek) still get minimal..high: Devin trusts only reported surfaces.
  const ids = ['claude-zz-9', 'gpt-zz-9', 'gemini-zz-9', 'qwen9-zz', 'deepseek-zz-9'];
  const rows = byIdOf(ids.flatMap((id) => [config(id, reasons), config(`${id}-thinking`, reasons)]));
  for (const id of ids) {
    assert.deepEqual(rows[id].reasoningLevels, ['none', 'minimal', 'low', 'medium', 'high'], id);
    assert.equal(rows[id].requiresEffort, undefined, id);
    assert.equal(rows[id].defaultEffort, undefined, id);
  }
});

test('presentation flags reach rows only when set, through collapsing too', () => {
  const rows = byIdOf([
    config('flagged', { isNew: true, isBeta: true, isRecommended: true }),
    config('plain'),
    config('gpt-5-6-sol-none', { ...reasons, isNew: true }),
    config('gpt-5-6-sol-high', { ...reasons, isBeta: true }),
  ]);
  assert.equal(rows.flagged.isNew, true);
  assert.equal(rows.flagged.isBeta, true);
  assert.equal(rows.flagged.isRecommended, true);
  assert.deepEqual(
    ['isNew', 'isBeta', 'isRecommended'].filter((flag) => flag in rows.plain),
    []
  );
  // A collapsed family takes its first member's flags.
  assert.equal(rows['gpt-5-6-sol'].isNew, true);
  assert.equal(rows['gpt-5-6-sol'].isBeta, undefined);
});

test('the account default sets its family default effort and uid', () => {
  const configs = wireConfigs([
    config('gpt-5-6-sol-none', reasons),
    config('gpt-5-6-sol-high', reasons),
    config('other', reasons),
  ]);
  configs.defaultModelUid = 'gpt-5-6-sol-high';
  const rows = Object.fromEntries(normalizeDevinModels(configs).map((row) => [row.id, row]));
  assert.equal(rows['gpt-5-6-sol'].isDefault, true);
  assert.equal(rows['gpt-5-6-sol'].uid, 'gpt-5-6-sol-high');
  assert.equal(rows['gpt-5-6-sol'].defaultEffort, 'high');
  assert.equal(rows.other.isDefault, undefined);
  const plain = Object.fromEntries(
    normalizeDevinModels(configs, { defaultModelUid: 'other' }).map((row) => [row.id, row])
  );
  assert.equal(plain.other.isDefault, true);
  assert.equal(plain['gpt-5-6-sol'].uid, 'gpt-5-6-sol-none');
});

test('discovery carries the account default and compares collapsed catalog sizes', async () => {
  const server = (nativeConfigs, legacyConfigs) => async (_url, init) => {
    const metadata = decodeDevinMessage('GetCliModelConfigsRequest', init.body).metadata;
    const legacy = metadata.ideName === 'windsurf';
    return new Response(
      encodeDevinMessage('GetCliModelConfigsResponse', {
        clientModelConfigs: legacy ? legacyConfigs : nativeConfigs,
        defaultOverrideModelConfig: { modelUid: legacy ? 'gpt-5-6-sol-low' : ' swe-1-6 ' },
      })
    );
  };
  // Two legacy configs collapse into one model: not larger than the native seed.
  let configs = await fetchDevinModels({
    sessionToken: 't',
    fetchFn: server([config('swe-1-6')], [config('gpt-5-6-sol-low', reasons), config('gpt-5-6-sol-high', reasons)]),
  });
  assert.deepEqual(uids(configs), ['swe-1-6']);
  assert.equal(configs.defaultModelUid, 'swe-1-6');
  assert.equal(normalizeDevinModels(configs)[0].isDefault, true);
  // Two collapsed legacy models beat one native seed row.
  configs = await fetchDevinModels({
    sessionToken: 't',
    fetchFn: server([config('swe-1-6')], [config('gpt-5-6-sol-low', reasons), config('glm-5', reasons)]),
  });
  assert.deepEqual(uids(configs), ['gpt-5-6-sol-low', 'glm-5']);
  assert.equal(configs.defaultModelUid, 'gpt-5-6-sol-low');
});
