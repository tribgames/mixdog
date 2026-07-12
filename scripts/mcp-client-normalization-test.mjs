#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMcpToolResult } from '../src/runtime/agent/orchestrator/mcp/client.mjs';
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
