import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { sessionRailSlot } from './session-rail-layout.ts';

// The session panel beside the conversation its pane shows: on the first
// panel, through a pane's hand-over between two conversations, and as a New
// Task's picks change. The first test needs the panel's module not yet loaded:
// it runs first in this file's process.

const MODEL = {
  provider: 'openai',
  model: 'gpt-rail-draft',
  display: 'Rail draft model',
  effortOptions: [
    { value: 'high', label: 'High' },
    { value: 'low', label: 'Low' },
  ],
  fastCapable: false,
  fastEfforts: [],
  fastPreferred: false,
  modelParameterOptions: [],
  parameterVariants: [],
  defaultModelParameters: {},
  savedModelParameters: {},
};
const PROJECTS = [
  { path: 'C:/work/app', name: 'app' },
  { path: 'C:/work/other', name: 'other' },
];
const branch = (name, current = false) => ({ name, current, remote: false, upstream: '' });
const PROJECT_MENU = {
  workspace: {
    projectPath: 'C:/work/app',
    repoCommonDir: 'C:/work/app/.git',
    cwd: 'C:/work/app',
    worktreeId: null,
    branch: 'main',
    baseCommit: null,
    mergeTarget: 'main',
    revision: 0,
    transition: { state: 'idle', txId: null },
  },
  branches: [branch('main', true), branch('dev')],
  occupancy: [
    { branch: 'main', kind: 'current' },
    { branch: 'dev', kind: 'free' },
  ],
  retainedWorktree: null,
};

async function setup(t) {
  const { document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver'],
  });
  const noop = () => {};
  window.mixdogDesktop = {
    rendererDiagnostic: noop,
    listProviderModels: async () => [MODEL],
    sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
    invokeCapability: async (request) => {
      if (request.capability === 'getProviderSetup') return { value: { api: [{ id: 'openai', authenticated: true }] } };
      if (request.capability === 'getProjectBranchMenu') return { value: PROJECT_MENU };
      return { value: null };
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
  // React's input-event fallback for an engine without `input` events, which jsdom looks like to it.
  window.HTMLElement.prototype.attachEvent ??= noop;
  window.HTMLElement.prototype.detachEvent ??= noop;
  const { ConversationComposerDock } = await import('./conversation-pane-composer-dock.tsx');
  const { SessionRailCard } = await import('./SessionRailCard.tsx');
  const { storeWorkflowOptions } = await import('./workflow-options-cache.ts');
  const { clearBranchMenuCache } = await import('./branch-menu.tsx');
  clearBranchMenuCache();
  storeWorkflowOptions([
    { value: 'default', label: 'Default', active: true },
    { value: 'review', label: 'Review', active: false },
  ]);
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
  /** The pane's conversation as the app draws it below the transcript: its composer dock. `label` names its project. */
  const conversation = (selection, leafId, overrides = {}) => {
    const draft = selection.kind === 'new';
    const snapshot = draft ? {} : { sessionId: selection.id, provider: MODEL.provider, model: MODEL.model, effort: 'high' };
    return React.createElement(ConversationComposerDock, {
      snapshot,
      routeSnapshot: snapshot,
      sessionAddress: draft ? '' : selection.id,
      transitioning: false,
      composerFocusRequest: 0,
      projects: PROJECTS,
      showProjectSelector: draft,
      activeProjectPath: 'C:/work/app',
      activeProjectLabel: draft ? `draft ${selection.draftId}` : `session ${selection.id}`,
      onClearProject: noop,
      onSelectProject: noop,
      draftWorkflow: null,
      onDraftWorkflow: draft ? noop : undefined,
      draftOrchestrationMode: draft ? 'none' : null,
      onDraftOrchestrationMode: draft ? noop : undefined,
      draftModelSelection: draft ? { provider: MODEL.provider, model: MODEL.model, effort: 'high' } : null,
      onDraftModelSelection: draft ? noop : undefined,
      contextIndicator: null,
      usageReadout: null,
      goalIsland: null,
      onAddProject: noop,
      paneLeafId: leafId,
      draftMode: draft,
      draftId: draft ? selection.draftId : '',
      agentMode: false,
      reviewActive: true,
      dropTargetRef: { current: null },
      routeProject: 'C:/work/app',
      island,
      submission,
      settledItems: [],
      openFile: noop,
      recoveryScope: `${leafId}:${draft ? selection.draftId : selection.id}`,
      hasConversation: !draft,
      ...overrides,
    });
  };
  const card = (leafId, selection) =>
    React.createElement(SessionRailCard, {
      leafId,
      sessionId: selection.kind === 'session' ? selection.id : '',
      draftId: selection.kind === 'new' ? selection.draftId : '',
      width: 400,
      reserve: 0,
    });
  const settle = () =>
    act(async () => {
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { document, root, conversation, card, settle };
}

/** What a panel body holds: its Info's Project text (a draft's project select, or a session's row when it cannot be
 *  moved), '' while it has no rows. */
const panelProject = (body) =>
  body.querySelector(
    '[data-category="info"] :is(.session-rail-select .mx-select-value, .session-rail-row[title="Project"] .session-rail-cut)'
  )?.textContent ?? '';
/** A composer's own controls: the New Task context bar and the model controls (the pill once the models are listed). */
const controls = (composer) => ({
  contextBar: Boolean(composer.querySelector('.composer-project-context')),
  modelControls: Boolean(composer.querySelector('.composer-model-line-controls, .model-trigger')),
});

test('the first panel: the composer keeps its controls until the panel draws its rows, and never paints without either', async (t) => {
  const view = await setup(t);
  const panes = [
    { leafId: 'cold-draft', selection: { kind: 'new', draftId: 'd-cold' } },
    { leafId: 'cold-session', selection: { kind: 'session', id: 's-cold' } },
  ];
  const cell = (leafId) => view.document.querySelector(`[data-leaf="${leafId}"]`);
  const body = (leafId) => cell(leafId).querySelector('.session-rail-body');
  const composer = (leafId) => cell(leafId).querySelector('[data-conversation]');
  const lapses = [];
  const check = (when) => {
    for (const { leafId, selection } of panes) {
      if (!cell(leafId)) continue;
      const shown = controls(composer(leafId));
      const own = selection.kind === 'new' ? shown.contextBar && shown.modelControls : shown.modelControls;
      if (!own && !panelProject(body(leafId))) lapses.push(`${leafId} ${when}`);
    }
  };
  // Every DOM change React commits is seen in one batch: a frame could paint any of them.
  const observer = new MutationObserver(() => check('in a commit'));
  observer.observe(view.document.body, { childList: true, subtree: true, attributes: true });
  t.after(() => observer.disconnect());
  act(() =>
    view.root.render(
      React.createElement(
        React.Fragment,
        null,
        ...panes.map(({ leafId, selection }) =>
          React.createElement(
            'div',
            { key: leafId, 'data-leaf': leafId },
            view.card(leafId, selection),
            React.createElement('div', { 'data-conversation': '' }, view.conversation(selection, leafId))
          )
        )
      )
    )
  );
  // The panel's module has not arrived: the panel is empty and each composer keeps what it would take.
  assert.equal(panelProject(body('cold-draft')), '');
  assert.deepEqual(controls(composer('cold-draft')), { contextBar: true, modelControls: true }, "the draft's pickers and pill");
  assert.equal(controls(composer('cold-session')).modelControls, true, "the session's model pill");
  check('before the panel loads');
  await import('./SessionRail.tsx');
  await view.settle();
  assert.equal(panelProject(body('cold-draft')), 'draft d-cold', "the draft's rows");
  assert.equal(panelProject(body('cold-session')), 'session s-cold', "the session's rows");
  assert.deepEqual(controls(composer('cold-draft')), { contextBar: false, modelControls: false }, 'then the composer is bare');
  assert.deepEqual(controls(composer('cold-session')), { contextBar: false, modelControls: false });
  check('after the panel loads');
  assert.deepEqual(lapses, [], 'no frame without the controls in either the composer or the panel');
  await act(async () => view.root.render(null));
});

/** One pane of the real workspace with its panel, each conversation answering for when it can be shown. */
async function handOverPane(t) {
  const view = await setup(t);
  await import('./SessionRail.tsx');
  const { flushSync } = await import('react-dom');
  const { PaneWorkspace } = await import('./PaneWorkspace.tsx');
  const { createPaneLeaf } = await import('./pane-layout.ts');
  const { usePanePresentation } = await import('./pane-presentation.ts');
  const { navigationKey } = await import('./text-format.ts');
  const presentations = new Map();
  function Conversation({ selection, leafId }) {
    // Heard: the conversation calls ready itself, here when the test says its rows have landed.
    presentations.set(navigationKey(selection), usePanePresentation());
    return React.createElement('div', { 'data-conv': navigationKey(selection) }, view.conversation(selection, leafId));
  }
  const noop = () => {};
  const tabs = [
    { kind: 'new', draftId: 'd-hand' },
    { kind: 'session', id: 's-a' },
    { kind: 'session', id: 's-b' },
  ];
  const render = (active) => {
    const leaf = { ...createPaneLeaf(active, 'pane-h'), tabs };
    return view.root.render(
      React.createElement(PaneWorkspace, {
        workspace: {
          layout: leaf,
          leaves: [leaf],
          restoredFromStorage: true,
          restorePending: false,
          focusedLeaf: leaf,
          focusedLeafId: leaf.id,
          focusLeaf: noop,
          activateTab: noop,
          setRatio: noop,
        },
        renderActive: () => null,
        renderSideDock: (shown) => view.card(shown.id, active),
        renderConversation: (selection, _focused, _focusPane, leafId) =>
          React.createElement(Conversation, { selection, leafId }),
        onFocusSelection: noop,
      })
    );
  };
  const body = () => view.document.querySelector('.session-rail-body');
  const composer = (selection) => view.document.querySelector(`[data-conv="${navigationKey(selection)}"]`);
  const preparing = () => view.document.querySelectorAll('.persistent-pane-surface[data-preparing]').length;
  /** The pane shows `selection`, with its panel. */
  const show = async (selection) => {
    await act(async () => render(selection));
    await view.settle();
    presentations.get(navigationKey(selection))?.ready();
    await view.settle();
  };
  /** Switches to `selection`; `during` sees each commit until its conversation says it can be shown, then that
   *  commit is returned as painted. */
  const switchTo = async (selection, during) => {
    await act(async () => {
      flushSync(() => render(selection));
      during('the commit of the switch');
    });
    await view.settle();
    during('while the conversation switched to prepares');
    let handed;
    await act(async () => {
      flushSync(() => presentations.get(navigationKey(selection)).ready());
      handed = { preparing: preparing(), project: panelProject(body()), composer: controls(composer(selection)) };
    });
    await view.settle();
    return handed;
  };
  return { ...view, body, composer, preparing, show, switchTo, tabs };
}

for (const [name, fromIndex, toIndex] of [
  ['draft to session', 0, 1],
  ['session to session', 1, 2],
  ['session to draft', 2, 0],
]) {
  test(`a hand-over ${name}: the panel keeps the conversation the pane shows until the pane changes, then both change together`, async (t) => {
    const pane = await handOverPane(t);
    const from = pane.tabs[fromIndex];
    const to = pane.tabs[toIndex];
    const label = (selection) => (selection.kind === 'new' ? `draft ${selection.draftId}` : `session ${selection.id}`);
    await pane.show(from);
    assert.equal(pane.preparing(), 0);
    assert.equal(panelProject(pane.body()), label(from));
    const before = controls(pane.composer(from));
    assert.deepEqual(before, { contextBar: false, modelControls: false }, 'the shown composer is bare beside its panel');
    const handed = await pane.switchTo(to, (when) => {
      const slot = sessionRailSlot('pane-h');
      assert.deepEqual(
        [slot.sessionId, slot.draftId],
        to.kind === 'new' ? ['', to.draftId] : [to.id, ''],
        `${when}: the tab in front is already ${label(to)}`
      );
      assert.equal(pane.preparing(), 1, `${when}: the pane still shows ${label(from)}`);
      assert.equal(panelProject(pane.body()), label(from), `${when}: the panel too`);
      assert.equal(pane.body().querySelectorAll('[data-category="info"]').length, 1, `${when}: one Info`);
      assert.deepEqual(controls(pane.composer(from)), before, `${when}: the shown composer neither gains nor loses controls`);
    });
    assert.deepEqual(
      handed,
      { preparing: 0, project: label(to), composer: { contextBar: false, modelControls: false } },
      'the commit that hands the pane over hands the panel over, its composer bare from its first frame'
    );
    await act(async () => pane.root.render(null));
  });
}

test("a New Task's panel rows follow each pick: project, branch, model, workflow and delegation", async (t) => {
  const view = await setup(t);
  await import('./SessionRail.tsx');
  const selection = { kind: 'new', draftId: 'd-follow' };
  function DraftPane() {
    const [project, setProject] = useState(PROJECTS[0]);
    const [model, setModel] = useState({ provider: MODEL.provider, model: MODEL.model, effort: 'high' });
    const [workflow, setWorkflow] = useState(null);
    const [mode, setMode] = useState('none');
    return React.createElement(
      'div',
      { 'data-leaf': 'follow' },
      view.card('follow', selection),
      view.conversation(selection, 'follow', {
        activeProjectPath: project.path,
        activeProjectLabel: project.name,
        onSelectProject: (path) => setProject(PROJECTS.find((entry) => entry.path === path)),
        onClearProject: () => setProject({ path: '', name: '' }),
        draftModelSelection: model,
        onDraftModelSelection: setModel,
        draftWorkflow: workflow,
        onDraftWorkflow: setWorkflow,
        draftOrchestrationMode: mode,
        onDraftOrchestrationMode: setMode,
      })
    );
  }
  await act(async () => view.root.render(React.createElement(DraftPane)));
  await view.settle();
  const { document } = view;
  const rail = document.querySelector('.session-rail-body');
  const row = (title) => rail.querySelector(`button.session-rail-row.session-rail-pick[title="${title}"]`);
  const text = (title) => row(title).querySelector('.session-rail-cut').textContent;
  const modelText = () => rail.querySelector('.session-rail-model button').textContent;
  const menuItem = (label) =>
    [...document.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent.trim().startsWith(label));
  // The Project row is the composer's project select.
  const project = () => rail.querySelector('.session-rail-select button.mx-select-trigger');
  const projectText = () => project().querySelector('.mx-select-value').textContent;
  const option = (label) =>
    [...document.querySelectorAll('.mx-menu [role="option"]')].find((item) => item.textContent.trim() === label);
  assert.deepEqual(
    [projectText(), text('Branch and worktree'), text('Workflow'), text('Delegation mode')],
    ['app', 'main', 'Default', 'Solo']
  );
  assert.match(modelText(), /High/);

  await act(async () => project().click());
  await act(async () => option('other').click());
  assert.equal(projectText(), 'other');
  await act(async () => project().click());
  await act(async () => option('No project').click());
  assert.equal(projectText(), 'No project');
  await act(async () => project().click());
  await act(async () => option('app').click());
  assert.equal(projectText(), 'app');

  rail.querySelector('.session-rail-branch').getBoundingClientRect = () => ({
    x: 300, y: 400, left: 300, right: 600, top: 400, bottom: 428, width: 300, height: 28,
  });
  await act(async () => row('Branch and worktree').click());
  await act(async () => document.querySelector('.branch-tab-host [data-branch="dev"]').click());
  assert.equal(text('Branch and worktree'), 'dev');

  await act(async () => row('Workflow').click());
  await act(async () => menuItem('Review').click());
  assert.equal(text('Workflow'), 'Review');
  await act(async () => row('Delegation mode').click());
  await act(async () => menuItem('Swarm').click());
  assert.equal(text('Delegation mode'), 'Swarm');

  const { requestOpenModelPicker } = await import('./model-picker-event.ts');
  await act(async () => requestOpenModelPicker());
  const effort = [...document.querySelectorAll('.route-sheet-row')].find((button) => button.textContent.includes('Reasoning effort'));
  await act(async () => effort.click());
  await act(async () => menuItem('Low').click());
  await view.settle();
  assert.match(modelText(), /Low/);
  assert.doesNotMatch(modelText(), /High/);
  await act(async () => view.root.render(null));
});
