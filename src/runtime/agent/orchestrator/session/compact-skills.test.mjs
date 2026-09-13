import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillToolEnvelope } from '../context/collect.mjs';
import { latestSkillBodies, skillContextReminder } from '../context/skill-state.mjs';
import { freshContextCompactMessages } from './compact.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import { latestActualUserInstructionMessage } from './compact/messages.mjs';
import { prepareProviderPrefixGuard } from './provider-prefix-guard.mjs';

const skill = (name, text) => buildSkillToolEnvelope(name, text, `/skills/${name}`).newMessages[0];
const compact = messages => freshContextCompactMessages(messages, 10_000, {
    force: true, handoffText: 'The request is still in progress.', activeTurn: true,
});

test('Compact restores the latest complete skill body and resume can reuse it without a new Skill call', () => {
    const old = skill('guide', '# Old procedure');
    const current = skill('guide', '# Current procedure\nKeep all of these instructions.');
    const other = skill('other', '# Other procedure');
    const input = [
        { role: 'system', content: 'Fixed system and catalog' },
        { role: 'user', content: 'Previous task' },
        old, other, current,
        { role: 'user', content: 'Continue the actual task' },
    ];
    const before = structuredClone(input);
    const first = compact(input);
    assert.deepEqual(input, before);
    assert.deepEqual(latestSkillBodies(first.messages).map(entry => entry.message), [other, current]);
    assert.equal(latestActualUserInstructionMessage(first.messages).content, 'Continue the actual task');
    const resumed = JSON.parse(JSON.stringify(first.messages));
    const repeat = buildSkillToolEnvelope('guide', '# Current procedure\nKeep all of these instructions.',
        '/skills/guide', {}, { messages: resumed });
    assert.deepEqual(repeat.newMessages, []);
    const second = compact(resumed);
    assert.deepEqual(latestSkillBodies(second.messages).map(entry => entry.message), [other, current]);
    const events = [];
    const baseline = prepareProviderPrefixGuard(null, second.messages, { tools: [] }, { provider: 'openai-oauth' });
    const followup = [...second.messages, { role: 'user', content: 'Next step' }, skillContextReminder(second.messages)];
    prepareProviderPrefixGuard(baseline, followup, { tools: [] },
        { provider: 'openai-oauth', onCacheBreak: event => events.push(event) });
    assert.deepEqual(events, []);
});

test('restoration is bounded, favors recent bodies, and never presents partial instructions as loaded', () => {
    const older = skill('older', '# Older\n' + 'instruction '.repeat(500));
    const recent = skill('recent', '# Recent\n' + 'instruction '.repeat(500));
    const oversized = skill('large', '# Large\n' + 'instruction '.repeat(20_000));
    const first = compact([
        { role: 'system', content: 'Stable' },
        { role: 'user', content: 'Start' }, older, recent, oversized,
        { role: 'user', content: 'Continue' },
    ]);
    const restored = latestSkillBodies(first.messages).map(entry => entry.message);
    assert.deepEqual(restored, [recent]);
    assert.ok(estimateMessagesTokens(restored) <= 2_000);
    assert.ok(estimateMessagesTokens(first.messages) <= 10_000);
    assert.match(skillContextReminder(first.messages).content, /"recent"/);
    assert.doesNotMatch(skillContextReminder(first.messages).content, /"older"|"large"/);
    const reload = buildSkillToolEnvelope('large', '# Large\n' + 'instruction '.repeat(20_000),
        '/skills/large', {}, { messages: first.messages });
    assert.equal(reload.newMessages.length, 1);
    assert.equal(reload.newMessages[0].content, oversized.content);
});

test('skills are isolated by transcript, not by a process-wide loaded flag', () => {
    const source = [{ role: 'system', content: 'S' }, { role: 'user', content: 'Start' }, skill('private', 'PRIVATE'),
        { role: 'user', content: 'Continue' }];
    const separate = compact([{ role: 'system', content: 'S' }, { role: 'user', content: 'Other session' }]);
    assert.equal(skillContextReminder(separate.messages), null);
    assert.equal(latestSkillBodies(compact(source).messages).length, 1);
    assert.equal(latestSkillBodies(separate.messages).length, 0);
});
