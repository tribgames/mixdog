import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CASES,
  DEFERRED_TOOLS,
  FN_CALL,
  SESSION_TOOLS,
  TS_CALL,
  TS_OUTPUT,
  TURN_OUTPUT,
  captureBodies,
  sendXaiResponses,
  sendXaiResponsesWebSocket,
  serverSearchEvents,
  serverSearchHistory,
  ws,
  xaiProvider,
} from './xai-tool-search.fixtures.mjs';

import { useXaiResponsesWebSocket } from './openai-compat-xai.mjs';

const ON = { xaiServerToolSearch: true };

// Request bodies captured by running the same fixtures against the pre-change
// (HEAD) xAI send path; see xai-tool-search.fixtures.mjs.
const HEAD = JSON.parse(readFileSync(new URL('./xai-tool-search-head-parity.json', import.meta.url), 'utf8'));

const types = (input) => input.map((item) => item.type || item.role);
const searchItems = (input) =>
  input.filter((item) => item.type === 'tool_search_call' || item.type === 'tool_search_output');

// Documented exception to the parity guarantee: xAI/Grok WebSocket RESULTS now
// always carry the owner-tagged providerReplay (encrypted reasoning and any
// server tool-search items) so it survives to the next turn, whatever
// `xaiServerToolSearch` says. Request bodies for these fixed histories are
// unchanged, hence the baseline file is still valid.
test('option OFF (unset, false, or opts false): xAI HTTP and WebSocket bodies match the pre-change code byte for byte', async () => {
  for (const [label, build, tools] of CASES) {
    for (const variant of [{}, { config: { xaiServerToolSearch: false } }, { opts: { xaiServerToolSearch: false } }]) {
      const actual = await captureBodies(build(), tools, variant);
      assert.deepEqual(actual.http, HEAD[`http/${label}`], `http/${label}`);
      assert.deepEqual(actual.ws, HEAD[`ws/${label}`], `ws/${label}`);
      // Deferred tools stay plain function tools: no tool_search tool, no defer_loading.
      for (const body of [actual.http, actual.ws]) {
        assert.equal(
          body.tools.some((tool) => tool.type === 'tool_search' || 'defer_loading' in tool),
          false,
          label
        );
      }
    }
  }
});

test('option ON: deferred tools carry defer_loading and the client loader becomes the server tool_search', async () => {
  for (const via of ['config', 'opts']) {
    const variant = via === 'config' ? { config: ON } : { opts: ON };
    const { http, ws: socketBody } = await captureBodies(serverSearchHistory(), DEFERRED_TOOLS, variant);
    for (const body of [http, socketBody]) {
      assert.deepEqual(
        body.tools.map((tool) => [tool.type, tool.name, tool.defer_loading]),
        [
          ['function', 'Read', undefined],
          ['tool_search', undefined, undefined],
          ['function', 'mcp__weather__forecast', true],
        ],
        via
      );
      assert.deepEqual(body.tools[1], { type: 'tool_search' });
      assert.equal(
        body.tools.some((tool) => tool.name === 'load_tool' || tool.name === 'tool_search'),
        false
      );
      assert.equal(body.parallel_tool_calls, true);
    }
  }
  // The history lowering is the same as OFF: only the tools differ.
  const on = await captureBodies(serverSearchHistory(), DEFERRED_TOOLS, { config: ON });
  assert.deepEqual(on.http.input, HEAD['http/server-replay/deferred-tools'].input);
  assert.deepEqual(on.ws.input, HEAD['ws/server-replay/deferred-tools'].input);
});

test('option ON: the server tool_search is added for deferred tools without a loader, and only once', async () => {
  const noLoader = DEFERRED_TOOLS.filter((tool) => tool.name !== 'load_tool');
  const { http } = await captureBodies(serverSearchHistory(), noLoader, { config: ON });
  assert.deepEqual(
    http.tools.map((tool) => tool.type === 'tool_search'),
    [false, false, true]
  );
  assert.equal(http.tools[1].defer_loading, true);
  const both = [...SESSION_TOOLS, { name: 'tool_search', description: 'alias', inputSchema: { type: 'object' } }];
  const twice = await captureBodies(serverSearchHistory(), both, { config: ON });
  assert.equal(twice.http.tools.filter((tool) => tool.type === 'tool_search').length, 1);
  // No deferred tools and no loader: nothing to add.
  const plain = await captureBodies(serverSearchHistory(), [SESSION_TOOLS[0]], { config: ON });
  assert.equal(
    plain.http.tools.some((tool) => tool.type === 'tool_search'),
    false
  );
});

function assertServerSearchTurn(result, dispatched, label) {
  // The server ran the search inside the response: only the function call is Mixdog's.
  assert.deepEqual(
    result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [['call_w', 'mcp__weather__forecast', { city: 'Seoul' }]],
    label
  );
  assert.deepEqual(
    dispatched.map((call) => call.id),
    ['call_w'],
    label
  );
  assert.equal(result.providerReplay.provider, 'xai-responses', label);
  assert.deepEqual(
    result.providerReplay.items.map((item) => item.type),
    types(TURN_OUTPUT),
    label
  );
  assert.deepEqual(searchItems(result.providerReplay.items), [TS_CALL, TS_OUTPUT], label);
}

function assertReplayedVerbatim(input, label) {
  // Native items, in order, byte for byte; their results are never function_call_output.
  assert.deepEqual(searchItems(input), [TS_CALL, TS_OUTPUT], label);
  assert.deepEqual(
    types(input),
    ['user', 'reasoning', 'tool_search_call', 'tool_search_output', 'function_call', 'function_call_output', 'user'],
    label
  );
  assert.deepEqual(
    input.filter((item) => item.type === 'function_call_output').map((item) => item.call_id),
    ['call_w'],
    label
  );
  assert.equal(
    input.some((item) => item.type === 'tool_search_output' && item.execution !== 'server'),
    false,
    label
  );
  assert.deepEqual(
    input.find((item) => item.type === 'function_call'),
    FN_CALL,
    label
  );
}

function nextTurnHistory(result) {
  return [
    { role: 'user', content: 'weather in Seoul?' },
    {
      role: 'assistant',
      content: result.content || '',
      toolCalls: result.toolCalls,
      providerReplay: result.providerReplay,
    },
    { role: 'tool', toolCallId: 'call_w', content: 'sunny' },
    { role: 'user', content: 'and Busan?' },
  ];
}

test('xAI WebSocket result keeps encrypted reasoning in providerReplay and providerState with the option unset', async () => {
  ws.scripts.push(serverSearchEvents());
  const { provider } = xaiProvider({});
  const result = await sendXaiResponsesWebSocket(
    provider,
    [{ role: 'user', content: 'hi' }],
    'grok-4',
    DEFERRED_TOOLS,
    {
      sessionId: 'sess-1',
      iteration: 1,
    }
  );
  assert.deepEqual(
    result.providerReplay?.items?.map((item) => item.type),
    types(TURN_OUTPUT)
  );
  assert.equal(result.providerState.xaiResponses.encryptedReasoningItems.length, 1);
});

test('output cap is sent as max_output_tokens on HTTP and WS only when the caller sets one', async () => {
  const set = await captureBodies(nativeHistoryFor(), SESSION_TOOLS, { opts: { maxOutputTokens: 1234.7 } });
  assert.equal(set.http.max_output_tokens, 1234);
  assert.equal(set.ws.max_output_tokens, 1234);
  const alias = await captureBodies(nativeHistoryFor(), SESSION_TOOLS, { opts: { maxTokens: 99 } });
  assert.equal(alias.http.max_output_tokens, 99);
  assert.equal(alias.ws.max_output_tokens, 99);
  const none = await captureBodies(nativeHistoryFor(), SESSION_TOOLS);
  assert.equal('max_output_tokens' in none.http, false);
  assert.equal('max_output_tokens' in none.ws, false);
});

test('parallel_tool_calls: default true, explicit parallelToolCalls:false is honored on HTTP and WS', async () => {
  const def = await captureBodies(nativeHistoryFor(), SESSION_TOOLS);
  assert.equal(def.http.parallel_tool_calls, true);
  assert.equal(def.ws.parallel_tool_calls, true);
  const off = await captureBodies(nativeHistoryFor(), SESSION_TOOLS, { opts: { parallelToolCalls: false } });
  assert.equal(off.http.parallel_tool_calls, false);
  assert.equal(off.ws.parallel_tool_calls, false);
  const on = await captureBodies(nativeHistoryFor(), SESSION_TOOLS, { opts: { parallelToolCalls: true } });
  assert.equal(on.http.parallel_tool_calls, true);
  const noTools = await captureBodies(nativeHistoryFor(), [], { opts: { parallelToolCalls: false } });
  assert.equal('parallel_tool_calls' in noTools.http, false);
});

test('a pinned (grok-oauth) route ignores request and env transport overrides; an unpinned one still honors them', () => {
  const pinned = { responsesTransport: 'http', transportPinned: true };
  assert.equal(useXaiResponsesWebSocket({ xaiResponsesTransport: 'ws' }, pinned), false);
  assert.equal(useXaiResponsesWebSocket({ xaiTransport: 'websocket' }, pinned), false);
  assert.equal(useXaiResponsesWebSocket({}, pinned), false);
  const open = { responsesTransport: 'http' };
  assert.equal(useXaiResponsesWebSocket({ xaiResponsesTransport: 'ws' }, open), true);
});

function nativeHistoryFor() {
  return [{ role: 'user', content: 'hi' }];
}

for (const mode of ['off', 'on']) {
  const config = mode === 'on' ? ON : {};

  test(`recorded server tool-search turn (HTTP, option ${mode}): never dispatched locally, replays as native items`, async () => {
    const dispatched = [];
    const first = xaiProvider(config, serverSearchEvents());
    const result = await sendXaiResponses(
      first.provider,
      [{ role: 'user', content: 'weather in Seoul?' }],
      'grok-4',
      DEFERRED_TOOLS,
      {
        sessionId: 'sess-1',
        onToolCall: (call) => dispatched.push(call),
      }
    );
    assertServerSearchTurn(result, dispatched, 'http');

    const next = xaiProvider(config);
    await sendXaiResponses(next.provider, nextTurnHistory(result), 'grok-4', DEFERRED_TOOLS, {
      sessionId: 'sess-1',
      providerState: result.providerState,
    });
    assertReplayedVerbatim(next.requests[0].input, 'http replay');
  });

  test(`recorded server tool-search turn (WebSocket, option ${mode}): never dispatched locally, replays natively over WS and HTTP`, async () => {
    const dispatched = [];
    ws.scripts.push(serverSearchEvents());
    const first = xaiProvider(config);
    const result = await sendXaiResponsesWebSocket(
      first.provider,
      [{ role: 'user', content: 'weather in Seoul?' }],
      'grok-4',
      DEFERRED_TOOLS,
      {
        sessionId: 'sess-1',
        iteration: 1,
        onToolCall: (call) => dispatched.push(call),
      }
    );
    assertServerSearchTurn(result, dispatched, 'ws');

    const before = ws.bodies.length;
    const again = xaiProvider(config);
    await sendXaiResponsesWebSocket(again.provider, nextTurnHistory(result), 'grok-4', DEFERRED_TOOLS, {
      sessionId: 'sess-1',
      iteration: 2,
      providerState: result.providerState,
    });
    assertReplayedVerbatim(ws.bodies[before].input, 'ws replay');

    // A turn recorded over WebSocket replays unchanged when the next turn falls back to HTTP.
    const http = xaiProvider(config);
    await sendXaiResponses(http.provider, nextTurnHistory(result), 'grok-4', DEFERRED_TOOLS, {
      sessionId: 'sess-1',
      providerState: result.providerState,
    });
    assertReplayedVerbatim(http.requests[0].input, 'ws-recorded http replay');
  });
}
