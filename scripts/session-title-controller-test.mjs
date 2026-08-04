import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionTitleController,
  firstTurnTitleSource,
  thirdTurnTitleSource,
} from '../src/session-runtime/session-title.mjs';

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail('condition did not settle');
};

test('shared title controller generates first and third-turn titles with system locale', async () => {
  const requests = [];
  const promotions = [];
  const session = { id: 'shared_title', messages: [] };
  const controller = createSessionTitleController({
    systemLocale: () => 'ko-KR',
    log: () => {},
    generateSessionTitle: async (source, options) => {
      requests.push({ source, options });
      return requests.length === 1 ? '첫 제목' : '세 번째 제목';
    },
    promoteGeneratedTitle: async (id, title, stage) => {
      promotions.push({ id, title, stage });
      session.title = title;
      session.generatedTitleStage = stage;
      return true;
    },
  });

  assert.equal(controller.scheduleFirst(session, '첫 질문'), true);
  await waitFor(() => promotions.length === 1);
  assert.equal(requests[0].source, '첫 질문');
  assert.equal(requests[0].options.locale, 'ko-KR');
  assert(requests[0].options.signal instanceof AbortSignal);
  session.messages = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First final answer' },
    { role: 'user', content: 'Second question' },
    { role: 'assistant', content: 'Second final answer' },
  ];
  assert.equal(controller.observeThird(session), false);
  assert.equal(session.title, '첫 제목');

  session.messages = [
    { role: 'system', content: 'private system prompt' },
    { role: 'user', content: '<system-reminder>hidden</system-reminder>\nFirst question' },
    { role: 'assistant', content: 'First preamble', toolCalls: [{ name: 'read' }] },
    { role: 'tool', content: 'private tool output' },
    { role: 'assistant', content: '<think>private reasoning</think> First final answer' },
    { role: 'user', content: 'Second question' },
    { role: 'assistant', content: 'Second final answer' },
    { role: 'user', content: 'Third question' },
    { role: 'assistant', content: 'Third preamble' },
    { role: 'tool', content: 'never include this' },
    { role: 'assistant', content: 'Third final answer' },
  ];
  assert.equal(controller.observeThird(session), true);
  await waitFor(() => promotions.length === 2);
  assert.equal(requests[1].source, [
    'User: First question',
    'Assistant: First final answer',
    'User: Second question',
    'Assistant: Second final answer',
    'User: Third question',
    'Assistant: Third final answer',
  ].join('\n'));
  assert.doesNotMatch(requests[1].source, /system prompt|preamble|tool output|reasoning/i);
  assert.deepEqual(promotions.map(({ title, stage }) => ({ title, stage })), [
    { title: '첫 제목', stage: 'first' },
    { title: '세 번째 제목', stage: 'third' },
  ]);
  controller.disposeAll();
});

test('manual session titles lock both automatic title stages', () => {
  const controller = createSessionTitleController({
    log: () => {},
    generateSessionTitle: async () => assert.fail('provider must not run'),
    promoteGeneratedTitle: async () => assert.fail('locked title must not be promoted'),
  });
  const session = {
    id: 'manual_title',
    title: '수동 제목',
    titleLocked: true,
    messages: [
      { role: 'user', content: 'One' },
      { role: 'assistant', content: 'Answer one' },
      { role: 'user', content: 'Two' },
      { role: 'assistant', content: 'Answer two' },
      { role: 'user', content: 'Three' },
      { role: 'assistant', content: 'Answer three' },
    ],
  };
  assert.equal(controller.scheduleFirst(session, '첫 질문'), false);
  assert.equal(controller.observeThird(session), false);
  assert.equal(session.title, '수동 제목');
});

test('shared title sources skip runtime context and use the first three completed turns', () => {
  assert.equal(
    firstTurnTitleSource('# Session\nCwd: C:\\Project\nModel: model\nWorkflow: Solo\n\n실제 요청'),
    '실제 요청',
  );
  const messages = [
    { role: 'user', content: 'One' },
    { role: 'assistant', content: 'Answer one' },
    { role: 'user', content: 'Two' },
    { role: 'assistant', content: 'Answer two' },
    { role: 'user', content: 'Three' },
    { role: 'assistant', content: 'Answer three' },
  ];
  const source = thirdTurnTitleSource(messages);
  assert(source);
  // Fewer than three completed exchanges never titles.
  assert.equal(thirdTurnTitleSource(messages.slice(0, 4)), '');
  // Past turn three (missed/retried attempts) the FIRST three exchanges win.
  assert.equal(thirdTurnTitleSource([...messages, { role: 'user', content: 'Four' }]), source);
  assert.equal(thirdTurnTitleSource([
    ...messages,
    { role: 'user', content: 'Four' },
    { role: 'assistant', content: 'Answer four' },
  ]), source);
});

test('greeting titles are deterministic and skip provider dispatch', async () => {
  const promotions = [];
  const controller = createSessionTitleController({
    log: () => {},
    generateSessionTitle: async () => assert.fail('provider must not run'),
    promoteGeneratedTitle: async (_id, title, stage) => {
      promotions.push([title, stage]);
      return true;
    },
  });
  assert.equal(controller.scheduleFirst({ id: 'greeting', messages: [] }, '하이'), true);
  await waitFor(() => promotions.length === 1);
  assert.deepEqual(promotions, [['인사', 'first']]);
});

test('title timeout aborts the lightweight completion and keeps the preview fallback', async () => {
  let completionSignal = null;
  const promotions = [];
  const logs = [];
  const controller = createSessionTitleController({
    timeoutMs: 5,
    log: (line) => logs.push(line),
    generateSessionTitle: async (_source, options) => {
      completionSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    promoteGeneratedTitle: async (...args) => {
      promotions.push(args);
      return true;
    },
  });
  assert.equal(controller.scheduleFirst({ id: 'timeout', messages: [] }, 'Fallback preview'), true);
  await waitFor(() => logs.some((line) => line.includes('failed id=timeout')));
  assert.equal(completionSignal.aborted, true);
  assert.deepEqual(promotions, []);
});

test('a failed third-turn attempt is released and retries on a later turn', async () => {
  const promotions = [];
  let calls = 0;
  const controller = createSessionTitleController({
    log: () => {},
    generateSessionTitle: async () => {
      calls += 1;
      if (calls === 1) throw new Error('provider unavailable');
      return '재시도 제목';
    },
    promoteGeneratedTitle: async (_id, title, stage) => {
      promotions.push([title, stage]);
      return true;
    },
  });
  const session = {
    id: 'retry_third',
    messages: [
      { role: 'user', content: 'One' },
      { role: 'assistant', content: 'Answer one' },
      { role: 'user', content: 'Two' },
      { role: 'assistant', content: 'Answer two' },
      { role: 'user', content: 'Three' },
      { role: 'assistant', content: 'Answer three' },
    ],
  };
  assert.equal(controller.observeThird(session), true);
  await waitFor(() => calls === 1);
  // The failure released the one-shot marker: the next completed turn retries.
  await waitFor(() => controller.observeThird(session) === true);
  await waitFor(() => promotions.length === 1);
  assert.deepEqual(promotions, [['재시도 제목', 'third']]);
  controller.disposeAll();
});
