import assert from 'node:assert/strict';
import test from 'node:test';

import { providerSafeMcpToolName } from './client-config.mjs';
import {
  _registerMcpServerForTest,
  disconnectAll,
  executeMcpTool,
  getMcpTools,
  isRegisteredMcpTool,
  mcpToolHasField,
} from './client.mjs';

const PROVIDER_SAFE = /^[A-Za-z0-9_-]{1,64}$/;
const LONG_SERVER = 'plugin-context7-documentation-xy';
const LONG_TOOL = 'list_all_available_documentation_pages';

test('names that already fit stay unchanged', () => {
  assert.equal(providerSafeMcpToolName('context7', 'resolve-library-id'), 'mcp__context7__resolve-library-id');
  assert.equal(providerSafeMcpToolName('a', 'b'), 'mcp__a__b');
});

test('too long or unsafe names shorten deterministically and stay distinct', () => {
  assert.equal(`mcp__${LONG_SERVER}__${LONG_TOOL}`.length, 77);
  const name = providerSafeMcpToolName(LONG_SERVER, LONG_TOOL);
  assert.match(name, PROVIDER_SAFE);
  assert.ok(name.startsWith(`mcp__${LONG_SERVER}__list_all`), name);
  assert.equal(name, providerSafeMcpToolName(LONG_SERVER, LONG_TOOL));
  assert.notEqual(name, providerSafeMcpToolName(LONG_SERVER, `${LONG_TOOL}_v2`));
  for (const [server, tool] of [
    ['my server.with dots', 'tool/with:chars'],
    ['x'.repeat(80), 'y'.repeat(80)],
    ['ok', 'ünïcode tool'],
  ]) {
    const safe = providerSafeMcpToolName(server, tool);
    assert.match(safe, PROVIDER_SAFE, safe);
    assert.match(safe, /^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*__/, safe);
  }
});

test('a shortened tool name maps back to its server and original tool name', async (t) => {
  const scopeId = 'tool-names-test';
  t.after(() => disconnectAll({ scopeId }));
  const calls = [];
  _registerMcpServerForTest(
    scopeId,
    LONG_SERVER,
    [{ name: LONG_TOOL, inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } } }],
    {
      callTool: async (params) => {
        calls.push(params.name);
        return { content: [{ type: 'text', text: 'pages' }] };
      },
    }
  );
  const [tool] = getMcpTools(scopeId);
  assert.match(tool.name, PROVIDER_SAFE);
  assert.equal(tool.mcpToolName, LONG_TOOL);
  assert.equal(tool.mcpServerName, LONG_SERVER);
  assert.equal(isRegisteredMcpTool(tool.name, scopeId), true);
  assert.equal(mcpToolHasField(tool.name, 'cwd', scopeId), true);
  assert.equal(await executeMcpTool(tool.name, {}, { scopeId }), 'pages');
  assert.deepEqual(calls, [LONG_TOOL]);
});

test('a server whose own name is unsafe still resolves through the shortened name', async (t) => {
  const scopeId = 'tool-names-unsafe';
  t.after(() => disconnectAll({ scopeId }));
  const calls = [];
  _registerMcpServerForTest(scopeId, 'my server.v2', [{ name: 'run' }], {
    callTool: async (params) => {
      calls.push(params.name);
      return { content: [{ type: 'text', text: 'ran' }] };
    },
  });
  const [tool] = getMcpTools(scopeId);
  assert.match(tool.name, PROVIDER_SAFE);
  assert.equal(await executeMcpTool(tool.name, {}, { scopeId }), 'ran');
  assert.deepEqual(calls, ['run']);
});
