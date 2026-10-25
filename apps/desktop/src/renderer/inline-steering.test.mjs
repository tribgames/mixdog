// Messages sent while a turn runs go straight into the chat: a user bubble at
// the transcript's end (above the working row) until the model reads it, with
// "Send now", ✕, "Not sent · Send again" or "Runs after this task" under it,
// and a muted ✓ once read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// Transitive component imports load react-dom before a test mounts; give its
// one-time DOM detection a window. Each test still owns a fresh one.
const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [
  { steerPromptItems, pendingPromptTranscriptItems },
  { appendLiveTranscriptRows, projectSettledTranscriptRows },
  { transcriptTurnKeys },
  { SteerStatus },
  { SteerContext, useSteerActions },
  { useConversationComposerActions },
  { createSlashExecutor },
  { stashComposerDraft, takeRejectedComposerSubmissionRecoveries },
  { renumberRestoredAttachments, restoreAttachmentsFromRecord },
] = await Promise.all([
  import('./conversation-prompt-items.ts'),
  import('./transcript-rows.ts'),
  import('./renderer-logic.mjs'),
  import('./transcript-steer-status.tsx'),
  import('./steer-actions.ts'),
  import('./conversation-support.tsx'),
  import('./composer-slash-executor.ts'),
  import('./composer-draft.ts'),
  import('./composer-attachment-restore.ts'),
]);

function mount(t) {
  const { document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Element', 'Node', 'MouseEvent', 'Event'],
    rootId: 'root',
  });
  return { document, root };
}

function rowsFor(items, { steerItems = [], liveItem = null, thinking = true } = {}) {
  const settled = projectSettledTranscriptRows({
    sessionKey: 's',
    items,
    turnKeys: transcriptTurnKeys(items),
    failedTurns: new Set(),
  });
  return appendLiveTranscriptRows({ sessionKey: 's', settled, steerItems, liveItem, thinking });
}

const prompt = { kind: 'user', id: 'p1', text: 'explain the change' };
const streaming = { kind: 'assistant', id: 'a1', text: 'The change moves the queue', streaming: true };

test('a message sent while the reply streams is a bubble right away, below the reply and above the working row', () => {
  // The composer's submit, behind the running turn, before the runtime
  // publishes it in its queue.
  const optimistic = {
    id: 'sub-1',
    kind: 'user',
    text: 'add a one-line summary',
    pending: true,
    accepted: false,
    submittedAt: 10,
    queuedBehindTurn: true,
    settledUserBaseline: 1,
  };
  const local = steerPromptItems([], pendingPromptTranscriptItems([optimistic], [prompt]));
  assert.equal(local.length, 1);
  assert.equal(local[0].steer, 'pending');
  assert.equal(local[0].steerLocal, true, 'not in the session queue yet');
  // Published: the queue entry replaces its local twin under the same id.
  const queued = steerPromptItems(
    [{ id: 'sub-1', displayText: 'add a one-line summary', submittedAt: 10 }],
    pendingPromptTranscriptItems([optimistic], [prompt])
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].steerLocal, undefined);
  assert.equal(queued[0].steer, 'pending');

  const rows = rowsFor([prompt], { steerItems: queued, liveItem: streaming });
  assert.deepEqual(
    rows.map((row) => row._tag),
    ['UserMessage', 'AssistantPart', 'TurnGap', 'UserMessage', 'Thinking']
  );
  assert.equal(rows[3].item.text, 'add a one-line summary');
  assert.equal(rows.at(-1)._tag, 'Thinking', 'the working row stays last');

  // The model reads it after the streamed message ends and continues the same
  // turn: the durable row lands where the bubble stood, under the same keys.
  const delivered = rowsFor(
    [
      prompt,
      { ...streaming, streaming: false },
      { kind: 'user', id: 'sub-1', text: 'add a one-line summary', steered: true },
    ],
    { liveItem: { kind: 'assistant', id: 'a2', text: 'Summary:', streaming: true } }
  );
  const bubble = delivered.find((row) => row._tag === 'UserMessage' && row.item.id === 'sub-1');
  assert.equal(bubble.key, rows[3].key, 'no remount when the bubble settles');
  assert.equal(bubble.item.steered, true);
  assert.equal(delivered.at(-1).key, rows.at(-1).key, 'the working row keeps its identity');
});

test('a queued bot message keeps its sending bot, like the delivered row', () => {
  const [row] = steerPromptItems(
    [{ id: 'bot-1', displayText: 'check the build', submittedAt: 10, sender: 'lead', fromAgent: 'alpha' }],
    []
  );
  assert.equal(row.fromAgent, 'alpha');
  assert.equal(row.sender, 'lead');
  assert.equal(row.text, 'check the build');
  const [plain] = steerPromptItems([{ id: 'u-1', displayText: 'hi', submittedAt: 11, sender: 'user' }], []);
  assert.equal(plain.fromAgent, undefined);
});

test('several waiting messages keep their order; a slash command is held for the turn end', () => {
  const items = steerPromptItems(
    [
      { id: 'q1', displayText: 'first' },
      { id: 'q2', displayText: '/compact' },
      { id: 'q3', displayText: '/compact', skipSlashCommands: true },
    ],
    []
  );
  assert.deepEqual(
    items.map((item) => [item.id, item.steer]),
    [
      ['q1', 'pending'],
      ['q2', 'held'],
      ['q3', 'pending'],
    ]
  );
  const rows = rowsFor([prompt], { steerItems: items });
  assert.deepEqual(
    rows.filter((row) => row._tag === 'UserMessage').map((row) => row.item.id),
    ['p1', 'q1', 'q2', 'q3']
  );
  assert.equal(rows.at(-1)._tag, 'Thinking');
});

test('a failed message stays a bubble until it is sent again or cancelled', () => {
  const failed = {
    id: 'f1',
    kind: 'user',
    text: 'retry me',
    pending: true,
    accepted: false,
    submittedAt: 5,
    queuedBehindTurn: true,
    settledUserBaseline: 0,
    steer: 'failed',
    retry: { content: 'retry me', options: { id: 'f1' } },
  };
  // Later user rows would release a pending twin by ordinal; a failed one stays.
  const settled = [prompt, { kind: 'user', id: 'other', text: 'other' }];
  const items = steerPromptItems([], pendingPromptTranscriptItems([failed], settled));
  assert.deepEqual(
    items.map((item) => [item.id, item.steer]),
    [['f1', 'failed']]
  );
});

function renderStatus(root, item, actions) {
  const status = React.createElement(SteerStatus, { item });
  return act(async () =>
    root.render(
      actions
        ? React.createElement(SteerContext.Provider, { value: { actions, draft: { current: null } } }, status)
        : status
    )
  );
}

test('✕ shows without hover on touch (coarse pointer, phone) as a 44px target; with a mouse on hover or keyboard focus', async (t) => {
  const { document, root } = mount(t);
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('./desktop/12-transcript.css', import.meta.url), 'utf8');
  document.head.append(style);
  const window = document.defaultView;
  let coarse = false;
  window.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' && coarse, media: query });
  const actions = { sendNow() {}, cancel() {}, retry() {} };
  const pending = { kind: 'user', id: 'q1', text: 'x', steer: 'pending' };
  const bubble = (item) =>
    React.createElement(
      'article',
      { className: 'message user' },
      React.createElement(
        SteerContext.Provider,
        { value: { actions, draft: { current: null } } },
        React.createElement(SteerStatus, { item })
      )
    );
  const render = (item = pending) => act(async () => root.render(bubble(item)));
  const cancel = () => document.querySelector('.message-steer-cancel');
  const shown = () => window.getComputedStyle(cancel()).opacity;

  // Mouse: hidden until hover, yet in the tab order (keyboard focus shows it).
  await render();
  assert.equal(document.querySelector('.message-steer').hasAttribute('data-touch'), false);
  assert.equal(shown(), '0');
  assert.equal(cancel().tabIndex, 0);
  assert.notEqual(window.getComputedStyle(cancel()).visibility, 'hidden', 'focusable while transparent');

  // Coarse pointer: always shown beside Send now, 44px.
  coarse = true;
  await render({ ...pending });
  const line = document.querySelector('.message-steer');
  assert.equal(line.hasAttribute('data-touch'), true);
  assert.equal(shown(), '1');
  assert.equal(window.getComputedStyle(cancel()).width, '44px');
  assert.equal(window.getComputedStyle(cancel()).height, '44px');
  assert.equal(window.getComputedStyle(line.querySelector('.message-steer-action')).minHeight, '44px');
  assert.equal(cancel().parentElement.nextElementSibling.textContent, 'Send now');
  // The 44px targets take no extra room: the row occupies 4px gap + a 24px line.
  const lineStyle = window.getComputedStyle(line);
  assert.equal(lineStyle.marginTop, '-6px');
  assert.equal(lineStyle.marginBottom, '-10px');
  assert.equal(window.getComputedStyle(cancel()).justifyItems, 'end', 'the ✕ sits next to Send now');

  // The phone client (marked root), even without a coarse pointer report.
  coarse = false;
  document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
  try {
    await render({ ...pending, steer: 'failed' });
    assert.equal(document.querySelector('.message-steer').hasAttribute('data-touch'), true);
    assert.equal(shown(), '1');
  } finally {
    document.documentElement.removeAttribute('data-mixdog-mobile-tabs');
  }
});

test('the steer line keeps one box through every state: waiting, held, failed, sending, read (no row shift)', async (t) => {
  const { document, root } = mount(t);
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('./desktop/12-transcript.css', import.meta.url), 'utf8');
  document.head.append(style);
  const window = document.defaultView;
  let coarse = false;
  window.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' && coarse, media: query });
  const actions = { sendNow() {}, cancel() {}, retry() {} };
  const base = { kind: 'user', id: 'q1', text: 'x' };
  const states = [
    { ...base, steer: 'pending' },
    { ...base, steer: 'pending', steerLocal: true },
    { ...base, steer: 'held' },
    { ...base, steer: 'failed' },
    { ...base, steer: 'sending' },
    { ...base, steered: true },
  ];
  for (const [height, isCoarse] of [
    ['20px', false],
    ['44px', true],
  ]) {
    coarse = isCoarse;
    for (const item of states) {
      await act(async () =>
        root.render(
          React.createElement(
            SteerContext.Provider,
            { value: { actions, draft: { current: null } } },
            React.createElement('article', { className: 'message user' }, React.createElement(SteerStatus, { item }))
          )
        )
      );
      const label = `${item.steer ?? 'read'} ${isCoarse ? 'touch' : 'mouse'}`;
      const line = document.querySelector('.message-steer');
      assert.ok(line, `${label}: the line is there`);
      const slot = line.firstElementChild;
      assert.equal(slot.className, 'message-steer-slot', `${label}: the control slot leads the line`);
      assert.equal(window.getComputedStyle(line).height, height, `${label}: line height`);
      assert.equal(window.getComputedStyle(slot).width, height, `${label}: slot width`);
      assert.equal(window.getComputedStyle(slot).height, height, `${label}: slot height`);
    }
  }
  // A plain prompt has no line at all.
  await renderStatus(root, base, actions);
  assert.equal(document.querySelector('.message-steer'), null);
});

test('an unread bubble offers Send now and ✕; a read one shows only a muted ✓', async (t) => {
  const { document, root } = mount(t);
  const calls = [];
  const actions = {
    sendNow: (id) => calls.push(['sendNow', id]),
    cancel: (id) => calls.push(['cancel', id]),
    retry: (id) => calls.push(['retry', id]),
  };
  await renderStatus(root, { kind: 'user', id: 'q1', text: 'x', steer: 'pending' }, actions);
  const send = document.querySelector('.message-steer-action');
  assert.equal(send.textContent, 'Send now');
  await act(async () => send.click());
  await act(async () => document.querySelector('.message-steer-cancel').click());
  assert.equal(document.querySelector('.message-steer-cancel').getAttribute('aria-label'), 'Cancel message');
  assert.deepEqual(calls, [
    ['sendNow', 'q1'],
    ['cancel', 'q1'],
  ]);

  // Not published yet: nothing to send or take back.
  await renderStatus(root, { kind: 'user', id: 'q1', text: 'x', steer: 'pending', steerLocal: true }, actions);
  assert.equal(document.querySelector('.message-steer-action').disabled, true);
  assert.equal(document.querySelector('.message-steer-cancel'), null);

  // Being sent now: the action row gives way.
  await renderStatus(root, { kind: 'user', id: 'q1', text: 'x', steer: 'sending' }, actions);
  assert.equal(document.querySelector('.message-steer-action'), null);
  assert.equal(document.querySelector('.message-steer-cancel'), null);

  await renderStatus(root, { kind: 'user', id: 'q1', text: 'x', steered: true }, actions);
  assert.equal(document.querySelector('.message-steer-action'), null, 'read: no action');
  assert.equal(document.querySelector('.message-steer-cancel'), null, 'read: no action');
  const read = document.querySelector('.message-steer-read');
  assert.equal(read.getAttribute('aria-label'), 'Read by the model');
  assert.ok(read.querySelector('svg'));
  assert.equal(read.textContent, '', 'the mark is the icon alone');

  // A prompt that opened its turn carries no mark at all.
  await renderStatus(root, { kind: 'user', id: 'p1', text: 'x' }, actions);
  assert.equal(document.body.textContent, '');
});

test('a failed bubble reads "Not sent · Send again"; a held slash command reads "Runs after this task"', async (t) => {
  const { document, root } = mount(t);
  const calls = [];
  const actions = {
    sendNow: (id) => calls.push(['sendNow', id]),
    cancel: (id) => calls.push(['cancel', id]),
    retry: (id) => calls.push(['retry', id]),
  };
  await renderStatus(root, { kind: 'user', id: 'f1', text: 'x', steer: 'failed', steerLocal: true }, actions);
  const line = document.querySelector('.message-steer[data-steer="failed"]');
  assert.equal(line.querySelector('.message-steer-note').textContent, 'Not sent');
  const again = line.querySelector('.message-steer-action');
  assert.equal(again.textContent, 'Send again');
  await act(async () => again.click());
  assert.ok(line.querySelector('.message-steer-cancel'), 'a failed message can be cancelled');
  assert.deepEqual(calls, [['retry', 'f1']]);

  await renderStatus(root, { kind: 'user', id: 'h1', text: '/compact', steer: 'held' }, actions);
  const held = document.querySelector('.message-steer[data-steer="held"]');
  assert.equal(held.querySelector('.message-steer-note').textContent, 'Runs after this task');
  assert.equal(held.querySelector('.message-steer-action'), null, 'no Send now for a held command');

  // A read-only view acts on nothing.
  await renderStatus(root, { kind: 'user', id: 'q1', text: 'x', steer: 'pending' }, null);
  assert.equal(document.querySelector('button'), null);
});

/** The pane's steering actions over a stubbed host. */
async function mountSteer(t, { steerItems, busy = true, answer = null, capability, submit = async () => true }) {
  const { root } = mount(t);
  const calls = [];
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      calls.push([request.capability, ...request.args]);
      return { value: capability(request.capability, request.args) };
    },
  };
  const view = { steer: null, taken: [], restored: [], values: [], aborts: [], submits: [] };
  const draft = {
    scope: () => 's1',
    recoveryScope: () => 'rec:s1',
    restore: (value, options) => {
      view.values.push(value);
      view.restored.push([value.text, options ?? {}]);
      return true;
    },
  };
  function Harness() {
    view.steer = useSteerActions({
      steerItems,
      busy,
      sessionId: 's1',
      invokeResult: (action) => Promise.resolve().then(action),
      applySnapshot() {},
      abort: async (options) => view.aborts.push(options),
      submit: async (content, options) => {
        view.submits.push([content, options]);
        return submit(content, options);
      },
      answerQuestion: { current: answer },
      onTaken: (ids) => view.taken.push(...ids),
    });
    view.steer.context.draft.current = draft;
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { view, calls, flush };
}

const queuedItem = (id, extra = {}) => ({
  id,
  kind: 'user',
  text: `message ${id}`,
  pending: true,
  accepted: true,
  submittedAt: 1,
  queuedBehindTurn: true,
  steer: 'pending',
  queueEntry: { id, text: `message ${id}`, displayText: `message ${id}` },
  ...extra,
});

test('Send now delivers immediately through the steer-now action: prioritize, then stop the running turn', async (t) => {
  const { view, calls, flush } = await mountSteer(t, {
    steerItems: [queuedItem('q1')],
    capability: (name) => (name === 'prioritizeQueued' ? { count: 1, ids: ['q1'], priority: 'now' } : null),
  });
  await act(async () => view.steer.context.actions.sendNow('q1'));
  await flush();
  assert.deepEqual(calls, [['prioritizeQueued', 'q1']]);
  assert.deepEqual(view.aborts, [{ restorePrompt: false }], 'the turn stops and reads it next');
  assert.deepEqual(view.taken, ['q1']);
  assert.equal(view.steer.visibleSteerItems[0].steer, 'sending', 'the bubble stays; its actions give way');
});

test('Send now while a question waits answers it instead of interrupting the turn', async (t) => {
  const answers = [];
  const { view, calls, flush } = await mountSteer(t, {
    steerItems: [queuedItem('q1')],
    answer: async (reply) => {
      answers.push(reply);
      return true;
    },
    capability: () => ({ count: 1, ids: ['q1'], text: 'message q1' }),
  });
  await act(async () => view.steer.context.actions.sendNow('q1'));
  await flush();
  assert.deepEqual(calls, [['restoreQueued', '', 'q1']]);
  assert.deepEqual(answers, ['message q1']);
  assert.deepEqual(view.aborts, []);
  assert.deepEqual(view.steer.visibleSteerItems, []);
});

test('✕ takes the message back: it leaves the transcript and returns only to an empty editor', async (t) => {
  const { view, calls, flush } = await mountSteer(t, {
    steerItems: [queuedItem('q1'), queuedItem('q2')],
    capability: () => ({ count: 1, ids: ['q1'], text: 'message q1' }),
  });
  await act(async () => view.steer.context.actions.cancel('q1'));
  await flush();
  assert.deepEqual(calls, [['restoreQueued', '', 'q1']]);
  assert.deepEqual(view.taken, ['q1']);
  assert.deepEqual(view.restored, [['message q1', { ifEmpty: true }]]);
  assert.deepEqual(
    view.steer.visibleSteerItems.map((item) => item.id),
    ['q2'],
    'hidden at once, before the queue publication catches up'
  );
});

test('a message the runtime already read cannot be cancelled: the bubble comes back and settles', async (t) => {
  const { view, flush } = await mountSteer(t, {
    steerItems: [queuedItem('q1')],
    capability: () => ({ count: 0, ids: [], text: '' }),
  });
  await act(async () => view.steer.context.actions.cancel('q1'));
  await flush();
  assert.deepEqual(view.restored, []);
  assert.deepEqual(
    view.steer.visibleSteerItems.map((item) => item.id),
    ['q1']
  );
});

test('a cancel or failed retry that completes after a session switch restores into its own session, never the shown one', async (t) => {
  const { root } = mount(t);
  const parked = (scope) =>
    takeRejectedComposerSubmissionRecoveries(scope).map(({ text, attachments }) => [text, attachments.length]);
  t.after(() => {
    parked('rec:s1');
    parked('rec:s2');
  });
  // The pane is reused across sessions: the same hook instance, the same
  // composer, only the session (and the composer's scope) change.
  let releaseRestore;
  window.mixdogDesktop = {
    invokeCapability: async (request) => {
      await new Promise((resolve) => {
        releaseRestore = resolve;
      });
      const id = request.args[1];
      return { value: { count: 1, ids: [id], text: `message ${id}` } };
    },
  };
  let releaseSubmit;
  const editor = { scope: 's1', restored: [] };
  const draft = {
    scope: () => editor.scope,
    recoveryScope: () => `rec:${editor.scope}`,
    restore: (value, options) => {
      editor.restored.push([editor.scope, value.text, options ?? {}]);
      return true;
    },
  };
  const failed = queuedItem('f1', {
    steer: 'failed',
    steerLocal: true,
    queueEntry: undefined,
    retry: { content: 'message f1', options: { id: 'f1' } },
  });
  const view = { steer: null, taken: [] };
  function Harness({ sessionId, steerItems }) {
    view.steer = useSteerActions({
      steerItems,
      busy: true,
      sessionId,
      invokeResult: (action) => Promise.resolve().then(action),
      applySnapshot() {},
      abort: async () => {},
      submit: () =>
        new Promise((resolve) => {
          releaseSubmit = resolve;
        }),
      answerQuestion: { current: null },
      onTaken: (ids) => view.taken.push(...ids),
    });
    view.steer.context.draft.current = draft;
    return null;
  }
  const show = (sessionId, steerItems) =>
    act(async () => root.render(React.createElement(Harness, { sessionId, steerItems })));
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  await show('s1', [queuedItem('q1')]);
  await act(async () => view.steer.context.actions.cancel('q1'));
  // The user switches to session s2 while the take-back is in flight.
  editor.scope = 's2';
  await show('s2', []);
  await act(async () => releaseRestore());
  await flush();
  assert.deepEqual(editor.restored, [], "s2's editor is never written");
  assert.deepEqual(view.taken, ['q1']);
  assert.deepEqual(parked('rec:s1'), [['message q1', 0]], 's1 gets the message back when it is shown again');
  assert.deepEqual(parked('rec:s2'), []);

  // Same for a retry refused after the switch: the message goes home.
  editor.scope = 's1';
  await show('s1', [failed]);
  await act(async () => view.steer.context.actions.retry('f1'));
  editor.scope = 's2';
  await show('s2', []);
  await act(async () => releaseSubmit(false));
  await flush();
  assert.deepEqual(editor.restored, []);
  assert.deepEqual(parked('rec:s1'), [['message f1', 0]]);
  assert.deepEqual(parked('rec:s2'), []);

  // Back on s1 while it completes: the shown editor is its own, so it restores there.
  await show('s1', [queuedItem('q2')]);
  editor.scope = 's1';
  await act(async () => view.steer.context.actions.cancel('q2'));
  await act(async () => releaseRestore());
  await flush();
  assert.deepEqual(editor.restored, [['s1', 'message q2', { ifEmpty: true }]]);
});

test('Send again resubmits the failed message under its own id; ✕ on it returns its text', async (t) => {
  const failed = queuedItem('f1', {
    steer: 'failed',
    steerLocal: true,
    queueEntry: undefined,
    retry: { content: 'message f1', options: { id: 'f1', displayText: 'message f1' } },
  });
  const { view, calls, flush } = await mountSteer(t, { steerItems: [failed], capability: () => null });
  await act(async () => view.steer.context.actions.retry('f1'));
  await flush();
  assert.deepEqual(view.submits, [['message f1', { id: 'f1', displayText: 'message f1' }]]);
  assert.deepEqual(view.restored, []);
  await act(async () => view.steer.context.actions.cancel('f1'));
  await flush();
  assert.deepEqual(calls, [], 'a failed message is not in the session queue');
  assert.deepEqual(view.taken, ['f1']);
  assert.deepEqual(view.restored, [['message f1', { ifEmpty: true }]]);
});

const PNG_B64 = 'iVBORw0KGgo=';
const imagePrompt = (id, words) => ({
  content: [...(words ? [{ type: 'text', text: words }] : []), { type: 'image', data: PNG_B64, mimeType: 'image/png' }],
  options: {
    id,
    ...(words ? { displayText: words } : {}),
    pastedImages: { 1: { id: 1, type: 'image', mediaType: 'image/png', filename: 'shot.png', sizeBytes: 8 } },
  },
});
const failedImage = (id, words) =>
  queuedItem(id, {
    text: words,
    steer: 'failed',
    steerLocal: true,
    queueEntry: undefined,
    images: [{ id: 1, name: 'shot.png' }],
    retry: imagePrompt(id, words),
  });
/** What the editor rebuilds from a restore record. */
const editorView = (value) => {
  const restored = restoreAttachmentsFromRecord(value, String(value.text || ''), {
    reservedIds: new Set(),
    sequence: { current: 1 },
  });
  return [restored.text, restored.attachments.map((attachment) => [attachment.kind, attachment.data])];
};

test('✕ and a refused retry on a failed text-only bubble return its pasted text and text file', async (t) => {
  const pastedTexts = {
    1: { id: 1, text: 'pasted body', filename: 'Pasted text · 12 lines', source: 'paste' },
    2: { id: 2, text: 'export const a = 1;\n', filename: 'main.ts', mimeType: 'text/plain', source: 'file' },
  };
  const text = 'see [Pasted text #1 +12 lines]\n[File #2: main.ts]';
  const failedText = (id) =>
    queuedItem(id, {
      text,
      steer: 'failed',
      steerLocal: true,
      queueEntry: undefined,
      retry: { content: text, options: { id, displayText: text, pastedTexts } },
    });
  const { view, flush } = await mountSteer(t, {
    steerItems: [failedText('f1'), failedText('f2')],
    capability: () => null,
    submit: async () => false,
  });
  await act(async () => view.steer.context.actions.cancel('f1'));
  await flush();
  await act(async () => view.steer.context.actions.retry('f2'));
  await flush();
  const expected = [
    'see',
    [
      ['text', 'pasted body'],
      ['text', 'export const a = 1;\n'],
    ],
  ];
  const [cancelled, refused] = view.values.map(editorView);
  assert.deepEqual([cancelled[0].replace(/\s*\[[^\]]+\]/g, ''), cancelled[1]], expected);
  assert.deepEqual([refused[0].replace(/\s*\[[^\]]+\]/g, ''), refused[1]], expected);
});

test('restored chips join the composer’s ids: parked, then a new chip, then parked again stay distinct', () => {
  // The composer's own sequence; its live chips.
  const sequence = { current: 1 };
  let live = [];
  const parkedMessage = () => [
    [
      { id: 1, name: 'shot.png', kind: 'image', mimeType: 'image/png', data: 'A', token: '' },
      {
        id: 2,
        name: 'Pasted text · 12 lines',
        kind: 'text',
        mimeType: 'text/plain',
        data: 'pasted body',
        token: '[Pasted text #2 +12 lines]',
        source: 'paste',
      },
    ],
    'see [Pasted text #2 +12 lines]',
  ];
  const restore = () => {
    const [attachments, text] = parkedMessage();
    const merged = renumberRestoredAttachments(
      attachments,
      text,
      live.map((attachment) => attachment.id),
      sequence
    );
    live = [...live, ...merged.attachments];
    return merged;
  };
  const first = restore();
  assert.deepEqual(
    first.attachments.map((attachment) => attachment.id),
    [1, 2],
    'free ids are kept'
  );
  assert.equal(first.text, 'see [Pasted text #2 +12 lines]');
  // The user attaches one more chip: the next id of the composer's sequence.
  live.push({ id: sequence.current++, kind: 'image', token: '' });
  const second = restore();
  const ids = live.map((attachment) => attachment.id);
  assert.equal(new Set(ids).size, ids.length, `all distinct: ${ids}`);
  const paste = second.attachments.find((attachment) => attachment.kind === 'text');
  assert.equal(paste.token, `[Pasted text #${paste.id} +12 lines]`);
  assert.equal(second.text, `see ${paste.token}`, 'the words point at the renumbered chip');
  assert.ok(sequence.current > Math.max(...ids), 'the composer’s next id is past every chip');
  // Two renames in one pass never land on each other's token.
  const swapped = renumberRestoredAttachments(
    [
      { id: 1, kind: 'text', token: '[File #1: a.ts]', data: 'a' },
      { id: 2, kind: 'text', token: '[File #2: b.ts]', data: 'b' },
    ],
    '[File #1: a.ts] [File #2: b.ts]',
    [1, 2],
    { current: 2 }
  );
  const [a, b] = swapped.attachments;
  assert.ok(a.id > 2 && b.id > 2 && a.id !== b.id);
  assert.deepEqual([a.token, b.token], [`[File #${a.id}: a.ts]`, `[File #${b.id}: b.ts]`]);
  assert.equal(swapped.text, `${a.token} ${b.token}`);
});

test('✕ on a failed image-only or image+text bubble returns its images, not just its words', async (t) => {
  const { view, flush } = await mountSteer(t, {
    steerItems: [failedImage('f1', ''), failedImage('f2', 'what is this?')],
    capability: () => null,
  });
  await act(async () => view.steer.context.actions.cancel('f1'));
  await flush();
  await act(async () => view.steer.context.actions.cancel('f2'));
  await flush();
  assert.deepEqual(view.taken, ['f1', 'f2']);
  assert.deepEqual(view.values.map(editorView), [
    ['', [['image', PNG_B64]]],
    ['what is this?', [['image', PNG_B64]]],
  ]);
  assert.deepEqual(
    view.restored.map(([, options]) => options),
    [{ ifEmpty: true }, { ifEmpty: true }]
  );
});

test('✕ on an unread image-only bubble: the runtime placeholder words never reach the editor', () => {
  // restoreQueued's text is the entry's display text, which spells an image as `[Image]`.
  assert.deepEqual(
    editorView({
      count: 1,
      ids: ['q1'],
      text: '[Image]\n[Image]',
      pastedImages: {
        1: { id: 1, content: PNG_B64, mediaType: 'image/png' },
        2: { id: 2, content: PNG_B64, mediaType: 'image/png' },
      },
    }),
    [
      '',
      [
        ['image', PNG_B64],
        ['image', PNG_B64],
      ],
    ]
  );
});

test('a cancel or refused retry after a session switch parks the whole message, attachments included', async (t) => {
  const { root } = mount(t);
  const parked = (scope) =>
    takeRejectedComposerSubmissionRecoveries(scope).map(({ text, attachments }) => ({
      text,
      attachments: attachments.map(({ id, kind, data, token }) => ({ id, kind, data, token })),
    }));
  t.after(() => {
    parked('rec:s1');
    parked('rec:s2');
    stashComposerDraft('s1', '');
  });
  let release;
  const restoredValue = {
    count: 1,
    ids: ['q1'],
    text: 'see [Pasted text #2 +12 lines]\n[Image]',
    pastedImages: { 1: { id: 1, content: PNG_B64, mediaType: 'image/png', filename: 'shot.png' } },
    pastedTexts: { 2: { id: 2, text: 'pasted body', source: 'paste' } },
  };
  window.mixdogDesktop = {
    invokeCapability: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { value: restoredValue };
    },
  };
  const editor = { scope: 's1', restored: [] };
  const draft = {
    scope: () => editor.scope,
    recoveryScope: () => `rec:${editor.scope}`,
    restore: (value) => {
      editor.restored.push(value);
      return true;
    },
  };
  const view = { steer: null };
  let refuse;
  function Harness({ steerItems }) {
    view.steer = useSteerActions({
      steerItems,
      busy: true,
      sessionId: editor.scope,
      invokeResult: (action) => Promise.resolve().then(action),
      applySnapshot() {},
      abort: async () => {},
      submit: () =>
        new Promise((resolve) => {
          refuse = () => resolve(false);
        }),
      answerQuestion: { current: null },
      onTaken() {},
    });
    view.steer.context.draft.current = draft;
    return null;
  }
  const show = (scope, steerItems) => {
    editor.scope = scope;
    return act(async () => root.render(React.createElement(Harness, { steerItems })));
  };
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  // Unread bubble with an image and a pasted text, cancelled, then s2 is shown.
  await show('s1', [queuedItem('q1', { text: 'see', images: [{ id: 1 }] })]);
  await act(async () => view.steer.context.actions.cancel('q1'));
  await show('s2', []);
  await act(async () => release());
  await flush();
  assert.deepEqual(editor.restored, [], "s2's editor is never written");
  assert.deepEqual(parked('rec:s2'), []);
  const [home] = parked('rec:s1');
  assert.equal(home.attachments.length, 2);
  const image = home.attachments.find((attachment) => attachment.kind === 'image');
  const paste = home.attachments.find((attachment) => attachment.kind === 'text');
  assert.equal(image.data, PNG_B64);
  assert.equal(paste.data, 'pasted body');
  // Parked under the record's own ids; the composer renumbers them on the way in.
  assert.deepEqual([image.id, paste.id], [1, 2]);
  assert.equal(home.text, 'see [Pasted text #2 +12 lines]');
  assert.equal(paste.token, '[Pasted text #2 +12 lines]');

  // A refused retry of an image-only failed bubble after the switch.
  await show('s1', [failedImage('f1', '')]);
  await act(async () => view.steer.context.actions.retry('f1'));
  await show('s2', []);
  await act(async () => refuse());
  await flush();
  assert.deepEqual(
    parked('rec:s1').map(({ text, attachments }) => [text, attachments.map(({ kind, data }) => [kind, data])]),
    [['', [['image', PNG_B64]]]]
  );

  // ✕ honours "only into an empty editor" for the parked conversation too.
  await show('s1', [queuedItem('q1')]);
  await act(async () => view.steer.context.actions.cancel('q1'));
  await show('s2', []);
  // Leaving s1 stashed what was typed there.
  stashComposerDraft('s1', 'typed while away');
  await act(async () => release());
  await flush();
  assert.deepEqual(parked('rec:s1'), []);
  assert.deepEqual(editor.restored, []);
});

test('a send behind the running turn that fails stays in the transcript as a failed bubble', async (t) => {
  const { root } = mount(t);
  for (const outcome of ['refused', 'thrown']) {
    const state = { prompts: [], actions: null };
    const host = () => (outcome === 'refused' ? Promise.resolve(false) : Promise.reject(new Error('PC offline')));
    function Harness() {
      const [prompts, setPrompts] = useState([]);
      state.prompts = prompts;
      state.actions = useConversationComposerActions({
        armFollowOnSubmitRef: { current: () => {} },
        composerActions: { current: { invokeResult: (action) => Promise.resolve().then(action), submit: host } },
        draftModeRef: { current: false },
        goalSubmission: { current: null },
        goalSubmitScopeRef: { current: 'session:s1' },
        queuedBehindTurnAtSubmit: { current: true },
        routeSessionIdRef: { current: 's1' },
        setOptimisticPrompts: setPrompts,
        settledUsersRef: { current: 1 },
        suppressDraftSubmitPaintHandoff: { current: false },
      });
      return null;
    }
    await act(async () => root.render(React.createElement(Harness, { key: outcome })));
    let accepted;
    await act(async () => {
      accepted = await state.actions.composerSubmit('keep me', { id: `s-${outcome}` });
    });
    assert.equal(accepted, true, `${outcome}: the bubble owns the message, so the composer clears`);
    assert.equal(state.prompts.length, 1, `${outcome}: the bubble stays`);
    assert.equal(state.prompts[0].steer, 'failed');
    assert.deepEqual(state.prompts[0].retry, { content: 'keep me', options: { id: `s-${outcome}` } });
  }
});

test('/compact sent mid-turn is held by the session and shows inline until the turn ends', async () => {
  const held = [];
  const capabilities = [];
  const execute = createSlashExecutor({
    turnBusy: true,
    sessionId: 's1',
    provider: 'p',
    model: 'm',
    effort: '',
    fast: false,
    fastCapable: false,
    invokeResult: async (action) => action(),
    invokeCapabilityResult: async (capability) => {
      capabilities.push(capability);
      return { value: { changed: false, scheduled: true } };
    },
    applySnapshot() {},
    submit: async () => true,
    setAttachmentError() {},
    clearNotice() {},
    showNotice() {},
    openGoalDialog() {},
    onBtw() {},
    openSkillMenu() {},
    onNewTask() {},
    onResumeSession() {},
    onOpenSessions() {},
    onOpenProjects() {},
    onOpenSettings() {},
    onOpenCommandSurface() {},
    onSlashHeld: (text) => held.push(text),
  });
  assert.equal(await execute('/compact'), true);
  assert.deepEqual(capabilities, ['compact'], 'the session keeps its own turn-end hold');
  assert.deepEqual(held, ['/compact']);
});
