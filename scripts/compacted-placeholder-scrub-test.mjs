#!/usr/bin/env node
// Regression tests for stable stored tool args: history keeps a compacted
// marker for every long body, and a FAILED call restores its full text
// (mutation bodies included) so the model never copies the marker back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compactToolCallsForHistory,
    compactSettledToolCallBodies,
    restoreToolCallBodyForId,
} from '../src/runtime/agent/orchestrator/session/loop/stored-tool-args.mjs';
import { preDispatchDenyForSession } from '../src/runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { repairTranscriptBeforeProviderSend } from '../src/runtime/agent/orchestrator/session/loop/transcript-repair.mjs';

// A patch body longer than the shared stored-arg limit (10 KB) compacts to a
// marker-alone string.
const BIG_PATCH = '*** Begin Patch\n' + '+x\n'.repeat(4000) + '*** End Patch';

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

test('failed-call restore brings back the full mutation body', () => {
    const originalCalls = [{
        id: 'call_3', name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' },
    }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    assert.match(msg.toolCalls[0].arguments.patch, /^\[mixdog compacted patch:/);
    restoreToolCallBodyForId(msg, originalCalls, 'call_3');
    assert.equal(msg.toolCalls[0].arguments.patch, BIG_PATCH);
    assert.equal(msg.toolCalls[0].arguments.base_path, '/repo');
});

test('failed-call restore reaches nested mutation bodies', () => {
    const originalCalls = [{
        id: 'call_3b', name: 'edit',
        arguments: { edits: [{ path: 'a.js', old_string: BIG_PATCH, new_string: 'ok' }] },
    }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    restoreToolCallBodyForId(msg, originalCalls, 'call_3b');
    const edit = msg.toolCalls[0].arguments.edits[0];
    assert.equal(edit.old_string, BIG_PATCH);
    assert.equal(edit.path, 'a.js');
    assert.equal(edit.new_string, 'ok');
});

test('a body already carrying real text is never overwritten by restore', () => {
    const originalCalls = [{
        id: 'call_3c', name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' },
    }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    msg.toolCalls[0].arguments.patch = '*** Begin Patch\n*** End Patch';
    restoreToolCallBodyForId(msg, originalCalls, 'call_3c');
    assert.equal(msg.toolCalls[0].arguments.patch, '*** Begin Patch\n*** End Patch');
});

test('a call that is never restored keeps its compacted body', () => {
    const originalCalls = [{
        id: 'call_3d', name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' },
    }];
    const msg = {
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(originalCalls),
    };
    restoreToolCallBodyForId(msg, originalCalls, 'other_call');
    assert.match(msg.toolCalls[0].arguments.patch, /^\[mixdog compacted patch:/);
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
    assert.match(asst.toolCalls[0].arguments.patch, /^\[mixdog compacted patch: \d+ chars, sha256:[a-f0-9]{16}; already applied - do not copy; re-read the file and write a fresh patch\]$/);
});

// ---- deferred body compaction (one turn of verbatim grace) ----------------

test('push-time deferral keeps the mutation body verbatim', () => {
    const calls = [{ id: 'call_d1', name: 'apply_patch', arguments: { patch: BIG_PATCH, base_path: '/repo' } }];
    const msg = { role: 'assistant', content: '', toolCalls: compactToolCallsForHistory(calls, { deferBodies: true }) };
    assert.equal(msg.toolCalls[0].arguments.patch, BIG_PATCH);
    assert.equal(msg.toolCalls[0].arguments.base_path, '/repo');
});

test('the settled sweep compacts successful bodies, keeps failed and unsettled ones verbatim', () => {
    const mk = (id) => ({
        role: 'assistant',
        content: '',
        toolCalls: compactToolCallsForHistory(
            [{ id, name: 'apply_patch', arguments: { patch: BIG_PATCH } }],
            { deferBodies: true },
        ),
    });
    const ok = mk('ok_1');
    const failed = mk('bad_1');
    const inflight = mk('new_1');
    const messages = [
        ok, { role: 'tool', content: 'OK applied', toolCallId: 'ok_1', toolKind: 'normal' },
        failed, { role: 'tool', content: 'Error: context not found', toolCallId: 'bad_1', toolKind: 'error' },
        inflight, // no result row yet — current batch
    ];
    compactSettledToolCallBodies(messages);
    assert.match(ok.toolCalls[0].arguments.patch, /^\[mixdog compacted patch:/);
    assert.equal(failed.toolCalls[0].arguments.patch, BIG_PATCH);
    assert.equal(inflight.toolCalls[0].arguments.patch, BIG_PATCH);
    // Idempotent: a second sweep leaves markers and protected bodies alone.
    const okMarker = ok.toolCalls[0].arguments.patch;
    compactSettledToolCallBodies(messages);
    assert.equal(ok.toolCalls[0].arguments.patch, okMarker);
    assert.equal(failed.toolCalls[0].arguments.patch, BIG_PATCH);
});
