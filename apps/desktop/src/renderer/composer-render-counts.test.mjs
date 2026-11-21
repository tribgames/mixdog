import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const PERFORMED_WORK = 1;
const RENDERING_TAGS = new Set([0, 11, 15]);
const renders = new Map();
function visit(fiber) {
  for (let f = fiber; f; f = f.sibling) {
    const prev = f.alternate;
    if (prev && f.child === prev.child && !(f.flags & PERFORMED_WORK)) continue;
    if (RENDERING_TAGS.has(f.tag) && f.flags & PERFORMED_WORK) {
      const name = f.type?.displayName || f.type?.name;
      if (name) renders.set(name, (renders.get(name) || 0) + 1);
    }
    visit(f.child);
  }
}
globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  checkDCE() {},
  onScheduleFiberRoot() {},
  onCommitFiberRoot: (_id, root) => visit(root.current),
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
};

const { restore } = installTestDom(null, {
  html: '<!doctype html><body><main></main></body>',
  jsdom: { pretendToBeVisual: true },
  expose: ['navigator', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'sessionStorage'],
  globals: {
    // Files are Node's (jsdom's Blob has no arrayBuffer), so reading is Node's too.
    FileReader: class {
      readAsDataURL(blob) {
        void blob.arrayBuffer().then(
          (buffer) => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onload?.();
          },
          () => this.onerror?.()
        );
      }
    },
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

const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('./Composer.tsx');
const { SendButton } = await import('./composer-surfaces.tsx');
const { SteerContext } = await import('./steer-actions.ts');
const { clearVisualizeChoices, setVisualizeChoice } = await import('./visualize-feedback-store.ts');

const CONTROLS = ['ComposerAddMenu', 'ComposerModelControls', 'ComposerModelLine'];
const count = (name) => renders.get(name) || 0;

const composerProps = (id, overrides = {}) => ({
  turnBusy: false,
  commandBusy: false,
  transitioning: false,
  focusRequest: 0,
  historyScope: id,
  identityScope: id,
  recoveryScope: id,
  sessionId: id,
  projectScope: 'C:/project',
  hasConversation: true,
  provider: 'openai-oauth',
  model: 'test-model',
  effort: 'medium',
  fast: false,
  fastCapable: false,
  paneActive: true,
  submit: async () => true,
  abort: async () => {},
  invokeResult: (action) => action(),
  applySnapshot() {},
  onNewTask() {},
  onResumeSession() {},
  onOpenSessions() {},
  onOpenProjects() {},
  onOpenSettings() {},
  onOpenCommandSurface() {},
  dropTargetRef: { current: null },
  ...overrides,
});
const capabilities = (voiceInstalled = false) => ({
  invokeCapability: async (request) => {
    if (request.capability === 'getVoiceStatus')
      return { value: { installed: voiceInstalled, enabled: voiceInstalled } };
    if (request.capability === 'transcribeAudio') return { value: 'first words' };
    if (request.capability === 'skillsStatus') return { value: { skills: [] } };
    return { value: {} };
  },
  readCapabilities: async (requests) => requests.map(() => ({ ok: true, value: { skills: [] } })),
  searchProjectFiles: async () => [],
  rendererDiagnostic() {},
});
const mountComposer = () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  return {
    render: (element) => act(async () => root.render(element)),
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
};
const sendButton = () => document.querySelector('.send-button');
const field = () => document.querySelector('textarea');
const settle = (ms = 30) => act(async () => new Promise((resolve) => window.setTimeout(resolve, ms)));
const click = (node) => act(async () => node.click());

async function mountDraftComposer(id) {
  window.mixdogDesktop = capabilities();
  const submitted = [];
  let finishSubmit = () => {};
  const baseProps = composerProps(id, {
    draftMode: true,
    promptHistoryList: ['recalled prompt'],
    submit: (content) => {
      submitted.push(content);
      return new Promise((resolve) => {
        finishSubmit = () => resolve(true);
      });
    },
  });
  const root = createRoot(document.querySelector('main'));
  await act(async () => root.render(React.createElement(Composer, baseProps)));
  const input = document.querySelector('textarea');
  return {
    root,
    baseProps,
    submitted,
    input,
    finishSubmit: () => finishSubmit(),
    send: () => document.querySelector('.send-button'),
    snapshot: () => ({ controls: CONTROLS.map(count), send: count('SendButton') }),
    type: (value) =>
      act(async () => {
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, value);
        input.setSelectionRange(value.length, value.length);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      }),
    unmount: () => act(async () => root.unmount()),
  };
}

test('typing leaves the + menu, model controls and model line alone; the send disc follows sendability only', async () => {
  const view = await mountDraftComposer('render-count-typing');
  const { input, send, snapshot, type } = view;
  try {
    assert.equal(send().disabled, true, 'empty draft cannot send');
    const settled = snapshot();

    // First character: sendability flips, so the disc (only) renders.
    await type('h');
    assert.equal(send().disabled, false);
    assert.deepEqual(snapshot().controls, settled.controls);
    assert.equal(count('SendButton'), settled.send + 1);

    // Ordinary typing: nothing draft-independent renders, the disc stays.
    const typing = snapshot();
    const composerBefore = count('Composer');
    for (const value of ['he', 'hel', 'hell', 'hello']) await type(value);
    assert.deepEqual(snapshot(), typing);
    assert.equal(send().disabled, false);
    // The counter itself works: the draft-owning composer renders per keystroke.
    assert.equal(count('Composer') - composerBefore, 4);

    // IME composition: mid-composition updates do not re-render them either.
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    await type('hello 한');
    await type('hello 한글');
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(input.value, 'hello 한글');
    assert.deepEqual(snapshot(), typing);

    // Back to nothing and to whitespace: the disc follows the trimmed draft.
    await type('');
    assert.equal(send().disabled, true);
    assert.equal(count('SendButton'), typing.send + 1);
    await type('   ');
    assert.equal(send().disabled, true, 'whitespace alone is not sendable');
    assert.equal(count('SendButton'), typing.send + 1);
    await type('   x');
    assert.equal(send().disabled, false);
    assert.equal(count('SendButton'), typing.send + 2);
    assert.deepEqual(snapshot().controls, settled.controls);
  } finally {
    await view.unmount();
  }
});

test('submitting shows the pending state on the send disc, clears the draft, and history recall brings the prompt back', async () => {
  const view = await mountDraftComposer('render-count-submit');
  const { input, send } = view;
  const sendLabel = () => send().getAttribute('aria-label');
  try {
    await view.type('send me');
    await act(async () => {
      document
        .querySelector('form.composer')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(view.submitted.length, 1);
    assert.equal(sendLabel(), 'Sending message');
    assert.equal(input.value, '', 'a sent draft clears');
    assert.equal(send().disabled, true);
    await act(async () => view.finishSubmit());
    assert.equal(sendLabel(), 'Send message');

    await act(async () => {
      input.focus();
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    assert.equal(input.value, 'send me', 'the newest prompt comes back first');
    assert.equal(send().disabled, false);
  } finally {
    await view.unmount();
  }
});

test('a model change still reaches the model controls and the model line', async () => {
  const view = await mountDraftComposer('render-count-model');
  try {
    const before = view.snapshot();
    await act(async () => view.root.render(React.createElement(Composer, { ...view.baseProps, model: 'other-model' })));
    assert.ok(count('ComposerModelControls') > before.controls[1], 'model controls render for a model change');
    assert.ok(count('ComposerModelLine') > before.controls[2], 'model line renders for a model change');
  } finally {
    await view.unmount();
  }
});

test('the send disc enables on sendable content and yields to stop, voice send and dictation', async () => {
  const root = createRoot(document.querySelector('main'));
  const base = {
    stopOnly: false,
    voiceSend: false,
    submitting: false,
    transitioning: false,
    hasConversation: true,
    dictationState: 'idle',
    sendable: false,
    onStop() {},
    onStopDictationAndSend() {},
  };
  const disabled = async (overrides) => {
    await act(async () => root.render(React.createElement(SendButton, { ...base, ...overrides })));
    return document.querySelector('.send-button').disabled;
  };
  try {
    assert.equal(await disabled({}), true);
    assert.equal(await disabled({ sendable: true }), false);
    assert.equal(await disabled({ sendable: true, transitioning: true }), true);
    assert.equal(await disabled({ sendable: true, dictationState: 'recording' }), true);
    assert.equal(await disabled({ stopOnly: true }), false, 'stop works without content');
    assert.equal(await disabled({ voiceSend: true, dictationState: 'recording' }), false, 'voice send works mid-take');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the mounted composer derives send enablement from attachments and queued visualize feedback', async () => {
  window.mixdogDesktop = capabilities();
  const id = 'derive-send';
  const mounted = mountComposer();
  const png = (name) => new File(['png'], name, { type: 'image/png' });
  const pasteFile = async (file) => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    const items = [{ kind: 'file', type: file.type, getAsFile: () => file }];
    Object.defineProperty(event, 'clipboardData', {
      value: { items, files: [file], types: [file.type], getData: () => '' },
    });
    await act(async () => field().dispatchEvent(event));
    await settle();
  };
  try {
    await mounted.render(React.createElement(Composer, composerProps(id)));
    assert.equal(sendButton().disabled, true, 'nothing to send');

    await pasteFile(png('shot.png'));
    assert.equal(document.querySelectorAll('.composer-attachments img').length, 1);
    assert.equal(field().value, '');
    assert.equal(sendButton().disabled, false, 'an attachment alone is sendable');
    await click(document.querySelector('.attachment-card-remove'));
    assert.equal(document.querySelectorAll('.composer-attachments img').length, 0);
    assert.equal(sendButton().disabled, true, 'removing the attachment disables send again');

    const choice = { tabId: 't', tabLabel: 'Mock', pane: 0, file: 'a.html', group: 'g', choice: 'one', label: 'One' };
    await act(async () => void setVisualizeChoice(id, choice, true));
    assert.equal(sendButton().disabled, false, 'queued visualize feedback is sendable without text');
    await act(async () => clearVisualizeChoices(id));
    assert.equal(sendButton().disabled, true);
  } finally {
    clearVisualizeChoices(id);
    await mounted.cleanup();
  }
});

test('a restored draft reaches the editor and the send disc: handoff restore, then a saved draft after a tab switch', async () => {
  window.mixdogDesktop = capabilities();
  const handoff = { current: null };
  const steer = { actions: { sendNow() {}, cancel() {}, retry() {} }, draft: handoff };
  const mounted = mountComposer();
  const render = (id) =>
    mounted.render(
      React.createElement(SteerContext.Provider, { value: steer }, React.createElement(Composer, composerProps(id)))
    );
  const restore = async (value, options) => {
    let accepted;
    await act(async () => {
      accepted = handoff.current.restore(value, options);
    });
    return accepted;
  };
  try {
    await render('restore-a');
    assert.ok(handoff.current, 'the composer registers its draft handoff');
    assert.equal(sendButton().disabled, true);

    // A message taken back from the transcript returns to the empty editor.
    assert.equal(await restore({ text: 'taken back' }, { ifEmpty: true }), true);
    assert.equal(field().value, 'taken back');
    assert.equal(sendButton().disabled, false);
    // `ifEmpty` leaves a draft in use alone; plain restore goes before it.
    assert.equal(await restore({ text: 'again' }, { ifEmpty: true }), false);
    assert.equal(field().value, 'taken back');
    assert.equal(await restore({ text: 'first' }), true);
    assert.equal(field().value, 'first\ntaken back');
    // `replace` edits a previous message in place of the whole draft.
    assert.equal(await restore({ text: 'edited' }, { replace: true }), true);
    assert.equal(field().value, 'edited');
    assert.equal(sendButton().disabled, false);

    // A tab switch parks the draft; coming back restores it and the disc.
    await render('restore-b');
    assert.equal(field().value, '');
    assert.equal(sendButton().disabled, true);
    await render('restore-a');
    assert.equal(field().value, 'edited');
    assert.equal(sendButton().disabled, false);

    // Replacing with an empty message empties the disc again.
    assert.equal(await restore({ text: '' }, { replace: true }), true);
    assert.equal(sendButton().disabled, true);
  } finally {
    await mounted.cleanup();
  }
});

test('stop and the + menu run the latest props after the parent passes new handlers', async () => {
  window.mixdogDesktop = capabilities();
  const id = 'latest-handlers';
  const aborted = [];
  const opened = [];
  const handlers = (tag) => ({
    abort: async (options) => void aborted.push([tag, options]),
    onOpenSettings: (section) => opened.push([tag, section]),
  });
  const mounted = mountComposer();
  const render = (tag) =>
    mounted.render(React.createElement(Composer, composerProps(id, { turnBusy: true, ...handlers(tag) })));
  const openMore = async () => {
    await click(document.querySelector('button[aria-label="Add to message"]'));
    const more = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
      item.textContent.includes('Manage skills')
    );
    await click(more);
  };
  try {
    await render('first');
    assert.equal(sendButton().getAttribute('aria-label'), 'Stop generation', 'a busy turn with no draft stops');
    assert.equal(sendButton().disabled, false);
    await click(sendButton());
    assert.deepEqual(aborted, [['first', { restorePrompt: false }]]);
    await openMore();
    assert.deepEqual(opened, [['first', 'skills']]);

    await render('second');
    await click(sendButton());
    assert.deepEqual(
      aborted.map(([tag]) => tag),
      ['first', 'second'],
      'the stable stop callback reaches the new abort handler'
    );
    await openMore();
    assert.deepEqual(
      opened.map(([tag]) => tag),
      ['first', 'second'],
      'the memoized + menu reaches the new settings handler'
    );
  } finally {
    await mounted.cleanup();
  }
});

test('the send disc ends a live dictation take and sends the transcript', async () => {
  window.mixdogDesktop = capabilities(true);
  const track = { muted: false, stop() {}, addEventListener() {}, removeEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let resolveMic;
  const recorders = [];
  globalThis.MediaRecorder = class {
    static isTypeSupported() {
      return true;
    }
    mimeType = 'audio/webm;codecs=opus';
    state = 'inactive';
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
      this.ondataavailable({ data: new Blob(['first words']) });
    }
    stop() {
      this.state = 'inactive';
      this.onstop();
    }
  };
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: () => new Promise((resolve) => (resolveMic = resolve)) },
  });
  const submitted = [];
  const mounted = mountComposer();
  try {
    await mounted.render(
      React.createElement(
        Composer,
        composerProps('voice-send', {
          submit: async (content) => {
            submitted.push(content);
            return true;
          },
        })
      )
    );
    await settle();
    assert.equal(sendButton().disabled, true);
    await click(document.querySelector('.composer-mic'));
    await act(async () => resolveMic(stream));
    await act(async () => {
      recorders[0].onstart();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    assert.equal(sendButton().getAttribute('aria-label'), 'Stop dictation and send');
    assert.equal(sendButton().disabled, false, 'a live take can be sent even with an empty draft');
    assert.equal(sendButton().type, 'button');

    await click(sendButton());
    await settle(60);
    assert.equal(submitted.length, 1, 'the transcript was sent');
    assert.match(JSON.stringify(submitted[0]), /first words/);
    assert.equal(sendButton().getAttribute('aria-label'), 'Send message');
  } finally {
    await mounted.cleanup();
    delete globalThis.MediaRecorder;
  }
});
