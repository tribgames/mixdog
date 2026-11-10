import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { pendingTaskNotificationIndexes } from './compact/messages.mjs';
import { isContextAckMessage } from './compact/user-message-kind.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import { markToolSurfaceMigrated } from './loop/tool-exposure-migration.mjs';
import { finalizeTurnInterruptionSnapshot } from './manager/turn-interruption.mjs';
import {
  openToolRoundStart,
  rebindToChangedPrefix,
  requestPrefixIdentity,
  withoutThinkingReplay,
} from './thinking-binding.mjs';

const signature = `Sig${'A'.repeat(4_000)}`;
const thinking = { type: 'thinking', thinking: 'weighing the options', signature };
const redacted = { type: 'redacted_thinking', data: `Red${'B'.repeat(4_000)}` };

function transcript() {
  return [
    { role: 'system', content: '# Session\nCwd: C:\\work' },
    { role: 'user', content: 'Plan the migration.' },
    {
      role: 'assistant',
      content: 'Reading first.',
      toolCalls: [{ id: 'call-1', name: 'read', arguments: '{}' }],
      thinkingBlocks: [thinking],
      providerReplay: {
        version: 1,
        provider: 'anthropic',
        items: [thinking, { type: 'text', text: 'Reading first.' }, { type: 'tool_use', id: 'call-1', name: 'read' }],
      },
    },
    { role: 'tool', toolCallId: 'call-1', content: 'file body' },
    {
      role: 'assistant',
      content: 'Here is the plan.',
      assistantBlocks: [redacted, { type: 'text', text: 'Here is the plan.' }],
    },
  ];
}

test('stripped thinking keeps every turn text and tool call, and stops counting toward the estimate', () => {
  const messages = transcript();
  const before = JSON.stringify(messages);
  const stripped = withoutThinkingReplay(messages);
  assert.equal(JSON.stringify(messages), before, 'the input is never mutated');
  assert.doesNotMatch(JSON.stringify(stripped), /thinking/);
  assert.deepEqual(stripped[2].providerReplay.items, [
    { type: 'text', text: 'Reading first.' },
    { type: 'tool_use', id: 'call-1', name: 'read' },
  ]);
  assert.deepEqual(stripped[2].toolCalls, messages[2].toolCalls);
  assert.deepEqual(stripped[4].assistantBlocks, [{ type: 'text', text: 'Here is the plan.' }]);
  assert.equal(stripped[3], messages[3]);
  assert.ok(estimateMessagesTokens(stripped) < estimateMessagesTokens(messages) - 1_000);
  // Nothing to strip: the very same array.
  assert.equal(withoutThinkingReplay(stripped), stripped);
});

test('a changed request prefix drops stored thinking outside a turn, never inside one', () => {
  const idle = { provider: 'anthropic-oauth', model: 'claude-sonnet-5-5', tools: [], messages: transcript() };
  const prefix = requestPrefixIdentity(idle);
  markToolSurfaceMigrated(idle, 'prompt_fold');
  assert.doesNotMatch(JSON.stringify(idle.messages), /thinking/);
  assert.equal(requestPrefixIdentity(idle), prefix, 'only the conversation changes');
  assert.equal(idle.pendingCacheBreakIntent, 'prompt_fold');
  assert.equal(idle.contextPressureBaselineTokens, null);

  const working = transcript();
  const running = { ...idle, messages: transcript(), liveTurnMessages: working };
  markToolSurfaceMigrated(running);
  assert.match(JSON.stringify(running.messages), /"thinking"/);
  assert.match(JSON.stringify(working), /"thinking"/);
});

// A provider error mid tool round persists the completed calls and results
// with no closing marker and no live-turn array: the session is idle, yet the
// next request continues that round.
function interruptedRound({ withThinking = true } = {}) {
  const [system, user, answered, result, closed] = transcript();
  const latest = {
    role: 'assistant',
    content: 'Checking the config next.',
    toolCalls: [{ id: 'call-2', name: 'read', arguments: '{}' }],
    ...(withThinking
      ? {
          thinkingBlocks: [thinking],
          providerReplay: {
            version: 1,
            provider: 'anthropic',
            items: [
              thinking,
              { type: 'text', text: 'Checking the config next.' },
              { type: 'tool_use', id: 'call-2', name: 'read' },
            ],
          },
        }
      : {}),
  };
  const followUp = { role: 'user', content: 'Now check the config.' };
  const { messages } = finalizeTurnInterruptionSnapshot({
    turnOutgoing: [system, user, answered, result, closed, followUp, latest],
    currentUserContent: followUp.content,
    snapshot: {
      responseStarted: true,
      phase: 'tools',
      observedToolResults: [['call-2', { toolCallId: 'call-2', content: 'config body' }]],
    },
    abortReason: 'provider-error',
  });
  return messages;
}

const firstReplayBlock = (message) => message.providerReplay?.items?.[0]?.type;

test('the trailing open tool round of a stopped turn keeps its thinking when earlier replay is stripped', () => {
  const messages = interruptedRound();
  assert.deepEqual(
    messages.slice(-2).map((message) => message.role),
    ['assistant', 'tool']
  );
  const start = openToolRoundStart(messages);
  assert.equal(messages[start].content, 'Checking the config next.');

  const stripped = withoutThinkingReplay(messages);
  assert.equal(firstReplayBlock(stripped[start]), 'thinking');
  assert.deepEqual(stripped[start].thinkingBlocks, [thinking]);
  assert.doesNotMatch(JSON.stringify(stripped.slice(0, start)), /"(redacted_)?thinking"/);
  // A final reply closes the round: everything is stripped again.
  assert.equal(openToolRoundStart(transcript()), -1);
});

test('a changed prefix ends an open tool round explicitly instead of sending it without its thinking', () => {
  const session = { provider: 'anthropic-oauth', model: 'claude-sonnet-5-5', tools: [], messages: interruptedRound() };
  const length = session.messages.length;
  markToolSurfaceMigrated(session, 'prompt_fold');
  const latest = session.messages.findLast((message) => message.role === 'assistant');
  // A runtime turn: a context ack with runtime provenance, which the
  // transcript restore hides and Compact never counts as a reply.
  assert.deepEqual(latest, { role: 'assistant', content: '.', meta: { source: 'context-ack', synthetic: true } });
  assert.equal(isContextAckMessage(latest), true);
  assert.equal(session.messages.length, length + 1);
  assert.equal(openToolRoundStart(session.messages), -1);
  assert.doesNotMatch(JSON.stringify(session.messages), /"(redacted_)?thinking"|thinkingBlocks/);
  // The round's calls and results stay paired ahead of the closing turn.
  assert.deepEqual(
    session.messages.slice(-3).map((message) => [message.role, message.toolCallId ?? message.content]),
    [
      ['assistant', 'Checking the config next.'],
      ['tool', 'call-2'],
      ['assistant', '.'],
    ]
  );
  // Once ended, a later migration has nothing left to close.
  const settled = session.messages;
  markToolSurfaceMigrated(session);
  assert.equal(session.messages, settled);

  // An open round without thinking has nothing bound to the old prefix.
  const plain = { ...session, messages: interruptedRound({ withThinking: false }) };
  plain.messages = withoutThinkingReplay(plain.messages);
  const before = plain.messages;
  markToolSurfaceMigrated(plain);
  assert.equal(plain.messages, before);
});

test('the closing turn lands right after the round, so a later task notification stays pending', () => {
  const notification = {
    role: 'user',
    content: '<task-notification>Agent "worker" completed</task-notification>',
    meta: { source: 'task-notification' },
  };
  const messages = [...interruptedRound(), notification];
  const pending = pendingTaskNotificationIndexes(messages);
  assert.deepEqual(pending, [messages.length - 1]);

  const rebound = rebindToChangedPrefix(messages);
  assert.deepEqual(
    rebound.slice(-4).map((message) => [message.role, message.meta?.source ?? message.toolCallId ?? message.content]),
    [
      ['assistant', 'Checking the config next.'],
      ['tool', 'call-2'],
      ['assistant', 'context-ack'],
      ['user', 'task-notification'],
    ]
  );
  assert.equal(rebound.at(-2).meta.synthetic, true);
  assert.deepEqual(pendingTaskNotificationIndexes(rebound), [rebound.length - 1]);
  assert.equal(rebound.at(-1), notification);
  assert.doesNotMatch(JSON.stringify(rebound), /"(redacted_)?thinking"|thinkingBlocks/);
  // Running it again changes nothing: the round is closed.
  assert.equal(rebindToChangedPrefix(rebound), rebound);
});
