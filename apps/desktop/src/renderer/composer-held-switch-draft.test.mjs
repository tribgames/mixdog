import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const MODEL = {
  provider: 'openai',
  model: 'gpt-held-switch',
  display: 'Held switch model',
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

// Opening a session keeps the outgoing session's composer on screen until the incoming lane is read, which can take
// seconds. Text typed in that wait enabled Send, then vanished (Send disabled again) when the lane landed.
test('text typed while the incoming lane is still loading survives the lane landing, and Send stays enabled', async (t) => {
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'localStorage'],
  });
  const noop = () => {};
  window.mixdogDesktop = {
    rendererDiagnostic: noop,
    listProviderModels: async () => [MODEL],
    sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
    invokeCapability: async (request) =>
      request.capability === 'getProviderSetup'
        ? { value: { api: [{ id: MODEL.provider, authenticated: true }] } }
        : { value: null },
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
  const actionCache = new Map();
  const actions = new Proxy(
    {},
    {
      get: (_, name) => {
        if (!actionCache.has(name)) actionCache.set(name, name === 'composerInvokeResult' ? (action) => action() : noop);
        return actionCache.get(name);
      },
    }
  );
  const island = { wrapSubmit: (submit) => submit, approval: null, islandFlash: null, quotaCard: null, quotaResume: null };
  const submission = { goalSubmissionId: '', reviewItems: [], steerItems: [], pendingPromptIds: [], holdSlashCommand: noop, actions };
  /** `held` is the session still presented; `selected` the one the pane was pointed at. */
  const pane = ({ held, selected }) => {
    const route = { sessionId: held, ...ROUTE };
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
      recoveryScope: 'pane-held-switch',
      hasConversation: true,
    });
  };
  const show = (selection) => act(async () => root.render(pane(selection)));
  const input = () => document.querySelector('textarea');
  const sendDisabled = () => document.querySelector('button.send-button').disabled;

  await show({ held: 'sess_a', selected: 'sess_a' });
  await show({ held: 'sess_a', selected: 'sess_b' });
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), '안녕하세요');
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(sendDisabled(), false, 'typing enables Send while the lane loads');

  await show({ held: 'sess_b', selected: 'sess_b' });
  assert.equal(input().value, '안녕하세요', 'the lane landing leaves the typed text alone');
  assert.equal(sendDisabled(), false, 'and Send stays enabled');
});
