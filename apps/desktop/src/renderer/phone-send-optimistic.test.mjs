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
    settledUsersRef: { current: 0 },
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
    const { takeRejectedComposerSubmissionRecoveries } = await import('./composer-draft.ts');
    for (const outcome of ['refused', 'thrown']) {
      const { useConversationComposerActions } = await import('./conversation-support.tsx');
      const errors = [];
      const drafts = [];
      const state = { send: null, prompts: [], versions: 0, actions: null };
      const submitHost = () =>
        outcome === 'refused' ? Promise.resolve(false) : Promise.reject(new Error('PC offline'));
      function Harness() {
        const [prompts, setPrompts] = useState([]);
        state.prompts = prompts;
        const actions = useConversationComposerActions({
          armFollowOnSubmitRef: { current: () => {} },
          composerActions: {
            current: { invokeResult: (action) => Promise.resolve().then(action), submit: submitHost },
          },
          draftModeRef: { current: false },
          goalSubmission: { current: null },
          goalSubmitScopeRef: { current: 'session:s1' },
          queuedBehindTurnAtSubmit: { current: false },
          routeSessionIdRef: { current: 's1' },
          setOptimisticPrompts: setPrompts,
          settledUsersRef: { current: 0 },
          suppressDraftSubmitPaintHandoff: { current: false },
        });
        const { send } = useComposerSubmission({
          turnBusy: false,
          commandBusy: false,
          recoveryScope: `scope-${outcome}`,
          textarea: { current: { value: 'keep this text' } },
          draftRef: { current: 'keep this text' },
          attachmentsRef: { current: [] },
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
      assert.equal(
        errors[0],
        outcome === 'refused' ? 'The message was not sent. It has been kept for retry.' : 'PC offline'
      );
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
