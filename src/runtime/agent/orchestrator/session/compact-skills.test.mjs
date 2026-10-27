import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSkillToolEnvelope } from '../context/collect.mjs';
import { latestSkillBodies } from '../context/skill-state.mjs';
import { freshContextCompactMessages } from './compact.mjs';
import { SKILL_RELOAD_MAX_IDLE } from './compact/runner.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import { latestActualUserInstructionMessage } from './compact/messages.mjs';
import { prepareProviderPrefixGuard } from './provider-prefix-guard.mjs';

const skill = (name, text) => buildSkillToolEnvelope(name, text, `/skills/${name}`).newMessages[0];
const compact = (messages, extra = {}) =>
  freshContextCompactMessages(messages, 10_000, {
    force: true,
    handoffText: 'The request is still in progress.',
    activeTurn: true,
    ...extra,
  });
// Repeated Compacts archive the execution history they drop.
function useDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-skill-window-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });
}
const reloadLines = (messages) => messages.filter((message) => message.meta?.source === 'compact-skill-reload');

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
  // Nothing used either skill since: no bodies, one reload line each.
  const second = compact(resumed);
  assert.deepEqual(latestSkillBodies(second.messages), []);
  assert.deepEqual(
    reloadLines(second.messages).map((line) => [line.meta.skill, line.meta.idle]),
    [
      ['other', 1],
      ['guide', 1],
    ]
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

// A model-driven load, as the Skill tool records it: the call, its stub result
// and (unless the body is already in context) the injected body.
let loadCount = 0;
function load(messages, name, text) {
  loadCount += 1;
  const id = `toolu_load_${name}_${loadCount}`;
  const envelope = buildSkillToolEnvelope(name, text, `/skills/${name}`, {}, { messages });
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'Skill', arguments: { name } }] },
    { role: 'tool', toolCallId: id, content: envelope.result },
    ...envelope.newMessages,
  ];
}
const bodiesOf = (messages, name) =>
  messages.filter(
    (message) => message.role === 'user' && String(message.content).startsWith(`<skill>\n<name>${name}</name>`)
  );
const idle = (messages) => Object.fromEntries(reloadLines(messages).map((line) => [line.meta.skill, line.meta.idle]));

function twoSkills() {
  const transcript = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Start' },
  ];
  transcript.push(...load(transcript, 'alpha', '# Alpha'));
  transcript.push(...load(transcript, 'beta', '# Beta'));
  transcript.push({ role: 'user', content: 'Continue' });
  return transcript;
}

test('after a Compact only the skills used in the window return as bodies; the rest become one reload line', () => {
  const first = compact(twoSkills());
  assert.deepEqual(
    latestSkillBodies(first.messages).map((entry) => entry.name),
    ['alpha', 'beta']
  );
  assert.deepEqual(reloadLines(first.messages), []);
  // Window two uses beta only (its Skill call finds the restored body: no new one).
  const next = [...first.messages, { role: 'assistant', content: 'Working.' }];
  next.push(...load(next, 'beta', '# Beta'), { role: 'user', content: 'More' });
  const second = compact(next);
  assert.deepEqual(
    latestSkillBodies(second.messages).map((entry) => entry.name),
    ['beta']
  );
  assert.equal(bodiesOf(second.messages, 'beta').length, 1);
  assert.deepEqual(idle(second.messages), { alpha: 1 });
  const [line] = reloadLines(second.messages);
  assert.match(
    line.content,
    /Skill "alpha" was active earlier, but Compact did not keep its instructions\. Reload it with the Skill tool/
  );
  assert.doesNotMatch(line.content, /did not fit/);
});

test('a marker with a missing or string span falls back to the whole transcript as the window', () => {
  const first = compact(twoSkills());
  for (const corrupt of [
    (meta) => delete meta.span,
    (meta) => {
      meta.span = '2';
    },
  ]) {
    const messages = structuredClone(first.messages);
    corrupt(messages.find((message) => message.meta?.source === 'compact-skill-window').meta);
    const second = compact(messages);
    assert.deepEqual(
      latestSkillBodies(second.messages).map((entry) => entry.name),
      ['alpha', 'beta']
    );
    assert.deepEqual(reloadLines(second.messages), []);
  }
});

test('a skill whose linked tool ran in the window is restored although it was not reloaded', () => {
  const body = skill('guide', '# Guide');
  const loader = nativeSkillLoader('guide', 'tidy');
  const first = compact([
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Start' },
    { role: 'assistant', content: '', toolCalls: [loader.call] },
    loader.result,
    body,
    { role: 'user', content: 'Continue' },
  ]);
  assert.equal(bodiesOf(first.messages, 'guide').length, 1);
  const run = (tool) => [
    ...first.messages,
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_run', name: tool, arguments: {} }] },
    { role: 'tool', toolCallId: 'toolu_run', content: 'ok' },
    { role: 'user', content: 'More' },
  ];
  const used = compact(run('tidy'));
  assert.equal(bodiesOf(used.messages, 'guide').length, 1);
  assert.deepEqual(reloadLines(used.messages), []);
  assert.equal(referencing(used.messages, 'tidy').length, 1);
  const unused = compact(run('read'));
  assert.equal(bodiesOf(unused.messages, 'guide').length, 0);
  assert.deepEqual(idle(unused.messages), { guide: 1 });
});

test('a reload line is dropped once its skill stayed unused for the bound', (t) => {
  useDataDir(t);
  const extra = { sessionId: 'compact-skill-window', contextWindow: 20_000 };
  let messages = compact(twoSkills(), extra).messages;
  const seen = [];
  for (let round = 0; round <= SKILL_RELOAD_MAX_IDLE + 1; round += 1) {
    messages = [...messages, { role: 'assistant', content: 'Working.' }];
    messages.push(...load(messages, 'beta', '# Beta'), { role: 'user', content: `Round ${round}` });
    messages = compact(messages, extra).messages;
    seen.push(idle(messages).alpha);
  }
  assert.deepEqual(seen, [1, 2, 3, undefined, undefined]);
  assert.equal(bodiesOf(messages, 'beta').length, 1);
  assert.equal(JSON.stringify(messages).includes('Skill \\"alpha\\"'), false);
});

test('loading a skill whose body Compact restored adds no second copy, and a reload line is replaced by the body', () => {
  const first = compact(twoSkills());
  const again = load(first.messages, 'alpha', '# Alpha');
  assert.equal(bodiesOf(again, 'alpha').length, 0);
  assert.match(again[1].content, /already active/);
  // alpha unused for one window: only a reload line is left.
  const next = [...first.messages, { role: 'assistant', content: 'Working.' }];
  next.push(...load(next, 'beta', '# Beta'), { role: 'user', content: 'More' });
  const second = compact(next);
  assert.equal(bodiesOf(second.messages, 'alpha').length, 0);
  const reloaded = [...second.messages];
  reloaded.push(...load(reloaded, 'alpha', '# Alpha'), { role: 'user', content: 'Again' });
  assert.equal(bodiesOf(reloaded, 'alpha').length, 1);
  const third = compact(reloaded);
  assert.equal(bodiesOf(third.messages, 'alpha').length, 1);
  assert.deepEqual(
    reloadLines(third.messages).filter((line) => line.meta.skill === 'alpha'),
    []
  );
});

test('consecutive passes that keep the summary verbatim still move the window boundary', (t) => {
  useDataDir(t);
  const extra = { sessionId: 'compact-skill-kept-summary', contextWindow: 20_000 };
  const rules = (messages) => compact(messages, { ...extra, handoffText: '' }).messages;
  const summaryOf = (messages) => messages.find((message) => message.meta?.source === 'compact-summary');
  const first = compact(twoSkills(), extra).messages;
  const next = [...first, { role: 'assistant', content: 'Working.' }];
  next.push(...load(next, 'beta', '# Beta'), { role: 'user', content: 'More' });
  const second = rules(next);
  assert.deepEqual(
    latestSkillBodies(second).map((entry) => entry.name),
    ['beta']
  );
  assert.equal(summaryOf(second).content, summaryOf(first).content);
  assert.deepEqual(idle(second), { alpha: 1 });
  // Nothing is used in the third window: beta's earlier call, still retained
  // after the summary, is history.
  const third = rules([...second, { role: 'assistant', content: 'Idle.' }, { role: 'user', content: 'Again' }]);
  assert.deepEqual(latestSkillBodies(third), []);
  assert.deepEqual(idle(third), { alpha: 2, beta: 1 });
});

test('without any summary an unused skill still ages to a reload line and disappears', (t) => {
  useDataDir(t);
  const extra = { sessionId: 'compact-skill-no-summary', contextWindow: 20_000, handoffText: '' };
  const transcript = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'Start' },
  ];
  transcript.push(...load(transcript, 'alpha', '# Alpha'), { role: 'user', content: 'Continue' });
  let messages = compact(transcript, extra).messages;
  assert.equal(
    messages.some((message) => message.meta?.source === 'compact-summary'),
    false
  );
  assert.equal(bodiesOf(messages, 'alpha').length, 1);
  // The Skill call and its result stay in the preserved conversation; with no
  // further use they are history, and nothing is restored again.
  const seen = [];
  for (let round = 0; round < SKILL_RELOAD_MAX_IDLE + 3; round += 1) {
    messages = compact(
      [...messages, { role: 'assistant', content: 'Idle.' }, { role: 'user', content: `Round ${round}` }],
      extra
    ).messages;
    seen.push([bodiesOf(messages, 'alpha').length, idle(messages).alpha]);
  }
  assert.deepEqual(seen, [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, undefined],
    [0, undefined],
    [0, undefined],
  ]);
});
