import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MID_CONVERSATION_SYSTEM_BETA_HEADER,
  TURN_SCOPED_SYSTEM_BETA_HEADER,
  buildAnthropicBetaHeaders,
} from './anthropic-betas.mjs';
import { _buildRequestBodyForCacheSmoke as smoke, _test as oauthTest } from './anthropic-oauth.mjs';
import { cloneProviderReplay, createProviderReplay } from './lib/provider-replay.mjs';
import { withTurnReminderContext, LEGACY_FABLE_51_REMINDER } from './anthropic-turn-reminder.mjs';
import { _sessionForDisk } from '../session/store/serialize.mjs';

// The route's reminder as the agent loop hands it over (opts.roundReminder).
const REMINDER =
  "First privately list what you need next; then request every item that doesn't depend on another's result in this one response.";
const build = (messages, model, opts = {}) => smoke(messages, model, [], { roundReminder: REMINDER, ...opts });

function toolContinuation() {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'toolu_read',
          name: 'read',
          arguments: { file_path: 'C:\\Project\\fixture.txt' },
        },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'toolu_read',
      content: 'fixture output',
    },
  ];
}

test('Fable 5.1 projects a system boundary after a tool result without mutating history', () => {
  const source = toolContinuation();
  const sourceSnapshot = structuredClone(source);
  const body = build(source, 'claude-fable-5-1');

  assert.deepEqual(source, sourceSnapshot);
  assert.equal(body.messages.at(-2).role, 'user');
  assert.equal(body.messages.at(-2).content[0].type, 'tool_result');
  assert.equal(body.messages.at(-1).role, 'system');
  assert.equal(body.messages.at(-1).clear_at, 'next_user_message');
  assert.equal(typeof body.messages.at(-1).content, 'string');
  assert.ok(body.messages.at(-1).content.length > 0);
});

test('Fable 5.1 keeps the prefix before signed thinking unchanged across tool continuations and resume', () => {
  const history = [{ role: 'user', content: 'Inspect the files.' }, ...toolContinuation()];
  const first = build(history, 'claude-fable-5-1');
  const signed = [
    { type: 'thinking', thinking: 'Continue.', signature: 'opaque-prefix-bound-signature' },
    { type: 'tool_use', id: 'toolu_second', name: 'read', input: { file_path: 'b.txt' } },
  ];
  history.push(
    {
      role: 'assistant',
      content: '',
      providerReplay: withTurnReminderContext(createProviderReplay('anthropic', signed), first),
      toolCalls: [{ id: 'toolu_second', name: 'read', arguments: { file_path: 'b.txt' } }],
    },
    { role: 'tool', toolCallId: 'toolu_second', content: 'second result' }
  );
  // Cache marker movement is explicitly allowed by the binding contract.
  const withoutCacheMarkers = (value) => {
    if (Array.isArray(value)) return value.map(withoutCacheMarkers);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, entry]) => [key, withoutCacheMarkers(entry)])
    );
  };
  const persisted = _sessionForDisk({ id: 'fable-scoped', messages: history });
  const resumed = JSON.parse(JSON.stringify(persisted)).messages.map((message) => ({
    ...message,
    ...(message.providerReplay ? { providerReplay: cloneProviderReplay(message.providerReplay) } : {}),
  }));
  for (const source of [history, resumed]) {
    const next = build(source, 'claude-fable-5-1');
    const signedIndex = next.messages.findIndex(
      (message) =>
        Array.isArray(message.content) && message.content.some((block) => block.signature === signed[0].signature)
    );
    assert.deepEqual(withoutCacheMarkers(next.messages.slice(0, signedIndex)), withoutCacheMarkers(first.messages));
    assert.deepEqual(withoutCacheMarkers(next.messages[signedIndex].content), signed);
    assert.equal(next.messages.at(-1).role, 'system');
    assert.equal(next.messages.at(-1).clear_at, 'next_user_message');
    const reminders = next.messages.filter((message) => message.role === 'system');
    assert.equal(reminders.length, 2);
    assert.ok(reminders.every((message) => message.clear_at === 'next_user_message'));
  }
  history.push({ role: 'user', content: 'Stop and explain.', meta: { source: 'steering' } });
  const steered = build(history, 'claude-fable-5-1');
  assert.equal(steered.messages.at(-1).role, 'user');
  assert.equal(steered.messages.filter((message) => message.role === 'system').length, 1);
});

test('legacy signed boundaries keep their old scope while new continuations expire', () => {
  const signed = [
    { type: 'thinking', thinking: 'Legacy response.', signature: 'legacy-prefix' },
    { type: 'tool_use', id: 'toolu_legacy', name: 'read', input: { file_path: 'legacy.txt' } },
  ];
  const history = [
    { role: 'user', content: '한국어로 진행해 주세요.' },
    ...toolContinuation(),
    {
      role: 'assistant',
      content: '',
      providerReplay: createProviderReplay('anthropic', signed),
      toolCalls: [{ id: 'toolu_legacy', name: 'read', arguments: { file_path: 'legacy.txt' } }],
    },
    { role: 'tool', toolCallId: 'toolu_legacy', content: 'legacy result' },
  ];
  const body = build(history, 'claude-fable-5-1');
  const reminders = body.messages.filter((message) => message.role === 'system');
  assert.equal(reminders.length, 2);
  assert.deepEqual(reminders[0], { role: 'system', content: LEGACY_FABLE_51_REMINDER });
  assert.equal(reminders[1].content, REMINDER);
  assert.equal(reminders[1].clear_at, 'next_user_message');
  const replayed = body.messages.find(
    (message) => Array.isArray(message.content) && message.content.some((block) => block.signature === 'legacy-prefix')
  );
  assert.deepEqual(replayed.content, signed);
});

test('no boundary precedes the first response, and a route without a reminder emits none', () => {

  const firstTurn = build([{ role: 'user', content: '첫 요청입니다.' }], 'claude-fable-5-1');
  assert.equal(
    firstTurn.messages.some((message) => message.role === 'system'),
    false
  );

  const body = build(toolContinuation(), 'claude-opus-5-1', { roundReminder: null });
  assert.equal(
    body.messages.some((message) => message.role === 'system'),
    false
  );
});

test('a changed route text leaves recorded boundaries byte-identical; only the newest follows it', () => {
  const history = [{ role: 'user', content: 'Inspect the files.' }, ...toolContinuation()];
  const first = build(history, 'claude-fable-5-1');
  const signed = [
    { type: 'thinking', thinking: 'Continue.', signature: 'route-text-signature' },
    { type: 'tool_use', id: 'toolu_next', name: 'read', input: { file_path: 'c.txt' } },
  ];
  history.push(
    {
      role: 'assistant',
      content: '',
      providerReplay: withTurnReminderContext(createProviderReplay('anthropic', signed), first),
      toolCalls: [{ id: 'toolu_next', name: 'read', arguments: { file_path: 'c.txt' } }],
    },
    { role: 'tool', toolCallId: 'toolu_next', content: 'next result' }
  );
  const changed = build(history, 'claude-fable-5-1', { roundReminder: 'Changed reminder.' });
  const reminders = changed.messages.filter((message) => message.role === 'system');
  assert.equal(reminders.length, 2);
  assert.deepEqual(reminders[0], { role: 'system', content: REMINDER, clear_at: 'next_user_message' });
  assert.deepEqual(reminders[1], { role: 'system', content: 'Changed reminder.', clear_at: 'next_user_message' });
  assert.equal(
    build(history, 'claude-fable-5-1', { roundReminder: null }).messages.some((message) => message.role === 'system'),
    false
  );
});

test('a steering user turn remains the final instruction and suppresses batching guidance', () => {
  const messages = [
    ...toolContinuation(),
    {
      role: 'user',
      content: '이 요청을 먼저 처리해 주세요.',
      meta: { source: 'steering' },
    },
  ];
  const body = build(messages, 'claude-fable-5-1');

  assert.equal(body.messages.at(-1).role, 'user');
  assert.equal(
    body.messages.some((message) => message.role === 'system'),
    false
  );
});

test('the mid-conversation system beta is request-gated and deduplicated', () => {
  assert.equal(
    buildAnthropicBetaHeaders({ base: '', midConversationSystem: false }).includes(MID_CONVERSATION_SYSTEM_BETA_HEADER),
    false
  );
  const headers = buildAnthropicBetaHeaders({
    base: `${MID_CONVERSATION_SYSTEM_BETA_HEADER},${TURN_SCOPED_SYSTEM_BETA_HEADER}`,
    midConversationSystem: true,
    turnScopedSystem: true,
  }).split(',');
  assert.equal(headers.filter((item) => item === MID_CONVERSATION_SYSTEM_BETA_HEADER).length, 1);
  assert.equal(headers.filter((item) => item === TURN_SCOPED_SYSTEM_BETA_HEADER).length, 1);
  assert.ok(
    !buildAnthropicBetaHeaders({ base: '', midConversationSystem: true }).includes(TURN_SCOPED_SYSTEM_BETA_HEADER)
  );

  const continuationBody = build(toolContinuation(), 'claude-fable-5-1');
  assert.equal(
    oauthTest
      .buildOAuthBetaHeaders(continuationBody, {
        model: 'claude-fable-5-1',
        opts: { effort: 'medium' },
      })
      .split(',')
      .includes(MID_CONVERSATION_SYSTEM_BETA_HEADER),
    true
  );
  assert.ok(
    oauthTest
      .buildOAuthBetaHeaders(continuationBody, { model: 'claude-fable-5-1' })
      .includes(TURN_SCOPED_SYSTEM_BETA_HEADER)
  );
  const firstTurnBody = build(
    [{ role: 'user', content: '첫 요청입니다.' }],
    'claude-fable-5-1'
  );
  assert.equal(
    oauthTest
      .buildOAuthBetaHeaders(firstTurnBody, {
        model: 'claude-fable-5-1',
        opts: { effort: 'medium' },
      })
      .split(',')
      .includes(MID_CONVERSATION_SYSTEM_BETA_HEADER),
    false
  );
  assert.ok(
    !oauthTest
      .buildOAuthBetaHeaders(firstTurnBody, { model: 'claude-fable-5-1' })
      .includes(TURN_SCOPED_SYSTEM_BETA_HEADER)
  );
});
