import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import { SUMMARY_PREFIX } from './compact/constants.mjs';
import { makeSummaryMessage } from './compact/messages.mjs';
import {
    SYNTHETIC_USER_ENVELOPE_TAG,
    SYNTHETIC_USER_KINDS,
    classifySyntheticUserMessage,
    projectSyntheticUserEnvelopes,
} from './synthetic-user-envelope.mjs';

const OPEN = (kind) => `<${SYNTHETIC_USER_ENVELOPE_TAG} kind="${kind}">\n`;
const CLOSE = `\n</${SYNTHETIC_USER_ENVELOPE_TAG}>`;

test('real user instructions stay unwrapped, including reminder-prefixed prompts', () => {
    const plain = { role: 'user', content: '이 파일 고쳐줘' };
    const withReminder = {
        role: 'user',
        content: '<system-reminder>\n# Current Time\n2026-09-03\n</system-reminder>\n\n이 파일 고쳐줘',
    };
    const steering = { role: 'user', content: 'stop and explain', meta: { source: 'steering' } };
    const imageOnly = { role: 'user', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] };
    for (const message of [plain, withReminder, steering, imageOnly]) {
        assert.equal(classifySyntheticUserMessage(message), null);
    }
    const { messages, stats } = projectSyntheticUserEnvelopes([plain, withReminder, steering, imageOnly]);
    assert.equal(stats.wrapped, 0);
    assert.equal(messages[0], plain);
    assert.equal(messages[1], withReminder);
});

test('runtime control rows are classified and wrapped on the wire', () => {
    const nudge = { role: 'user', content: '[mixdog-runtime] Empty response (1/2). Return final text.' };
    const interrupted = { role: 'user', content: '[Request interrupted by user for tool use]' };
    const asyncDone = {
        role: 'user',
        content: 'Async shell task job_1 (completed, exit 0) finished.\n\nResult:\n> [task_id: job_1]\n> [status: completed]',
    };
    const capReminder = {
        role: 'user',
        content: '<system-reminder>\nIteration cap reached — tools disabled.\n</system-reminder>',
        meta: 'hook',
    };
    const recovery = { role: 'user', content: 'Output token limit hit. Resume directly.', meta: { source: 'max-output-recovery', attempt: 1 } };
    for (const message of [nudge, interrupted, asyncDone, capReminder, recovery]) {
        assert.equal(classifySyntheticUserMessage(message), SYNTHETIC_USER_KINDS.RUNTIME_CONTROL, message.content);
    }
    const { messages, stats } = projectSyntheticUserEnvelopes([nudge]);
    assert.equal(stats.wrapped, 1);
    assert.equal(messages[0].content, `${OPEN('runtime-control')}${nudge.content}${CLOSE}`);
    assert.equal(nudge.content.startsWith('[mixdog-runtime]'), true, 'stored row is untouched');
});

test('compaction state and attached context get their own kinds', () => {
    const summary = makeSummaryMessage(`${SUMMARY_PREFIX}\nmessages=3 sha256=abc roles=user:1\n\nhandoff`);
    const continuation = {
        role: 'user',
        content: '<system-reminder>\n<active-turn-continuation>\ncontinue\n</active-turn-continuation>\n</system-reminder>',
        meta: { source: 'compact-active-turn-continuation', synthetic: true },
    };
    const skill = { role: 'user', content: '<skill>\n# docx\nbody\n</skill>', meta: 'skill' };
    const reference = { role: 'user', content: 'Reference files:\n\n--- a.md ---\nx' };
    assert.equal(classifySyntheticUserMessage(summary), SYNTHETIC_USER_KINDS.COMPACT_STATE);
    assert.equal(classifySyntheticUserMessage(continuation), SYNTHETIC_USER_KINDS.COMPACT_STATE);
    assert.equal(classifySyntheticUserMessage(skill), SYNTHETIC_USER_KINDS.CONTEXT_ATTACHMENT);
    assert.equal(classifySyntheticUserMessage(reference), SYNTHETIC_USER_KINDS.CONTEXT_ATTACHMENT);
    const { messages, stats } = projectSyntheticUserEnvelopes([summary, skill]);
    assert.deepEqual(stats.byKind, { 'compact-state': 1, 'context-attachment': 1 });
    assert.equal(messages[0].meta.source, 'compact-summary', 'meta survives the projection');
    assert.ok(messages[0].content.startsWith(OPEN('compact-state')));
});

test('block-array content wraps only the outer text blocks and stays idempotent', () => {
    const message = {
        role: 'user',
        content: [
            { type: 'text', text: '[mixdog-runtime] first' },
            { type: 'image', data: 'x', mimeType: 'image/png' },
            { type: 'text', text: 'last' },
        ],
    };
    const once = projectSyntheticUserEnvelopes([message]).messages[0];
    assert.equal(once.content[0].text, `${OPEN('runtime-control')}[mixdog-runtime] first`);
    assert.equal(once.content[1].type, 'image');
    assert.equal(once.content[2].text, `last${CLOSE}`);
    const twice = projectSyntheticUserEnvelopes([once]);
    assert.equal(twice.stats.wrapped, 0);
    assert.equal(twice.messages[0], once);
});

test('wire projection is stable across session reload and meta-dropping tail rebuilds', () => {
    const messages = [
        makeSummaryMessage(`${SUMMARY_PREFIX}\nmessages=3 sha256=abc roles=user:1\n\nhandoff`),
        { role: 'assistant', content: '.' },
        {
            role: 'user',
            content: '<system-reminder>\n<active-turn-continuation>\ncontinue\n</active-turn-continuation>\n</system-reminder>',
            meta: { source: 'compact-active-turn-continuation', synthetic: true },
        },
        { role: 'user', content: '<system-reminder>\nGOAL\n</system-reminder>\n\n한국어 요청' },
        { role: 'user', content: 'Output token limit hit. Resume directly.', meta: { source: 'max-output-recovery', attempt: 1 } },
        { role: 'user', content: '[mixdog-runtime] Empty response (1/2). Return final text.' },
    ];
    const wireContent = (rows) => JSON.stringify(projectSyntheticUserEnvelopes(rows).messages.map((m) => m.content));
    const wire = wireContent(messages);
    const reloaded = JSON.parse(JSON.stringify(messages));
    assert.equal(wireContent(reloaded), wire);
    const withoutMeta = reloaded.map(({ meta: _meta, ...rest }) => rest);
    assert.equal(wireContent(withoutMeta), wire);
});

test('agent loop sends enveloped synthetic rows while persisting the raw transcript', async () => {
    const sent = [];
    const provider = {
        async send(messages) {
            sent.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')));
            return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const session = {
        id: 'synthetic-envelope-wire-test',
        owner: 'cli',
        contextWindow: 200_000,
        rawContextWindow: 200_000,
        compaction: { auto: false },
    };
    const nudgeText = '[mixdog-runtime] Empty response (1/2). Return final text.';
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: '첫 요청' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: nudgeText },
        { role: 'assistant', content: 'still' },
        { role: 'user', content: '<system-reminder>\nGOAL\n</system-reminder>\n\n다음 요청' },
    ];
    await agentLoop(provider, messages, 'fake-model', [], null, process.cwd(), { session, sessionId: session.id });
    assert.equal(sent.length, 1);
    const wire = sent[0];
    assert.equal(wire[1], '첫 요청');
    assert.equal(wire[3], `${OPEN('runtime-control')}${nudgeText}${CLOSE}`);
    assert.equal(wire[5], '<system-reminder>\nGOAL\n</system-reminder>\n\n다음 요청');
    assert.equal(messages[3].content, nudgeText, 'stored transcript keeps the raw nudge');
});
