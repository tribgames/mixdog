import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSkillToolEnvelope } from '../context/collect.mjs';
import { latestSkillBodies } from '../context/skill-state.mjs';
import { freshContextCompactMessages } from './compact.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import { latestActualUserInstructionMessage } from './compact/messages.mjs';
import { prepareProviderPrefixGuard } from './provider-prefix-guard.mjs';

const skill = (name, text) => buildSkillToolEnvelope(name, text, `/skills/${name}`).newMessages[0];
const compact = (messages) =>
  freshContextCompactMessages(messages, 10_000, {
    force: true,
    handoffText: 'The request is still in progress.',
    activeTurn: true,
  });

test('Compact restores the latest complete skill body and resume can reuse it without a new Skill call', () => {
  const old = skill('guide', '# Old procedure');
  const current = skill('guide', '# Current procedure\nKeep all of these instructions.');
  const other = skill('other', '# Other procedure');
  const input = [
    { role: 'system', content: 'Fixed system and catalog' },
    { role: 'user', content: 'Previous task' },
    old,
    other,
    current,
    { role: 'user', content: 'Continue the actual task' },
  ];
  const before = structuredClone(input);
  const first = compact(input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    latestSkillBodies(first.messages).map((entry) => entry.message),
    [other, current]
  );
  assert.equal(latestActualUserInstructionMessage(first.messages).content, 'Continue the actual task');
  const resumed = JSON.parse(JSON.stringify(first.messages));
  const repeat = buildSkillToolEnvelope(
    'guide',
    '# Current procedure\nKeep all of these instructions.',
    '/skills/guide',
    {},
    { messages: resumed }
  );
  assert.deepEqual(repeat.newMessages, []);
  const second = compact(resumed);
  assert.deepEqual(
    latestSkillBodies(second.messages).map((entry) => entry.message),
    [other, current]
  );
  assert.equal(
    second.messages.some((message) => message.meta?.source === 'skill-context'),
    false
  );
  const events = [];
  const baseline = prepareProviderPrefixGuard(null, second.messages, { tools: [] }, { provider: 'openai-oauth' });
  const followup = [...second.messages, { role: 'user', content: 'Next step' }];
  prepareProviderPrefixGuard(
    baseline,
    followup,
    { tools: [] },
    { provider: 'openai-oauth', onCacheBreak: (event) => events.push(event) }
  );
  assert.deepEqual(events, []);
});

test('restoration is bounded, favors recent bodies, and never presents partial instructions as loaded', () => {
  const older = skill('older', `# Older\n${'instruction '.repeat(500)}`);
  const recent = skill('recent', `# Recent\n${'instruction '.repeat(500)}`);
  const oversized = skill('large', `# Large\n${'instruction '.repeat(20_000)}`);
  const first = compact([
    { role: 'system', content: 'Stable' },
    { role: 'user', content: 'Start' },
    older,
    recent,
    oversized,
    { role: 'user', content: 'Continue' },
  ]);
  const restored = latestSkillBodies(first.messages).map((entry) => entry.message);
  assert.deepEqual(restored, [recent]);
  assert.ok(estimateMessagesTokens(restored) <= 2_000);
  assert.ok(estimateMessagesTokens(first.messages) <= 10_000);
  const reload = buildSkillToolEnvelope(
    'large',
    `# Large\n${'instruction '.repeat(20_000)}`,
    '/skills/large',
    {},
    { messages: first.messages }
  );
  assert.equal(reload.newMessages.length, 1);
  assert.equal(reload.newMessages[0].content, oversized.content);
});

function nativeSkillLoader(name, tool) {
  const call = { id: `toolu_skill_${name}`, name: 'Skill', arguments: { name } };
  const result = {
    role: 'tool',
    toolCallId: call.id,
    content: `Loaded skill: ${name}`,
    nativeToolSearch: { provider: 'anthropic-oauth', toolReferences: [tool], openaiTools: [] },
  };
  return { call, result };
}

const referencing = (messages, tool) =>
  messages.filter((message) => message.nativeToolSearch?.toolReferences?.includes(tool));

test('a restored skill body keeps the native loader pair that exposes its linked tools', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-skill-loader-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
  const body = skill('guide', '# Guide');
  const loader = nativeSkillLoader('guide', 'tidy');
  // Later tool work fills the tool-history budget, so the loader group itself
  // falls outside the retained execution tail.
  const work = [];
  for (let index = 0; index < 4; index += 1) {
    const id = `toolu_read_${index}`;
    work.push(
      { role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: { file_path: `f${index}` } }] },
      { role: 'tool', toolCallId: id, content: 'line '.repeat(250) }
    );
  }
  const result = freshContextCompactMessages(
    [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: '', toolCalls: [loader.call] },
      loader.result,
      body,
      ...work,
    ],
    10_000,
    {
      force: true,
      handoffText: 'The request is still in progress.',
      activeTurn: true,
      contextWindow: 20_000,
      sessionId: 'compact-skill-loader',
    }
  ).messages;
  const loaders = referencing(result, 'tidy');
  assert.equal(loaders.length, 1);
  const index = result.indexOf(loaders[0]);
  assert.deepEqual(result[index - 1].toolCalls, [loader.call]);
  assert.equal(result[index + 1], body);
});

test('a loader pair already kept in the retained tail is not restored twice', () => {
  const body = skill('guide', '# Guide');
  const loader = nativeSkillLoader('guide', 'tidy');
  const result = compact([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Start' },
    { role: 'assistant', content: '', toolCalls: [loader.call] },
    loader.result,
    body,
    { role: 'assistant', content: 'Working on it.' },
    { role: 'user', content: 'Continue' },
  ]).messages;
  assert.equal(referencing(result, 'tidy').length, 1);
  assert.equal(result.filter((message) => message.toolCalls?.some((call) => call.id === loader.call.id)).length, 1);
  assert.equal(latestSkillBodies(result).length, 1);
});

test('skills are isolated by transcript, not by a process-wide loaded flag', () => {
  const source = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Start' },
    skill('private', 'PRIVATE'),
    { role: 'user', content: 'Continue' },
  ];
  const separate = compact([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Other session' },
  ]);
  assert.equal(latestSkillBodies(compact(source).messages).length, 1);
  assert.equal(latestSkillBodies(separate.messages).length, 0);
});
