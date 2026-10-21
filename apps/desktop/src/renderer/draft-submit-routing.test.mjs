import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator'],
});

const { useAppSubmitRouting } = await import('./use-app-submit-routing.ts');

const DRAFT = { kind: 'new', draftId: 'd1' };

const NO_PICK = { modelSelection: null };

function mountRouting(desktop, modelPrefs = NO_PICK) {
  window.mixdogDesktop = desktop;
  let routing = null;
  function Harness() {
    const selectionRef = useRef(DRAFT);
    const focusedLeafIdRef = useRef('leaf-1');
    const paneLeavesRef = useRef([{ type: 'leaf', id: 'leaf-1', tabs: [DRAFT], activeKey: 'new:d1' }]);
    const navigationEpoch = useRef(0);
    routing = useAppSubmitRouting({
      selectionRef,
      focusedLeafIdRef,
      paneLeavesRef,
      navigationEpoch,
      resolvedDraftPrefsFor: () => ({
        projectPath: '',
        ...modelPrefs,
        workflow: null,
        orchestrationMode: undefined,
      }),
      effectiveDraftProjectPath: (candidate) => String(candidate || ''),
      clearNewTaskPreferences: () => {},
      setNewTaskDeferred: () => {},
      stageCreatedSession: () => {},
      activateSelection: () => {},
      promoteSelectionInLeaf: () => {},
      registerWorkspaceSelection: () => {},
      applySessionLaneResult: () => {},
    });
    return null;
  }
  const container = document.createElement('main');
  document.body.append(container);
  const root = createRoot(container);
  return {
    render: () => act(async () => root.render(React.createElement(Harness, null))),
    submitDraft: (text) => routing.paneDraftSubmitFor(DRAFT, 'leaf-1')(text, { id: `submit-${text}` }),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('a prompt sent before the draft promotes joins the session it is minting', async () => {
  let releaseCreation = () => {};
  const creation = new Promise((resolve) => {
    releaseCreation = resolve;
  });
  const calls = { creations: 0, submits: [] };
  const mounted = mountRouting({
    async submitNewTask() {
      calls.creations += 1;
      await creation;
      return { accepted: true, sessionId: 's1', snapshot: { sessionId: 's1' } };
    },
    async submitToSession(sessionId, content) {
      calls.submits.push([sessionId, content]);
      return true;
    },
  });
  try {
    await mounted.render();
    const first = mounted.submitDraft('first prompt');
    const second = mounted.submitDraft('second prompt');
    releaseCreation();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(calls.creations, 1, 'the draft minted exactly one session');
    assert.deepEqual(calls.submits, [['s1', 'second prompt']]);

    // A late prompt still addressed to the draft route lands in that session.
    assert.equal(await mounted.submitDraft('third prompt'), true);
    assert.equal(calls.creations, 1);
    assert.deepEqual(calls.submits.at(-1), ['s1', 'third prompt']);
  } finally {
    await mounted.cleanup();
  }
});

// Issue #149: a New task wrote its draft's selection over the Main (Lead)
// route, so a model/effort the draft merely inherited (a cache from before the
// Lead was edited) replaced the Lead's saved choice.
test('a New task sends a route only for a model the user picked in that draft', async () => {
  const inherited = { provider: 'anthropic-oauth', model: 'claude-opus-5-5', effort: 'high' };
  const submitted = async (modelPrefs) => {
    const drafts = [];
    const mounted = mountRouting(
      {
        async submitNewTask(_prompt, _options, draft) {
          drafts.push(draft);
          return { accepted: true, sessionId: 's3', snapshot: { sessionId: 's3' } };
        },
        async submitToSession() {
          return true;
        },
      },
      modelPrefs
    );
    try {
      await mounted.render();
      await mounted.submitDraft('go');
    } finally {
      await mounted.cleanup();
    }
    return drafts[0];
  };

  const unpicked = await submitted({ modelSelection: inherited, explicitModelSelection: null });
  assert.equal(Object.hasOwn(unpicked, 'route'), false, 'an inherited selection is not sent as the Lead route');

  const picked = await submitted({ modelSelection: inherited, explicitModelSelection: inherited });
  assert.deepEqual(picked.route, inherited, 'an explicit pick in the draft is the route');
});

test('a draft whose creation failed still mints its session on retry', async () => {
  const calls = { creations: 0 };
  const mounted = mountRouting({
    async submitNewTask() {
      calls.creations += 1;
      if (calls.creations === 1) throw new Error('transport closed');
      return { accepted: true, sessionId: 's2', snapshot: { sessionId: 's2' } };
    },
    async submitToSession() {
      return true;
    },
  });
  try {
    await mounted.render();
    await assert.rejects(mounted.submitDraft('first prompt'), /transport closed/);
    assert.equal(await mounted.submitDraft('retry prompt'), true);
    assert.equal(calls.creations, 2);
  } finally {
    await mounted.cleanup();
  }
});
