import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    _computeDelta,
    _sansInput,
    _stableStringify,
} from './openai-ws-delta.mjs';
import { _applyReasoningReplayPolicy } from './openai-oauth-ws.mjs';
import { _captureTurnStateFromEvent } from './openai-ws-stream.mjs';
import { _convertMessagesToResponsesInputForTest } from './openai-responses-payload.mjs';

// A turn may reason, speak, then reason again before calling a tool. Replaying
// every retained item in front of the text invents an order the response never
// produced, and the next request's incremental check fails on the message item.
test('a turn that reasons, speaks, then reasons again replays in that order', () => {
    const beforeText = { id: 'rs-1', encrypted_content: 'e1', summary: [] };
    const afterText = { id: 'rs-2', encrypted_content: 'e2', summary: [], afterText: true };
    const input = _convertMessagesToResponsesInputForTest([
        { role: 'user', content: 'task' },
        {
            role: 'assistant',
            content: 'looking now',
            reasoningItems: [beforeText, afterText],
            toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'a' } }],
        },
        { role: 'tool', toolCallId: 'call-1', content: 'contents' },
    ], { replayEncryptedReasoning: true });

    assert.deepEqual(input.map((item) => item.type ?? 'message'), [
        'message',
        'reasoning',
        'message',
        'reasoning',
        'function_call',
        'function_call_output',
    ]);
    assert.equal(input[1].id, 'rs-1');
    assert.equal(input[3].id, 'rs-2');
    // The ordering marker is bookkeeping, never a wire field.
    assert.equal(input[3].afterText, undefined);
});

// A live chain's sticky-routing token can never be swapped mid-session: the
// entry holds it write-once, whichever path first supplied it.
test('a live turn-state token is never replaced by a later event token', () => {
    const entry = {};
    _captureTurnStateFromEvent(entry, {
        type: 'response.created',
        headers: { 'x-codex-turn-state': 'handshake-token' },
    });
    _captureTurnStateFromEvent(entry, {
        type: 'response.created',
        headers: { 'x-codex-turn-state': 'later-token' },
    });
    assert.equal(entry.turnState, 'handshake-token');
});

// The logical request history always carries retained reasoning — a pooled
// entry with a live chain included. Only the duplicate-rejection retry drops it.
test('reasoning stays in the logical history on every send', () => {
    const reasoning = {
        type: 'reasoning',
        id: 'rs-1',
        encrypted_content: 'encrypted',
        summary: [],
    };
    const toolOutput = { type: 'function_call_output', call_id: 'call-1', output: 'ok' };
    const body = { input: [reasoning, toolOutput] };
    const entry = { lastResponseId: 'resp-1', lastRequestInput: [] };

    const retained = _applyReasoningReplayPolicy(entry, body);
    assert.equal(retained, body);
    assert.equal(retained.input[0], reasoning);
    assert.equal(entry.replayReasoning, true);

    const suppressed = _applyReasoningReplayPolicy(entry, body, { suppress: true });
    assert.equal(entry.replayReasoning, false);
    assert.deepEqual(suppressed.input, [toolOutput]);
});

test('Codex delta parity falls back when a previous response item is absent', (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });

    const previousInput = [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'task' }],
    }];
    const previousCall = {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read',
        arguments: '{"path":"/app/input.txt"}',
    };
    const body = {
        model: 'gpt-5.6-sol',
        input: [
            ...previousInput,
            // The reasoning item from the previous response is missing here.
            previousCall,
            {
                type: 'function_call_output',
                call_id: 'call-1',
                output: 'fixture',
            },
        ],
    };
    const entry = {
        lastRequestSansInput: _stableStringify(_sansInput({
            model: body.model,
            input: previousInput,
        })),
        lastRequestInput: previousInput,
        lastResponseId: 'resp-1',
        lastResponseItems: [
            {
                type: 'reasoning',
                id: 'rs-1',
                encrypted_content: 'encrypted',
            },
            previousCall,
        ],
        turnState: 'sticky',
    };

    const delta = _computeDelta({ entry, body, traceProvider: 'openai-oauth' });
    assert.equal(delta.mode, 'full');
    assert.equal(delta.reason, 'response_output_mismatch:reasoning');
    assert.equal(delta.frame.previous_response_id, undefined);
    assert.deepEqual(delta.frame.input, body.input);
});

// Retained reasoning rides the logical history, and the delta builder is what
// keeps it off the wire: it belongs to the anchored previous response, so the
// frame carries only what is genuinely new. This is the whole reason the
// history keeps the item instead of dropping it before the delta runs.
test('the delta frame drops the anchored reasoning item from the wire tail', (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });

    const previousInput = [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'task' }],
    }];
    const reasoning = { type: 'reasoning', id: 'rs-1', encrypted_content: 'encrypted' };
    const previousCall = {
        type: 'function_call',
        call_id: 'call-1',
        name: 'read',
        arguments: '{"path":"/app/input.txt"}',
    };
    const toolOutput = {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'fixture',
    };
    const body = {
        model: 'gpt-5.6-sol',
        input: [...previousInput, reasoning, previousCall, toolOutput],
    };
    const entry = {
        lastRequestSansInput: _stableStringify(_sansInput({
            model: body.model,
            input: previousInput,
        })),
        lastRequestInput: previousInput,
        lastResponseId: 'resp-1',
        lastResponseItems: [reasoning, previousCall],
        replayReasoning: true,
        turnState: 'sticky',
    };

    const delta = _computeDelta({ entry, body, traceProvider: 'openai-oauth' });
    assert.equal(delta.mode, 'delta');
    assert.equal(delta.reason, null);
    assert.equal(delta.frame.previous_response_id, 'resp-1');
    assert.deepEqual(delta.frame.input, [toolOutput]);
    assert.equal(delta.strippedResponseItems, 2);
});
