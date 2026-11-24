import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const MODEL = {
  provider: 'openai',
  model: 'gpt-draft-restart',
  display: 'Draft restart model',
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
const DRAFTS_KEY = 'mixdog.composer-drafts';

// The reported case: "000", parked under a New Task that became a session and under the scope a session pane
// held until its lane was read, turned up in a long-running session's composer after every restart.
test('parked text reaches only its own conversation, and is stored nowhere once sent or once its draft became a session', async (t) => {
  const { window, document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'localStorage'],
  });
  // What the user's profile held at launch.
  const stale = [
    ['draft:mwjj46yi-ym2rjo', '000'],
    ['new-task', '000'],
  ];
  window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(stale));
  const stored = () => JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? '[]');
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
  // React's input-event fallback for an engine without `input` events, which jsdom looks like to it.
  window.HTMLElement.prototype.attachEvent ??= noop;
  window.HTMLElement.prototype.detachEvent ??= noop;
  const { ConversationComposerDock } = await import('./conversation-pane-composer-dock.tsx');
  const { noteDraftPromotion } = await import('./composer-draft.ts');
  // The host holds the first prompt's acknowledgement while it mints the session.
  const acknowledged = Promise.withResolvers();
  const sent = Promise.withResolvers();
  const actionCache = new Map();
  const actionFor = (name) => {
    if (name === 'composerSubmit') {
      return () => {
        sent.resolve();
        return acknowledged.promise;
      };
    }
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
  const island = { wrapSubmit: (submit) => submit, approval: null, islandFlash: null, quotaCard: null, quotaResume: null };
  const submission = { goalSubmissionId: '', reviewItems: [], steerItems: [], pendingPromptIds: [], holdSlashCommand: noop, actions };
  /** The pane's composer dock showing a New Task (`draftId`) or a session, whose lane is read once `laneRead`. */
  const pane = ({ draftId = '', sessionId = '', laneRead = true }) => {
    const route = sessionId && laneRead ? { sessionId, ...ROUTE } : {};
    return React.createElement(ConversationComposerDock, {
      snapshot: route,
      routeSnapshot: route,
      sessionAddress: sessionId,
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
      draftModelSelection: draftId ? ROUTE : null,
      onDraftModelSelection: draftId ? noop : undefined,
      contextIndicator: null,
      usageReadout: null,
      goalIsland: null,
      onAddProject: noop,
      draftMode: Boolean(draftId),
      draftId,
      agentMode: false,
      reviewActive: true,
      dropTargetRef: { current: null },
      routeProject: route.sessionId ? 'C:/work/app' : '',
      island,
      submission,
      settledItems: [],
      openFile: noop,
      recoveryScope: 'pane-restart',
      hasConversation: Boolean(sessionId),
    });
  };
  const show = (selection) => act(async () => root.render(pane(selection)));
  const input = () => document.querySelector('textarea');
  const type = (text) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input(), text);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const hide = () => act(async () => window.dispatchEvent(new window.Event('pagehide')));

  // Launch: the long-running session's pane, focused, before and after its lane is read.
  await show({ sessionId: 'sess_long', laneRead: false });
  assert.equal(input().value, '', 'nothing parked under another conversation shows before the lane is read');
  await act(async () => input().focus());
  await show({ sessionId: 'sess_long' });
  assert.equal(input().value, '', 'nor once it is read');

  // A New Task in the same pane: "000" typed, parked by a hide, then sent as its first prompt.
  await show({ draftId: 'mx-new' });
  await type('000');
  await hide();
  assert.deepEqual(stored(), [...stale, ['draft:mx-new', '000']], 'a hide stores the unsent text');
  await act(async () => {
    document.querySelector('form.composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    // The composer empties itself before it hands the prompt to the host.
    await sent.promise;
  });
  assert.equal(input().value, '');
  assert.deepEqual(stored(), stale, 'sent: stored nowhere, before any hide');

  // Typed again while the first prompt is in flight and parked by another hide; then the draft becomes its session.
  await type('000');
  await hide();
  assert.deepEqual(stored(), [...stale, ['draft:mx-new', '000']]);
  noteDraftPromotion('mx-new', 'sess_from_draft');
  await act(async () => {
    acknowledged.resolve(true);
    // The composer awaits this acknowledgement first, so its send has finished when this await returns.
    await acknowledged.promise;
  });
  await show({ sessionId: 'sess_from_draft' });
  assert.deepEqual(stored(), stale, 'nothing stays parked under a draft that became a session');
  await hide();
  assert.deepEqual(stored(), [...stale, ['sess_from_draft', '000']], 'the text typed in flight went with the session');
});
