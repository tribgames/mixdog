#!/usr/bin/env node
// Regression test for the pre-send compacted-placeholder invariant: no
// provider-visible assistant toolCall may ship a `[mixdog compacted …]`
// placeholder body that the model could copy back as apply_patch input.
// scrubCompactedPlaceholderToolCalls is the single enforcement point invoked
// by repairTranscriptBeforeProviderSend right before provider.send.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compactToolCallsForHistory,
    scrubCompactedPlaceholderToolCalls,
} from '../src/runtime/agent/orchestrator/session/loop/stored-tool-args.mjs';
import { repairTranscriptBeforeProviderSend } from '../src/runtime/agent/orchestrator/session/loop/transcript-repair.mjs';

// A patch body longer than the body limit compacts to a marker-alone string.
const BIG_PATCH = '*** Begin Patch\n' + '+x\n'.repeat(2000) + '*** End Patch';

function assistantWithCompactedPatch(id = 'call_1') {
    const calls = [{ id, name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' } }];
    return { role: 'assistant', content: '', toolCalls: compactToolCallsForHistory(calls) };
}

test('compact leaves a placeholder patch body (precondition)', () => {
    const msg = assistantWithCompactedPatch();
    assert.match(msg.toolCalls[0].arguments.patch, /^\[mixdog compacted /);
    assert.equal(msg.toolCalls[0].arguments.base_path, '/repo');
});

test('scrub drops the placeholder patch key, keeps other args', () => {
    const msg = assistantWithCompactedPatch();
    scrubCompactedPlaceholderToolCalls([msg]);
    assert.equal('patch' in msg.toolCalls[0].arguments, false);
    assert.equal(msg.toolCalls[0].arguments.base_path, '/repo');
});

test('scrub is recursive across nested batch body args', () => {
    const calls = [{
        id: 'call_2', name: 'edit',
        arguments: { edits: [{ path: 'a.js', old_string: BIG_PATCH, new_string: 'ok' }] },
    }];
    const msg = { role: 'assistant', content: '', toolCalls: compactToolCallsForHistory(calls) };
    assert.match(msg.toolCalls[0].arguments.edits[0].old_string, /^\[mixdog compacted /);
    scrubCompactedPlaceholderToolCalls([msg]);
    const edit = msg.toolCalls[0].arguments.edits[0];
    assert.equal('old_string' in edit, false);
    assert.equal(edit.path, 'a.js');
    assert.equal(edit.new_string, 'ok');
});

test('scrub leaves real (restored) patch bodies untouched', () => {
    const real = '*** Begin Patch\n@@\n-a\n+b\n*** End Patch';
    const msg = { role: 'assistant', content: '', toolCalls: [
        { id: 'call_3', name: 'apply_patch', arguments: { patch: real } },
    ] };
    scrubCompactedPlaceholderToolCalls([msg]);
    assert.equal(msg.toolCalls[0].arguments.patch, real);
});

test('scrub ignores non-assistant / non-toolCall messages', () => {
    const msgs = [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'x', toolCallId: 'call_1' },
        { role: 'assistant', content: 'text only' },
    ];
    assert.doesNotThrow(() => scrubCompactedPlaceholderToolCalls(msgs));
});

test('repairTranscriptBeforeProviderSend enforces the invariant end-to-end', () => {
    const msgs = [
        { role: 'user', content: 'do it' },
        assistantWithCompactedPatch('call_9'),
        { role: 'tool', content: 'applied', toolCallId: 'call_9' },
    ];
    repairTranscriptBeforeProviderSend(msgs, null);
    const asst = msgs.find((m) => m.role === 'assistant');
    assert.equal('patch' in asst.toolCalls[0].arguments, false);
});
