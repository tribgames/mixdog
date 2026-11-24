import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const MODEL = {
  provider: 'openai',
  model: 'gpt-held-submit',
  display: 'Held submit model',
  effortOptions: [{ value: 'high', label: 'High' }],
  fastCapable: false,
  fastEfforts: [],
  fastPreferred: false,
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
};
const ROUTE = { provider: MODEL.provider, model: MODEL.model, effort: 'high' };

// While a picked session's lane is still being read, the pane keeps presenting the outgoing session: every
// route-bound input of the composer (approval or question, route, room, recovery, restore) still names it, while the
// draft already belongs to the picked one.
async function mountHeldPane(t) {
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'localStorage'],
  });
  const noop = () => {};
  const capabilities = [];
  window.mixdogDesktop = {
    rendererDiagnostic: noop,
    listProviderModels: async () => [MODEL],
    sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
    invokeCapability: async (request) => {
      capabilities.push(request);
      return request.capability === 'getProviderSetup'
        ? { value: { api: [{ id: MODEL.provider, authenticated: true }] } }
        : { value: null };
    },
  };
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
  if (!globalThis.getComputedStyle) {
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    t.after(() => delete globalThis.getComputedStyle);
  }
  window.HTMLElement.prototype.scrollIntoView ??= noop;
  window.HTMLElement.prototype.attachEvent ??= noop;
  window.HTMLElement.prototype.detachEvent ??= noop;
  const { ConversationComposerDock } = await import('./conversation-pane-composer-dock.tsx');
  const submits = [];
  const actionCache = new Map();
  const actionFor = (name) => {
    if (name === 'composerSubmit') return async (content) => (submits.push({ content, sentVia: 'host' }), true);
    return name === 'composerInvokeResult' ? (action) => action() : noop;
  };
  const actions = new Proxy(
    {},
    {
      get: (_, name) => {
        if (!actionCache.has(name)) actionCache.set(name, actionFor(name));
        return actionCache.get(name);
      },
    }
  );
  const submission = { goalSubmissionId: '', reviewItems: [], steerItems: [], pendingPromptIds: [], holdSlashCommand: noop, actions };
  /** `held` is the session the pane still presents; `selected` the one it was pointed at. */
  const pane = ({ held, selected, promptRestore = null }) => {
    const route = { sessionId: held, promptRestore, ...ROUTE };
    // Stands for the approval/question wrapper, which answers the session its render presents.
    const island = {
      wrapSubmit: (submit) => (content, options) => {
        submits.push({ content, answers: held });
        return submit(content, options);
      },
      approval: null,
      islandFlash: null,
      quotaCard: null,
      quotaResume: null,
    };
    return React.createElement(ConversationComposerDock, {
      snapshot: route,
      routeSnapshot: route,
      sessionAddress: held,
      selectedSessionId: selected,
      transitioning: false,
      composerFocusRequest: 0,
      projects: [],
      showProjectSelector: false,
      activeProjectPath: 'C:/work/app',
      activeProjectLabel: 'app',
      onClearProject: noop,
      onSelectProject: noop,
      draftWorkflow: null,
      draftOrchestrationMode: null,
      draftModelSelection: null,
      contextIndicator: null,
      usageReadout: null,
      goalIsland: null,
      onAddProject: noop,
      draftMode: false,
      draftId: '',
      agentMode: false,
      reviewActive: true,
      dropTargetRef: { current: null },
      routeProject: 'C:/work/app',
      island,
      submission,
      settledItems: [],
      openFile: noop,
      recoveryScope: `pane-recovery:${held}`,
      hasConversation: true,
    });
  };
  const show = (selection) => act(async () => root.render(pane(selection)));
  const input = () => document.querySelector('textarea');
  const type = (text) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), text);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const press = () =>
    act(async () => {
      document.querySelector('form.composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  return { show, input, type, press, submits, capabilities };
}

test('a send made while the picked lane is held goes to the picked session once it lands, never to the outgoing one', async (t) => {
  const { show, input, type, press, submits } = await mountHeldPane(t);
  await show({ held: 'sess_a1', selected: 'sess_a1' });
  await show({ held: 'sess_a1', selected: 'sess_b1' });
  await type('for b');
  await press();
  assert.deepEqual(submits, [], 'nothing reaches the outgoing session (or its pending question)');
  assert.equal(input().value, 'for b', 'the message stays in the composer meanwhile');
  await show({ held: 'sess_b1', selected: 'sess_b1' });
  await act(async () => {});
  assert.equal(submits.length, 2, 'wrapped once, then handed to the host once');
  assert.ok(submits.every((entry) => entry.answers === undefined || entry.answers === 'sess_b1'));
  assert.equal(submits[0].answers, 'sess_b1', 'it ran through the picked session’s own question/approval state');
  assert.equal(input().value, '', 'and was sent');
});

test('a slash command typed while the picked lane is held runs against the picked session', async (t) => {
  const { show, type, press, capabilities } = await mountHeldPane(t);
  await show({ held: 'sess_a2', selected: 'sess_a2' });
  await show({ held: 'sess_a2', selected: 'sess_b2' });
  await type('/compact');
  await press();
  const commands = () => capabilities.filter((request) => request.capability === 'compact');
  assert.deepEqual(commands().filter((request) => JSON.stringify(request).includes('sess_a2')), [], 'not the outgoing one');
  assert.deepEqual(commands().filter((request) => JSON.stringify(request).includes('sess_b2')), [], 'and not yet');
  await show({ held: 'sess_b2', selected: 'sess_b2' });
  await act(async () => {});
  const ran = commands().filter((request) => JSON.stringify(request).includes('sess_b2'));
  assert.ok(ran.length > 0, 'it runs once the lane lands');
  assert.equal(commands().filter((request) => JSON.stringify(request).includes('sess_a2')).length, 0);
});

test('a send parked for a session the pane has left again is dropped, not sent to the next one', async (t) => {
  const { show, input, type, press, submits } = await mountHeldPane(t);
  await show({ held: 'sess_a3', selected: 'sess_a3' });
  await show({ held: 'sess_a3', selected: 'sess_b3' });
  await type('for b');
  await press();
  await show({ held: 'sess_a3', selected: 'sess_c3' });
  await show({ held: 'sess_c3', selected: 'sess_c3' });
  await act(async () => {});
  assert.deepEqual(submits, []);
  assert.equal(input().value, '');
});

test('a prompt handed back for the outgoing session while the lane is held waits in that session’s draft', async (t) => {
  const { show, input } = await mountHeldPane(t);
  const { nextComposerSubmissionId, stashedComposerDraft } = await import('./composer-draft.ts');
  const id = nextComposerSubmissionId();
  await show({ held: 'sess_a4', selected: 'sess_a4' });
  await show({ held: 'sess_a4', selected: 'sess_b4' });
  await show({
    held: 'sess_a4',
    selected: 'sess_b4',
    promptRestore: { id: 'restore-1', ids: [id], text: 'back for a', device: 'desktop', at: 1 },
  });
  assert.equal(input().value, '', 'the picked session’s draft is not written');
  assert.equal(stashedComposerDraft('sess_a4'), 'back for a', 'it waits with the session it belongs to');
});
