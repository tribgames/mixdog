import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  publishSessionRailSlot,
  SESSION_RAIL_DEFAULT_WIDTH,
  SESSION_RAIL_MIN_WIDTH,
  sessionRailComposerMode,
  sessionRailFit,
  sessionRailSlot,
} from './session-rail-layout.ts';
import {
  PANE_SIDE_DOCK_DEFAULT_WIDTH,
  PANE_SIDE_DOCK_MIN_WIDTH,
  PANE_SIDE_DOCK_SHEET_FRAME_WIDTH,
  SESSION_RAIL_WIDTH_KEY,
} from './pane-side-dock-model.ts';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout.ts';
import { sessionProjectMove } from './session-project-move.ts';
import { islandAgentRows } from './agent-activity-model.ts';
import { requestOpenModelPicker, OPEN_MODEL_PICKER_EVENT } from './model-picker-event.ts';

const FRAME = PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;
const FLOOR = DESKTOP_WORKSPACE_MIN_WIDTH;

test('the panel fits beside a dock: the dock yields to its minimum first, then the panel, then the panel is raised', () => {
  const fit = (cellWidth, dockOpen = true) =>
    sessionRailFit({ cellWidth, dockFloor: dockOpen ? PANE_SIDE_DOCK_MIN_WIDTH : 0, railPref: SESSION_RAIL_DEFAULT_WIDTH });
  // Everything at its preferred width.
  const roomy = FLOOR + FRAME + PANE_SIDE_DOCK_DEFAULT_WIDTH + FRAME + SESSION_RAIL_DEFAULT_WIDTH;
  assert.deepEqual(fit(roomy), { mode: 'column', width: 400, dockRoom: PANE_SIDE_DOCK_DEFAULT_WIDTH });
  // Narrower: the dock gives up width, the panel keeps its own.
  assert.deepEqual(fit(roomy - 1), { mode: 'column', width: 400, dockRoom: PANE_SIDE_DOCK_DEFAULT_WIDTH - 1 });
  const dockAtMinimum = FLOOR + FRAME + PANE_SIDE_DOCK_MIN_WIDTH + FRAME + SESSION_RAIL_DEFAULT_WIDTH;
  assert.deepEqual(fit(dockAtMinimum), { mode: 'column', width: 400, dockRoom: PANE_SIDE_DOCK_MIN_WIDTH });
  // Then the panel gives up width, the dock stays at its minimum.
  assert.deepEqual(fit(dockAtMinimum - 1), { mode: 'column', width: 399, dockRoom: PANE_SIDE_DOCK_MIN_WIDTH });
  const bothAtMinimum = FLOOR + FRAME + PANE_SIDE_DOCK_MIN_WIDTH + FRAME + SESSION_RAIL_MIN_WIDTH;
  assert.deepEqual(fit(bothAtMinimum), { mode: 'column', width: 300, dockRoom: PANE_SIDE_DOCK_MIN_WIDTH });
  // Still less: the panel is raised over the dock's right edge, which keeps the room it has without it.
  const raised = fit(bothAtMinimum - 1);
  assert.equal(raised.mode, 'raised');
  assert.equal(raised.width, 400);
  assert.equal(raised.dockRoom, bothAtMinimum - 1 - FLOOR - FRAME);
});

test('with no dock the panel is a column down to its minimum beside the conversation, then raised over it', () => {
  const fit = (cellWidth) => sessionRailFit({ cellWidth, dockFloor: 0, railPref: SESSION_RAIL_DEFAULT_WIDTH });
  assert.equal(fit(FLOOR + FRAME + 400).width, 400);
  assert.deepEqual(fit(FLOOR + FRAME + 300), { mode: 'column', width: 300, dockRoom: FLOOR + FRAME + 300 - FLOOR - FRAME - 300 - FRAME });
  assert.equal(fit(FLOOR + FRAME + 299).mode, 'raised');
});

test('the composer is bare only while its session shows the panel as a column', () => {
  const element = { nodeType: 1 };
  const shown = { sessionId: 'a', onScreen: true };
  const mode = (conversation = shown) => sessionRailComposerMode(sessionRailSlot('leaf'), conversation);
  publishSessionRailSlot('leaf', null);
  assert.equal(mode(), 'off', 'panel off');
  publishSessionRailSlot('leaf', { element, mode: 'column', sessionId: 'a' });
  assert.equal(mode(), 'column');
  assert.equal(mode({ sessionId: '', onScreen: true }), 'off', 'a draft keeps its composer');
  publishSessionRailSlot('leaf', { element, mode: 'raised', sessionId: 'a' });
  assert.equal(mode(), 'raised');
  publishSessionRailSlot('leaf', null);
  assert.equal(mode(), 'off');
});

test('the panel belongs to the session the pane shows: a retained or another conversation keeps its composer', () => {
  const element = { nodeType: 1 };
  publishSessionRailSlot('leaf', { element, mode: 'column', sessionId: 'b' });
  const mode = (conversation) => sessionRailComposerMode(sessionRailSlot('leaf'), conversation);
  assert.equal(mode({ sessionId: 'b', onScreen: true }), 'column', 'the shown session draws the panel');
  assert.equal(mode({ sessionId: 'a', onScreen: false }), 'off', 'session A, retained behind B');
  assert.equal(mode({ sessionId: 'a', onScreen: true }), 'off', 'another session on screen (a dock conversation)');
  assert.equal(mode({ sessionId: 'b', onScreen: false }), 'off', 'the same session parked off screen');
  publishSessionRailSlot('leaf', null);
});

test('one calculation places the dock and the panel from the pane cell', async () => {
  const { paneDockRailLayout } = await import('./pane-side-dock.tsx');
  const pair = {
    openNow: true,
    mobileSheet: false,
    diffShowing: true,
    sessionSurfaceShowing: false,
    sessionMin: 0,
    sessionPref: 0,
    panelPref: 400,
    diffPref: 400,
  };
  const layout = (cellWidth, bottom = false) =>
    paneDockRailLayout({ cellWidth, bottom, sheetFrame: FRAME, rail: 400, dock: pair });
  // A file diff beside the dock needs its two columns: at 1,100 px both do not fit, so the panel is raised
  // (the composer keeps its controls) and the dock decides alone.
  const narrow = layout(1100);
  assert.equal(narrow.rail.mode, 'raised');
  // With room for the pair, the panel and the conversation's floor, all three are inline.
  const wide = layout(FLOOR + FRAME + 800 + FRAME + 400);
  assert.equal(wide.rail.mode, 'column');
  assert.equal(wide.rail.width, 400);
  assert.equal(wide.dock.overlay, false);
  assert.equal(wide.dock.pairShowing, true);
  assert.equal(wide.dock.baseAsideWidth + wide.dock.diffWidth, 800);
  // A dock below the chat takes none of the conversation's width: the panel stays a column.
  const below = layout(1100, true);
  assert.equal(below.rail.mode, 'column');
  assert.equal(below.rail.width, 400);
  // Off: the dock alone.
  assert.equal(paneDockRailLayout({ cellWidth: 1100, bottom: false, sheetFrame: FRAME, rail: null, dock: pair }).rail, null);
});

test('one panel width, live in every pane; the resize edge takes keys', async (t) => {
  const { useSessionRailWidth, setSessionRailWidth, resetSessionRailWidth } = await import('./session-rail-layout.ts');
  const { sessionRailWidthForKey } = await import('./SessionRailColumn.tsx');
  const widths = {};
  function Pane({ id }) {
    widths[id] = useSessionRailWidth();
    return null;
  }
  const { root } = await mount(
    t,
    React.createElement(React.Fragment, null, React.createElement(Pane, { id: 'a' }), React.createElement(Pane, { id: 'b' }))
  );
  window.localStorage.removeItem(SESSION_RAIL_WIDTH_KEY);
  resetSessionRailWidth();
  await act(async () => setSessionRailWidth(500, false));
  assert.deepEqual(widths, { a: 500, b: 500 });
  await act(async () => setSessionRailWidth(9999, true));
  assert.deepEqual(widths, { a: 560, b: 560 });
  await act(async () => root.render(null));
  resetSessionRailWidth();
  setSessionRailWidth(400, true);
  assert.equal(sessionRailWidthForKey('ArrowLeft', 400), 416, 'Left widens the panel');
  assert.equal(sessionRailWidthForKey('ArrowRight', 400), 384);
  assert.equal(sessionRailWidthForKey('Home', 400), SESSION_RAIL_MIN_WIDTH);
  assert.equal(sessionRailWidthForKey('End', 400), 560);
  assert.equal(sessionRailWidthForKey('a', 400), null);
});

async function railColumn(t, props) {
  const { SessionRailColumn } = await import('./SessionRailColumn.tsx');
  const { document, root } = await mount(t, null);
  const proto = window.HTMLElement.prototype;
  const captured = new Set();
  proto.setPointerCapture ??= function (id) {
    captured.add(id);
  };
  proto.releasePointerCapture ??= function (id) {
    captured.delete(id);
  };
  proto.hasPointerCapture ??= (id) => captured.has(id);
  let closed = 0;
  const element = (next = {}) =>
    React.createElement(SessionRailColumn, {
      leafId: 'leaf-rail',
      sessionId: LEAD,
      mode: 'column',
      width: 400,
      onClose: () => closed++,
      ...props,
      ...next,
    });
  await act(async () => root.render(element()));
  return { document, root, element, closed: () => closed };
}

test('a press or Escape in a layer stacked above the raised panel does not close it; the surface under it does', async (t) => {
  const view = await railColumn(t, { mode: 'raised' });
  const { document } = view;
  const confirmation = document.createElement('div');
  confirmation.innerHTML = '<button>Cancel</button>';
  document.body.append(confirmation);
  const button = confirmation.querySelector('button');
  const press = (target) => target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  await act(async () => press(button));
  button.focus();
  await act(async () => button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(view.closed(), 0, "a confirmation's press and Escape are its own");
  await act(async () => press(document.querySelector('.session-rail-body')));
  assert.equal(view.closed(), 0, 'a press in the panel');
  const surface = document.createElement('div');
  document.getElementById('root').append(surface);
  await act(async () => press(surface));
  assert.equal(view.closed(), 1, 'a press on the surface under the panel closes it');
  confirmation.remove();
});

test("a press on the panel's frame selects its pane, so what is typed next goes to that pane", async (t) => {
  let selected = 0;
  const view = await railColumn(t, { onFocusPane: () => selected++ });
  const press = (target, button = 0) =>
    target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button }));
  await act(async () => press(view.document.querySelector('.session-rail-head button'), 2));
  assert.equal(selected, 0, 'only the primary button');
  await act(async () => press(view.document.querySelector('.session-rail-head button')));
  assert.equal(selected, 1, 'the Close button in the title row');
  await act(async () => press(view.document.querySelector('.session-rail-resize')));
  assert.equal(selected, 2, 'the resize edge');
  // The focused pane's panel is given no selector: nothing to select.
  await act(async () => view.root.render(view.element({ onFocusPane: undefined })));
  await act(async () => press(view.document.querySelector('.session-rail-body')));
  assert.equal(selected, 2);
});

test('the remembered width is only what a drag or a key chose: a still press or a cancelled drag leaves it', async (t) => {
  const { resetSessionRailWidth, setSessionRailWidth, useSessionRailWidth } = await import('./session-rail-layout.ts');
  // A roomy pane chose 500; this pane's cell fits the panel at 336.
  const view = await railColumn(t, { width: 336 });
  const { document } = view;
  window.localStorage.removeItem(SESSION_RAIL_WIDTH_KEY);
  resetSessionRailWidth();
  setSessionRailWidth(500, true);
  let shared;
  function Roomy() {
    shared = useSessionRailWidth();
    return null;
  }
  await act(async () =>
    view.root.render(React.createElement(React.Fragment, null, view.element(), React.createElement(Roomy)))
  );
  const edge = () => document.querySelector('.session-rail-resize');
  const pointer = (type, clientX, clientY = 0) =>
    act(async () =>
      edge().dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX, clientY }))
    );
  await pointer('pointerdown', 100);
  await pointer('pointerup', 100);
  assert.equal(shared, 500, 'a press without movement');
  assert.equal(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY), '500');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 100, 10);
  await pointer('pointerup', 100, 10);
  assert.equal(shared, 500, 'a move straight down the edge');
  assert.equal(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY), '500');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 90);
  await pointer('pointermove', 100);
  await pointer('pointerup', 100);
  assert.equal(shared, 500, 'a drag that came back to where it started');
  assert.equal(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY), '500');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 90);
  assert.equal(shared, 346, 'the drag previews in every pane');
  await act(async () => edge().dispatchEvent(new window.PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
  assert.equal(shared, 500, 'a cancel puts back the width chosen before the drag');
  assert.equal(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY), '500');
  await pointer('pointerdown', 100);
  await pointer('pointermove', 80);
  await pointer('pointerup', 80);
  assert.equal(shared, 356, 'a drag that moved is remembered');
  assert.equal(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY), '356');
  await act(async () => edge().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  assert.equal(window.localStorage.getItem(SESSION_RAIL_WIDTH_KEY), '560', 'and so is a key');
  await act(async () => view.root.render(null));
  resetSessionRailWidth();
});

test('the Project row reads a pending move and a failed one from the workspace state', () => {
  assert.deepEqual(sessionProjectMove(null), { pending: null, failed: null });
  assert.deepEqual(sessionProjectMove({ pendingProjectMove: { projectPath: 'C:/work/app', requestedAt: 5 } }), {
    pending: { projectPath: 'C:/work/app', requestedAt: 5 },
    failed: null,
  });
  // null: the task workspace; outside a repository the workspace holds only this field.
  assert.deepEqual(sessionProjectMove({ pendingProjectMove: { projectPath: null, requestedAt: 7 } }).pending, {
    projectPath: null,
    requestedAt: 7,
  });
  assert.deepEqual(
    sessionProjectMove({
      branch: 'main',
      projectMoveFailed: { projectPath: 'C:/work/app', message: 'Folder is gone', at: 9 },
    }).failed,
    { projectPath: 'C:/work/app', message: 'Folder is gone', at: 9 }
  );
  assert.deepEqual(sessionProjectMove({ pendingProjectMove: { projectPath: '', requestedAt: 1 } }).pending, null);
  assert.deepEqual(sessionProjectMove({ projectMoveFailed: { projectPath: 'x', message: ' ' } }).failed, null);
});

async function mount(t, element, host = {}) {
  const { document, root } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver'] });
  window.mixdogDesktop = { invokeCapability: async () => ({ value: null }), ...host };
  window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (!globalThis.getComputedStyle) {
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    t.after(() => delete globalThis.getComputedStyle);
  }
  window.requestAnimationFrame ??= globalThis.requestAnimationFrame;
  window.cancelAnimationFrame ??= globalThis.cancelAnimationFrame;
  await act(async () => root.render(element));
  return { document, root };
}

const LEAD = 'lead-rail';
const agent = (id, status, stage = status) => ({
  tag: id,
  sessionId: id,
  ownerSessionId: LEAD,
  parentSessionId: LEAD,
  agent: 'worker',
  status,
  stage,
});
const shell = (key, finished) => ({ key, kind: 'shell', label: `npm run ${key}`, startedAt: Date.now() - 5_000, finished, taskId: key, cwd: '' });

test('a category is absent when it has nothing, and its buttons show only while it is open', async (t) => {
  const { ShellsSection } = await import('./session-rail-jobs.tsx');
  const element = (shells, open) =>
    React.createElement(ShellsSection, { sessionId: LEAD, shells, shellKeys: null, open, onToggle() {} });
  const { document, root } = await mount(t, element([], true));
  assert.equal(document.querySelector('[data-category="shells"]'), null);
  await act(async () => root.render(element([shell('build', true)], false)));
  const section = document.querySelector('[data-category="shells"]');
  assert.ok(section);
  assert.equal(section.querySelector('.session-rail-tidy'), null, 'no Clean up while closed');
  assert.equal(section.querySelector('.session-rail-bd'), null);
  assert.match(section.querySelector('.session-rail-sm').textContent, /Ended 1/);
  await act(async () => root.render(element([shell('build', true)], true)));
  assert.ok(document.querySelector('[data-category="shells"] .session-rail-tidy'), 'Clean up while open');
  assert.equal(document.querySelector('[data-category="shells"] .session-rail-sm').getAttribute('aria-hidden'), 'true');
});

test("each head's Clean up is enabled only with something to clear", async (t) => {
  const { ShellsSection, AgentsSection } = await import('./session-rail-jobs.tsx');
  const shells = (rows) =>
    React.createElement(ShellsSection, { sessionId: LEAD, shells: rows, shellKeys: null, open: true, onToggle() {} });
  const { document, root } = await mount(t, shells([shell('dev', false)]));
  const tidy = () => document.querySelector('.session-rail-tidy');
  assert.equal(tidy().getAttribute('aria-disabled'), 'true', 'a running shell has nothing to clear');
  await act(async () => root.render(shells([shell('dev', false), shell('test', true)])));
  assert.equal(tidy().getAttribute('aria-disabled'), null);

  const lead = { tag: `lead:${LEAD}`, sessionId: LEAD, ownerSessionId: LEAD, agent: 'lead', status: 'idle', stage: 'idle' };
  const agents = (pool) =>
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows([lead, ...pool], LEAD),
      shellKeys: null,
      open: true,
      onToggle() {},
    });
  await act(async () => root.render(agents([agent('a', 'running', 'streaming')])));
  assert.equal(tidy().getAttribute('aria-disabled'), 'true', 'a running agent has nothing to clear');
  const finished = { ...agent('b', 'completed'), settledAt: Date.now() - 1_000 };
  await act(async () => root.render(agents([agent('a', 'running', 'streaming'), finished])));
  assert.equal(tidy().getAttribute('aria-disabled'), null);
});

test("the Worktrees head's Clean up follows the cleanup preview", async (t) => {
  const { WorktreesSection } = await import('./session-rail-worktrees.tsx');
  const { clearBranchMenuReads } = await import('./branch-menu-data.ts');
  clearBranchMenuReads();
  // Two projects: one whose cleanup preview finds nothing, one with a candidate.
  const workspaceOf = (project) => ({
    cwd: project,
    branch: 'main',
    repoCommonDir: `${project}/.git`,
    worktreeId: null,
    revision: 3,
    transition: { state: 'idle', txId: null },
  });
  const projectOf = { quiet: 'C:/work/quiet', busy: 'C:/work/busy' };
  const host = {
    invokeCapability: async ({ capability, args, sessionId }) => {
      if (capability === 'getBranchMenu') {
        const project = projectOf[sessionId];
        return {
          value: {
            workspace: workspaceOf(project),
            branches: [{ name: 'main' }, { name: 'feature' }],
            occupancy: [
              { branch: 'main', kind: 'current' },
              { branch: 'feature', kind: 'session', sessionId: 'other', path: `${project}-wt/feature` },
            ],
            retainedWorktree: null,
          },
        };
      }
      if (capability === 'previewWorktreeCleanup') {
        return { value: { hasCandidates: args[0].repoCommonDir === `${projectOf.busy}/.git` } };
      }
      if (capability === 'listWorktrees') return { value: [] };
      return { value: null };
    },
  };
  const element = (sessionId) =>
    React.createElement(WorktreesSection, {
      key: sessionId,
      sessionId,
      workspace: workspaceOf(projectOf[sessionId]),
      projectPath: projectOf[sessionId],
      locked: false,
      refreshKey: '',
      open: true,
      onToggle() {},
      onFlash() {},
    });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const { document, root } = await mount(t, element('quiet'), host);
  await settle();
  assert.ok(document.querySelector('[data-category="worktrees"]'), 'a worktree besides the main checkout');
  assert.equal(document.querySelector('.session-rail-tidy').getAttribute('aria-disabled'), 'true', 'nothing to clean up');
  await act(async () => root.render(element('busy')));
  await settle();
  assert.equal(document.querySelector('.session-rail-tidy').getAttribute('aria-disabled'), null);
});

test('folds are remembered per session', async (t) => {
  const { useSessionRailFolds, SESSION_RAIL_FIRST_OPEN } = await import('./session-rail-folds.ts');
  let folds;
  function Probe({ sessionId }) {
    folds = useSessionRailFolds(sessionId);
    return null;
  }
  const { root } = await mount(t, React.createElement(Probe, { sessionId: 'one' }));
  for (const category of ['goal', 'todo', 'agents', 'shells', 'changes']) assert.equal(folds.isOpen(category), true);
  assert.equal(folds.isOpen('info'), false);
  assert.equal(folds.isOpen('worktrees'), false);
  assert.deepEqual([...SESSION_RAIL_FIRST_OPEN].sort(), ['agents', 'changes', 'goal', 'shells', 'todo']);
  await act(async () => folds.toggle('info'));
  await act(async () => folds.toggle('agents'));
  await act(async () => folds.setGroups({ done: true }));
  await act(async () => root.render(React.createElement(Probe, { sessionId: 'two' })));
  assert.equal(folds.isOpen('info'), false, 'another session starts from the first state');
  assert.equal(folds.isOpen('agents'), true);
  // A fresh mount reads them back.
  await act(async () => root.render(React.createElement(Probe, { key: 'again', sessionId: 'one' })));
  assert.equal(folds.isOpen('info'), true);
  assert.equal(folds.isOpen('agents'), false);
  assert.equal(folds.groupOpen('done', false), true);
});

test('a model picker request while the panel is a column is answered by its Model row, Info unfolding for it', async (t) => {
  const { useFoldedModelPickerRequest } = await import('./session-rail-folds.ts');
  const opened = [];
  // Stands in for the Model row: it listens only while mounted (Info open), as RouteEditor does.
  function ModelRow() {
    React.useEffect(() => {
      const onRequest = (event) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        opened.push('model row');
      };
      window.addEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
      return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onRequest);
    }, []);
    return null;
  }
  function Panel({ column }) {
    const [infoOpen, setInfoOpen] = React.useState(false);
    useFoldedModelPickerRequest(column, infoOpen, () => setInfoOpen(true));
    return infoOpen ? React.createElement(ModelRow) : null;
  }
  const { root } = await mount(t, React.createElement(Panel, { column: false }));
  let answered;
  await act(async () => {
    answered = requestOpenModelPicker();
  });
  assert.equal(answered, false, 'raised or off: the composer pill answers, not the panel');
  await act(async () => root.render(React.createElement(Panel, { column: true })));
  await act(async () => {
    answered = requestOpenModelPicker();
  });
  assert.equal(answered, true);
  assert.deepEqual(opened, ['model row']);
  await act(async () => {
    answered = requestOpenModelPicker();
  });
  assert.deepEqual(opened, ['model row', 'model row'], 'with Info open the row answers at once');
});

test('the island is not drawn beside a column, the composer is', async (t) => {
  const { ComposerDock } = await import('./ComposerDock.tsx');
  const element = (islandHidden) =>
    React.createElement(
      ComposerDock,
      {
        sessionId: 'dock',
        goalSubmissionId: '',
        goalIsland: React.createElement('span', { className: 'probe-goal' }, 'goal'),
        showProjectSelector: false,
        reviewItems: [],
        reviewActive: true,
        reviewBusy: false,
        reviewSessionId: 'dock',
        reviewCwd: 'C:/work/app',
        islandHidden,
      },
      React.createElement('form', { className: 'composer' })
    );
  const { document, root } = await mount(t, element(false));
  assert.ok(document.querySelector('.probe-goal'), 'rail off or raised: the island carries the goal');
  await act(async () => root.render(element(true)));
  assert.equal(document.querySelector('.probe-goal'), null, 'column: no island');
  assert.ok(document.querySelector('form.composer'));
  assert.equal(document.querySelector('.composer-island'), null);

  // Beside a column the island still holds what the panel has no place for.
  const withIsland = (extra) =>
    React.cloneElement(element(true), extra, React.createElement('form', { className: 'composer' }));
  let cancelled = 0;
  await act(async () =>
    root.render(withIsland({ quotaResume: { model: 'Model', resetAt: Date.now() + 60_000, onCancel: () => cancelled++ } }))
  );
  assert.ok(document.querySelector('.composer-island'), 'a waiting quota resume keeps its cancel');
  assert.equal(document.querySelector('.probe-goal'), null);
  await act(async () => root.render(element(true)));
  await act(async () => root.render(withIsland({ islandFlash: { key: 'approval:1', text: 'Approved on another device' } })));
  assert.ok(document.querySelector('.composer-island'), "an approval's result notice has its island from the first frame");
  assert.equal(document.querySelector('.probe-goal'), null);
});

const goalSnapshot = (goal, todo) => ({ sessionId: LEAD, goal, ...(todo ? { todo } : {}) });
const goalOf = (status) => ({
  id: `goal-${status}`,
  status,
  title: 'Find the leak',
  objective: 'Find the relay memory leak',
  createdAt: Date.now() - 60_000,
  lastStartedAt: Date.now() - 60_000,
  timeUsedMs: 60_000,
});

async function goalSection(t, snapshot) {
  const { useSessionGoal } = await import('./SessionGoalIsland.tsx');
  const { GoalSection, TodoSection } = await import('./session-rail-goal.tsx');
  const { useSessionRailFolds } = await import('./session-rail-folds.ts');
  function Goal({ snapshot: shown }) {
    const model = useSessionGoal(shown);
    const folds = useSessionRailFolds(LEAD);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(GoalSection, { model, open: true, onToggle() {} }),
      React.createElement(TodoSection, { model, folds, open: true, onToggle() {} })
    );
  }
  const mounted = await mount(t, React.createElement(Goal, { snapshot }));
  return { ...mounted, render: (next) => act(async () => mounted.root.render(React.createElement(Goal, { snapshot: next }))) };
}

test('a paused or blocked goal can be dismissed, as on the island; an active one cannot', async (t) => {
  const { document, render } = await goalSection(t, goalSnapshot(goalOf('active')));
  const dismiss = () => document.querySelector('[data-category="goal"] [aria-label="Dismiss goal"]');
  assert.equal(dismiss(), null);
  await render(goalSnapshot(goalOf('paused')));
  assert.ok(dismiss(), 'paused');
  await render(goalSnapshot({ ...goalOf('blocked'), blocker: 'Waiting for the soak machine' }));
  assert.ok(dismiss(), 'blocked');
});

test("the goal's stop confirmation takes focus, and Cancel hands it back to Stop", async (t) => {
  const { document } = await goalSection(t, goalSnapshot(goalOf('active')));
  const stop = () => document.querySelector('[data-category="goal"] [aria-label="Stop goal"]');
  stop().focus();
  await act(async () => stop().click());
  const cancel = document.querySelector('.session-rail-goal-confirm button');
  assert.equal(document.activeElement, cancel);
  await act(async () => cancel.click());
  assert.equal(document.activeElement, stop());
});

test("a task group's chevron follows its name; the count comes after", async (t) => {
  const todo = {
    phases: [{ name: 'Fix', tasks: [{ content: 'one', status: 'pending' }, { content: 'two', status: 'completed' }] }],
    completed: 1,
    abandoned: 0,
    total: 2,
  };
  const { document } = await goalSection(t, goalSnapshot(goalOf('active'), todo));
  const heads = [...document.querySelectorAll('[data-category="todo"] button[aria-expanded]')].filter((head) =>
    head.querySelector('.session-rail-cv')
  );
  assert.ok(heads.length > 0);
  for (const head of heads) {
    const kids = [...head.children];
    const chevron = kids.findIndex((kid) => kid.classList.contains('session-rail-cv'));
    assert.equal(chevron, 1, `chevron right after the name in "${head.textContent}"`);
    assert.match(kids[2]?.textContent ?? '', /^\d+(\/\d+)?$/);
  }
});

test("Info's usage row opens usage; a bot's home thread or a room reads its routines, and a room shows no model or context", async (t) => {
  const { InfoSection } = await import('./session-rail-info.tsx');
  const opened = [];
  const noop = () => {};
  const element = (sessionId) =>
    React.createElement(InfoSection, {
      open: true,
      onToggle: noop,
      snapshot: { sessionId, contextPercent: 40, contextTokens: 200000, stats: { inputTokens: 1200, outputTokens: 300, costUsd: 1.25 } },
      sessionId,
      workspace: null,
      projectPath: '',
      projectLabel: '',
      projects: [],
      locked: false,
      agentMode: false,
      answersModelPickerRequests: false,
      model: {
        provider: 'anthropic',
        model: 'model',
        effort: '',
        fast: false,
        fastCapable: false,
        sessionId,
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: async (action) => action(),
        applySnapshot: noop,
        onOpenSettings: noop,
      },
      sessionChoices: [],
      onFlash: noop,
      onOpenCommandSurface: (surface) => opened.push(surface),
    });
  const { document, root } = await mount(t, element(LEAD));
  const usage = document.querySelector('[data-category="info"] .session-rail-usage');
  assert.equal(usage.tagName, 'BUTTON', 'reachable by Tab');
  assert.match(usage.textContent, /\$1\.25/, 'the cost the footer shows');
  await act(async () => usage.click());
  assert.deepEqual(opened, ['stats']);
  assert.ok(document.querySelector('[data-category="info"] .session-rail-model'));
  assert.ok(document.querySelector('[data-category="info"] .session-rail-context'));

  await act(async () => root.render(element('sess_home_helper')));
  assert.notEqual(document.querySelector('[data-category="info"] .session-rail-usage').tagName, 'BUTTON');
  assert.ok(document.querySelector('[data-category="info"] .session-rail-model'), "a bot's thread keeps its model");

  await act(async () => root.render(element('sess_room_abcdef12')));
  assert.equal(document.querySelector('[data-category="info"] .session-rail-model'), null, 'each room member runs its own');
  assert.equal(document.querySelector('[data-category="info"] .session-rail-context'), null);
});

test("the panel's context control opens a dialog, with an id of its own beside the composer's gauge", async (t) => {
  const { ContextUsageIndicator } = await import('./transcript-status.tsx');
  const snapshot = { sessionId: LEAD, contextPercent: 40, contextTokens: 200000 };
  const { document } = await mount(
    t,
    React.createElement(
      React.Fragment,
      null,
      React.createElement(ContextUsageIndicator, { snapshot }),
      React.createElement(ContextUsageIndicator, { snapshot, rowLabel: 'Context' })
    )
  );
  const cards = [...document.querySelectorAll('.session-context-popover')];
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].id, cards[1].id);
  assert.equal(cards[0].getAttribute('role'), 'tooltip');
  assert.equal(cards[1].getAttribute('role'), 'dialog');
});

const worktreeProject = 'C:/work/app';
const worktreeWorkspace = (extra = {}) => ({
  cwd: worktreeProject,
  branch: 'main',
  repoCommonDir: `${worktreeProject}/.git`,
  worktreeId: null,
  revision: 3,
  transition: { state: 'idle', txId: null },
  ...extra,
});

async function worktreesSection(t, { locked = false, menu, host = {} }) {
  const { WorktreesSection } = await import('./session-rail-worktrees.tsx');
  const { clearBranchMenuReads } = await import('./branch-menu-data.ts');
  clearBranchMenuReads();
  const calls = [];
  const element = (isLocked) =>
    React.createElement(WorktreesSection, {
      sessionId: LEAD,
      workspace: menu.workspace,
      projectPath: worktreeProject,
      locked: isLocked,
      refreshKey: '',
      open: true,
      onToggle() {},
      onFlash() {},
    });
  const mounted = await mount(
    t,
    element(locked),
    {
      invokeCapability: async (request) => {
        calls.push(request);
        if (request.capability === 'getBranchMenu') return { value: menu };
        if (request.capability === 'previewWorktreeCleanup') return { value: { hasCandidates: false } };
        if (request.capability === 'listWorktrees') return { value: [] };
        return host.invokeCapability ? host.invokeCapability(request) : { value: null };
      },
      openLocalFileLink: async (...args) => calls.push({ openLocalFileLink: args }),
    }
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const row = (name) =>
    [...mounted.document.querySelectorAll('[data-category="worktrees"] .session-rail-row')].find((node) =>
      node.textContent.includes(name)
    );
  const action = (name, label) => row(name)?.querySelector(`[aria-label="${label}"]`);
  const lock = (isLocked) => act(async () => mounted.root.render(element(isLocked)));
  return { ...mounted, calls, row, action, lock };
}

test("worktree rows follow the island's eligibility: locked while work runs, unmanaged folders open but are not removed", async (t) => {
  const menu = {
    workspace: worktreeWorkspace(),
    branches: [{ name: 'main' }, { name: 'feature' }, { name: 'outside' }],
    occupancy: [
      { branch: 'main', kind: 'current' },
      { branch: 'feature', kind: 'session', sessionId: 'other', path: `${worktreeProject}-wt/feature` },
      { branch: 'outside', kind: 'external', path: 'D:/elsewhere/outside' },
    ],
    retainedWorktree: null,
  };
  const idle = await worktreesSection(t, { menu });
  assert.equal(idle.action('feature', 'Merge').disabled, false);
  assert.equal(idle.action('feature', 'Remove').disabled, false);
  assert.equal(idle.action('outside', 'Open folder').disabled, false, 'an unmanaged worktree still opens its folder');
  assert.equal(idle.action('outside', 'Remove').disabled, true, 'only app-managed folders are removed');
  await act(async () => idle.action('outside', 'Open folder').click());
  assert.deepEqual(idle.calls.at(-1), { openLocalFileLink: ['D:/elsewhere/outside', '.'] });
  await idle.lock(true);
  assert.equal(idle.action('feature', 'Merge').disabled, true, 'a turn or a shell locks merge');
  assert.equal(idle.action('feature', 'Remove').disabled, true);
});

test("the session's own existing-branch worktree merges into the project folder's branch without an explicit target", async (t) => {
  const own = worktreeWorkspace({ cwd: `${worktreeProject}-wt/topic`, branch: 'topic', worktreeId: 'wt-1', mergeTarget: '' });
  const menu = {
    workspace: own,
    branches: [{ name: 'develop' }, { name: 'topic' }],
    occupancy: [
      { branch: 'develop', kind: 'current' },
      { branch: 'topic', kind: 'session', sessionId: LEAD, path: own.cwd },
    ],
    retainedWorktree: null,
  };
  const { action, document } = await worktreesSection(t, { menu });
  assert.equal(action('topic', 'Merge').disabled, false);
  await act(async () => action('topic', 'Merge').click());
  assert.match(document.body.textContent, /Merge topic into develop\?/);
});

test('New worktree with uncommitted project-folder files asks the carry choice in the panel', async (t) => {
  const menu = {
    workspace: worktreeWorkspace(),
    branches: [{ name: 'main' }, { name: 'feature' }],
    occupancy: [
      { branch: 'main', kind: 'current' },
      { branch: 'feature', kind: 'session', sessionId: 'other', path: `${worktreeProject}-wt/feature` },
    ],
    retainedWorktree: null,
  };
  const { document } = await worktreesSection(t, {
    menu,
    host: {
      invokeCapability: async () => {
        throw new Error('WORKTREE_DIRTY_CHOICE: dirty\n[worktree-details] {"count":2,"paths":["a.ts","b.ts"]}');
      },
    },
  });
  const more = document.querySelector('[data-category="worktrees"] .dock-header-more');
  await act(async () => more.click());
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => /New worktree/.test(node.textContent));
  await act(async () => item.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(document.querySelector('.worktree-carry-dialog'), 'the carry choice is shown, not left waiting');
});

test('a session moved out of its repository shows no branch from the old one', async (t) => {
  const { BranchIslandSegment, clearBranchSegmentCache } = await import('./WorktreeIslandSegment.tsx');
  clearBranchSegmentCache();
  const menu = {
    workspace: worktreeWorkspace(),
    branches: [{ name: 'main' }],
    occupancy: [{ branch: 'main', kind: 'current' }],
    retainedWorktree: null,
  };
  const element = (workspace, projectPath) =>
    React.createElement(BranchIslandSegment, { sessionId: LEAD, workspace, projectPath });
  let moved = false;
  const { document, root } = await mount(t, element(worktreeWorkspace(), worktreeProject), {
    invokeCapability: async ({ capability }) =>
      capability === 'getBranchMenu' && !moved ? { value: menu } : { value: null },
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.ok(document.querySelector('.composer-island-seg-branch'));
  moved = true;
  // Outside a repository the workspace holds only the move's own fields.
  await act(async () => root.render(element({ pendingProjectMove: null }, '')));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  assert.equal(document.querySelector('.composer-island-seg-branch'), null);
});

test("a branch row's menu, portalled out of the panel's branch tab, works: a press in it does not close the tab", async (t) => {
  const { BranchIslandSegment, clearBranchSegmentCache } = await import('./WorktreeIslandSegment.tsx');
  clearBranchSegmentCache();
  const menu = {
    workspace: worktreeWorkspace(),
    branches: [{ name: 'main' }, { name: 'feature' }],
    occupancy: [
      { branch: 'main', kind: 'current' },
      { branch: 'feature', kind: 'session', sessionId: 'other', path: `${worktreeProject}-wt/feature` },
    ],
    retainedWorktree: null,
  };
  const opened = [];
  const { document } = await mount(
    t,
    React.createElement(BranchIslandSegment, {
      sessionId: LEAD,
      workspace: worktreeWorkspace(),
      projectPath: worktreeProject,
      renderTrigger: (button) => React.createElement('button', { ...button, type: 'button', className: 'probe-branch-row' }, 'Branch'),
    }),
    {
      invokeCapability: async ({ capability }) => {
        if (capability === 'getBranchMenu') return { value: menu };
        if (capability === 'inspectProjectBranch')
          return { value: { kind: 'managed', path: `${worktreeProject}-wt/feature`, target: 'main', commit: 'abc' } };
        return { value: null };
      },
      openLocalFileLink: async (...args) => opened.push(args),
    }
  );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => document.querySelector('.probe-branch-row').click());
  await settle();
  const more = document.querySelector('[aria-label="Actions for feature"]');
  assert.ok(more, 'the tab lists the worktree branch');
  await act(async () => more.click());
  await settle();
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.includes('Open folder'));
  assert.ok(item);
  await act(async () => item.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
  assert.ok(item.isConnected, 'the press did not unmount the menu');
  assert.ok(document.querySelector('[aria-label="Actions for feature"]'), 'nor close the tab');
  await act(async () => item.click());
  await settle();
  assert.deepEqual(opened, [[`${worktreeProject}-wt/feature`, '.']]);
  // A press outside the tab still closes it.
  await act(async () => document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('[aria-label="Actions for feature"]'), null);
});

test('a clean branch with commits not pushed keeps Changes and its Git actions', async (t) => {
  const { ChangesSection } = await import('./session-rail-changes.tsx');
  const cwd = 'C:/work/ahead';
  const status = (ahead) => ({
    repository: true,
    root: cwd,
    branch: 'main',
    detached: false,
    unborn: false,
    upstream: true,
    upstreamName: 'origin/main',
    remote: true,
    ahead,
    behind: 0,
    operation: '',
    files: [],
  });
  const view = {
    label: 'Uncommitted',
    fileCount: 0,
    files: new Map(),
    headlineStats: { additions: 0, deletions: 0, hasLineStats: false },
    sessionId: LEAD,
    historyTurns: 0,
    busy: false,
    emptyText: 'No changes',
  };
  const element = React.createElement(ChangesSection, { view, cwd, open: false, onToggle() {} });
  const { document } = await mount(t, element, {
    gitStatus: async () => status(2),
    gitReview: async () => ({ repository: true, root: cwd, base: 'HEAD', files: [] }),
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const section = document.querySelector('[data-category="changes"]');
  assert.ok(section, 'two commits ahead: the category stays');
  assert.match(section.textContent, /↑2/);
});
