#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    executeInternalTool,
    setInternalToolsProvider,
} from '../src/runtime/agent/orchestrator/internal-tools.mjs';
import { classifyResultKind } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';

async function normalizeToolResult(result) {
    setInternalToolsProvider({
        tools: [{ name: 'normalization_test' }],
        executor: async () => result,
    });
    return executeInternalTool('normalization_test', {});
}

test('already-prefixed handler errors keep one canonical Error: prefix', async () => {
    const result = await normalizeToolResult({
        content: [{ type: 'text', text: 'Error: web search failed' }],
        isError: true,
    });
    assert.equal(result, 'Error: web search failed');
    assert.equal(classifyResultKind(result), 'error');
});

test('ordinary handler error text receives the canonical Error: prefix', async () => {
    const result = await normalizeToolResult({
        content: [{ type: 'text', text: 'core add: project_id required' }],
        isError: true,
    });
    assert.equal(result, 'Error: core add: project_id required');
    assert.equal(classifyResultKind(result), 'error');
});

test('successful empty output stays normal', async () => {
    const result = await normalizeToolResult({
        content: [{ type: 'text', text: '' }],
        isError: false,
    });
    assert.equal(result, '');
    assert.equal(classifyResultKind(result), 'normal');
});

test('isError:false output stays normal', async () => {
    const result = await normalizeToolResult({
        content: [{ type: 'text', text: 'search complete' }],
        isError: false,
    });
    assert.equal(result, 'search complete');
    assert.equal(classifyResultKind(result), 'normal');
});

test('structured image output survives internal tool normalization', async () => {
    const input = {
        content: [
            { type: 'text', text: 'downloaded' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
        ],
    };
    assert.deepEqual(await normalizeToolResult(input), input);
});
