import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createContextStatus,
  requestSerializedToolsForContext,
} from '../src/session-runtime/context-status.mjs';
import { splitToolStatusCounts } from '../src/session-runtime/session-turn-api.mjs';
import { toolKind } from '../src/session-runtime/tool-catalog.mjs';

const schema = (description) => ({
  type: 'object',
  properties: { value: { type: 'string', description } },
});

test('context meters Anthropic deferred MCP schemas and invalidates on catalog changes', () => {
  const read = { name: 'read', description: 'Read a file', inputSchema: schema('path') };
  const mcp = { name: 'mcp__demo__lookup', description: 'MCP lookup', inputSchema: schema('mcp payload '.repeat(100)) };
  const session = {
    id: 'deferred-mcp-context',
    provider: 'anthropic',
    contextWindow: 100_000,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [read],
    deferredNativeTools: true,
    deferredToolCatalog: [read, mcp],
    compaction: {},
  };
  const route = { provider: 'openai', model: 'test' };
  const { contextStatus } = createContextStatus({
    getSession: () => session,
    getRoute: () => route,
    getCurrentCwd: () => '',
    getMode: () => 'default',
  });

  assert.deepEqual(requestSerializedToolsForContext(session, 'openai'), [read]);
  assert.equal(requestSerializedToolsForContext(session, 'anthropic').length, 2);
  const before = contextStatus();
  assert.equal(before.request.toolSchemaBreakdown.mcp.count, 1);
  assert.ok(before.request.toolSchemaBreakdown.mcp.tokens > 0);

  session.provider = 'openai';
  const switched = contextStatus();
  assert.notEqual(switched, before);
  assert.equal(switched.request.toolSchemaBreakdown.mcp, undefined);
  assert.ok(switched.request.toolSchemaTokens < before.request.toolSchemaTokens);

  session.provider = 'anthropic';
  session.deferredToolCatalog.push({
    name: 'mcp__demo__second',
    description: 'Second MCP tool',
    inputSchema: schema('second payload '.repeat(100)),
  });
  const after = contextStatus();
  assert.notEqual(after, before);
  assert.equal(after.request.toolSchemaBreakdown.mcp.count, 2);
  assert.ok(after.request.toolSchemaTokens > before.request.toolSchemaTokens);
  assert.ok(after.request.reserveTokens > before.request.reserveTokens);
  assert.ok(after.usedTokens > before.usedTokens);
});

test('tool status counts exclude MCP and skills while exposing MCP tool count', () => {
  const rows = [
    { name: 'read', kind: toolKind({ name: 'read' }), active: true },
    { name: 'mcp__demo__lookup', kind: toolKind({ name: 'mcp__demo__lookup' }), active: false },
    { name: 'Skill', kind: toolKind({ name: 'Skill' }), active: true },
  ];
  assert.deepEqual(splitToolStatusCounts(rows), {
    count: 1,
    activeCount: 1,
    mcpToolCount: 1,
    activeMcpToolCount: 0,
  });
});
