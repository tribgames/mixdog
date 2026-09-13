import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillSelectionHeader, selectedSkillName } from '../../../shared/skill-selection.mjs';
import { invalidateSkillsCache } from '../context/collect.mjs';
import { latestSkillBodies } from '../context/skill-state.mjs';
import { prepareExplicitSkills } from './explicit-skills.mjs';
import { SKILL_TOOL } from '../../../../session-runtime/tool-defs.mjs';
import { applyDeferredToolSurface, snapshotProviderRequestTools } from '../../../../session-runtime/tool-catalog.mjs';
import { buildRequestBody } from '../providers/openai-responses-payload.mjs';
import { toAnthropicMessages } from '../providers/lib/anthropic-request-utils.mjs';
import { prepareProviderPrefixGuard } from './provider-prefix-guard.mjs';
import { agentLoop } from './agent-loop.mjs';

const BODY = '# Selected guide\nUse the selected procedure, not a substitute.';
const office = {
    name: 'office', description: 'Create a document.',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
};
const read = {
    name: 'read', description: 'Read a file.', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {} },
};

async function withSkill(run) {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-explicit-skill-'));
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = root;
    const dir = join(root, 'skills', 'selected-guide');
    mkdirSync(dir, { recursive: true });
    const write = body => {
        writeFileSync(join(dir, 'SKILL.md'),
            `---\nname: selected-guide\ndescription: Exercise explicit skill selection.\ndependencies:\n  tools:\n    - type: tool\n      value: office\n---\n${body}\n`);
        invalidateSkillsCache(root);
    };
    write(BODY);
    try { await run({ root, write }); }
    finally {
        invalidateSkillsCache(root);
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
}

function newSession(provider, root) {
    const session = { provider, cwd: root, toolSpec: 'full', tools: [SKILL_TOOL, office, read],
        messages: [{ role: 'system', content: 'Stable instructions and skill catalog.' }], compaction: { auto: false } };
    applyDeferredToolSurface(session, 'full');
    session.liveTurnMessages = session.messages;
    return session;
}

const requestTools = session => snapshotProviderRequestTools({
    provider: session.provider, tools: session.tools, messages: session.messages, session,
});
const bodies = session => session.messages.filter(message => (
    message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<skill>')
));

test('only a leading explicit selection is syntax, with multimodal content and escaped names supported', () => {
    const name = 'a "quoted" skill';
    assert.equal(selectedSkillName(skillSelectionHeader(name) + 'Work'), name);
    assert.equal(selectedSkillName([{ type: 'text', text: skillSelectionHeader(name) }, { type: 'image', data: 'x' }]), name);
    for (const prompt of [
        'Please discuss Skill: "pdf"', 'Skill: broken\n\nWork', 'Skill: ""\n\nWork',
        '```\nSkill: "pdf"\n\n```', 'Quoted:\nSkill: "pdf"\n\nWork',
        [{ type: 'image', data: 'x' }, { type: 'text', text: skillSelectionHeader('pdf') }],
    ]) assert.equal(selectedSkillName(prompt), null);
});

test('explicit preparation is append-only and the first model request has the body and valid native schemas', async () => {
    await withSkill(async ({ root }) => {
        for (const provider of ['openai-oauth', 'anthropic-oauth', 'gemini', 'openrouter']) {
            const session = newSession(provider, root);
            const prompt = skillSelectionHeader('selected-guide') + 'Create the document.';
            session.messages.push({ role: 'user', content: prompt });
            const prefix = structuredClone(session.messages);
            const tools = requestTools(session);
            const cacheBreaks = [];
            const before = prepareProviderPrefixGuard(null, session.messages, { tools }, { provider });
            await prepareExplicitSkills(prompt, session.messages, session);
            assert.deepEqual(session.messages.slice(0, prefix.length), prefix);
            prepareProviderPrefixGuard(before, session.messages, { tools: requestTools(session) },
                { provider, onCacheBreak: event => cacheBreaks.push(event) });
            assert.deepEqual(cacheBreaks, []);
            assert.equal(bodies(session).length, 1);
            assert.ok(bodies(session)[0].content.includes(BODY));
            let sends = 0;
            await agentLoop({ name: provider, async send(messages, _model, sentTools) {
                sends += 1;
                assert.equal(JSON.stringify(messages).split('Selected guide').length - 1, 1);
                if (provider === 'openai-oauth') {
                    const payload = buildRequestBody(messages, 'gpt-6-astra', sentTools);
                    const call = payload.input.find(item => item.type === 'tool_search_call');
                    const output = payload.input.find(item => item.type === 'tool_search_output');
                    assert.ok(call);
                    assert.equal(output.call_id, call.call_id);
                    assert.deepEqual(output.tools.find(tool => tool.name === 'office').parameters, office.inputSchema);
                    assert.deepEqual(payload.tools, buildRequestBody(prefix, 'gpt-6-astra', tools).tools);
                } else if (provider === 'anthropic-oauth') {
                    assert.ok(JSON.stringify(toAnthropicMessages(messages, sentTools)).includes('"tool_reference","tool_name":"office"'));
                    assert.equal(sentTools.find(tool => tool.name === 'office').deferLoading, true);
                }
                return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
            } }, session.messages, 'fake-model', session.tools, null, root, { session });
            assert.equal(sends, 1, 'preparation must not consume a model round-trip');
        }
    });
});

test('repeat, resume and edited skills reuse only current bodies without rewriting previous requests', async () => {
    await withSkill(async ({ root, write }) => {
        let session = newSession('openai-oauth', root);
        const prompt = skillSelectionHeader('selected-guide') + 'Work';
        session.messages.push({ role: 'user', content: prompt });
        await prepareExplicitSkills(prompt, session.messages, session);
        const calls = session.messages.filter(message => message.toolCalls?.length).length;
        // Resume has no process-local skill registry: only durable messages.
        session = { ...session, messages: JSON.parse(JSON.stringify(session.messages)) };
        session.liveTurnMessages = session.messages;
        const before = structuredClone(session.messages);
        session.messages.push({ role: 'user', content: prompt });
        await prepareExplicitSkills(prompt, session.messages, session);
        assert.deepEqual(session.messages.slice(0, before.length), before);
        assert.equal(bodies(session).length, 1);
        assert.equal(session.messages.filter(message => message.toolCalls?.length).length, calls);
        write('# Updated guide\nUse the revised procedure.');
        session.messages.push({ role: 'user', content: prompt });
        await prepareExplicitSkills(prompt, session.messages, session);
        assert.equal(bodies(session).length, 2);
        assert.equal(latestSkillBodies(session.messages).length, 1);
        assert.match(latestSkillBodies(session.messages)[0].message.content, /revised procedure/);
        assert.deepEqual(session.messages.slice(0, before.length), before);
    });
});

test('ordinary follow-up turns advertise reusable skills without executing another load', async () => {
    await withSkill(async ({ root }) => {
        for (const provider of ['openai-oauth', 'anthropic-oauth']) {
            const session = newSession(provider, root);
            const selected = skillSelectionHeader('selected-guide') + 'Start the task.';
            session.messages.push({ role: 'user', content: selected });
            await prepareExplicitSkills(selected, session.messages, session);
            session.messages.push({ role: 'assistant', content: 'Ready.' });

            for (const prompt of [
                'Continue the same task.',
                'Use selected-guide for the next step too.',
                'Switch to an unrelated task.',
            ]) {
                session.messages.push({ role: 'user', content: prompt });
                await prepareExplicitSkills(prompt, session.messages, session, {
                    execute() { assert.fail('an ordinary follow-up must not execute Skill'); },
                });
                const reminder = session.messages.at(-1);
                assert.match(reminder.content, /Skill bodies already present in this context: "selected-guide"/);
                assert.match(reminder.content, /Reuse these bodies for matching requests, including later turns and repeated mentions/);
                assert.match(reminder.content, /do not call Skill again unless the body is missing or needs an update/);
                assert.match(reminder.content, /load_tool rather than reloading the skill/);
                session.messages.push({ role: 'assistant', content: 'Done.' });
            }
        }
    });
});

test('concurrent equivalent Skill calls inject one body even before the batch is flushed', async () => {
    await withSkill(async ({ root }) => {
        const session = newSession('openai-oauth', root);
        session.messages.push({ role: 'user', content: 'Use the selected guide.' });
        let sends = 0;
        await agentLoop({ name: 'openai-oauth', async send(messages) {
            sends += 1;
            if (sends === 1) return { content: '', toolCalls: [
                { id: 'first', name: 'Skill', arguments: { name: 'selected-guide' } },
                { id: 'second', name: 'Skill', arguments: { name: ' selected-guide ' } },
            ] };
            assert.equal(JSON.stringify(messages).split('Selected guide').length - 1, 1);
            return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
        } }, session.messages, 'fake-model', session.tools, null, root, { session });
        assert.equal(sends, 2);
        assert.equal(bodies(session).length, 1);
    });
});

test('queued selections are prepared before continuation, while task notifications cannot select skills', async () => {
    await withSkill(async ({ root }) => {
        const session = newSession('openai-oauth', root);
        session.messages.push({ role: 'user', content: 'First task' });
        const executed = [];
        session.beforeToolHook = async call => { executed.push(call.args.name); return { action: 'allow' }; };
        let sends = 0;
        let drained = false;
        await agentLoop({ name: 'openai-oauth', async send(messages) {
            sends += 1;
            if (sends === 1) assert.equal(latestSkillBodies(session.messages).length, 0);
            else assert.equal(JSON.stringify(messages).split('Selected guide').length - 1, 1);
            return { content: 'Done.', toolCalls: [], stopReason: 'end_turn' };
        } }, session.messages, 'fake-model', session.tools, null, root, {
            session,
            drainSteering() {
                if (sends !== 1 || drained) return [];
                drained = true;
                return [
                    { mode: 'task-notification', content: skillSelectionHeader('not-installed') + 'Finished.' },
                    { mode: 'prompt', content: skillSelectionHeader('selected-guide') + 'Next task' },
                ];
            },
        });
        assert.equal(sends, 2);
        assert.deepEqual(executed, ['selected-guide']);
        assert.equal(bodies(session).length, 1);
    });
});

test('missing, denied and cancelled selections never become successful skill bodies or schema grants', async () => {
    await withSkill(async ({ root }) => {
        for (const setup of [
            session => { session.beforeToolHook = async () => ({ action: 'deny', reason: 'policy' }); },
            session => { session.schemaAllowedTools = ['read']; },
        ]) {
            const session = newSession('openai-oauth', root);
            setup(session);
            const originalTools = structuredClone(session.tools);
            await prepareExplicitSkills(skillSelectionHeader('selected-guide'), session.messages, session);
            assert.equal(bodies(session).length, 0);
            assert.deepEqual(session.tools, originalTools);
            assert.match(session.messages.at(-1).content, /Error:/);
            assert.equal(session.messages.some(message => message.nativeToolSearch), false);
        }
        const session = newSession('openai-oauth', root);
        await prepareExplicitSkills(skillSelectionHeader('not-installed'), session.messages, session);
        assert.equal(bodies(session).length, 0);
        assert.match(session.messages.at(-1).content, /not found/);
        const before = structuredClone(session.messages);
        await assert.rejects(prepareExplicitSkills(skillSelectionHeader('selected-guide'), session.messages, session,
            { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
        assert.deepEqual(session.messages, before);
        session.toolSpec = 'readonly';
        await prepareExplicitSkills(skillSelectionHeader('selected-guide'), session.messages, session);
        assert.equal(bodies(session).length, 1);
        assert.ok(session.messages.some(message => /Required tools unavailable/.test(message.content)));
        assert.equal(session.deferredCallableTools?.includes('office') || false, false);
    });
});
