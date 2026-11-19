import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installPhonePaneDom } from './test-support/phone-pane-dom.mjs';

// The real PaneConversation answers "may I be released?" through the gate its
// pane hands it: no while it holds anything unfinished, yes once at rest.
// Each test has its own session: a composer parks its draft per session.
let sessions = 0;
async function conversation(t, extraProps = {}) {
  const { dom, root, props, PaneConversation, defaultSessionLaneStore, frames } = await installPhonePaneDom(t, {
    mobile: false,
  });
  const sessionId = `release-${++sessions}`;
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const computedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  t.after(() => {
    globalThis.getComputedStyle = computedStyle;
  });
  const { ConversationReleaseContext, createConversationReleaseGate } = await import('./conversation-release.ts');
  const doc = dom.window.document;
  const gate = createConversationReleaseGate();
  const frame = () =>
    act(async () => {
      for (let step = 0; step < 4 && frames.size; step++) {
        const due = [...frames.values()];
        frames.clear();
        for (const callback of due) callback(0);
      }
    });
  const deliver = async (fields = {}) => {
    await act(async () =>
      defaultSessionLaneStore.apply({
        sessionId,
        frameSource: 'live',
        snapshot: {
          sessionId,
          provider: 'openai-oauth',
          model: 'test-model',
          items: [
            { kind: 'user', id: 'u', text: 'question' },
            { kind: 'assistant', id: 'r', text: 'answer' },
          ],
          ...fields,
        },
      })
    );
    await frame();
  };
  await deliver();
  await act(async () =>
    root.render(
      React.createElement(
        ConversationReleaseContext.Provider,
        { value: gate },
        React.createElement(PaneConversation, { ...props(sessionId), ...extraProps })
      )
    )
  );
  await frame();
  const setValue = (element, value) =>
    act(async () => {
      const proto = Object.getPrototypeOf(element);
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  const textarea = () => doc.querySelector('.composer textarea');
  return {
    dom,
    doc,
    gate,
    deliver,
    frame,
    textarea,
    setValue,
    type: (value) => setValue(textarea(), value),
    key: (key) =>
      act(async () => {
        textarea().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }),
    settle: (ms = 20) => act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, ms))),
  };
}

const askArgs = { questions: [{ question: 'Which one?', options: [{ label: 'Red' }, { label: 'Blue' }] }] };
// The card sits at its waiting ask_user call in the transcript.
const asking = {
  items: [
    { kind: 'user', id: 'u', text: 'question' },
    { kind: 'tool', id: 'call-ask', callId: 'call-ask', name: 'ask_user', args: askArgs, status: 'running' },
  ],
  busy: false,
  toolApproval: { id: 'ask-1', kind: 'question', name: 'ask_user', toolCallId: 'call-ask', args: askArgs },
};

test('at rest, the conversation may be released', async (t) => {
  const c = await conversation(t);
  assert.ok(c.textarea(), 'the composer is mounted');
  assert.equal(c.gate.mayRelease(), true);
});

test('a running turn keeps the conversation until it ends', async (t) => {
  const c = await conversation(t);
  await c.deliver({ busy: true });
  assert.equal(c.gate.mayRelease(), false);
  await c.deliver({ busy: false });
  assert.equal(c.gate.mayRelease(), true);
});

test('queued prompts keep the conversation', async (t) => {
  const c = await conversation(t);
  await c.deliver({ queued: [{ id: 'q1', text: 'next one' }] });
  assert.equal(c.gate.mayRelease(), false);
  await c.deliver({ queued: [] });
  assert.equal(c.gate.mayRelease(), true);
});

test('a pending question with a pick keeps the conversation', async (t) => {
  const c = await conversation(t);
  await c.deliver(asking);
  const option = c.doc.querySelector('.question-option');
  assert.ok(option, 'the question card is shown');
  assert.equal(c.gate.mayRelease(), true, 'an untouched question holds nothing');
  await act(async () => option.click());
  assert.equal(c.gate.mayRelease(), false);
});

test('a pending question with a typed answer keeps the conversation', async (t) => {
  const c = await conversation(t);
  await c.deliver(asking);
  await c.setValue(c.doc.querySelector('.question-other input'), 'Green');
  assert.equal(c.gate.mayRelease(), false);
});

test('a partly filled secret field keeps the conversation', async (t) => {
  const c = await conversation(t);
  // The desktop API that takes a typed value; without it the card offers Cancel only.
  const had = c.dom.window.mixdogDesktop;
  c.dom.window.mixdogDesktop = { ...had, provideSecretInput: async () => true };
  t.after(() => {
    c.dom.window.mixdogDesktop = had;
  });
  await c.deliver({
    toolApproval: {
      id: 'secret-1',
      name: 'ask_user',
      kind: 'secret',
      remember: ['once'],
      secret: { requestId: 'secret_secret-10123456789', surface: 'browser', target: 'bank', field: 'Password' },
    },
  });
  const field = c.doc.querySelector('input.approval-secret');
  assert.ok(field, 'the secret field is shown');
  assert.equal(c.gate.mayRelease(), true, 'an empty field holds nothing');
  field.value = 'hunter2';
  assert.equal(c.gate.mayRelease(), false);
  field.value = '';
  assert.equal(c.gate.mayRelease(), true);
});

test('a prompt sent behind a turn that failed to send keeps the conversation after the turn ends', async (t) => {
  const c = await conversation(t, {
    submit: async () => {
      throw new Error('transport closed');
    },
  });
  await c.deliver({ busy: true });
  await c.type('while you work');
  await act(async () => {
    c.doc
      .querySelector('form.composer')
      .dispatchEvent(new c.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await c.settle();
  await c.deliver({ busy: false });
  await c.type('');
  assert.match(c.doc.body.textContent, /while you work/, 'the unsent prompt is still on screen');
  assert.equal(c.gate.mayRelease(), false);
});

test('an approval whose editable text was changed keeps the conversation', async (t) => {
  const c = await conversation(t);
  await c.deliver({
    toolApproval: {
      id: 'post-1',
      name: 'github',
      kind: 'outbound',
      remember: ['once'],
      outbound: { category: 'comment', target: 'repo#1', payload: 'LGTM', editable: ['body'], details: {} },
    },
  });
  const editor = c.doc.querySelector('textarea[aria-label="Text to send, editable"]');
  assert.ok(editor, 'the editable text is shown');
  assert.equal(c.gate.mayRelease(), true, 'the text as proposed holds nothing');
  await c.setValue(editor, 'LGTM, ship it');
  assert.equal(c.gate.mayRelease(), false);
  await c.setValue(editor, 'LGTM');
  assert.equal(c.gate.mayRelease(), true, 'back to the proposed text');
});

test('composer text keeps the conversation', async (t) => {
  const c = await conversation(t);
  await c.type('half a thought');
  assert.equal(c.gate.mayRelease(), false);
  await c.type('');
  assert.equal(c.gate.mayRelease(), true);
});

test('an attachment chip keeps the conversation', async (t) => {
  const c = await conversation(t);
  const text = 'row of a spreadsheet\n'.repeat(60);
  await act(async () => {
    const event = new c.dom.window.Event('paste', { bubbles: true, cancelable: true });
    const data = { 'text/plain': text };
    Object.defineProperty(event, 'clipboardData', {
      value: {
        items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
        files: [],
        types: ['text/plain'],
        getData: (type) => data[type] ?? '',
      },
    });
    c.textarea().dispatchEvent(event);
  });
  await c.settle();
  assert.equal(c.textarea().value, '', 'the paste became a chip, not text');
  assert.equal(c.doc.querySelectorAll('.composer-attachments > *').length, 1);
  assert.equal(c.gate.mayRelease(), false);
});

test('a prompt-history recall keeps the conversation until it returns to the draft', async (t) => {
  const c = await conversation(t);
  await c.deliver({ promptHistoryList: ['an earlier prompt'] });
  await c.key('ArrowUp');
  assert.equal(c.textarea().value, 'an earlier prompt', 'the recall is in progress');
  assert.equal(c.gate.mayRelease(), false);
  await c.key('ArrowDown');
  assert.equal(c.textarea().value, '');
  await c.settle();
  assert.equal(c.gate.mayRelease(), true);
});

test('a send still in flight keeps the conversation', async (t) => {
  const acknowledge = Promise.withResolvers();
  const c = await conversation(t, { submit: () => acknowledge.promise });
  await c.type('on its way');
  await act(async () => {
    c.doc
      .querySelector('form.composer')
      .dispatchEvent(new c.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await c.settle();
  assert.equal(c.textarea().value, '', 'the composer emptied for the send');
  assert.equal(c.gate.mayRelease(), false);
  acknowledge.resolve(true);
  await c.settle();
});

test('a submission id kept for retry after a transport error keeps the conversation, even emptied', async (t) => {
  const c = await conversation(t, {
    submit: async () => {
      throw new Error('transport closed');
    },
  });
  await c.type('send me');
  await act(async () => {
    c.doc
      .querySelector('form.composer')
      .dispatchEvent(new c.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await c.settle();
  assert.equal(c.textarea().value, 'send me', 'the failed send is restored');
  await c.type('');
  assert.equal(c.gate.mayRelease(), false, 'the kept retry id still holds it');
});
