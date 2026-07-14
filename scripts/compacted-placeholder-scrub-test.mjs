#!/usr/bin/env node
// Regression tests for stable stored tool args: successful calls retain their
// self-explanatory compacted marker, while failed calls can restore full bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compactToolCallsForHistory,
    restoreToolCallBodyForId,
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

test('nested body args retain their compacted markers', () => {
    const calls = [{
        id: 'call_2', name: 'edit',
        arguments: { edits: [{ path: 'a.js', old_string: BIG_PATCH, new_string: 'ok' }] },
    }];
    const msg = { role: 'assistant', content: '', toolCalls: compactToolCallsForHistory(calls) };
    assert.match(msg.toolCalls[0].arguments.edits[0].old_string, /^\[mixdog compacted /);
    const edit = msg.toolCalls[0].arguments.edits[0];
    assert.equal(edit.path, 'a.js');
    assert.equal(edit.new_string, 'ok');
});

test('failed-call restore replaces the marker with the full original body', () => {
    const originalCalls = [{
        id: 'call_3', name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' },
    }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    restoreToolCallBodyForId(msg, originalCalls, 'call_3');
    assert.equal(msg.toolCalls[0].arguments.patch, BIG_PATCH);
    assert.equal(msg.toolCalls[0].arguments.base_path, '/repo');
});

test('pre-send transcript repair does not mutate compacted tool-call args', () => {
    const msgs = [
        { role: 'user', content: 'do it' },
        assistantWithCompactedPatch('call_9'),
        { role: 'tool', content: 'applied', toolCallId: 'call_9' },
    ];
    const argsBefore = structuredClone(msgs[1].toolCalls[0].arguments);
    repairTranscriptBeforeProviderSend(msgs, null);
    const asst = msgs.find((m) => m.role === 'assistant');
    assert.deepEqual(asst.toolCalls[0].arguments, argsBefore);
    assert.match(asst.toolCalls[0].arguments.patch, /^\[mixdog compacted patch: \d+ chars, sha256:[a-f0-9]{16}\]$/);
});
