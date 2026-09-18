import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://mixdog.test/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: dom.window.navigator,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { useAppSubmitRouting } = await import('./use-app-submit-routing.ts');

const DRAFT = { kind: 'new', draftId: 'd1' };

function mountRouting(desktop) {
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
        modelSelection: null,
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
