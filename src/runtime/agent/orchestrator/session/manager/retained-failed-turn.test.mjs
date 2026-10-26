import assert from 'node:assert/strict';
import test from 'node:test';
import { retainedFailedTurnInput } from './failed-turn-rewind.mjs';
import { createTakeEntriesOps } from '../../../../../tui/session/session-flow/queue/take-entries.mjs';
import { transcriptTurnKeys } from '../../../../shared/transcript-turn-keys.mjs';
import { restoreTranscriptItems } from '../transcript-restore/restore.mjs';
import { routineResultMessage } from '../routine-result.mjs';

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

test('the posted marker of a stored message reaches its restored item, in full and tail restores', () => {
  const posted = (n) => ({
    role: 'assistant',
    content: `check-in ${n}`,
    meta: { transcript: { at: n * 1000, messageId: `msg_${n}`, posted: true } },
  });
  const messages = [posted(1), posted(2), { role: 'user', content: 'hi', meta: { transcript: { messageId: 'u' } } }];
  for (const itemLimit of [2, Infinity]) {
    const items = restoreTranscriptItems(messages, { sessionId: 'test', itemLimit });
    assert.deepEqual(
      items.map((item) => item.posted === true),
      [true, true, false].slice(-items.length)
    );
  }
});

test('rows posted before the marker existed restore as posted; a routine fire prompt does not', () => {
  const legacy = (n) => ({
    role: 'assistant',
    content: `check-in ${n}`,
    meta: { transcript: { at: n * 1000, messageId: `routine_heartbeat_sess_daemon_${n}` } },
  });
  const messages = [
    legacy(1),
    legacy(2),
    routineResultMessage({ name: 'news', ok: true, text: 'done', messageId: 'routine_run_9' }),
    { role: 'user', content: 'fire', meta: { transcript: { messageId: 'routine_3f2a' } } },
    {
      role: 'assistant',
      content: 'fired',
      meta: { transcript: { completion: { status: 'done', elapsedMs: 1, attemptId: 'attempt-fire' } } },
    },
  ];
  const items = restoreTranscriptItems(messages, { sessionId: 'test' });
  assert.deepEqual(
    items.map((item) => item.posted === true),
    [true, true, true, false, false, false]
  );
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
