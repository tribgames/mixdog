import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeSteeringEntries } from '../../runtime/agent/orchestrator/session/loop/steering.mjs';
import { restoreTranscriptItems } from './session-api-ext.mjs';
import { persistedUserTranscriptMetadata } from '../../runtime/shared/transcript-metadata.mjs';
import { agentTaskMessage, routineResultNotice } from '../../runtime/agent/orchestrator/session/routine-result.mjs';

test('restored Agent transcript preserves Lead message attribution', () => {
  const items = restoreTranscriptItems(
    [
      {
        role: 'user',
        content: 'Review this change.',
        meta: { transcript: { at: 1, sender: 'lead' } },
      },
      {
        role: 'user',
        content: 'Please explain the result.',
        meta: { transcript: { at: 2, sender: 'user' } },
      },
    ],
    { sessionId: 'sess_agent' }
  );

  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'user');
  assert.equal(items[0].sender, 'lead');
  assert.equal(items[0].text, 'Review this change.');
  assert.equal(items[1].kind, 'user');
  assert.equal(items[1].sender, 'user');
  assert.equal(items[1].text, 'Please explain the result.');
});

test('busy Agent steering keeps User attribution metadata', () => {
  const merged = mergeSteeringEntries([
    {
      id: 'desktop-message',
      content: 'Can you clarify?',
      transcriptMeta: { sender: 'user' },
    },
  ]);
  assert.deepEqual(merged.transcriptMeta, { sender: 'user' });
});

test('a bot-sent message keeps its sending bot through persistence and restore', () => {
  const meta = persistedUserTranscriptMetadata({ sender: 'lead', fromAgent: 'agent-12c3dee5bf' });
  assert.equal(meta.fromAgent, 'agent-12c3dee5bf');
  assert.equal(persistedUserTranscriptMetadata({ sender: 'lead' }).fromAgent, undefined);
  const [item] = restoreTranscriptItems([{ role: 'user', content: 'hi', meta: { transcript: meta } }], {
    sessionId: 'sess_home_agent-a70d746b04',
  });
  assert.equal(item.sender, 'lead');
  assert.equal(item.fromAgent, 'agent-12c3dee5bf');
});

test('a reply report names the answering bot in its notice', () => {
  const message = agentTaskMessage({
    title: 'Secretary',
    status: 'completed',
    text: 'ok',
    taskSessionId: 'sess_home_agent-a70d746b04',
    target: 'session',
  });
  assert.equal(routineResultNotice(message).routine.agentId, 'agent-a70d746b04');
  const plain = agentTaskMessage({
    title: 'T',
    status: 'completed',
    text: 'ok',
    taskSessionId: 'sess_x',
    target: 'session',
  });
  assert.equal(routineResultNotice(plain).routine.agentId, undefined);
});
test('a bot message steered into a running turn keeps its sending bot on the live row', async () => {
  const { steeringItemExtras } = await import('./turn.mjs');
  const extras = steeringItemExtras({ transcriptMeta: { sender: 'lead', fromAgent: 'agent-1' } });
  assert.equal(extras.fromAgent, 'agent-1');
  assert.equal(extras.sender, 'lead');
  assert.equal(steeringItemExtras({ transcriptMeta: { sender: 'user' } }).fromAgent, undefined);
});
test('the steering injection path pushes the live row with its sending bot', async () => {
  const { injectSteerMessage } = await import('./turn.mjs');
  const pushed = [];
  const stream = {
    assistantText: '',
    currentAssistantText: '',
    batchTimer: null,
    isCurrentTurn: () => false,
    getState: () => ({}),
  };
  injectSteerMessage(
    {
      stream,
      cards: { aggregates: { clearAggregateContinuation() {} } },
      pushUserOrSyntheticItem: (text, id, kind, extra) => pushed.push({ text, id, kind, extra }),
    },
    'from the marketer',
    { ids: ['m1'], transcriptMeta: { sender: 'lead', fromAgent: 'agent-1' } }
  );
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].kind, 'injected');
  assert.equal(pushed[0].extra.fromAgent, 'agent-1');
  assert.equal(pushed[0].extra.sender, 'lead');
});
