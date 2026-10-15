// Anthropic Messages request/result contract: request-wide cache breakpoint
// limit, eligible-block placement, system block shapes, tool_choice mapping,
// max_tokens ceilings, and stop/usage carry-through.
import assert from 'node:assert/strict';
import test from 'node:test';

import { _buildRequestBodyForCacheSmoke } from './anthropic-oauth.mjs';
import { buildAnthropicApiRequest } from './anthropic-api-request.mjs';
import { resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';
import { buildAnthropicTurnResult } from './anthropic-turn-result.mjs';
import { systemBlockItems } from './lib/anthropic-system-blocks.mjs';
import {
  applyAnthropicCacheMarkers,
  countAnthropicCacheControls,
  normalizeAnthropicNonStreamingResponse,
  resolveAnthropicMessageCacheSlots,
  toAnthropicToolChoice,
} from './lib/anthropic-request-utils.mjs';

const eph = { type: 'ephemeral' };
const MODEL = 'claude-sonnet-4-5';
const TOOLS = [{ name: 'read', description: 'd', inputSchema: { type: 'object', properties: {} } }];

test('cache slots: tool markers count toward the request-wide limit', () => {
  const sys = [1, 2, 3].map(() => ({ type: 'text', text: 'x', cache_control: eph }));
  const r = resolveAnthropicMessageCacheSlots(sys, { messages: eph }, { tools: [{ name: 't', cache_control: eph }] });
  assert.equal(r.messageSlots, 0);
  assert.equal(r.messageTtl, null);
  const ok = resolveAnthropicMessageCacheSlots(sys, { messages: eph });
  assert.equal(ok.messageSlots, 1);
});

test('cache markers: preserved message markers are limited to the remaining budget (oldest dropped)', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'a', cache_control: eph }] },
    { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: eph }] },
    { role: 'user', content: [{ type: 'text', text: 'c', cache_control: eph }] },
  ];
  applyAnthropicCacheMarkers(msgs, { messageTtl: eph, messageSlots: 1, reservedSlots: 2 });
  assert.equal(countAnthropicCacheControls(msgs), 2);
  assert.equal(msgs[0].content[0].cache_control, undefined);
  assert.ok(msgs[2].content[0].cache_control);
});

test('cache markers: no new marker when system+tools already use all 4', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }];
  applyAnthropicCacheMarkers(msgs, { messageTtl: eph, messageSlots: 1, reservedSlots: 4 });
  assert.equal(countAnthropicCacheControls(msgs), 0);
});

test('cache markers: skip thinking and empty text, pick last eligible block', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'thinking', thinking: 't', signature: 's' },
        { type: 'redacted_thinking', data: 'd' },
      ],
    },
  ];
  applyAnthropicCacheMarkers(msgs, { messageTtl: eph, messageSlots: 1 });
  assert.ok(msgs[1].content[0].cache_control);
  assert.equal(msgs[1].content[1].cache_control, undefined);
  assert.equal(msgs[1].content[2].cache_control, undefined);
  const empty = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: '' },
  ];
  applyAnthropicCacheMarkers(empty, { messageTtl: eph, messageSlots: 1 });
  assert.ok(empty[0].content[0].cache_control);
});

test('ordinary request keeps tail marker byte-identical on both providers', async () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
  ];
  const oauth = _buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, {});
  const api = (
    await buildAnthropicApiRequest({ name: 'anthropic', config: {}, messages, useModel: MODEL, tools: TOOLS, opts: {}, fastModeLatched: false })
  ).params;
  for (const body of [oauth, api]) {
    assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: eph }] }]);
    assert.equal(body.tool_choice, undefined);
    assert.equal('tool_choice' in body, false);
  }
});

test('request: native tool markers reduce message slots', () => {
  const native = [1, 2, 3, 4].map((i) => ({ type: 'web_search_20250305', name: `w${i}`, cache_control: eph }));
  const body = _buildRequestBodyForCacheSmoke([{ role: 'user', content: 'hi' }], MODEL, TOOLS, { nativeTools: native });
  assert.ok(countAnthropicCacheControls(body.tools) + countAnthropicCacheControls(body.system || []) + countAnthropicCacheControls(body.messages) <= 4);
});

test('systemBlockItems accepts string and text-block arrays, rejects unknown shapes', () => {
  assert.deepEqual(systemBlockItems('  hi '), [{ text: 'hi', tier: 'system' }]);
  assert.deepEqual(systemBlockItems([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]).map((i) => i.text), ['a', 'b']);
  assert.deepEqual(
    systemBlockItems([{ role: 'system', cacheTier: 'tier3', content: [{ type: 'text', text: 'z' }] }]),
    [{ text: 'z', tier: 'tier3' }]
  );
  assert.deepEqual(systemBlockItems(undefined), []);
  assert.throws(() => systemBlockItems([{ role: 'system', content: [{ type: 'image' }] }]), TypeError);
});

test('system role message with block-array content reaches the wire', () => {
  const body = _buildRequestBodyForCacheSmoke(
    [{ role: 'system', content: [{ type: 'text', text: 'structured rules' }] }, { role: 'user', content: 'hi' }],
    MODEL,
    [],
    {}
  );
  assert.ok(body.system.some((b) => b.text.includes('structured rules')));
});

test('toAnthropicToolChoice mapping and thinking awareness', () => {
  assert.deepEqual(toAnthropicToolChoice('none'), { type: 'none' });
  assert.deepEqual(toAnthropicToolChoice('auto'), { type: 'auto' });
  assert.deepEqual(toAnthropicToolChoice('required'), { type: 'any' });
  assert.deepEqual(toAnthropicToolChoice({ name: 'read' }), { type: 'tool', name: 'read' });
  assert.equal(toAnthropicToolChoice(undefined), undefined);
  assert.equal(toAnthropicToolChoice('required', { thinking: true }), undefined);
  assert.throws(() => toAnthropicToolChoice({ name: 'x' }, { thinking: true, onThinkingConflict: 'error' }));
  assert.deepEqual(toAnthropicToolChoice(undefined, { disableParallelToolUse: true }), {
    type: 'auto',
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(toAnthropicToolChoice('required', { disableParallelToolUse: true }), {
    type: 'any',
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(toAnthropicToolChoice('none', { disableParallelToolUse: true }), { type: 'none' });
  assert.equal(toAnthropicToolChoice(undefined, { disableParallelToolUse: true, supportsDisableParallelToolUse: false }), undefined);
});

test('request wires tool_choice, parallel disable and gateway capability', async () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const build = (config, opts) =>
    buildAnthropicApiRequest({ name: 'anthropic', config, messages, useModel: MODEL, tools: TOOLS, opts, fastModeLatched: false });
  assert.deepEqual((await build({}, { toolChoice: 'required' })).params.tool_choice, { type: 'any' });
  assert.deepEqual((await build({}, { disableParallelToolUse: true })).params.tool_choice, {
    type: 'auto',
    disable_parallel_tool_use: true,
  });
  assert.equal((await build({ supportsDisableParallelToolUse: false }, { disableParallelToolUse: true })).params.tool_choice, undefined);
  assert.deepEqual(_buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, { toolChoice: 'none' }).tool_choice, { type: 'none' });
});

test('max tokens: declared limit is a ceiling; gateway limit wins; env capped', () => {
  const saved = process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
  try {
    delete process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup: () => 4096 }), 4096);
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup: () => 64000, modelMaxOutputTokens: 2048 }), 2048);
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup: () => 4096, modelMaxOutputTokens: null }), 4096);
    process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS = '100000';
    assert.equal(resolveAnthropicMaxTokens('claude-x', { catalogLookup: () => 4096 }), 4096);
    assert.equal(resolveAnthropicMaxTokens('claude-x', { modelMaxOutputTokens: 8000 }), 8000);
  } finally {
    if (saved === undefined) delete process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS;
    else process.env.MIXDOG_ANTHROPIC_MAX_OUTPUT_TOKENS = saved;
  }
});

test('turn result carries stopDetails, stopSequence and raw usage', () => {
  const raw = { input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 3 } };
  const parse = {
    content: 'x',
    stopReason: 'refusal',
    stopDetails: { category: 'cyber' },
    stopSequence: 'END',
    usage: { inputTokens: 1, outputTokens: 2, raw },
  };
  const r = buildAnthropicTurnResult(parse, { provider: 'anthropic', useModel: MODEL, opts: {} });
  assert.deepEqual(r.stopDetails, { category: 'cyber' });
  assert.equal(r.stopSequence, 'END');
  assert.deepEqual(r.usage.raw, raw);
  const plain = buildAnthropicTurnResult({ content: 'x', usage: {} }, { provider: 'anthropic', useModel: MODEL, opts: {} });
  assert.equal('stopDetails' in plain, false);
  assert.equal('stopSequence' in plain, false);
  assert.equal('raw' in plain.usage, false);
});

test('non-streaming normalize carries stop fields, raw usage and tool_search replay', () => {
  const message = {
    model: MODEL,
    stop_reason: 'pause_turn',
    stop_sequence: 'END',
    stop_details: { category: 'x' },
    usage: { input_tokens: 1, output_tokens: 2, server_tool_use: { web_search_requests: 1 } },
    content: [
      { type: 'text', text: 'looking' },
      { type: 'server_tool_use', id: 'srv_1', name: 'tool_search_tool_regex', input: { query: 'a' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srv_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } },
    ],
  };
  const r = normalizeAnthropicNonStreamingResponse(message);
  assert.equal(r.stopSequence, 'END');
  assert.deepEqual(r.stopDetails, { category: 'x' });
  assert.deepEqual(r.usage.raw.server_tool_use, { web_search_requests: 1 });
  assert.deepEqual(r.assistantBlocks.map((b) => b.type), ['text', 'server_tool_use', 'tool_search_tool_result']);
  const plain = normalizeAnthropicNonStreamingResponse({ content: [{ type: 'text', text: 'a' }], usage: {} });
  assert.equal('stopDetails' in plain, false);
  assert.equal('stopSequence' in plain, false);
});

test('serverToolUse and costUsd are normalized on streaming usage, non-streaming and the API-key result', async () => {
  const { updateTurnUsage } = await import('./anthropic-sse-turn/turn-state.mjs');
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null };
  updateTurnUsage(usage, { input_tokens: 5, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } });
  updateTurnUsage(usage, { output_tokens: 7, cost: 0.0123 });
  assert.deepEqual(usage.serverToolUse, { webSearchRequests: 1, webFetchRequests: 0 });
  assert.equal(usage.costUsd, 0.0123);
  const none = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null };
  updateTurnUsage(none, { input_tokens: 1, cost: null });
  assert.equal('serverToolUse' in none, false);
  assert.equal('costUsd' in none, false);

  const nonStreaming = normalizeAnthropicNonStreamingResponse({
    content: [{ type: 'text', text: 'a' }],
    usage: { input_tokens: 1, output_tokens: 2, cost: 0.5, server_tool_use: { web_search_requests: 2 } },
  });
  assert.equal(nonStreaming.usage.costUsd, 0.5);
  assert.deepEqual(nonStreaming.usage.serverToolUse, { webSearchRequests: 2 });

  const r = buildAnthropicTurnResult({ content: 'x', usage }, { provider: 'anthropic', useModel: MODEL, opts: {} });
  assert.equal(r.usage.costUsd, 0.0123);
  assert.deepEqual(r.usage.serverToolUse, { webSearchRequests: 1, webFetchRequests: 0 });
  const plain = buildAnthropicTurnResult({ content: 'x', usage: {} }, { provider: 'anthropic', useModel: MODEL, opts: {} });
  assert.equal('serverToolUse' in plain.usage, false);
  assert.equal('costUsd' in plain.usage, false);
});

test('system markers are capped to the slots tools leave, earliest dropped first', () => {
  const sys = [1, 2, 3, 4].map((i) => ({ type: 'text', text: `s${i}`, cache_control: eph }));
  const r = resolveAnthropicMessageCacheSlots(sys, { messages: eph }, { tools: [{ name: 't', cache_control: eph }] });
  assert.deepEqual(sys.map((b) => Boolean(b.cache_control)), [false, true, true, true]);
  assert.equal(r.reservedSlots, 4);
  assert.equal(r.messageSlots, 0);
});

test('five tool markers are trimmed to the request-wide limit, earliest dropped, caller objects untouched', async () => {
  const tools = [1, 2, 3, 4, 5].map((i) => ({ name: `t${i}`, cache_control: eph }));
  const originals = tools.slice();
  const sys = [{ type: 'text', text: 's', cache_control: eph }];
  const r = resolveAnthropicMessageCacheSlots(sys, { messages: eph }, { tools });
  assert.deepEqual(tools.map((t) => Boolean(t.cache_control)), [false, true, true, true, true]);
  assert.ok(originals.every((t) => t.cache_control), 'shared tool objects are not mutated');
  assert.equal(sys[0].cache_control, undefined);
  assert.equal(r.reservedSlots, 4);
  assert.equal(r.messageSlots, 0);

  const native = [1, 2, 3, 4, 5].map((i) => ({ type: 'web_search_20250305', name: `w${i}`, cache_control: eph }));
  const messages = [{ role: 'system', content: 'a' }, { role: 'user', content: 'hi' }];
  const oauth = _buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, { nativeTools: native });
  const api = (await buildAnthropicApiRequest({ name: 'anthropic', config: {}, messages, useModel: MODEL, tools: TOOLS, opts: { nativeTools: native }, fastModeLatched: false })).params;
  for (const body of [oauth, api]) {
    const total = countAnthropicCacheControls(body.system) + countAnthropicCacheControls(body.tools) + countAnthropicCacheControls(body.messages);
    assert.ok(total <= 4, `total ${total}`);
    assert.ok(body.tools.filter((t) => t.cache_control).at(-1), 'latest tool marker kept');
  }
});

test('request with 1 native-tool marker never exceeds 4 breakpoints in total', () => {
  const native = [{ type: 'web_search_20250305', name: 'w', cache_control: eph }];
  const messages = [
    { role: 'system', content: 'a' },
    { role: 'system', content: 'b' },
    { role: 'system', cacheTier: 'tier3', content: 'c' },
    { role: 'system', content: 'd' },
    { role: 'user', content: 'hi' },
  ];
  const body = _buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, { nativeTools: native });
  const total = countAnthropicCacheControls(body.system) + countAnthropicCacheControls(body.tools) + countAnthropicCacheControls(body.messages);
  assert.ok(total <= 4, `total ${total}`);
  assert.ok(body.system.at(-1).cache_control, 'latest system marker kept');
});