import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  _registerMcpServerForTest,
  disconnectAll,
  getMcpToolGeneration,
  getMcpTools,
} from '../runtime/agent/orchestrator/mcp/client.mjs';
import { TOOL_SEARCH_TOOL } from '../runtime/agent/orchestrator/runtime-core/tool-defs.mjs';
import {
  applyDeferredToolSurface,
  reconcileDeferredMcpToolCatalog,
} from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';

function setup(t) {
  const scopeId = randomUUID();
  const server = `reuse-${scopeId}`;
  const name = `mcp__${server}__menu`;
  const tool = (description) => ({
    name,
    description,
    inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
  });
  const session = {
    id: scopeId,
    mcpScopeId: scopeId,
    provider: 'openai-oauth',
    model: 'gpt-6-astra',
    cwd: process.cwd(),
    toolSpec: 'full',
    tools: [TOOL_SEARCH_TOOL],
    messages: [],
    compaction: { auto: false },
  };
  applyDeferredToolSurface(session, 'full');
  const register = (tools) => _registerMcpServerForTest(scopeId, server, tools, { callTool: async () => ({}) });
  t.after(() => disconnectAll({ scopeId }));
  return { session, scopeId, name, tool, register };
}

const lateEntry = (f) => f.session.deferredLateToolCatalog.find((x) => x.name === f.name);

test('unchanged catalog and settings reuse one frozen definition without rebuilding', (t) => {
  const f = setup(t);
  f.register([f.tool('v1')]);
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  const first = lateEntry(f);
  const catalog = f.session.deferredLateToolCatalog;
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.inputSchema));
  assert.equal(reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId)), null);
  assert.equal(f.session.deferredLateToolCatalog, catalog, 'late catalog not rebuilt');
  assert.equal(lateEntry(f), first);
});

test('reconnect, disconnect, cwd and disallowed changes rebuild the surface', (t) => {
  const f = setup(t);
  f.register([f.tool('v1')]);
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  const catalog = f.session.deferredLateToolCatalog;
  const gen = getMcpToolGeneration();

  f.register([f.tool('v2')]);
  assert.ok(getMcpToolGeneration() > gen);
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  assert.notEqual(f.session.deferredLateToolCatalog, catalog);
  assert.equal(lateEntry(f).description, 'v2');

  const afterReconnect = f.session.deferredLateToolCatalog;
  f.session.cwd = `${process.cwd()}-other`;
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  assert.notEqual(f.session.deferredLateToolCatalog, afterReconnect);

  const afterCwd = f.session.deferredLateToolCatalog;
  f.session.disallowedTools = [f.name];
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  assert.notEqual(f.session.deferredLateToolCatalog, afterCwd);
  assert.equal(lateEntry(f), undefined);

  f.session.disallowedTools = [];
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  assert.equal(lateEntry(f).description, 'v2');
  return disconnectAll({ scopeId: f.scopeId }).then(() => {
    const delta = reconcileDeferredMcpToolCatalog(f.session, []);
    assert.deepEqual(delta, [f.name]);
  });
});

test('promotion and read-only toggle invalidate reuse', (t) => {
  const f = setup(t);
  f.register([f.tool('v1')]);
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  const catalog = f.session.deferredLateToolCatalog;
  f.session.deferredCallableTools = [...(f.session.deferredCallableTools || []), f.name];
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  assert.notEqual(f.session.deferredLateToolCatalog, catalog);
  const promoted = f.session.deferredLateToolCatalog;
  f.session.deferredSurfaceMode = 'readonly';
  reconcileDeferredMcpToolCatalog(f.session, getMcpTools(f.scopeId));
  assert.notEqual(f.session.deferredLateToolCatalog, promoted);
});
