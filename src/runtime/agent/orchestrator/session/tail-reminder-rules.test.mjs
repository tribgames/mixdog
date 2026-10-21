import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TAIL_REMINDER_RULES,
  matchTailReminder,
  modelFamilyId,
  validateTailReminderRules,
  withTailReminder,
} from './tail-reminder-rules.mjs';
import { _buildRequestBodyForCacheSmoke } from '../providers/anthropic-oauth.mjs';
import { buildAnthropicApiRequest } from '../providers/anthropic-api-request.mjs';

const KO = { id: 'ko', name: 'Korean' };
const OPUS = 'claude-opus-5-5';
const KOREAN_TEXT = '<system-reminder>Write all user-facing text in Korean.</system-reminder>';
const ctx = (over = {}) => ({ provider: 'anthropic-oauth', model: OPUS, language: KO, role: 'lead', ...over });

// --- matcher ---

test('shipped rule: Opus 5.5 x Korean x lead/bot, any provider', () => {
  assert.equal(matchTailReminder(ctx()), KOREAN_TEXT);
  assert.equal(matchTailReminder(ctx({ role: 'bot' })), KOREAN_TEXT);
  for (const provider of ['anthropic', 'openrouter', 'bedrock', '']) {
    assert.equal(matchTailReminder(ctx({ provider })), KOREAN_TEXT, provider);
  }
  for (const model of ['anthropic/claude-opus-5.5', 'claude-opus-5-5-20260101', 'us.anthropic.claude-opus-5-5-v1:0']) {
    assert.equal(matchTailReminder(ctx({ model })), KOREAN_TEXT, model);
  }
});

test('shipped rule: other languages, models and roles never match', () => {
  assert.equal(matchTailReminder(ctx({ language: { id: 'en', name: 'English' } })), '');
  assert.equal(matchTailReminder(ctx({ language: { id: 'ja', name: 'Japanese (日本語)' } })), '');
  assert.equal(matchTailReminder(ctx({ language: null })), '');
  for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5-5', 'claude-opus-5-50', 'gpt-5']) {
    assert.equal(matchTailReminder(ctx({ model })), '', model);
  }
  assert.equal(matchTailReminder(ctx({ role: 'worker' })), '');
});

test('matcher: every tag narrows, an omitted tag matches anything, placeholder resolves', () => {
  const rule = (when) => [{ id: 'r', when, text: 'say {language}' }];
  const open = rule({});
  assert.equal(
    matchTailReminder(ctx({ model: 'x', language: null, role: 'worker', provider: 'p' }), open),
    '<system-reminder>say </system-reminder>'
  );
  const all = rule({ provider: ['anthropic'], model: [OPUS], language: ['ko'], role: ['lead'] });
  assert.match(matchTailReminder(ctx(), all), /say Korean/);
  // Provider family and exact id both work; each tag alone removes the match.
  assert.ok(matchTailReminder(ctx({ provider: 'anthropic-oauth' }), rule({ provider: ['anthropic-oauth'] })));
  assert.equal(matchTailReminder(ctx({ provider: 'openrouter' }), all), '');
  assert.equal(matchTailReminder(ctx({ model: 'claude-opus-4-8' }), all), '');
  assert.equal(matchTailReminder(ctx({ language: { id: 'ja', name: 'Japanese' } }), all), '');
  assert.equal(matchTailReminder(ctx({ role: 'bot' }), all), '');
  // Several matching rules join into one reminder.
  const two = [...rule({ language: ['ko'] }), { id: 's', when: { role: ['lead'] }, text: 'second' }];
  assert.equal(matchTailReminder(ctx(), two), '<system-reminder>say Korean\nsecond</system-reminder>');
});

test('rule table validation rejects unknown tags, fields, roles and duplicates', () => {
  const ok = { id: 'a', when: { model: [OPUS] }, text: 't' };
  assert.doesNotThrow(() => validateTailReminderRules([ok]));
  assert.doesNotThrow(() => validateTailReminderRules(TAIL_REMINDER_RULES));
  assert.throws(() => validateTailReminderRules([{ ...ok, when: { lang: ['ko'] } }]), /unknown tag/);
  assert.throws(() => validateTailReminderRules([{ ...ok, extra: 1 }]), /unknown field/);
  assert.throws(() => validateTailReminderRules([{ ...ok, when: { role: ['admin'] } }]), /unknown role/);
  assert.throws(() => validateTailReminderRules([{ ...ok, when: { model: 'x' } }]), /non-empty string list/);
  assert.throws(() => validateTailReminderRules([{ ...ok, text: '' }]), /text required/);
  assert.throws(() => validateTailReminderRules([ok, ok]), /duplicate id/);
});

test('modelFamilyId folds route prefixes, dots, dates and versions', () => {
  assert.equal(modelFamilyId('anthropic/claude-opus-5.5'), OPUS);
  assert.equal(modelFamilyId('claude-opus-5-5-20260101'), OPUS);
  assert.equal(modelFamilyId('claude-opus-5-5@20260101'), OPUS);
  assert.equal(modelFamilyId('claude-opus-5-5-thinking'), OPUS);
  assert.equal(modelFamilyId('openai/gpt-5'), 'gpt-5');
});

// --- injection ---

test('withTailReminder appends one ephemeral message to a copy, by session role', () => {
  const history = [
    { role: 'user', content: 'hi' },
    { role: 'tool', toolCallId: 'c', content: 'English output' },
  ];
  const frozen = JSON.stringify(history);
  const lead = withTailReminder(history, { session: { provider: 'anthropic-oauth' }, model: OPUS }, KO);
  assert.equal(lead.length, history.length + 1);
  assert.equal(lead.at(-1).content, KOREAN_TEXT);
  assert.equal(JSON.stringify(history), frozen, 'stored history is untouched');
  const bot = withTailReminder(history, { session: { sessionMode: 'agent' }, model: OPUS }, KO);
  assert.equal(bot.at(-1).content, KOREAN_TEXT);
  for (const [session, model, language] of [
    [{ owner: 'agent' }, OPUS, KO],
    [{}, 'claude-opus-4-8', KO],
    [{}, OPUS, { id: 'en', name: 'English' }],
    [{}, OPUS, null],
  ]) {
    assert.equal(withTailReminder(history, { session, model }, language), history);
  }
});

test('sendWithRecovery hands the provider the reminder and leaves the transcript alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-tail-reminder-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'mixdog-config.json'), JSON.stringify({ agent: { profile: { language: 'ko' } } }));
  const { sendWithRecovery } = await import('./send-with-recovery.mjs');
  const sent = [];
  const provider = {
    name: 'anthropic-oauth',
    send: async (messages) => {
      sent.push(messages);
      return { content: 'ok' };
    },
  };
  const messages = [{ role: 'user', content: 'hi' }];
  const run = (sessionRef, model) =>
    sendWithRecovery({ provider, messages, model, sendTools: [], opts: {}, sessionId: 's', sessionRef });
  await run({ provider: 'anthropic-oauth' }, OPUS);
  await run({ provider: 'anthropic-oauth' }, 'claude-opus-4-8');
  await run({ provider: 'anthropic-oauth', owner: 'agent' }, OPUS);
  assert.equal(sent[0].at(-1).content, KOREAN_TEXT);
  assert.equal(sent[1].length, 1);
  assert.equal(sent[2].length, 1);
  assert.equal(messages.length, 1, 'the loop transcript never receives the reminder');
});

// --- Anthropic cache layout ---

const MODEL = OPUS;
const TOOLS = [{ name: 'read', description: 'Read', inputSchema: { type: 'object', properties: {} } }];
const HISTORY = [
  { role: 'system', content: 'You are the Lead.' },
  { role: 'user', content: 'Refactor the parser.' },
  { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
  { role: 'tool', toolCallId: 'call_1', content: 'export function parse() {}' },
];
const withReminder = (history) => withTailReminder(history, { session: {}, model: MODEL }, KO);

const builders = {
  'anthropic-oauth': async (messages) => _buildRequestBodyForCacheSmoke(messages, MODEL, TOOLS, {}),
  anthropic: async (messages) =>
    (
      await buildAnthropicApiRequest({
        name: 'anthropic',
        config: {},
        messages,
        useModel: MODEL,
        tools: TOOLS,
        opts: {},
        fastModeLatched: false,
      })
    ).params,
};

const marks = (messages) =>
  messages.flatMap((m, i) =>
    (Array.isArray(m.content) ? m.content : []).flatMap((b, j) => (b?.cache_control ? [[i, j]] : []))
  );

for (const [name, build] of Object.entries(builders)) {
  test(`${name}: the reminder is the last block and the breakpoint sits on the block before it`, async () => {
    const plain = await build(HISTORY);
    const body = await build(withReminder(HISTORY));
    const last = body.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content.at(-1), { type: 'text', text: KOREAN_TEXT });
    assert.equal(last.content.at(-1).cache_control, undefined);
    const before = last.content.at(-2);
    assert.ok(before.cache_control, 'cache_control on the block before the reminder');
    assert.equal(marks(body.messages).length, marks(plain.messages).length);
    // Same marked position and content as the request without a reminder.
    assert.deepEqual(marks(body.messages), marks(plain.messages));
  });

  test(`${name}: two consecutive requests share a byte-identical cached prefix`, async () => {
    const first = await build(withReminder(HISTORY));
    const next = [
      ...HISTORY,
      { role: 'assistant', content: 'Editing.', toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'b' } }] },
      { role: 'tool', toolCallId: 'call_2', content: 'more output' },
    ];
    const second = await build(withReminder(next));
    const noMarks = (value) => JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v));
    // Everything up to and including the first request's breakpoint block.
    const prefix = (body) => {
      const [i, j] = marks(body.messages).at(-1);
      return {
        system: body.system,
        tools: body.tools,
        before: body.messages.slice(0, i),
        block: body.messages[i].content.slice(0, j + 1),
      };
    };
    const cached = prefix(first);
    // The reminder is not part of it: it equals the reminder-free request's prefix.
    assert.equal(JSON.stringify(cached), JSON.stringify(prefix(await build(HISTORY))));
    // The next request starts with exactly those bytes (its marker moves later).
    assert.equal(noMarks(second.system), noMarks(cached.system));
    assert.equal(noMarks(second.tools), noMarks(cached.tools));
    assert.equal(noMarks(second.messages.slice(0, cached.before.length)), noMarks(cached.before));
    assert.equal(
      noMarks(second.messages[cached.before.length].content.slice(0, cached.block.length)),
      noMarks(cached.block)
    );
    // Only one reminder per request, never carried into history.
    assert.equal(JSON.stringify(second.messages).split('system-reminder>Write all user-facing text').length - 1, 1);
  });
}
