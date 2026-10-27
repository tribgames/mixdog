// A tool_result a provider request already carried is never rewritten: what
// an interruption appends after it (the cancel or restart marker, the next
// prompt, reminders riding with it) follows as sibling text blocks in the
// same user message. Text after a tool_result no request has carried yet is
// still folded into it (empty end_turn livelock prevention).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTurnInterruptionTracker,
  finalizeTurnInterruptionSnapshot,
} from '../../session/manager/turn-interruption.mjs';
import { toAnthropicMessages } from './anthropic-request-utils.mjs';

const PROMPT = 'read the file';
const call = { id: 'call_1', name: 'read', arguments: { path: 'a.txt' } };
const toolTurn = () => [
  { role: 'user', content: PROMPT },
  { role: 'assistant', content: '', toolCalls: [call] },
  { role: 'tool', toolCallId: 'call_1', content: 'alpha' },
  // A reminder the loop appended before the send: folded at send time.
  { role: 'user', content: '<system-reminder>\nnote\n</system-reminder>' },
];

/** The turn's transcript after it is interrupted with its request on the wire. */
function interruptedInRequest(abortReason) {
  const tracker = createTurnInterruptionTracker();
  const outgoing = toolTurn();
  tracker.recordToolCalls([call]);
  tracker.markToolPhaseStarted();
  tracker.recordToolResult(outgoing[2]);
  tracker.markProviderSendStarted();
  const sent = toAnthropicMessages(outgoing);
  const { messages } =
    abortReason === 'process-crash'
      ? finalizeTurnInterruptionSnapshot({
          turnOutgoing: outgoing,
          currentUserContent: PROMPT,
          snapshot: tracker.snapshot(),
        })
      : tracker.finalize({ turnOutgoing: outgoing, currentUserContent: PROMPT, abortReason });
  return { sent, messages };
}

function assertSentResultKept(sent, resumed, marker) {
  const at = sent.length - 1;
  const sentBlocks = sent[at].content;
  assert.equal(resumed.length, sent.length, 'no user turn of its own');
  // The sent blocks — the tool_result with its folded reminder — are byte-identical.
  assert.deepEqual(resumed[at].content.slice(0, sentBlocks.length), sentBlocks);
  const siblings = resumed[at].content.slice(sentBlocks.length);
  assert.deepEqual(
    siblings.map((block) => block.text),
    [marker, '<system-reminder>\nresumed\n</system-reminder>', 'next task']
  );
}

const resumedTurn = (messages) => [
  ...messages,
  { role: 'user', content: '<system-reminder>\nresumed\n</system-reminder>' },
  { role: 'user', content: 'next task' },
];

test('a marker and the next prompt after a tool_result a killed request carried stay its siblings', () => {
  const { sent, messages } = interruptedInRequest('process-crash');
  assert.match(JSON.stringify(sent.at(-1).content[0].content), /alpha[\s\S]*note/, 'the reminder was folded at send');
  assertSentResultKept(sent, toAnthropicMessages(resumedTurn(messages)), '[Request interrupted by process restart]');
});

test('a user cancel during streaming keeps the tool_result the request carried', () => {
  const { sent, messages } = interruptedInRequest('user-cancel');
  assertSentResultKept(sent, toAnthropicMessages(resumedTurn(messages)), '[Request interrupted by user]');
});

test('the stamp changes no wire bytes of the request it ended', () => {
  const { sent, messages } = interruptedInRequest('process-crash');
  assert.deepEqual(
    toAnthropicMessages(messages).at(-1).content.slice(0, sent.at(-1).content.length),
    sent.at(-1).content
  );
});

test('a reminder after a tool_result no request has carried is still folded into it', () => {
  const lowered = toAnthropicMessages(toolTurn());
  assert.equal(lowered.at(-1).content.length, 1);
  assert.equal(lowered.at(-1).content[0].type, 'tool_result');
  assert.match(String(lowered.at(-1).content[0].content), /alpha\n\n<system-reminder>\nnote/);
});

test('steering after a sent tool_result keeps its own user turn', () => {
  const { messages } = interruptedInRequest('process-crash');
  const lowered = toAnthropicMessages([...messages, { role: 'user', content: 'steer', meta: { source: 'steering' } }]);
  assert.deepEqual(lowered.at(-1), { role: 'user', content: 'steer' });
});
