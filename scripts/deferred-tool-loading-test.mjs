#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDeferredToolSurface,
  rebuildDeferredToolSurfaceForProvider,
  reconcileDeferredMcpToolCatalog,
  renderToolSearch,
} from '../src/session-runtime/tool-catalog.mjs';
import { prepareDeferredToolCallThrough } from '../src/runtime/agent/orchestrator/session/loop/deferred-call-through.mjs';
import { buildRequestBody } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _buildRequestBodyForCacheSmoke as buildAnthropicRequestBody } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';

const schema = { type: 'object', properties: {} };
const catalog = [
  { name: 'load_tool', description: 'Load deferred tools.', annotations: { readOnlyHint: true }, inputSchema: schema },
  { name: 'read', description: 'Read.', annotations: { readOnlyHint: true }, inputSchema: schema },
  { name: 'mcp__demo__ping', description: 'Ping.', annotations: { readOnlyHint: true }, inputSchema: schema },
];

test('OpenAI first/repeated load uses history schemas and keeps base tools/cache key stable', () => {
  const session = { id: 'deferred-openai', provider: 'openai-oauth', tools: [], messages: [] };
  applyDeferredToolSurface(session, 'full', catalog, { provider: session.provider });
  const baseTools = JSON.stringify(session.tools);
  const firstBody = buildRequestBody(
    [{ role: 'user', content: 'load ping' }],
    'gpt-5.4',
    session.tools,
    { sessionId: session.id, session },
  );

  const first = JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));
  assert.deepEqual(first.loaded, ['mcp__demo__ping']);
  assert.equal(session.tools.some((tool) => tool.name === 'mcp__demo__ping'), false);
  assert.equal(JSON.stringify(session.tools), baseTools);

  const history = [
    { role: 'user', content: 'load ping' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'search-1',
        name: 'load_tool',
        arguments: { names: ['mcp__demo__ping'] },
        nativeType: 'tool_search_call',
      }],
    },
    {
      role: 'tool',
      toolCallId: 'search-1',
      content: first.nativeToolSearch.summary,
      nativeToolSearch: first.nativeToolSearch,
    },
  ];
  const followup = buildRequestBody(history, 'gpt-5.4', session.tools, {
    sessionId: session.id,
    session,
  });
  assert.equal(JSON.stringify(followup.tools), JSON.stringify(firstBody.tools));
  assert.equal(followup.prompt_cache_key, firstBody.prompt_cache_key);
  assert.equal(followup.tools.some((tool) => tool.name === 'mcp__demo__ping'), false);
  assert.equal(
    followup.input.find((item) => item.type === 'tool_search_output').tools[0].name,
    'mcp__demo__ping',
  );

  const repeated = JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));
  assert.deepEqual(repeated.loaded, []);
  assert.deepEqual(repeated.alreadyActive, ['mcp__demo__ping']);
  assert.deepEqual(repeated.nativeToolSearch.toolReferences, []);
  assert.deepEqual(repeated.nativeToolSearch.openaiTools, []);
  assert.equal(JSON.stringify(session.tools), baseTools);

  const repeatedFollowup = buildRequestBody([
    ...history,
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'search-2',
        name: 'load_tool',
        arguments: { names: ['mcp__demo__ping'] },
        nativeType: 'tool_search_call',
      }],
    },
    {
      role: 'tool',
      toolCallId: 'search-2',
      content: repeated.nativeToolSearch.summary,
      nativeToolSearch: repeated.nativeToolSearch,
    },
  ], 'gpt-5.4', session.tools, { sessionId: session.id, session });
  const repeatedOutput = repeatedFollowup.input.at(-1);
  assert.equal(JSON.stringify(repeatedFollowup.tools), JSON.stringify(firstBody.tools));
  assert.equal(repeatedFollowup.prompt_cache_key, firstBody.prompt_cache_key);
  assert.equal(repeatedFollowup.input.at(-2).type, 'tool_search_call');
  assert.equal(repeatedOutput.type, 'tool_search_output');
  assert.deepEqual(repeatedOutput.tools, []);
});

test('Anthropic repeated native loads retain an empty provider envelope', () => {
  const session = { provider: 'anthropic-oauth', tools: [], messages: [] };
  applyDeferredToolSurface(session, 'full', catalog, { provider: session.provider });
  const first = JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));
  const before = JSON.stringify(session.tools);
  const repeated = JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));

  assert.deepEqual(first.nativeToolSearch.toolReferences, ['mcp__demo__ping']);
  assert.deepEqual(repeated.loaded, []);
  assert.deepEqual(repeated.alreadyActive, ['mcp__demo__ping']);
  assert.deepEqual(repeated.nativeToolSearch.toolReferences, []);
  assert.deepEqual(repeated.nativeToolSearch.openaiTools, []);
  assert.equal(JSON.stringify(session.tools), before);
  assert.equal(session.deferredCallableTools.includes('mcp__demo__ping'), true);
  assert.equal(session.deferredDiscoveredTools.includes('mcp__demo__ping'), true);

  const body = buildAnthropicRequestBody([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'load-a1', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] } }],
    },
    {
      role: 'tool',
      toolCallId: 'load-a1',
      content: first.nativeToolSearch.summary,
      nativeToolSearch: first.nativeToolSearch,
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'load-a2', name: 'load_tool', arguments: { names: ['mcp__demo__ping'] } }],
    },
    {
      role: 'tool',
      toolCallId: 'load-a2',
      content: repeated.nativeToolSearch.summary,
      nativeToolSearch: repeated.nativeToolSearch,
    },
  ], 'claude-sonnet-4-6', session.tools, { session });
  const results = body.messages.flatMap((message) => (
    Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result') : []
  ));
  assert.deepEqual(results.map((block) => block.tool_use_id), ['load-a1', 'load-a2']);
  assert.deepEqual(results[0].content, [{ type: 'tool_reference', tool_name: 'mcp__demo__ping' }]);
  assert.equal(results[1].content, 'Already active: mcp__demo__ping');
  assert.equal(body.tools.find((tool) => tool.name === 'mcp__demo__ping')?.defer_loading, true);
});

test('OpenAI API-key path accepts its own native tool_search_output history', () => {
  const session = { id: 'deferred-openai-direct', provider: 'openai', tools: [], messages: [] };
  applyDeferredToolSurface(session, 'full', catalog, { provider: session.provider });
  const loaded = JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));
  const body = buildRequestBody([
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'search-direct',
        name: 'load_tool',
        arguments: { names: ['mcp__demo__ping'] },
        nativeType: 'tool_search_call',
      }],
    },
    {
      role: 'tool',
      toolCallId: 'search-direct',
      content: loaded.nativeToolSearch.summary,
      nativeToolSearch: loaded.nativeToolSearch,
    },
  ], 'gpt-5.4', session.tools, {
    sessionId: session.id,
    session,
    promptCacheProvider: 'openai',
  });
  assert.equal(body.input[0].type, 'tool_search_call');
  assert.equal(body.input[1].type, 'tool_search_output');
});

test('subsequent ordinary MCP calls use the callable registry, not session.tools promotion', () => {
  const session = { provider: 'openai-oauth', toolSpec: 'full', tools: [], messages: [] };
  applyDeferredToolSurface(session, 'full', catalog, { provider: session.provider });
  JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));
  const before = JSON.stringify(session.tools);
  assert.equal(prepareDeferredToolCallThrough(session, 'mcp__demo__ping', {}), null);
  assert.equal(JSON.stringify(session.tools), before);
  assert.equal(session.deferredCallableTools.includes('mcp__demo__ping'), true);
});

test('xAI/Grok and unsupported providers use a fixed canonical non-native surface', () => {
  for (const provider of ['xai', 'grok-oauth', 'opencode-go']) {
    const session = { provider, tools: [], messages: [] };
    applyDeferredToolSurface(session, 'full', catalog, { provider });
    const before = JSON.stringify(session.tools);
    const result = JSON.parse(renderToolSearch({ names: ['mcp__demo__ping'] }, session, 'full'));
    assert.equal(session.deferredNativeTools, false);
    assert.equal(result.nativeToolSearch, undefined);
    assert.deepEqual(result.alreadyActive, ['mcp__demo__ping']);
    assert.equal(JSON.stringify(session.tools), before);
  }
});

test('Gemini manifest changes only at the next user-turn reconciliation', () => {
  const session = { provider: 'gemini', tools: [], messages: [] };
  applyDeferredToolSurface(session, 'full', catalog.slice(0, 2), { provider: session.provider });
  const duringTurn = JSON.stringify(session.tools);
  const orderedBaseNames = session.tools.map((tool) => tool.name);
  assert.equal(JSON.stringify(session.tools), duringTurn);

  reconcileDeferredMcpToolCatalog(session, [catalog[2]]);
  assert.deepEqual(session.tools.map((tool) => tool.name), [...orderedBaseNames, 'mcp__demo__ping']);
  assert.equal(session.deferredProviderMode, 'manifest');
});

test('live provider switching rebuilds native and canonical surfaces in both directions', () => {
  const session = { provider: 'openai-oauth', tools: [], messages: [] };
  applyDeferredToolSurface(session, 'full', catalog, { provider: session.provider });
  assert.equal(session.tools.some((tool) => tool.name === 'mcp__demo__ping'), false);

  rebuildDeferredToolSurfaceForProvider(session, 'xai');
  session.provider = 'xai';
  assert.equal(session.deferredProviderMode, 'canonical');
  assert.deepEqual(session.tools.map((tool) => tool.name), session.deferredCallableTools);
  assert.equal(session.tools.some((tool) => tool.name === 'mcp__demo__ping'), true);

  rebuildDeferredToolSurfaceForProvider(session, 'openai');
  session.provider = 'openai';
  assert.equal(session.deferredProviderMode, 'native');
  assert.equal(session.tools.some((tool) => tool.name === 'mcp__demo__ping'), false);
  assert.equal(session.deferredCallableTools.includes('mcp__demo__ping'), false);
});
