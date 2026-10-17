import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedFailedTurnInput } from './failed-turn-rewind.mjs';
import { createTakeEntriesOps } from '../../../../../tui/session/session-flow/queue/take-entries.mjs';
import { transcriptTurnKeys } from '../../../../shared/transcript-turn-keys.mjs';
import { restoreTranscriptItems } from '../transcript-restore/restore.mjs';

test('attempt identity survives full and tail restoration for visible and internal prompts', () => {
  for (const content of ['user prompt', '<system-reminder>internal notice</system-reminder>']) {
    const completion = { status: 'failed', elapsedMs: 1, attemptId: 'attempt-a' };
    const message = { role: 'user', content, meta: { transcript: { messageId: 'input', completion } } };
    const live = [
      { kind: 'user', id: 'it_1', text: content },
      { kind: 'turndone', id: 'it_2', ...completion },
    ];
    assert.equal(transcriptTurnKeys(live).at(-1), 'attempt:attempt-a');
    for (const itemLimit of [1, Infinity]) {
      const restored = restoreTranscriptItems([message], { sessionId: 'test', itemLimit });
      assert.equal(transcriptTurnKeys(restored).at(-1), 'attempt:attempt-a');
    }
  }
});

test('a stale attempt cannot retry the same retained input after it fails again', () => {
  const messages = [
    {
      role: 'user',
      content: 'input',
      meta: {
        transcript: { messageId: 'input', completion: { status: 'failed', attemptId: 'attempt-b' } },
      },
    },
  ];
  assert.throws(() => retainedFailedTurnInput(messages, 'input', 'attempt-a'), /failed attempt/);
  assert.equal(retainedFailedTurnInput(messages, 'input', 'attempt-b').message, messages[0]);
});

test('restored attempts retain their timestamps and interleave model changes chronologically', () => {
  const messages = [
    {
      role: 'user',
      content: 'input',
      meta: {
        transcript: {
          at: 50,
          messageId: 'input',
          previousCompletions: [{ status: 'failed', elapsedMs: 1, attemptId: 'a', at: 100 }],
          completion: { status: 'failed', elapsedMs: 1, attemptId: 'b', at: 300 },
        },
        modelSwitches: [{ provider: 'openai', modelId: 'next-model', at: 200 }],
      },
    },
  ];
  const events = restoreTranscriptItems(messages).filter((item) => item.kind !== 'user');
  assert.deepEqual(
    events.map((item) => [item.kind, item.at]),
    [
      ['turndone', 100],
      ['statusdone', 200],
      ['turndone', 300],
    ]
  );
});

test('retained retry selects the exact failed input without changing structured content', () => {
  const content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }];
  const message = {
    role: 'user',
    content,
    meta: {
      source: 'task-notification',
      transcript: { messageId: 'failure', completion: { status: 'failed' } },
    },
  };
  const messages = [message];
  assert.equal(retainedFailedTurnInput(messages, 'failure').message, message);
  assert.equal(message.content, content);
  assert.equal(message.meta.transcript.completion.status, 'failed');
  assert.throws(() => retainedFailedTurnInput(messages, 'older'), /no longer/);
  assert.throws(() => retainedFailedTurnInput([...messages, { role: 'user', content: 'new' }], 'failure'), /no longer/);
});

test('partial output is not rewound to its original input', () => {
  const messages = [
    {
      role: 'assistant',
      content: 'partial',
      meta: {
        transcript: { messageId: 'partial', completion: { status: 'failed' } },
      },
    },
  ];
  assert.equal(retainedFailedTurnInput(messages, 'partial'), null);
});

test('retained retries never share a batch with another submission', () => {
  const entry = (id, retryTurnId) => ({ id, mode: 'prompt', priority: 'next', retryTurnId });
  const pending = [entry('before'), entry('retry', 'failure'), entry('after')];
  const queue = createTakeEntriesOps({
    pending,
    pendingNotificationKeys: new Set(),
    removeQueuedEntries() {},
    leadSessionId: () => 'session',
  });
  assert.deepEqual(
    queue.dequeueQueueBatch().map((item) => item.id),
    ['before']
  );
  assert.deepEqual(
    queue.dequeueQueueBatch().map((item) => item.id),
    ['retry']
  );
  assert.deepEqual(
    queue.dequeueQueueBatch().map((item) => item.id),
    ['after']
  );
});
