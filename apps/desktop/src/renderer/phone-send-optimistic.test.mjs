import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const ANDROID_PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

function installPhone() {
  return installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
    globals: { navigator: { userAgent: ANDROID_PHONE, platform: 'Linux armv8l', maxTouchPoints: 5 } },
  });
}

const deferred = () => {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

/** Mounts the pane's real composer-actions hook over stubbed host calls. */
async function mountActions(document, submit) {
  const { createRoot } = await import('react-dom/client');
  const { useConversationComposerActions } = await import('./conversation-support.tsx');
  const view = { actions: null, prompts: [], armed: 0 };
  const refs = {
    armFollowOnSubmitRef: {
      current: () => {
        view.armed += 1;
      },
    },
    composerActions: { current: { invokeResult: (action) => Promise.resolve().then(action), submit } },
    draftModeRef: { current: false },
    goalSubmission: { current: null },
    goalSubmitScopeRef: { current: 'session:s1' },
    queuedBehindTurnAtSubmit: { current: false },
    routeSessionIdRef: { current: 's1' },
    suppressDraftSubmitPaintHandoff: { current: false },
  };
  function Harness() {
    const [prompts, setPrompts] = useState([]);
    view.prompts = prompts;
    view.actions = useConversationComposerActions({ ...refs, setOptimisticPrompts: setPrompts });
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  return { view, unmount: () => act(async () => root.unmount()) };
}

test('phone send: the pending row shows before the host answers, then reconciles when it accepts', async () => {
  const { restore, document } = installPhone();
  try {
    const host = deferred();
    const { view, unmount } = await mountActions(document, () => host.promise);
    let sending;
    await act(async () => {
      sending = view.actions.composerSubmit('hello phone', { id: 'submit-1' });
    });
    assert.equal(view.prompts.length, 1, 'the optimistic row exists while the host has not answered');
    assert.equal(view.prompts[0].text, 'hello phone');
    assert.equal(view.prompts[0].pending, true);
    assert.equal(view.prompts[0].accepted, false);
    assert.equal(view.armed, 1, 'follow is armed with the row');
    await act(async () => {
      host.resolve(true);
      await sending;
    });
    assert.equal(view.prompts.length, 1);
    assert.equal(view.prompts[0].accepted, true, 'the PC confirmation reconciles the row');
    await unmount();
  } finally {
    restore();
  }
});

test('phone send: a refused or failed submit removes the row and keeps the text recoverable with an error', async () => {
  const { restore, document } = installPhone();
  try {
    const { createRoot } = await import('react-dom/client');
    const { useComposerSubmission } = await import('./use-composer-submission.ts');
    const { useAppInvocation } = await import('./app-root/use-app-invocation.ts');
    const { takeRejectedComposerSubmissionRecoveries } = await import('./composer-draft.ts');
    const { useConversationComposerActions } = await import('./conversation-support.tsx');
    const stale = 'This conversation changed on another device. Review the latest messages, then send again.';
    const expectedError = {
      refused: 'The message was not sent. It has been kept for retry.',
      thrown: 'PC offline',
      stale,
    };
    for (const outcome of ['refused', 'thrown', 'stale']) {
      const errors = [];
      const drafts = [];
      const state = { send: null, prompts: [], versions: 0, actions: null };
      const submitHost = () =>
        outcome === 'refused'
          ? Promise.resolve(false)
          : Promise.reject(new Error(outcome === 'stale' ? stale : 'PC offline'));
      function Harness() {
        const [prompts, setPrompts] = useState([]);
        const { invokeResult } = useAppInvocation({
          error: '',
          connected: true,
          setError: (message) => {
            if (message) errors.push(message);
          },
        });
        state.prompts = prompts;
        const actions = useConversationComposerActions({
          armFollowOnSubmitRef: { current: () => {} },
          composerActions: {
            current: { invokeResult, submit: submitHost },
          },
          draftModeRef: { current: false },
          goalSubmission: { current: null },
          goalSubmitScopeRef: { current: 'session:s1' },
          queuedBehindTurnAtSubmit: { current: false },
          routeSessionIdRef: { current: 's1' },
          setOptimisticPrompts: setPrompts,
          suppressDraftSubmitPaintHandoff: { current: false },
        });
        const { send } = useComposerSubmission({
          turnBusy: false,
          commandBusy: false,
          recoveryScope: `scope-${outcome}`,
          textarea: { current: { value: 'keep this text' } },
          draftRef: { current: 'keep this text' },
          attachmentsRef: { current: [] },
          pendingLoads: { current: 0 },
          transitioningRef: { current: false },
          composingRef: { current: false },
          submittingRef: { current: false },
          submissionRetryRef: { current: null },
          mountedRef: { current: true },
          historyNavigation: { current: { index: -1, seed: '' } },
          setDraft: (update) => drafts.push(typeof update === 'function' ? update('keep this text') : update),
          setSubmitting() {},
          setSubmissionRecoveryVersion: () => {
            state.versions += 1;
          },
          clearNotice() {},
          setAttachmentError: (message) => {
            if (message) errors.push(message);
          },
          removeAttachments() {},
          mergeRestoredAttachments: (_restored, text) => text,
          restoredAttachments: (_value, text) => ({ attachments: [], text }),
          executeSlash: async () => false,
          rememberPrompt() {},
          submit: actions.composerSubmit,
          abort: async () => ({}),
        });
        state.send = send;
        return null;
      }
      const root = createRoot(document.getElementById('root'));
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => {
        await state.send('', 'form-submit');
      });
      assert.deepEqual(drafts, [''], `${outcome}: the composer cleared on the tap`);
      assert.equal(state.prompts.length, 0, `${outcome}: the optimistic row is withdrawn`);
      assert.equal(state.versions, 1, `${outcome}: the composer is told to restore`);
      assert.equal(errors.length, 1, `${outcome}: the failure is surfaced as an error`);
      assert.equal(errors[0], expectedError[outcome]);
      const recovered = takeRejectedComposerSubmissionRecoveries(`scope-${outcome}`);
      assert.deepEqual(
        recovered.map((entry) => entry.text),
        ['keep this text'],
        `${outcome}: the typed text comes back`
      );
      await act(async () => root.unmount());
    }
  } finally {
    restore();
  }
});

async function keyCapture({ shellHeight } = {}) {
  const { conversationKeyDownCapture } = await import('./conversation-support.tsx');
  const log = [];
  const element = {
    clientHeight: 1000,
    scrollHeight: 5000,
    parentElement: shellHeight === undefined ? null : { clientHeight: shellHeight },
    scrollBy: (options) => log.push(['scrollBy', options.top]),
    scrollTo: (options) => log.push(['scrollTo', options.top]),
  };
  const composer = { focus: (options) => log.push(['focus', options.preventScroll]) };
  const press = (key, { inField = false, paletteOpen = false, ctrlKey = false, readOnly = false } = {}) =>
    conversationKeyDownCapture(
      {
        key,
        ctrlKey,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target: { closest: (selector) => (inField && selector.includes('textarea') ? {} : null) },
        currentTarget: {
          querySelector: (selector) => (selector.includes('composer-input-row') ? composer : paletteOpen ? {} : null),
        },
        preventDefault: () => log.push(['preventDefault']),
      },
      {
        readOnly,
        viewport: { current: element },
        onTranscriptKey: ({ key: paged }) => log.push(['transcriptKey', paged]),
      }
    );
  return { log, press };
}

test('key capture: paging keys scroll the transcript unless a field, a palette or a modifier owns them', async () => {
  const { log, press } = await keyCapture();
  press('PageDown');
  press('PageUp');
  press('End');
  press('Home');
  assert.deepEqual(log, [
    ['preventDefault'],
    ['transcriptKey', 'PageDown'],
    ['scrollBy', 900],
    ['preventDefault'],
    ['transcriptKey', 'PageUp'],
    ['scrollBy', -900],
    ['preventDefault'],
    ['transcriptKey', 'End'],
    ['scrollTo', 5000],
    ['preventDefault'],
    ['transcriptKey', 'Home'],
    ['scrollTo', 0],
  ]);
  log.length = 0;
  press('Home', { inField: true });
  press('PageDown', { paletteOpen: true });
  press('PageDown', { ctrlKey: true });
  press('PageDown', { readOnly: true });
  assert.deepEqual(log, []);
});

test('key capture: a page is the part of the transcript shown above the composer dock', async () => {
  const { log, press } = await keyCapture({ shellHeight: 700 });
  press('PageDown');
  press('PageUp');
  assert.deepEqual(
    log.filter(([kind]) => kind === 'scrollBy'),
    [
      ['scrollBy', 630],
      ['scrollBy', -630],
    ]
  );
});

test('key capture: a printable or IME key pressed outside a field refocuses the composer', async () => {
  const { log, press } = await keyCapture();
  press('a');
  press('Process');
  assert.deepEqual(log, [
    ['focus', true],
    ['focus', true],
  ]);
  log.length = 0;
  press('a', { inField: true });
  press('a', { ctrlKey: true });
  press('Shift');
  assert.deepEqual(log, []);
});
