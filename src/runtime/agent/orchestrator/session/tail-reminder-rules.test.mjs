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
import { _buildRequestBodyForCacheSmoke, _test as oauthTest } from '../providers/anthropic-oauth.mjs';
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
  const run = (sessionRef, model, target = provider, opts = {}) =>
    sendWithRecovery({ provider: target, messages, model, sendTools: [], opts, sessionId: 's', sessionRef });
  const results = [
    await run({ provider: 'anthropic-oauth' }, OPUS),
    await run({ provider: 'anthropic-oauth' }, 'claude-opus-4-8'),
    await run({ provider: 'anthropic-oauth', owner: 'agent' }, OPUS),
  ];
  assert.equal(sent[0].at(-1).content, KOREAN_TEXT);
  assert.equal(sent[1].length, 1);
  assert.equal(sent[2].length, 1);
  assert.equal(messages.length, 1, 'the loop transcript never receives the reminder');
  // The response keeps the reminder it was generated under; none without one.
  assert.equal(results[0].response.turnReminder, KOREAN_TEXT);
  assert.equal(results[1].response.turnReminder, undefined);
  assert.equal(results[2].response.turnReminder, undefined);

  // A cut stream recovered as a tool-call turn (partial replay) keeps it too.
  const done = { id: 'call-done', name: 'read', arguments: {} };
  const cut = Object.assign(new TypeError('terminated'), {
    partialContent: '',
    partialToolCalls: [done],
    pendingToolUse: true,
  });
  const cutting = {
    name: 'anthropic-oauth',
    send: async (_messages, _model, _tools, sendOpts) => {
      sendOpts.onToolCall(done);
      throw cut;
    },
  };
  const recovered = await run({ provider: 'anthropic-oauth' }, OPUS, cutting, { onToolCall: () => {} });
  assert.equal(recovered.response.partialToolRecovery, true);
  assert.equal(recovered.response.turnReminder, KOREAN_TEXT);
});

test('every assistant turn committed from a response stores its reminder through persistence', async () => {
  const { buildIntermediateAssistantMessage, buildToolCallAssistantMessage } = await import(
    './loop/assistant-commit.mjs'
  );
  const { appendAssistantTurnMessage } = await import('./manager/ask-turn-commit.mjs');
  const { filterModelVisibleSessionMessages } = await import('./manager/message-sanitize.mjs');
  const { _sessionForDisk } = await import('./store/serialize.mjs');
  const calls = [{ id: 'c1', name: 'read', arguments: {} }];
  const session = {
    id: 's',
    messages: [
      buildToolCallAssistantMessage({ content: 'Reading.', toolCalls: calls, turnReminder: KOREAN_TEXT }, { calls }),
      buildIntermediateAssistantMessage({ content: 'Partial', stopReason: 'max_tokens', turnReminder: KOREAN_TEXT }),
    ],
  };
  appendAssistantTurnMessage({ session, sessionId: 's', result: { content: 'Done.', turnReminder: KOREAN_TEXT } });
  const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  const visible = filterModelVisibleSessionMessages(restored.messages);
  assert.deepEqual(
    visible.map((m) => m.turnReminder),
    [KOREAN_TEXT, KOREAN_TEXT, KOREAN_TEXT]
  );
  // No field at all on a turn sent without a reminder.
  assert.equal(Object.hasOwn(buildIntermediateAssistantMessage({ content: 'x' }), 'turnReminder'), false);
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
const CLEAR_AT_BETA = 'mid-conversation-system-clear-at-2026-08-21';
const TURN_SCOPED = {
  role: 'system',
  clear_at: 'next_user_message',
  content: [{ type: 'text', text: KOREAN_TEXT }],
};

// Each returns the wire body and its anthropic-beta header.
const requestBuilders = {
  'anthropic-oauth': async (messages, model = MODEL, opts = {}) => {
    const body = _buildRequestBodyForCacheSmoke(messages, model, TOOLS, opts);
    return { body, beta: oauthTest.buildOAuthBetaHeaders(body, { model, opts }) };
  },
  anthropic: async (messages, model = MODEL, opts = {}) => {
    const { params, requestHeaders } = await buildAnthropicApiRequest({
      name: 'anthropic',
      config: {},
      messages,
      useModel: model,
      tools: TOOLS,
      opts,
      fastModeLatched: false,
    });
    return { body: params, beta: requestHeaders?.['anthropic-beta'] || '' };
  },
};
const builders = Object.fromEntries(
  Object.entries(requestBuilders).map(([name, request]) => [name, async (messages) => (await request(messages)).body])
);

const marks = (messages) =>
  messages.flatMap((m, i) =>
    (Array.isArray(m.content) ? m.content : []).flatMap((b, j) => (b?.cache_control ? [[i, j]] : []))
  );
// The wire as JSON with every cache_control removed (and symbol keys gone).
const noCacheMarks = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === 'cache_control' ? undefined : v)));
const systemMessages = (messages) => messages.filter((m) => m.role === 'system');
// A committed assistant turn, carrying the reminder its request sent.
const committed = (message) => ({ ...message, turnReminder: KOREAN_TEXT });

// Requests of one session, each after the previous response was committed:
// request N must be an exact prefix of request N+1 (cache_control aside).
async function assertAppendOnly(request, steps, check = () => {}) {
  const history = [];
  let previous = null;
  for (const step of steps) {
    history.push(...step);
    const { body, beta } = await request(withReminder(history));
    assert.deepEqual(body.messages.at(-1), TURN_SCOPED, 'the reminder ends the request');
    for (const message of systemMessages(body.messages)) {
      assert.equal(JSON.stringify(message).includes('cache_control'), false, 'no cache_control on a system message');
    }
    assert.ok(beta.split(',').includes(CLEAR_AT_BETA), beta);
    const wire = noCacheMarks(body.messages);
    if (previous) assert.deepEqual(wire.slice(0, previous.length), previous);
    // One reminder per assistant turn plus the current one, each right before its turn.
    const assistants = history.filter((m) => m.role === 'assistant').length;
    assert.equal(wire.filter((m) => m.clear_at).length, assistants + 1);
    wire.forEach((m, i) => {
      if (m.role === 'assistant') assert.deepEqual(wire[i - 1], TURN_SCOPED);
    });
    check(wire);
    previous = wire;
  }
}

const TOOL_LOOP = [
  [HISTORY[0], { role: 'user', content: 'Refactor the parser.' }],
  [committed(HISTORY[2]), HISTORY[3]],
  [
    committed({ role: 'assistant', content: 'Editing.', toolCalls: [{ id: 'call_2', name: 'read', arguments: {} }] }),
    { role: 'tool', toolCallId: 'call_2', content: 'more output' },
  ],
  [
    committed({ role: 'assistant', content: '', toolCalls: [{ id: 'call_3', name: 'read', arguments: {} }] }),
    { role: 'tool', toolCallId: 'call_3', content: 'third output' },
  ],
  [committed({ role: 'assistant', content: 'Done.' }), { role: 'user', content: 'Now add tests.' }],
];

for (const [name, request] of Object.entries(requestBuilders)) {
  test(`${name} ${MODEL}: turn-scoped reminders keep a tool loop append-only`, async () => {
    await assertAppendOnly(request, TOOL_LOOP);
  });

  test(`${name} ${MODEL}: effort controls precede the reminder, in the request and its replays`, async () => {
    const snapshot = (initialEffort, effort) => ({
      meta: {
        effortConfiguration: { version: 1, provider: name, model: MODEL, mode: 'anthropic', initialEffort, effort },
      },
    });
    const control = (effort) => ({ role: 'system', content: [], output_config: { effort } });
    const steps = [
      [HISTORY[0], { role: 'user', content: 'Refactor the parser.', ...snapshot('low', 'low') }],
      // The tool batch raises the effort: the control lands after it.
      [committed(HISTORY[2]), { ...HISTORY[3], ...snapshot('low', 'high') }],
      [
        committed({
          role: 'assistant',
          content: 'Editing.',
          toolCalls: [{ id: 'call_2', name: 'read', arguments: {} }],
        }),
        { role: 'tool', toolCallId: 'call_2', content: 'more output' },
      ],
      [
        committed({ role: 'assistant', content: 'Done.' }),
        { role: 'user', content: 'Next.', ...snapshot('low', 'medium') },
      ],
    ];
    let controls = 0;
    await assertAppendOnly(request, steps, (wire) => {
      const found = wire.flatMap((m, i) => (m.output_config ? [i] : []));
      assert.ok(found.length >= controls, 'earlier controls stay');
      controls = found.length;
      for (const i of found) {
        // Control, then (when an assistant turn follows) its reminder, then that turn.
        if (wire[i + 1]?.clear_at && wire[i + 2]) assert.equal(wire[i + 2].role, 'assistant');
        assert.ok(wire[i + 1]?.clear_at || wire[i + 1]?.role === 'user', JSON.stringify(wire[i + 1]));
      }
    });
    const { body, beta } = await request(withReminder(steps.flat()));
    assert.ok(beta.includes('mid-conversation-output-config'), beta);
    const wire = noCacheMarks(body.messages);
    const high = wire.findIndex((m) => m.output_config?.effort === 'high');
    assert.deepEqual(wire.slice(high, high + 3), [control('high'), TURN_SCOPED, noCacheMarks(wire[high + 2])]);
    assert.equal(wire[high + 2].role, 'assistant');
    assert.equal(wire[high - 1].role, 'user');
    assert.equal(controls, 2);
  });

  test(`${name} ${MODEL}: a request ending on an assistant turn sends no reminder and stays append-only`, async () => {
    const history = [
      HISTORY[0],
      HISTORY[1],
      committed(HISTORY[2]),
      HISTORY[3],
      // A max-output continuation segment: the next request ends on it.
      committed({ role: 'assistant', content: 'Partial answer, cut at the output limit', stopReason: 'max_tokens' }),
    ];
    const first = await request(withReminder(history));
    const firstWire = noCacheMarks(first.body.messages);
    const reminderTexts = (wire) => JSON.stringify(wire).split('Write all user-facing text').length - 1;
    assert.equal(firstWire.at(-1).role, 'assistant', 'no reminder after an assistant tail');
    // Only the stored reminders of the two committed turns, no legacy user one.
    assert.equal(firstWire.filter((m) => m.clear_at).length, 2);
    assert.equal(reminderTexts(firstWire), 2);
    // The continuation response was committed with the reminder it ran under;
    // creation sent none for it, so replay must not either.
    history.push(committed({ role: 'assistant', content: ' and its continuation.' }));
    history.push({ role: 'user', content: 'Thanks.' });
    const second = await request(withReminder(history));
    const secondWire = noCacheMarks(second.body.messages);
    assert.deepEqual(secondWire.slice(0, firstWire.length), firstWire);
    assert.equal(secondWire[firstWire.length].role, 'assistant');
    assert.deepEqual(secondWire.at(-1), TURN_SCOPED);
    // Reminders: before the first two assistant turns, and the current one.
    assert.equal(secondWire.filter((m) => m.clear_at).length, 3);
    assert.equal(reminderTexts(secondWire), 3);
  });

  test(`${name} ${MODEL}: server-side fallback stays on alongside turn-scoped reminders`, async () => {
    const history = [HISTORY[0], HISTORY[1], committed(HISTORY[2]), HISTORY[3]];
    const { body, beta } = await request(withReminder(history));
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.messages.at(-1), TURN_SCOPED);
    const betas = beta.split(',');
    assert.ok(betas.includes(CLEAR_AT_BETA), beta);
    assert.ok(betas.includes('server-side-fallback-2026-07-01'), beta);
  });

  test(`${name}: claude-sonnet-5 keeps the legacy layout and never sends stored reminders`, async () => {
    const legacy = 'claude-sonnet-5';
    const history = [HISTORY[0], HISTORY[1], committed(HISTORY[2]), HISTORY[3]];
    const { body, beta } = await request(withReminder(history), legacy);
    const plain = (await request(HISTORY, legacy)).body;
    const last = body.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content.at(-1), { type: 'text', text: KOREAN_TEXT });
    assert.ok(last.content.at(-2).cache_control, 'cache_control on the block before the reminder');
    assert.deepEqual(marks(body.messages), marks(plain.messages));
    assert.equal(JSON.stringify(body.messages).split('Write all user-facing text').length - 1, 1);
    assert.equal(JSON.stringify(body.messages).includes('clear_at'), false);
    assert.equal(beta.includes(CLEAR_AT_BETA), false);
  });
}

for (const [name, build] of Object.entries(builders)) {
  test(`${name}: the reminder follows the breakpoint as a turn-scoped system message`, async () => {
    const plain = await build(HISTORY);
    const body = await build(withReminder(HISTORY));
    assert.deepEqual(body.messages.at(-1), TURN_SCOPED);
    const before = body.messages.at(-2).content.at(-1);
    assert.ok(before.cache_control, 'cache_control on the block before the reminder');
    // Same marked position and content as the request without a reminder.
    assert.deepEqual(marks(body.messages), marks(plain.messages));
    assert.equal(JSON.stringify(body.messages.slice(0, -1)), JSON.stringify(plain.messages));
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
