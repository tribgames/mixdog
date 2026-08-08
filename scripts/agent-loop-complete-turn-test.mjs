#!/usr/bin/env node
// Turn-loop termination contract. A no-tool assistant message is TERMINAL:
// there is no mandatory terminal tool, no completion strikes, and no
// progress-text heuristic. Sampling
// only continues on a structured provider follow-up signal (end_turn=false /
// pause_turn), tool calls/results, the bounded empty/output-limit ladders, or a
// stop hook that blocks once with a continuation prompt.
//
// The only preserved defense is the narrow unresolved-tool-failure stop hook:
// after a real tool failure it blocks the FIRST terminal message once, records
// a structural continuation prompt, then never blocks again in that turn.
// (File name is pinned by package.json test:session.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Diagnostic-sink isolation: these tests intentionally fail apply_patch calls,
// and without redirection every dev-loop run appends phantom failures to the
// REAL ~/.mixdog tool-failure log and patch-replay captures (observed: 783
// no-session rows in one day). Env is read lazily at first failure, so setting
// it here — after the hoisted imports but before any test runs — is safe.
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(tmpdir(), `mixdog-agent-loop-test-failures-${process.pid}.jsonl`);
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';

import { agentLoop } from '../src/runtime/agent/orchestrator/session/agent-loop.mjs';
import { _intraTurnSig } from '../src/runtime/agent/orchestrator/session/loop/tool-classify.mjs';
import {
    STOP_HOOK_SOURCE,
    createToolFailureStopHook,
    toolFailureContinuationPrompt,
} from '../src/runtime/agent/orchestrator/session/loop/stop-hooks.mjs';
import { classifyTerminationReason } from '../src/runtime/agent/orchestrator/session/loop/termination.mjs';
import { finalizeSessionToolList } from '../src/runtime/agent/orchestrator/session/manager/tool-resolution.mjs';
import { applyDeferredToolSurface } from '../src/session-runtime/tool-catalog.mjs';
import {
    DEFERRED_DEFAULT_FULL_TOOLS,
    DEFERRED_DEFAULT_LEAD_TOOLS,
    DEFERRED_DEFAULT_READONLY_TOOLS,
} from '../src/session-runtime/tool-catalog-data.mjs';

// Fresh object per run: the loop mutates sessionRef (repeat-failure guard
// counters), so a shared literal would leak guard state between tests.
const publicSession = (extra = {}) => ({ owner: 'agent', agent: 'heavy-worker', ...extra });
// The real Main/Lead runtime shape (session-runtime/session-lifecycle.mjs:175).
const LEAD_SESSION = { owner: 'cli', agent: 'lead' };
const LIST_TOOL = { name: 'list', annotations: { readOnlyHint: true } };
const TOOLS = [LIST_TOOL];

function queuedProvider(responses) {
    const sent = [];
    let index = 0;
    return {
        sent,
        async send(messages) {
            sent.push(structuredClone(messages));
            const response = responses[index++];
            assert.ok(response, `unexpected provider send ${index}`);
            return { usage: { inputTokens: 1, outputTokens: 1 }, ...response };
        },
    };
}

function repeatingProvider(response) {
    const sent = [];
    return {
        sent,
        async send(messages) {
            sent.push(structuredClone(messages));
            return { usage: { inputTokens: 1, outputTokens: 1 }, ...response };
        },
    };
}

async function run(provider, messages, { session = publicSession(), tools = TOOLS } = {}) {
    return agentLoop(provider, messages, 'fake-model', tools, undefined, process.cwd(), { session });
}

const stopHookPrompts = (messages) => messages.filter((m) => m?.meta?.source === STOP_HOOK_SOURCE);
const steeringMessages = (messages) => messages.filter((m) => m?.meta?.source === 'steering');
const systemReminders = (messages) => messages.filter((m) => (
    m?.role === 'user'
    && m?.meta === 'hook'
    && /<system-reminder>/i.test(String(m?.content || ''))
));
const failingPatchCall = (id = 'call-patch') => ({
    id,
    name: 'apply_patch',
    arguments: { patch: 'this is not a diff', base_path: tmpdir() },
});

// ---- no mandatory terminal tool anywhere ---------------------------------

test('no terminal tool is registered or pinned onto any surface', () => {
    const names = (list) => (list || []).map((tool) => tool?.name ?? tool);
    const base = [{ name: 'read' }, { name: 'shell' }];
    for (const resolvedAgent of ['lead', null, 'worker', 'explorer']) {
        assert.deepEqual(
            names(finalizeSessionToolList(base, { ownerIsAgent: resolvedAgent === 'worker', resolvedAgent })),
            ['read', 'shell'],
            String(resolvedAgent),
        );
    }
    for (const defaults of [DEFERRED_DEFAULT_FULL_TOOLS, DEFERRED_DEFAULT_LEAD_TOOLS, DEFERRED_DEFAULT_READONLY_TOOLS]) {
        assert.equal(defaults.includes('complete_turn'), false);
    }
    // The deferred surface no longer force-selects a terminal action.
    const session = { tools: [{ name: 'read', annotations: { readOnlyHint: true } }], provider: 'anthropic' };
    applyDeferredToolSurface(session, 'lead', [], { provider: 'anthropic' });
    assert.deepEqual(names(session.tools), ['read']);
    assert.equal((session.deferredCallableTools || []).includes('complete_turn'), false);
});

// ---- stop-hook unit ------------------------------------------------------

test('the stop hook arms on a failed batch, clears on an executed success, and fires once', () => {
    const hook = createToolFailureStopHook();
    assert.equal(hook.takeContinuationPrompt(), null);

    hook.observeToolResult({ role: 'tool', content: 'Error: nope', toolCallId: 'c1', toolKind: 'error' });
    hook.endBatch([{ id: 'c1', name: 'apply_patch' }]);
    assert.equal(hook.unresolvedFailure, true);
    assert.equal(hook.lastFailedTool, 'apply_patch');

    // Dedup/guard skip stubs executed nothing: neutral, they cannot resolve it.
    hook.observeToolResult({ role: 'tool', content: '[cross-turn-dedup] …', toolCallId: 'c2', toolKind: 'skipped' });
    hook.observeToolResult({ role: 'tool', content: 'unknown kind', toolCallId: 'c3' });
    hook.endBatch([{ id: 'c2', name: 'list' }, { id: 'c3', name: 'list' }]);
    assert.equal(hook.unresolvedFailure, true);

    // Blocks exactly once, then stays inactive.
    const prompt = hook.takeContinuationPrompt();
    assert.equal(prompt, toolFailureContinuationPrompt('apply_patch'));
    assert.match(prompt, /apply_patch/);
    assert.equal(hook.takeContinuationPrompt(), null);
    assert.equal(hook.active, true);

    hook.observeToolResult({ role: 'tool', content: 'ok', toolCallId: 'c4', toolKind: 'normal' });
    hook.endBatch([{ id: 'c4', name: 'list' }]);
    assert.equal(hook.unresolvedFailure, false);
    assert.equal(hook.takeContinuationPrompt(), null);
});

test('only an executed `normal` result resolves a failure; guard skips never arm one', () => {
    const hook = createToolFailureStopHook();
    hook.observeToolResult({ role: 'tool', content: 'Error: boom', toolCallId: 'c1', toolKind: 'error' });
    hook.endBatch([{ id: 'c1', name: 'apply_patch' }]);
    // Cache hits replay an earlier result — nothing executed, nothing resolved.
    for (const kind of ['cache-hit', 'scoped-cache-hit', 'skipped']) {
        hook.observeToolResult({ role: 'tool', content: 'replayed', toolCallId: `c-${kind}`, toolKind: kind });
        hook.endBatch([{ id: `c-${kind}`, name: 'read' }]);
        assert.equal(hook.unresolvedFailure, true, kind);
    }
    hook.observeToolResult({ role: 'tool', content: 'ok', toolCallId: 'c9', toolKind: 'normal' });
    hook.endBatch([{ id: 'c9', name: 'read' }]);
    assert.equal(hook.unresolvedFailure, false);

    // A repeat-failure-guard skip is tagged 'error' for downstream consumers,
    // but nothing was dispatched: it is not a real tool failure.
    const guarded = createToolFailureStopHook();
    guarded.observeToolResult({ role: 'tool', content: '[repeat-failure-guard] …', toolCallId: 'g1', toolKind: 'error', guardSkip: true });
    guarded.endBatch([{ id: 'g1', name: 'definitely_missing_tool' }]);
    assert.equal(guarded.unresolvedFailure, false);
    assert.equal(guarded.takeContinuationPrompt(), null);
});

test('classifyTerminationReason has no completion-contract reason left', () => {
    assert.equal(
        classifyTerminationReason({ content: 'final', stopReason: 'end_turn' }, { sessionAgent: 'heavy-worker' }),
        undefined,
    );
    assert.equal(
        classifyTerminationReason({ content: '', stopReason: 'end_turn' }, { sessionAgent: 'heavy-worker' }),
        'empty',
    );
});

// ---- loop behavior -------------------------------------------------------

test('text-only turn is the final answer — one send, no continuation', async () => {
    const provider = queuedProvider([{ content: 'edited a.mjs:12; tests pass', stopReason: 'end_turn' }]);
    const messages = [{ role: 'user', content: 'do the work' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 1);
    assert.equal(result.content, 'edited a.mjs:12; tests pass');
    assert.equal(result.terminationReason, undefined);
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.completion, undefined);
});

test('regression: failed apply_patch then "retrying" prose gets ONE stop-hook continuation, then the next text ends the turn', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall()] },
        { content: 'apply_patch failed - retrying now.', stopReason: 'end_turn' },
        { content: 'patch reapplied by hand; a.mjs:12 updated', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'patch the file' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 3);
    assert.equal(messages.find((m) => m.toolCallId === 'call-patch').toolKind, 'error');
    // Exactly one structural continuation prompt, naming the failed tool.
    const prompts = stopHookPrompts(messages);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].meta.tool, 'apply_patch');
    assert.match(prompts[0].content, /Stop hook: `apply_patch` failed/);
    // The blocked narration stays in context exactly once.
    assert.equal(messages.filter((m) => m.role === 'assistant' && m.content === 'apply_patch failed - retrying now.').length, 1);
    assert.equal(result.content, 'patch reapplied by hand; a.mjs:12 updated');
    assert.equal(result.terminationReason, undefined);
});

test('the stop hook never blocks a second time — a still-unresolved failure ends on final text', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall()] },
        { content: 'first wrap-up', stopReason: 'end_turn' },
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall('call-patch-2')] },
        { content: 'blocked: apply_patch keeps failing on this file', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'patch the file' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 4);
    assert.equal(stopHookPrompts(messages).length, 1);
    // Blocked/error prose is an ordinary accepted final answer.
    assert.equal(result.content, 'blocked: apply_patch keeps failing on this file');
    assert.equal(result.terminationReason, undefined);
});

test('a later successful tool call resolves the failure so no stop hook fires at all', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall()] },
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'call-list', name: 'list', arguments: { path: process.cwd() } }] },
        { content: 'recovered; listed cwd', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'patch the file' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 3);
    assert.equal(messages.find((m) => m.toolCallId === 'call-list').toolKind, 'normal');
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.content, 'recovered; listed cwd');
});

test('pending input is folded in before the stop hook, so steering is never displaced', async () => {
    // Pending input feeds needs_follow_up, which is
    // evaluated BEFORE run_turn_stop_hooks.
    let queued = [{ content: 'also update the README', submittedAt: Date.now() }];
    let drains = 0;
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall()] },
        { content: 'first wrap-up', stopReason: 'end_turn' },
        { content: 'second wrap-up', stopReason: 'end_turn' },
        { content: 'final handoff', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'patch the file' }];

    const result = await agentLoop(provider, messages, 'fake-model', TOOLS, undefined, process.cwd(), {
        session: publicSession(),
        // 1st call = post-tool-batch pre-send drain, 2nd = the terminal drain.
        drainSteering: () => {
            drains += 1;
            if (drains !== 2) return [];
            const out = queued;
            queued = [];
            return out;
        },
    });

    assert.equal(provider.sent.length, 4);
    const steer = steeringMessages(messages);
    assert.equal(steer.length, 1);
    assert.equal(steer[0].content, 'also update the README');
    // The blocked terminal text is committed once, ahead of the steering turn.
    assert.equal(messages.filter((m) => m.role === 'assistant' && m.content === 'first wrap-up').length, 1);
    assert.ok(messages.indexOf(steer[0]) > messages.findIndex((m) => m.content === 'first wrap-up'));
    // The synthetic continuation only fires on the LATER terminal turn.
    const prompts = stopHookPrompts(messages);
    assert.equal(prompts.length, 1);
    assert.ok(messages.indexOf(steer[0]) < messages.indexOf(prompts[0]));
    assert.equal(result.content, 'final handoff');
});

test('hidden roles are exempt from the failed-tool stop hook', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall()] },
        { content: 'chunk-a|chunk-b', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'patch the file' }];

    const result = await run(provider, messages, { session: { owner: 'agent', agent: 'explorer' } });

    assert.equal(provider.sent.length, 2);
    assert.equal(messages.find((m) => m.toolCallId === 'call-patch').toolKind, 'error');
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.content, 'chunk-a|chunk-b');
    assert.equal(result.terminationReason, undefined);
});

test('a repeat-failure-guard skip is not a real failure: the terminal text ends the turn', async () => {
    const failingArgs = { path: 'nowhere' };
    const session = publicSession({
        // Guard already at the limit: the next identical call is skipped, not run.
        _repeatFailGuard: { sig: _intraTurnSig('definitely_missing_tool', failingArgs), count: 3 },
    });
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'call-skip', name: 'definitely_missing_tool', arguments: failingArgs }] },
        { content: 'that tool cannot run here; stopping', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'do the work' }];

    const result = await run(provider, messages, { session });

    assert.equal(provider.sent.length, 2);
    const skip = messages.find((m) => m.toolCallId === 'call-skip');
    assert.match(skip.content, /\[repeat-failure-guard\]/);
    assert.equal(skip.toolKind, 'error');
    assert.equal(skip.guardSkip, true);
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.content, 'that tool cannot run here; stopping');
});

test('dedup/guard skips stay non-resolving: the hook still blocks once after them', async () => {
    const listArgs = { path: process.cwd() };
    const provider = queuedProvider([
        // seed the cross-turn dedup map with a real success
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'call-seed', name: 'list', arguments: listArgs }] },
        { content: '', stopReason: 'tool_use', toolCalls: [failingPatchCall()] },
        {
            content: '',
            stopReason: 'tool_use',
            toolCalls: [
                { id: 'call-cross', name: 'list', arguments: listArgs },
                { id: 'call-intra', name: 'list', arguments: listArgs },
            ],
        },
        { content: 'wrapping up', stopReason: 'end_turn' },
        { content: 'final handoff', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'patch the file' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 5);
    const cross = messages.find((m) => m.toolCallId === 'call-cross');
    assert.match(cross.content, /\[cross-turn-dedup\]/);
    assert.equal(cross.toolKind, 'skipped');
    const intra = messages.find((m) => m.toolCallId === 'call-intra');
    assert.match(intra.content, /\[intra-turn-dedup\]/);
    assert.equal(intra.toolKind, 'skipped');
    assert.equal(stopHookPrompts(messages).length, 1);
    assert.equal(result.content, 'final handoff');
});

test('Main/Lead (owner cli, agent lead) follows the same Codex terminal semantics', async () => {
    const provider = queuedProvider([{ content: 'config verified; nothing to change', stopReason: 'end_turn' }]);
    const messages = [{ role: 'user', content: 'check the config' }];

    const result = await run(provider, messages, { session: LEAD_SESSION });

    assert.equal(provider.sent.length, 1);
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.content, 'config verified; nothing to change');
    assert.equal(result.terminationReason, undefined);
});

test('hidden roles keep their text-only terminal contract', async () => {
    const provider = queuedProvider([{ content: 'final answer', stopReason: 'end_turn' }]);
    const messages = [{ role: 'user', content: 'do the work' }];
    const result = await run(provider, messages, { session: { owner: 'agent', agent: 'explorer' } });
    assert.equal(provider.sent.length, 1);
    assert.equal(result.content, 'final answer');
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.terminationReason, undefined);
});

test('explorer gets three report gates and an explicit fifth-and-final report turn', async () => {
    const provider = queuedProvider([
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'ex-1', name: 'definitely_missing_tool', arguments: { q: 1 } }] },
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'ex-2', name: 'definitely_missing_tool', arguments: { q: 2 } }] },
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'ex-3', name: 'definitely_missing_tool', arguments: { q: 3 } }] },
        { content: '', stopReason: 'tool_use', toolCalls: [{ id: 'ex-4', name: 'definitely_missing_tool', arguments: { q: 4 } }] },
        { content: 'src/example.mjs:7 — target — current anchor', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'locate target' }];
    const result = await run(provider, messages, {
        session: { owner: 'agent', agent: 'explorer', maxLoopIterations: 200 },
    });

    assert.equal(provider.sent.length, 5);
    assert.equal(result.maxLoopIterations, 4);
    assert.equal(result.content, 'src/example.mjs:7 — target — current anchor');
    const reminders = systemReminders(messages);
    assert.equal(reminders.length, 4);
    assert.match(reminders[0].content, /turn 1\/5 complete[\s\S]*already has a credible anchor[\s\S]*report immediately[\s\S]*zero anchors[\s\S]*never reconfirm/i);
    assert.match(reminders[1].content, /turn 2\/5 complete[\s\S]*already has a credible anchor[\s\S]*report immediately[\s\S]*zero anchors[\s\S]*never reconfirm/i);
    assert.match(reminders[2].content, /turn 3\/5 complete[\s\S]*already has a credible anchor[\s\S]*report immediately[\s\S]*final recovery tool turn[\s\S]*zero anchors[\s\S]*never reconfirm/i);
    assert.match(reminders[3].content, /turn 5\/5[\s\S]*FINAL REPORT TURN[\s\S]*last turn[\s\S]*Tools are disabled[\s\S]*anchors currently held[\s\S]*EXPLORATION_FAILED/i);
    assert.equal(provider.sent[1].some((m) => m === reminders[0] || m?.content === reminders[0].content), true);
    assert.equal(provider.sent[2].some((m) => m === reminders[1] || m?.content === reminders[1].content), true);
    assert.equal(provider.sent[3].some((m) => m === reminders[2] || m?.content === reminders[2].content), true);
    assert.equal(provider.sent[4].some((m) => m === reminders[3] || m?.content === reminders[3].content), true);
});

test('structured provider continuation and output-limit recovery keep sampling alive', async () => {
    const provider = queuedProvider([
        // ResponseEvent::Completed { end_turn: Some(false) } → needs_follow_up
        { content: 'mid-turn synthesis', stopReason: 'end_turn', endTurn: false },
        { content: 'paused output', stopReason: 'pause_turn' },
        { content: 'A', stopReason: 'max_tokens', truncated: true },
        { content: 'final structured handoff', stopReason: 'end_turn' },
    ]);
    const messages = [{ role: 'user', content: 'do the work' }];

    const result = await run(provider, messages);

    assert.equal(provider.sent.length, 4);
    assert.equal(result.providerContinuations, 2);
    assert.equal(messages.filter((m) => m?.meta?.source === 'max-output-recovery').length, 1);
    assert.equal(stopHookPrompts(messages).length, 0);
    assert.equal(result.content, 'Afinal structured handoff');
    assert.equal(result.terminationReason, undefined);
});

test('empty-turn ladder and iteration cap stay the bounding guards', async () => {
    const empty = repeatingProvider({ content: '', stopReason: 'end_turn' });
    const emptyMessages = [{ role: 'user', content: 'do the work' }];
    const emptyResult = await run(empty, emptyMessages);
    assert.equal(empty.sent.length, 4);
    assert.equal(emptyResult.terminationReason, 'empty');
    assert.equal(stopHookPrompts(emptyMessages).length, 0);

    const capped = repeatingProvider({
        content: '',
        stopReason: 'tool_use',
        toolCalls: [{ id: 'call-x', name: 'definitely_missing_tool', arguments: {} }],
    });
    const cappedMessages = [{ role: 'user', content: 'do the work' }];
    const cappedResult = await agentLoop(capped, cappedMessages, 'fake-model', TOOLS, undefined, process.cwd(), {
        session: publicSession({ maxLoopIterations: 3 }),
    });
    assert.equal(cappedResult.terminationReason, 'iteration_cap');
    assert.equal(cappedResult.maxLoopIterations, 3);
    // The granted hard-cap final turn is never blocked by the stop hook.
    assert.equal(stopHookPrompts(cappedMessages).length, 0);
});
