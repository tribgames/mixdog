// Task-notification parity: a finished tool/agent task drained from the
// pending queue must keep its mode + execution provenance from enqueue through
// the drained turn group, the stored message classification, and the
// transcript restore — never collapsing into "the user typed this".
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    _groupPendingMessageEntries,
    _mergePendingMessageEntries,
    markCompletionEntry,
    pendingEntryMode,
    PENDING_MODE_PROMPT,
    PENDING_MODE_TASK_NOTIFICATION,
} from './pending-messages.mjs';
import { mergeSteeringEntries } from '../loop/steering.mjs';
import {
    classifySyntheticUserMessage,
    SYNTHETIC_USER_KINDS,
} from '../synthetic-user-envelope.mjs';
import { restoreTranscriptItems } from '../../../../../tui/session/session-api-ext.mjs';

const RECOVERY_NOTICE = [
    'Async shell task job_recovery_1 (failed, exit n/a) finished.',
    '',
    'Result:',
    '> [task_id: job_recovery_1]',
    '> [status: failed]',
    '> [exit: n/a]',
    '> ',
    '> Summary: daemon restarted while this shell task was running; its outcome was lost.',
].join('\n');

const SHELL_META = {
    type: 'shell_task_result',
    execution_surface: 'shell',
    execution_id: 'job_recovery_1',
    status: 'failed',
};

test('markCompletionEntry carries the queue mode and execution provenance from the notify meta', () => {
    const entry = markCompletionEntry(RECOVERY_NOTICE, { executionId: 'job_recovery_1', meta: SHELL_META });
    assert.equal(entry.mode, PENDING_MODE_TASK_NOTIFICATION);
    assert.deepEqual(entry.execution, {
        surface: 'shell', id: 'job_recovery_1', status: 'failed', resultType: 'shell_task_result',
    });
    assert.equal(pendingEntryMode(entry), PENDING_MODE_TASK_NOTIFICATION);
    assert.equal(pendingEntryMode({ id: 'u1', content: '이거 고쳐줘', enqueuedAt: 1 }), PENDING_MODE_PROMPT);
});

test('a drain batch groups by mode: prompts merge into one turn, each notification stands alone', () => {
    const typedA = { id: 'u1', content: '먼저 이것', enqueuedAt: 10 };
    const noteA = markCompletionEntry(RECOVERY_NOTICE, { executionId: 'job_recovery_1', meta: SHELL_META });
    const typedB = { id: 'u2', content: '그리고 저것', enqueuedAt: 30 };
    const noteB = markCompletionEntry('Async agent task task_2 (completed) finished.\n\nResult:\n> done', {
        executionId: 'task_2',
        meta: { type: 'agent_task_result', execution_surface: 'agent', execution_id: 'task_2', status: 'completed' },
    });
    const groups = _groupPendingMessageEntries([typedA, noteA, typedB, noteB]);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].mode, PENDING_MODE_PROMPT);
    assert.equal(groups[0].content, '먼저 이것\n그리고 저것');
    assert.deepEqual(groups[0].ids, ['u1', 'u2']);
    assert.equal(groups[1].mode, PENDING_MODE_TASK_NOTIFICATION);
    assert.equal(groups[1].execution.surface, 'shell');
    assert.deepEqual(groups[1].entries, [noteA]);
    assert.equal(groups[2].execution.surface, 'agent');
    // No group ever mixes typed text with a notification body.
    for (const group of groups.slice(1)) assert.ok(!group.content.includes('이것'));
    // The legacy single-message merge still exists for callers that rely on it.
    assert.ok(_mergePendingMessageEntries([typedA, noteA]).content.startsWith('먼저 이것'));
});

test('the steering merge keeps a notification-only group marked; any typed text makes it a prompt', () => {
    const group = _groupPendingMessageEntries([
        markCompletionEntry(RECOVERY_NOTICE, { executionId: 'job_recovery_1', meta: SHELL_META }),
    ])[0];
    const merged = mergeSteeringEntries([{ content: group.content, text: group.text, ids: group.ids, mode: group.mode, execution: group.execution }]);
    assert.equal(merged.mode, 'task-notification');
    assert.equal(merged.execution.id, 'job_recovery_1');
    const mixed = mergeSteeringEntries([
        { content: '사용자 입력', text: '사용자 입력', ids: ['u1'] },
        { content: group.content, text: group.text, ids: group.ids, mode: group.mode, execution: group.execution },
    ]);
    assert.equal(mixed.mode, undefined);
    assert.equal(mixed.execution, undefined);
});

test('a stored task-notification row is runtime control on the wire by source, and by text without meta', () => {
    const bySource = { role: 'user', content: RECOVERY_NOTICE, meta: { source: 'task-notification', execution: { surface: 'shell' } } };
    assert.equal(classifySyntheticUserMessage(bySource), SYNTHETIC_USER_KINDS.RUNTIME_CONTROL);
    const metaLess = { role: 'user', content: RECOVERY_NOTICE };
    assert.equal(classifySyntheticUserMessage(metaLess), SYNTHETIC_USER_KINDS.RUNTIME_CONTROL);
    // The legacy steering-sourced shape (rows persisted before the mode existed)
    // is rescued by the text test too, so old transcripts stop reading as user speech.
    const legacy = { role: 'user', content: RECOVERY_NOTICE, meta: { source: 'steering' } };
    assert.equal(classifySyntheticUserMessage(legacy), SYNTHETIC_USER_KINDS.RUNTIME_CONTROL);
    // Real steering stays the user's own words.
    assert.equal(classifySyntheticUserMessage({ role: 'user', content: '멈추고 설명해', meta: { source: 'steering' } }), null);
});

test('a task-notification row restores as a tool card even when its body has no envelope header', () => {
    const messages = [
        { role: 'user', content: '배포해줘' },
        { role: 'assistant', content: '배포 시작했습니다.' },
        {
            role: 'user',
            content: RECOVERY_NOTICE,
            meta: { source: 'task-notification', execution: { surface: 'shell', id: 'job_recovery_1', status: 'failed' } },
        },
    ];
    const restored = restoreTranscriptItems(messages, { sessionId: 'sess_mode_test' });
    const items = Array.isArray(restored) ? restored : restored.items;
    const card = items.find((it) => it?.kind === 'tool' && it?.args?.task_id === 'job_recovery_1');
    assert.ok(card, 'notification row must project a tool card');
    assert.equal(card.name, 'shell');
    assert.equal(card.isError, true);
    assert.match(String(card.result || ''), /outcome was lost/);
    assert.ok(!items.some((it) => it?.kind === 'user' && /Async shell task/.test(it.text || '')));
});
