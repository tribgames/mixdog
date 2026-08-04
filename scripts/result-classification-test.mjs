#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    executeInternalTool,
    setInternalToolsProvider,
} from '../src/runtime/agent/orchestrator/internal-tools.mjs';
import { classifyResultKind } from '../src/runtime/agent/orchestrator/session/result-classification.mjs';
import { normalizeToolEnvelope } from '../src/runtime/agent/orchestrator/session/tool-envelope.mjs';
import { executeTool } from '../src/runtime/agent/orchestrator/session/loop/tool-exec.mjs';

async function classifyHandlerResult(handlerResult) {
    setInternalToolsProvider({
        tools: [{ name: 'result_classification_test' }],
        executor: async () => handlerResult,
    });
    const returned = await executeInternalTool('result_classification_test', {});
    const normalized = normalizeToolEnvelope(returned);
    return classifyResultKind(normalized.result, normalized.explicitSuccess);
}

test('explicit success suppresses Error: text-prefix classification', async () => {
    assert.equal(await classifyHandlerResult({
        content: [{ type: 'text', text: 'Error: quoted log output' }],
        isError: false,
    }), 'normal');
});

test('explicit isError:true remains an error', async () => {
    assert.equal(await classifyHandlerResult({
        content: [{ type: 'text', text: 'handler failed' }],
        isError: true,
    }), 'error');
});

test('flag-less Error: text remains an error', async () => {
    assert.equal(await classifyHandlerResult({
        content: [{ type: 'text', text: 'Error: prefix-only failure' }],
    }), 'error');
});

test('flag-less normal text remains normal', async () => {
    assert.equal(await classifyHandlerResult({
        content: [{ type: 'text', text: 'ordinary output' }],
    }), 'normal');
});

test('afterToolHook receives unwrapped explicit-success text', async () => {
    setInternalToolsProvider({
        tools: [{ name: 'result_classification_test' }],
        executor: async () => ({
            content: [{ type: 'text', text: 'Error: quoted hook payload' }],
            isError: false,
        }),
    });
    let hookResult;
    const returned = await executeTool(
        'result_classification_test',
        {},
        process.cwd(),
        'result-classification-test-session',
        {
            afterToolHook: async (input) => {
                hookResult = input.result;
            },
        },
        { toolCallId: 'result-classification-hook-call' },
    );
    assert.equal(hookResult, 'Error: quoted hook payload');
    assert.equal(typeof hookResult, 'string');

    const normalized = normalizeToolEnvelope(returned);
    assert.equal(normalized.result, hookResult);
    assert.equal(normalized.explicitSuccess, true);
});
