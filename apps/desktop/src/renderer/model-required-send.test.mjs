import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const used = { provider: 'anthropic-oauth', model: 'claude-opus-5' };

test('send with no model opens the picker, keeps the draft and does not submit', async () => {
  const { restore, document } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  });
  try {
    const { createRoot } = await import('react-dom/client');
    const { useComposerSubmission } = await import('./use-composer-submission.ts');
    const { OPEN_MODEL_PICKER_EVENT } = await import('./model-picker-event.ts');
    for (const [label, modelMissing, answered, expectSubmit] of [
      ['no model, picker answers', true, true, 0],
      ['model chosen', false, true, 1],
    ]) {
      const calls = { submit: 0, picker: 0, drafts: [] };
      const onPicker = (event) => {
        if (!answered) return;
        calls.picker += 1;
        event.preventDefault();
      };
      window.addEventListener(OPEN_MODEL_PICKER_EVENT, onPicker);
      let send;
      function Harness() {
        ({ send } = useComposerSubmission({
          turnBusy: false,
          commandBusy: false,
          recoveryScope: `scope-${label}`,
          textarea: { current: { value: 'my draft' } },
          draftRef: { current: 'my draft' },
          attachmentsRef: { current: [] },
          pendingLoads: { current: 0 },
          transitioningRef: { current: false },
          composingRef: { current: false },
          submittingRef: { current: false },
          submissionRetryRef: { current: null },
          mountedRef: { current: true },
          historyNavigation: { current: { index: -1, seed: '' } },
          setDraft: (update) => calls.drafts.push(update),
          setSubmitting() {},
          setSubmissionRecoveryVersion() {},
          clearNotice() {},
          setAttachmentError() {},
          removeAttachments() {},
          mergeRestoredAttachments: (_restored, text) => text,
          restoredAttachments: (_value, text) => ({ attachments: [], text }),
          executeSlash: async () => false,
          rememberPrompt() {},
          submit: async () => {
            calls.submit += 1;
            return { accepted: true };
          },
          abort: async () => ({}),
          modelMissing,
        }));
        return null;
      }
      const root = createRoot(document.getElementById('root'));
      await act(async () => root.render(React.createElement(Harness)));
      await act(async () => {
        await send('', 'form-submit');
      });
      assert.equal(calls.submit, expectSubmit, label);
      assert.equal(calls.picker, modelMissing ? 1 : 0, label);
      if (modelMissing) assert.deepEqual(calls.drafts, [], 'the draft is left untouched');
      window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onPicker);
      await act(async () => root.unmount());
    }
  } finally {
    restore();
  }
});

test('Lead: an empty route takes the last new-task model through one conditional write, never a read first', async () => {
  const { backfillLeadRoute } = await import('./draft-pane-prefs-store.ts');
  // The runtime answers with the route it ends on: the pick when it was empty,
  // the route it already had otherwise.
  const run = async (last, routeNow) => {
    const set = [];
    const applied = await backfillLeadRoute({
      last,
      setModelRoute: async (selection) => {
        set.push(selection);
        return routeNow.provider ? routeNow : { provider: selection.provider, model: selection.model };
      },
    });
    return { applied: applied.applied, set };
  };
  const last = { projectPath: null, workflow: null, modelSelection: used };
  assert.deepEqual(await run(last, {}), { applied: true, set: [{ ...used, onlyIfEmpty: true }] });
  // A route set meanwhile is answered back untouched: nothing applied.
  const fable = { provider: 'anthropic-oauth', model: 'claude-fable-5' };
  assert.deepEqual(await run(last, fable), { applied: false, set: [{ ...used, onlyIfEmpty: true }] });
  assert.deepEqual(await run(null, {}), { applied: false, set: [] });
  assert.deepEqual(await run({ ...last, modelSelection: null }, {}), { applied: false, set: [] });
});

test('bot: a prior chat model fills an empty bot route through one conditional write', async () => {
  const { backfillAgentChatRoute } = await import('./agent-chat-route.ts');
  const run = async (sessionId, skipped) => {
    const calls = [];
    const api = {
      invokeCapability: async (request) => {
        calls.push(request);
        return { value: skipped ? { skipped: true } : {} };
      },
    };
    const applied = await backfillAgentChatRoute(sessionId, used, api);
    return { applied, calls };
  };
  for (const sessionId of ['sess_home_helper', 'sess_home_lead']) {
    const agent = sessionId === 'sess_home_lead' ? 'lead' : 'helper';
    const filled = await run(sessionId, false);
    assert.equal(filled.applied, true);
    assert.deepEqual(filled.calls, [{ capability: 'setAgentRoute', args: [agent, { ...used, onlyIfEmpty: true }] }]);
    // A route the runtime already holds (set meanwhile or configured) is kept.
    const kept = await run(sessionId, true);
    assert.equal(kept.applied, false);
  }
});

test('Lead: a skipped backfill makes the unstaged cache follow the Lead route that won', async () => {
  const { backfillLeadRoute, followLeadRoute } = await import('./draft-pane-prefs-store.ts');
  const last = { projectPath: null, workflow: null, modelSelection: used };
  const winner = { provider: 'anthropic-oauth', model: 'claude-fable-5', effort: 'high' };
  const result = await backfillLeadRoute({ last, setModelRoute: async () => winner });
  assert.deepEqual(result, { applied: false, route: winner });
  // The cache still holding the tried model follows the Lead route: no window
  // or phone keeps showing (and submitting) the stale one.
  assert.deepEqual(followLeadRoute(last, used, winner), { ...last, modelSelection: winner });
  // Applied (the Lead route is the tried model), no route known, or something
  // staged since the backfill began: the cache stays as it is.
  const { resolveDraftPrefs } = await import('./draft-pane-prefs-store.ts');
  const resolve = (entry, cache) =>
    resolveDraftPrefs({
      entry,
      last: cache,
      seed: undefined,
      snapshotDraftModelSelection: null,
      preferredDraftProjectPath: '',
      effectiveDraftProjectPath: (path) => String(path || ''),
    }).modelSelection;
  const followed = followLeadRoute(last, used, winner);
  assert.deepEqual(resolve(undefined, followed), winner, 'a draft without an explicit pick shows the Lead route');
  const explicit = { projectPath: null, workflow: null, modelSelection: used };
  assert.deepEqual(resolve(explicit, followed), used, 'an explicit pick of the draft is kept');
  assert.equal(followLeadRoute(last, used, used), null);
  assert.equal(followLeadRoute(last, used, null), null);
  const staged = { ...last, modelSelection: { provider: 'openai', model: 'gpt-staged' } };
  assert.equal(followLeadRoute(staged, used, winner), null);
  assert.equal(followLeadRoute(null, used, winner), null);
});
