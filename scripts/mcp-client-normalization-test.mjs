#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    _registerMcpServerForTest,
    disconnectAll,
    disconnectMcpServer,
    executeMcpTool,
    getMcpServerInstructionsMap,
    getMcpServerStatus,
    getMcpTools,
    isRegisteredMcpTool,
    mcpToolHasField,
    normalizeMcpToolResult,
} from '../src/runtime/agent/orchestrator/mcp/client.mjs';
import { classifyResultKind } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';
import { normalizeToolEnvelope } from '../src/runtime/agent/orchestrator/session/tool-envelope.mjs';

test('isError:true plain MCP text receives one canonical Error: prefix', () => {
    const result = normalizeMcpToolResult({
        content: [{ type: 'text', text: 'connection refused' }],
        isError: true,
    });
    assert.equal(result, 'Error: connection refused');
    assert.equal(classifyResultKind(result), 'error');
});

test('isError:true already-prefixed MCP text is unchanged', () => {
    const result = normalizeMcpToolResult({
        content: [{ type: 'text', text: 'Error: connection refused' }],
        isError: true,
    });
    assert.equal(result, 'Error: connection refused');
});

test('absent or false isError leaves MCP text untouched', () => {
    for (const isError of [undefined, false]) {
        const result = normalizeMcpToolResult({
            content: [{ type: 'text', text: 'search complete' }],
            ...(isError === undefined ? {} : { isError }),
        });
        assert.equal(result, 'search complete');
        assert.equal(classifyResultKind(result), 'normal');
    }
});

test('isError:false Error:-leading MCP text stays untouched and normal', () => {
    const returned = normalizeMcpToolResult({
        content: [{ type: 'text', text: 'Error: quoted search result' }],
        isError: false,
    });
    const normalized = normalizeToolEnvelope(returned);
    assert.equal(normalized.result, 'Error: quoted search result');
    assert.equal(normalized.explicitSuccess, true);
    assert.equal(classifyResultKind(normalized.result, normalized.explicitSuccess), 'normal');
});

test('MCP registry scopes isolate identical server names, discovery, execution, and teardown', async (t) => {
    const scopeA = 'scope-a';
    const scopeB = 'scope-b';
    const scopeC = 'scope-c';
    t.after(async () => {
        await disconnectAll({ scopeId: scopeA });
        await disconnectAll({ scopeId: scopeB });
        await disconnectAll({ scopeId: scopeC });
    });
    const tool = {
        name: 'who',
        description: 'identify scope',
        inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } },
    };
    _registerMcpServerForTest(scopeA, 'unity', [tool], {
        instructions: 'scope A',
        callTool: async () => ({ content: [{ type: 'text', text: 'A' }] }),
    });
    _registerMcpServerForTest(scopeB, 'unity', [tool], {
        instructions: 'scope B',
        callTool: async () => ({ content: [{ type: 'text', text: 'B' }] }),
    });

    assert.deepEqual(getMcpTools(scopeA).map((entry) => entry.name), ['mcp__unity__who']);
    assert.deepEqual(getMcpTools(scopeB).map((entry) => entry.name), ['mcp__unity__who']);
    assert.deepEqual(getMcpTools(scopeC), []);
    assert.equal(getMcpServerStatus(scopeA).length, 1);
    assert.equal(getMcpServerStatus(scopeC).length, 0);
    assert.deepEqual(getMcpServerInstructionsMap(scopeA), { unity: 'scope A' });
    assert.deepEqual(getMcpServerInstructionsMap(scopeB), { unity: 'scope B' });
    assert.equal(isRegisteredMcpTool('mcp__unity__who', scopeA), true);
    assert.equal(isRegisteredMcpTool('mcp__unity__who', scopeC), false);
    assert.equal(mcpToolHasField('mcp__unity__who', 'cwd', scopeA), true);
    assert.equal(mcpToolHasField('mcp__unity__who', 'cwd', scopeC), false);
    assert.equal(await executeMcpTool('mcp__unity__who', {}, { scopeId: scopeA }), 'A');
    assert.equal(await executeMcpTool('mcp__unity__who', {}, { scopeId: scopeB }), 'B');
    await assert.rejects(
        executeMcpTool('mcp__unity__who', {}, { scopeId: scopeC }),
        /not connected/,
    );
    assert.equal(await disconnectMcpServer('unity', { scopeId: scopeC }), false);
    await disconnectAll({ scopeId: scopeA });
    assert.deepEqual(getMcpTools(scopeA), []);
    assert.deepEqual(getMcpTools(scopeB).map((entry) => entry.name), ['mcp__unity__who']);
});
