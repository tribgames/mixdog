#!/usr/bin/env node
// Regression tests for stable stored tool args: mutation bodies retain their
// self-explanatory compacted marker after failures, while retry-safe commands
// may restore their full text.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compactToolCallsForHistory,
    restoreToolCallBodyForId,
} from '../src/runtime/agent/orchestrator/session/loop/stored-tool-args.mjs';
import { preDispatchDenyForSession } from '../src/runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
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

test('failed-call restore keeps mutation bodies compacted to prevent stale replay', () => {
    const originalCalls = [{
        id: 'call_3', name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' },
    }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    restoreToolCallBodyForId(msg, originalCalls, 'call_3');
    assert.match(msg.toolCalls[0].arguments.patch, /^\[mixdog compacted patch:/);
    assert.equal(msg.toolCalls[0].arguments.base_path, '/repo');
});

test('failed-call restore still restores retry-safe long commands', () => {
    const command = 'Write-Output x\n'.repeat(1000);
    const originalCalls = [{ id: 'call_4', name: 'shell', arguments: { command, cwd: '/repo' } }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    assert.match(msg.toolCalls[0].arguments.command, /^\[mixdog compacted command:/);
    restoreToolCallBodyForId(msg, originalCalls, 'call_4');
    assert.equal(msg.toolCalls[0].arguments.command, command);
    assert.equal(msg.toolCalls[0].arguments.cwd, '/repo');
});

test('compacted patch markers are rejected at the shared pre-dispatch boundary', () => {
    const denial = preDispatchDenyForSession({}, {
        name: 'apply_patch',
        arguments: { patch: '[mixdog compacted patch: 4000 chars, sha256:deadbeefdeadbeef]' },
    });
    assert.match(denial, /^Error: \[tool-input-validation\]/);
    assert.match(denial, /fresh full patch/i);
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
