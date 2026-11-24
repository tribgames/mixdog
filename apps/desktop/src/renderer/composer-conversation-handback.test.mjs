import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

// What the mounted Composer hands back, and to which conversation: the text typed across a switch, a Stop's prompt, a
// refused command, a steer message sent again, the rewind picker's prompts, and the line break of an Enter the IME takes.
const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'sessionStorage'],
  globals: {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  },
});
test.after(() => restore());
Object.defineProperty(window.navigator, 'userAgent', { value: 'Electron' });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};

const toasts = [];
window.addEventListener('mixdog:desktop-toast', (event) => toasts.push(event.detail.text));
window.mixdogDesktop = {
  invokeCapability: async (request) => {
    if (request.capability === 'skillsStatus') return { value: { skills: [] } };
    return request.capability === 'getVoiceStatus' ? { value: { installed: false } } : { value: {} };
  },
  readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: { skills: [] } })),
  searchProjectFiles: async () => [],
  rendererDiagnostic() {},
};

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('./Composer.tsx');
const { SteerContext, useSteerActions } = await import('./steer-actions.ts');

const scopeProps = (id) => ({ historyScope: id, identityScope: id, recoveryScope: id, sessionId: id });
const baseProps = {
  turnBusy: false,
  commandBusy: false,
  transitioning: false,
  focusRequest: 0,
  projectScope: 'C:/project',
  hasConversation: true,
  provider: 'openai-oauth',
  model: 'test-model',
  effort: 'medium',
  fast: false,
  fastCapable: false,
  paneActive: true,
  submit: async () => true,
  abort: async () => ({}),
  invokeResult: (action) => action(),
  applySnapshot() {},
  onNewTask() {},
  onResumeSession() {},
  onOpenSessions() {},
  onOpenProjects() {},
  onOpenSettings() {},
  onOpenCommandSurface() {},
  dropTargetRef: { current: null },
};

const input = () => document.querySelector('textarea');
const typeText = (text) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), text);
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const chipCount = () => document.querySelectorAll('.composer-attachments > *').length;
const sendForm = () =>
  act(async () => {
    document
      .querySelector('form.composer')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
const press = (init) =>
  act(async () => {
    input().dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });

function mount(t, element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return (props) => act(async () => root.render(element(props)));
}

test('text typed live in one session never shows in another, whether or not either lane is loaded', async (t) => {
  // As the pane's dock gives them: the session is the identity from the first frame, its id arrives with its lane.
  const render = mount(t, ({ id, loaded }) =>
    React.createElement(Composer, {
      ...baseProps,
      historyScope: id,
      identityScope: id,
      recoveryScope: id,
      sessionId: loaded ? id : '',
    })
  );
  // Cold A, typed into with focus in the field, to B without a blur.
  await render({ id: 'cold-a', loaded: false });
  input().focus();
  await typeText('000');
  await render({ id: 'cold-b', loaded: false });
  assert.equal(input().value, '', "A's text does not follow into B");
  await render({ id: 'cold-b', loaded: true });
  assert.equal(input().value, '', "nor once B's lane is read");
  await render({ id: 'cold-a', loaded: true });
  assert.equal(input().value, '000', 'A gets it back');
  // The mirror: warm A, typed into live, to a B whose lane is not read yet.
  input().focus();
  await typeText('000 again');
  await render({ id: 'cold-c', loaded: false });
  assert.equal(input().value, '', "warm A's text does not follow into cold C");
  await render({ id: 'cold-c', loaded: true });
  assert.equal(input().value, '');
  await render({ id: 'cold-a', loaded: true });
  assert.equal(input().value, '000 again');
});

test('a Stop answered after the composer moved to another session hands its prompt back to the stopped one', async (t) => {
  const answer = Promise.withResolvers();
  const render = mount(t, (id) =>
    React.createElement(Composer, { ...baseProps, turnBusy: true, abort: () => answer.promise, ...scopeProps(id) })
  );
  await render('stop-a');
  await press({ key: 'Escape' });
  await render('stop-b');
  await act(async () => {
    answer.resolve({
      aborted: true,
      restoreText: 'look at [Pasted text #1 +3 lines]',
      pastedTexts: { 1: { id: 1, text: 'one\ntwo\nthree\nfour', source: 'paste' } },
      restoredSubmissionIds: [],
    });
    await answer.promise;
  });
  assert.equal(input().value, '', "B's draft is not written");
  assert.equal(chipCount(), 0, 'no chip of A shows in B');
  await render('stop-a');
  assert.equal(input().value, 'look at');
  assert.equal(chipCount(), 1, 'the pasted text comes back with it');
  await render('stop-b');
  assert.equal(chipCount(), 0);
});

test('a refused slash command answered after the composer moved to another session goes back to its own', async (t) => {
  const refusal = Promise.withResolvers();
  const render = mount(t, (id) =>
    React.createElement(Composer, { ...baseProps, onInherit: () => refusal.promise, ...scopeProps(id) })
  );
  await render('slash-a');
  await typeText('/fork');
  await sendForm();
  assert.equal(input().value, '', 'the command left the editor while it runs');
  await render('slash-b');
  await act(async () => {
    refusal.resolve(false);
    await refusal.promise;
  });
  assert.equal(input().value, '', "B's draft is not written");
  await render('slash-a');
  assert.equal(input().value, '/fork', 'A gets its command back');
});

test('a steer message whose resend failed again goes out from the editor under its own id', async (t) => {
  const refusal = Promise.withResolvers();
  const sent = Promise.withResolvers();
  const failed = {
    kind: 'user',
    id: 'f1',
    text: 'steer words',
    steer: 'failed',
    steerLocal: true,
    retry: { content: 'steer words', options: { id: 'desktop-submit-f1', displayText: 'steer words' } },
  };
  const view = {};
  function Pane() {
    const { context } = useSteerActions({
      steerItems: [failed],
      turnId: 'turn-1',
      sessionId: 'steer-a',
      invokeResult: (action) => action(),
      applySnapshot() {},
      submit: () => refusal.promise,
      answerQuestion: { current: null },
      onTaken() {},
    });
    view.actions = context.actions;
    return React.createElement(
      SteerContext.Provider,
      { value: context },
      React.createElement(Composer, {
        ...baseProps,
        ...scopeProps('steer-a'),
        submit: async (_content, options) => {
          sent.resolve(options.id);
          return true;
        },
      })
    );
  }
  const render = mount(t, () => React.createElement(Pane));
  await render();
  await act(async () => {
    view.actions.retry('f1');
    refusal.reject(new Error('connection interrupted'));
    await refusal.promise.catch(() => {});
  });
  assert.equal(input().value, 'steer words', 'the message is back in the editor');
  let sentId;
  await act(async () => {
    document
      .querySelector('form.composer')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    sentId = await sent.promise;
  });
  assert.equal(sentId, 'desktop-submit-f1', 'an earlier attempt that landed is acknowledged, not posted twice');
});

test('Esc Esc asks the stored history even when the rows held show no prompt, and again after an empty answer', async (t) => {
  let stored = [];
  const answers = [];
  window.mixdogDesktop.listRewindTargets = () => {
    const answer = Promise.resolve({ data: stored });
    answers.push(answer);
    return answer;
  };
  t.after(() => {
    delete window.mixdogDesktop.listRewindTargets;
  });
  const render = mount(t, () =>
    React.createElement(Composer, { ...baseProps, ...scopeProps('rewind-a'), userMessages: [] })
  );
  await render();
  const now = Date.now;
  Date.now = () => 5_000;
  t.after(() => {
    Date.now = now;
  });
  const escEsc = () =>
    act(async () => {
      const asked = answers.length;
      for (let count = 0; count < 2; count += 1) {
        input().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      }
      assert.equal(answers.length, asked + 1, 'the second Esc asks the stored history');
      await answers.at(-1);
    });
  await escEsc();
  assert.equal(document.querySelector('.message-selector'), null);
  assert.ok(toasts.includes('No message to jump back to.'), 'an empty history says so');
  stored = [{ position: 'p1', text: 'an earlier prompt' }];
  await escEsc();
  assert.match(document.querySelector('.message-selector')?.textContent ?? '', /an earlier prompt/);
});

test('an Enter the IME takes (Windows: key Process, code Enter) commits without a line break', async (t) => {
  const sent = [];
  const render = mount(t, () =>
    React.createElement(Composer, {
      ...baseProps,
      ...scopeProps('ime-a'),
      submit: async (content) => {
        sent.push(content);
        return true;
      },
    })
  );
  await render();
  input().focus();
  await act(async () => input().dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
  await press({ key: 'Process', code: 'Enter', keyCode: 229 });
  await act(async () => input().dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
  const lineBreak = new window.InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true });
  await act(async () => input().dispatchEvent(lineBreak));
  assert.equal(lineBreak.defaultPrevented, true, 'no blank line follows the commit');
  assert.deepEqual(sent, []);
});
