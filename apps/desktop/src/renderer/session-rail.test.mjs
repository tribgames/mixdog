import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout.ts';
import {
  publishSessionRailSlot,
  SESSION_RAIL_GAP,
  SESSION_RAIL_MIN_WIDTH,
  sessionRailFit,
  sessionRailHost,
  sessionRailSlot,
} from './session-rail-layout.ts';
import {
  PANE_SIDE_DOCK_MIN_WIDTH,
  PANE_SIDE_DOCK_SHEET_FRAME_WIDTH,
  SESSION_RAIL_WIDTH_KEY,
} from './pane-side-dock-model.ts';
import { sessionProjectMove } from './session-project-move.ts';
import { islandAgentRows } from './agent-activity-model.ts';
import { requestOpenModelPicker, OPEN_MODEL_PICKER_EVENT } from './model-picker-event.ts';
import { t } from './i18n.ts';

const FRAME = PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;

// The pane width in which the conversation at its floor and a panel `width` wide, with its edges, just fit.
const paneFor = (width) => DESKTOP_WORKSPACE_MIN_WIDTH + SESSION_RAIL_GAP + width;
// The narrowest pane every side-dock surface stands beside the conversation in.
const BESIDE_FROM = DESKTOP_WORKSPACE_MIN_WIDTH + FRAME + PANE_SIDE_DOCK_MIN_WIDTH;
// --pane-column's cap (12-transcript.css), the column a pane wider than 1,060px gives its rows.
const COLUMN_CAP = 848;

test('the panel takes what the conversation at its floor leaves it: it yields to its minimum, then lies over the conversation', () => {
  // A panel the user widened to 400.
  const fit = (cellWidth) => sessionRailFit({ cellWidth, railPref: 400 });
  const beside = (width, reserve) => ({ width, reserve, presentation: 'beside' });
  // The scroller, giving up the panel's band on both sides, still holds the column: nothing moves.
  const roomy = COLUMN_CAP + 2 * (400 + SESSION_RAIL_GAP);
  assert.deepEqual(fit(roomy), beside(400, 0));
  assert.deepEqual(fit(roomy + 500), beside(400, 0), 'no wider than its preferred width');
  // Less than that: the conversation re-centres left of it, down to its floor.
  assert.deepEqual(fit(roomy - 1), beside(400, 400 + SESSION_RAIL_GAP));
  assert.deepEqual(fit(paneFor(400)), beside(400, 400 + SESSION_RAIL_GAP));
  assert.deepEqual(fit(paneFor(400) - 1), beside(399, 399 + SESSION_RAIL_GAP), 'then the panel gives up width');
  assert.deepEqual(
    fit(paneFor(SESSION_RAIL_MIN_WIDTH)),
    beside(SESSION_RAIL_MIN_WIDTH, SESSION_RAIL_MIN_WIDTH + SESSION_RAIL_GAP)
  );
  // Beside down to the pane width every side-dock surface stands beside the conversation in, at its own minimum.
  assert.deepEqual(fit(BESIDE_FROM), beside(SESSION_RAIL_MIN_WIDTH, SESSION_RAIL_MIN_WIDTH + SESSION_RAIL_GAP));
  assert.deepEqual(
    fit(BESIDE_FROM - 1),
    { width: 400, reserve: 0, presentation: 'overlay' },
    'the conversation at its floor would not fit a side sheet beside it: the panel at its width over the conversation'
  );
  // Above its minimum, no panel width beside the conversation leaves it under its floor.
  for (const pref of [SESSION_RAIL_MIN_WIDTH + 1, 400, 560]) {
    for (let cellWidth = BESIDE_FROM; cellWidth <= 1800; cellWidth += 1) {
      const fitted = sessionRailFit({ cellWidth, railPref: pref });
      if (fitted.width === SESSION_RAIL_MIN_WIDTH) continue;
      assert.ok(
        cellWidth - fitted.width - SESSION_RAIL_GAP >= DESKTOP_WORKSPACE_MIN_WIDTH,
        `${pref}px panel in a ${cellWidth}px pane`
      );
    }
  }
});

test("nothing moves only while the transcript's rows keep the column the pane gives them", () => {
  // Past 1,060px the pane gives its rows --pane-column's 848px cap (clamp(800px, 80cqi, 848px)); the scroller gives up
  // the panel's band on its left and its right.
  for (const pref of [SESSION_RAIL_MIN_WIDTH, 400]) {
    const band = pref + SESSION_RAIL_GAP;
    const fit = (cellWidth) => sessionRailFit({ cellWidth, railPref: pref });
    const boundary = COLUMN_CAP + 2 * band;
    assert.deepEqual(
      fit(boundary),
      { width: pref, reserve: 0, presentation: 'beside' },
      `${pref}: the rows keep 848px beside the band`
    );
    assert.deepEqual(
      fit(boundary - 1),
      { width: pref, reserve: band, presentation: 'beside' },
      `${pref}: one pixel less re-centres the conversation`
    );
    // Where the margins beside an 816px conversation would hold the band, the rows would be narrowed.
    assert.equal(fit(816 + 2 * band).reserve, band, `${pref}: not an 816px conversation`);
  }
});

test('the panel belongs to the session or draft the pane shows: a retained or another conversation keeps its composer', () => {
  const element = { nodeType: 1 };
  const host = (conversation) => sessionRailHost(sessionRailSlot('leaf'), conversation);
  publishSessionRailSlot('leaf', null);
  assert.equal(host({ sessionId: 'b', onScreen: true }), null, 'no panel');
  assert.equal(host({ sessionId: '', draftId: 'd1', onScreen: true }), null, 'no panel for a draft either');
  publishSessionRailSlot('leaf', { element, sessionId: 'b', draftId: '' });
  assert.equal(host({ sessionId: 'b', onScreen: true }), element, 'the shown session draws the panel');
  assert.equal(host({ sessionId: '', draftId: 'd1', onScreen: true }), null, "a draft beside the pane's session");
  assert.equal(host({ sessionId: '', onScreen: true }), null);
  assert.equal(host({ sessionId: 'a', onScreen: false }), null, 'session A, retained behind B');
  assert.equal(host({ sessionId: 'a', onScreen: true }), null, 'another session on screen (a dock conversation)');
  assert.equal(host({ sessionId: 'b', onScreen: false }), null, 'the same session parked off screen');
  publishSessionRailSlot('leaf', { element, sessionId: '', draftId: 'd1' });
  assert.equal(host({ sessionId: '', draftId: 'd1', onScreen: true }), element, 'the shown draft draws the panel');
  assert.equal(host({ sessionId: '', draftId: 'd2', onScreen: true }), null, 'another draft');
  assert.equal(host({ sessionId: '', draftId: 'd1', onScreen: false }), null, 'the same draft retained or parked');
  assert.equal(host({ sessionId: 'b', onScreen: true }), null, 'a session on screen beside the draft');
  assert.equal(host({ sessionId: '', onScreen: true }), null);
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
  // A dock open at the pane's side covers the panel, floating (the diff pair at 1,100 px) or inline beside the
  // conversation with room to spare: the conversation gives up room for the dock alone.
  const narrow = layout(1100);
  assert.equal(narrow.dock.overlay, true);
  assert.equal(narrow.dock.pairShowing, true);
  assert.deepEqual([narrow.rail.width, narrow.rail.reserve], [0, 0]);
  const wide = layout(paneFor(400) + FRAME + 800);
  assert.equal(wide.dock.overlay, false);
  assert.equal(wide.dock.pairShowing, true);
  assert.equal(wide.dock.baseAsideWidth + wide.dock.diffWidth, 800);
  assert.deepEqual([wide.rail.width, wide.rail.reserve], [0, 0]);
  // Folded, the panel is back where the pane's width puts it; a dock below the chat covers nothing.
  const folded = paneDockRailLayout({
    cellWidth: 1100,
    bottom: false,
    sheetFrame: FRAME,
    rail: 400,
    dock: { ...pair, openNow: false },
  });
  assert.deepEqual(folded.rail, sessionRailFit({ cellWidth: 1100, railPref: 400 }));
  assert.equal(layout(paneFor(400), true).rail.width, 400);
  // Off: the dock alone.
  assert.equal(
    paneDockRailLayout({ cellWidth: 3000, bottom: false, sheetFrame: FRAME, rail: null, dock: pair }).rail.width,
    0
  );
});

test('one panel width, live in every pane; the resize edge takes keys', async (t) => {
  const { useSessionRailWidth, setSessionRailWidth, resetSessionRailWidth } = await import('./session-rail-layout.ts');
  const { sessionRailWidthForKey } = await import('./SessionRailCard.tsx');
  const widths = {};
  function Pane({ id }) {
    widths[id] = useSessionRailWidth();
    return null;
  }
  const { root } = await mount(
    t,
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Pane, { id: 'a' }),
      React.createElement(Pane, { id: 'b' })
    )
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

async function railCard(t, props) {
  const { SessionRailCard } = await import('./SessionRailCard.tsx');
  const { document, root } = await mount(t, null);
  const proto = window.HTMLElement.prototype;
  const captured = new Set();
  proto.setPointerCapture ??= (id) => {
    captured.add(id);
  };
  proto.releasePointerCapture ??= (id) => {
    captured.delete(id);
  };
  proto.hasPointerCapture ??= (id) => captured.has(id);
  const element = (next = {}) =>
    React.createElement(SessionRailCard, {
      leafId: 'leaf-rail',
      sessionId: LEAD,
      width: 400,
      reserve: 0,
      ...props,
      ...next,
    });
  await act(async () => root.render(element()));
  return { document, root, element };
}

test('the panel has no head row: its resize edge, then the body its sections fill from the top; the panel keeps its name', async (t) => {
  const view = await railCard(t, {});
  const panel = view.document.querySelector('.session-rail');
  assert.equal(panel.getAttribute('aria-label'), 'Session');
  assert.equal(view.document.querySelector('.session-rail-head'), null, 'no head');
  assert.deepEqual(
    [...panel.children].map((child) => child.className),
    ['workbench-side-panel-resize session-rail-resize', 'session-rail-body']
  );
  assert.equal(panel.textContent, '', 'no title');
  assert.equal(panel.querySelector('button'), null, 'no tools of its own');
  await act(async () => view.root.render(null));
});

test('the conversation is told the room it gives up for the panel, and is given it back when the panel goes', async (t) => {
  const view = await railCard(t, { reserve: 344 });
  const cell = view.document.querySelector('.session-rail').parentElement;
  assert.equal(cell.style.getPropertyValue('--session-rail-reserve'), '344px');
  await act(async () => view.root.render(view.element({ reserve: 0 })));
  assert.equal(cell.style.getPropertyValue('--session-rail-reserve'), '0px');
  await act(async () => view.root.render(null));
  assert.equal(cell.style.getPropertyValue('--session-rail-reserve'), '');
});

test('while the margin holds the panel the scroller is told the room the panel takes; with a reserve, none; gone with the panel', async (t) => {
  const view = await railCard(t, { width: 400, reserve: 0 });
  const cell = view.document.querySelector('.session-rail').parentElement;
  assert.equal(cell.style.getPropertyValue('--session-rail-over'), `${400 + SESSION_RAIL_GAP}px`);
  await act(async () => view.root.render(view.element({ width: 336 })));
  assert.equal(
    cell.style.getPropertyValue('--session-rail-over'),
    `${336 + SESSION_RAIL_GAP}px`,
    'it follows the width'
  );
  await act(async () => view.root.render(view.element({ width: 336, reserve: 336 + SESSION_RAIL_GAP })));
  assert.equal(
    cell.style.getPropertyValue('--session-rail-over'),
    '0px',
    'the conversation already ends before the panel'
  );
  await act(async () => view.root.render(null));
  assert.equal(cell.style.getPropertyValue('--session-rail-over'), '');
});

test("the cell carries the panel's band, with a reserve or without, and loses it with the panel", async (t) => {
  const view = await railCard(t, { width: 400, reserve: 0 });
  const cell = view.document.querySelector('.session-rail').parentElement;
  assert.equal(cell.style.getPropertyValue('--session-rail-band'), `${400 + SESSION_RAIL_GAP}px`);
  await act(async () => view.root.render(view.element({ width: 336, reserve: 336 + SESSION_RAIL_GAP })));
  assert.equal(
    cell.style.getPropertyValue('--session-rail-band'),
    `${336 + SESSION_RAIL_GAP}px`,
    'the tab strip ends at the panel either way'
  );
  await act(async () => view.root.render(null));
  assert.equal(cell.style.getPropertyValue('--session-rail-band'), '');
});

test("a press on the panel's frame selects its pane, so what is typed next goes to that pane", async (t) => {
  let selected = 0;
  const view = await railCard(t, { onFocusPane: () => selected++ });
  const press = (target, button = 0) =>
    target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button }));
  await act(async () => press(view.document.querySelector('.session-rail-body'), 2));
  assert.equal(selected, 0, 'only the primary button');
  await act(async () => press(view.document.querySelector('.session-rail-body')));
  assert.equal(selected, 1, 'the body');
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
  const view = await railCard(t, { width: 336 });
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
  await act(async () =>
    edge().dispatchEvent(new window.PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }))
  );
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

async function mount(t, element, host = {}, prepare) {
  const { document, root } = installTestDom(t, {
    rootId: 'root',
    expose: ['HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver'],
  });
  window.mixdogDesktop = { invokeCapability: async () => ({ value: null }), ...host };
  prepare?.(window);
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

/** Opens every kind the session panel's Agents section shows folded (its default). */
async function openKinds(document) {
  for (const fold of document.querySelectorAll(
    '[data-category="agents"] .composer-island-agent-fold[aria-expanded="false"]'
  )) {
    await act(async () => fold.click());
  }
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
const shell = (key, finished) => ({
  key,
  kind: 'shell',
  label: `npm run ${key}`,
  startedAt: Date.now() - 5_000,
  finished,
  taskId: key,
  cwd: '',
});

test('a category is absent when it has nothing, and its body and Clean up show only while it is open', async (t) => {
  const { ShellsSection } = await import('./session-rail-jobs.tsx');
  const element = (shells, open) =>
    React.createElement(ShellsSection, { sessionId: LEAD, shells, shellKeys: null, open, onToggle() {} });
  const { document, root } = await mount(t, element([], true));
  assert.equal(document.querySelector('[data-category="shells"]'), null);
  await act(async () => root.render(element([shell('build', true)], false)));
  const section = document.querySelector('[data-category="shells"]');
  assert.ok(section);
  assert.equal(section.querySelector('[data-kind="close-all"]'), null, 'no Clean up while closed');
  assert.equal(section.querySelector('.session-rail-bd'), null);
  assert.equal(section.querySelector('.session-rail-ft'), null);
  // The head's figures stand at its end: the mark, then how many still run; the chevron right after the name.
  const figures = () => [
    ...document.querySelector('[data-category="shells"] .session-rail-ct > .session-rail-todo-figure').children,
  ];
  const read = () => figures().map((part) => [part.className, part.textContent]);
  assert.equal(
    document.querySelector('[data-category="shells"] .session-rail-ct'),
    null,
    'only an ended shell: neither the mark nor a count'
  );
  assert.equal(document.querySelector('[data-category="shells"] .session-rail-sm').textContent, '');
  assert.ok(
    document.querySelector('[data-category="shells"] .session-rail-tt + .session-rail-cv'),
    'the name, then the chevron'
  );
  await act(async () => root.render(element([shell('build', true)], true)));
  // Clean up at the foot's right end, the island panels' button, named by what it removes; nothing else in the foot.
  const foot = document.querySelector('[data-category="shells"] .session-rail-ft');
  assert.equal(foot?.children.length, 1);
  const tidy = foot.lastElementChild;
  assert.ok(tidy.matches('button.composer-island-button.session-rail-tidy[data-kind="close-all"]'), tidy.outerHTML);
  assert.equal(tidy.getAttribute('aria-label'), 'Clean up', 'Clean up while open');
  assert.equal(tidy.title, 'Clear ended shells');
  assert.ok(
    document.querySelector('[data-category="shells"] .session-rail-bd .composer-island-row'),
    "the island's shell row"
  );
  await act(async () => root.render(element([shell('build', true), shell('dev', false), shell('test', false)], true)));
  assert.deepEqual(
    read(),
    [
      ['composer-island-mark-slot', ''],
      ['', '2'],
    ],
    'two running of three: the mark, then the running count'
  );
  assert.equal(figures()[0].querySelector('.composer-island-dot-idle'), null, 'a running shell: the mark pulses');
});

test("each foot's Clean up: Shells' only while an ended shell is listed, Agents' disabled with nothing to clear", async (t) => {
  const { ShellsSection, AgentsSection } = await import('./session-rail-jobs.tsx');
  const shells = (rows) =>
    React.createElement(ShellsSection, { sessionId: LEAD, shells: rows, shellKeys: null, open: true, onToggle() {} });
  const { document, root } = await mount(t, shells([shell('dev', false)]));
  const tidy = () => document.querySelector('.session-rail-ft > .session-rail-tidy[data-kind]');
  assert.equal(tidy(), null, 'a running shell has nothing to clear: no Clean up');
  assert.equal(document.querySelector('[data-category="shells"] .session-rail-ft'), null, 'and no foot');
  await act(async () => root.render(shells([shell('dev', false), shell('test', true)])));
  assert.equal(tidy().getAttribute('aria-disabled'), null);

  const lead = {
    tag: `lead:${LEAD}`,
    sessionId: LEAD,
    ownerSessionId: LEAD,
    agent: 'lead',
    status: 'idle',
    stage: 'idle',
  };
  const agents = (pool) =>
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows([lead, ...pool], LEAD),
      poolRows: [lead, ...pool],
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    });
  await act(async () => root.render(agents([agent('a', 'running', 'streaming')])));
  assert.equal(tidy().getAttribute('aria-disabled'), 'true', 'a running agent has nothing to clear');
  assert.equal(tidy().getAttribute('aria-label'), 'Clean up');
  const finished = { ...agent('b', 'completed'), settledAt: Date.now() - 1_000 };
  await act(async () => root.render(agents([agent('a', 'running', 'streaming'), finished])));
  assert.equal(tidy().getAttribute('aria-disabled'), null);
  // The foot holds Clean up alone at its right end: the session's usage is Info's row.
  const section = document.querySelector('[data-category="agents"]');
  const foot = section.querySelector('.session-rail-ft');
  assert.deepEqual(
    [...foot.children].map((part) => part.className),
    ['composer-island-button session-rail-tidy']
  );
  // The island's list, one row an agent, the finished one among them (its kind opened).
  await openKinds(document);
  assert.deepEqual(
    [...section.querySelectorAll('.composer-island-agents.agent-pool-list .agent-pool-name')].map(
      (name) => name.textContent
    ),
    ['a', 'b']
  );
});

test("the Agents head reads as the island's segment after its name: the mark and how many are in progress, neither while none is; no state words, no total", async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const section = (pool) =>
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    });
  const head = () =>
    [...document.querySelectorAll('[data-category="agents"] .session-rail-ct > .session-rail-todo-figure > *')].map(
      (part) => [part.className.baseVal ?? part.className, part.textContent]
    );
  const mark = () =>
    document.querySelector(
      '[data-category="agents"] .session-rail-ct > .session-rail-todo-figure > .composer-island-mark-slot'
    );
  const idle = { ...agent('idle', 'completed'), settledAt: Date.now() - 1_000 };
  const { document, root } = await mount(t, section([idle]));
  assert.deepEqual(head(), [], 'an agent at rest: neither the mark nor a count');
  assert.equal(document.querySelector('[data-category="agents"] .session-rail-ct'), null);
  assert.equal(
    document.querySelector('[data-category="agents"] .session-rail-sm').textContent,
    '',
    'nothing at the end'
  );
  await act(async () => root.render(section([agent('stopped', 'cancelled')])));
  assert.deepEqual(head(), [], 'a cancelled agent');
  await act(async () =>
    root.render(section([idle, agent('stopped', 'cancelled'), agent('queued', 'running', 'resource_wait')]))
  );
  assert.deepEqual(
    head(),
    [
      ['composer-island-mark-slot', ''],
      ['', '1'],
    ],
    'a queued agent waits: the mark, then the one in progress'
  );
  assert.ok(mark().querySelector('.composer-island-dot-idle'), 'only waiting: the mark rests');
  await act(async () =>
    root.render(section([idle, agent('a', 'running', 'streaming'), agent('b', 'running', 'streaming')]))
  );
  assert.deepEqual(head(), [
    ['composer-island-mark-slot', ''],
    ['', '2'],
  ]);
  assert.equal(mark().querySelector('.composer-island-dot-idle'), null, 'an agent at work: the mark pulses');
  // An agent waiting on the user: the attention mark in the mark's place, after the count.
  const asking = { ...agent('ask', 'running', 'tool_running'), awaitingUser: 'approval' };
  await act(async () => root.render(section([idle, agent('a', 'running', 'streaming'), asking])));
  const parts = [
    ...document.querySelectorAll('[data-category="agents"] .session-rail-ct > .session-rail-todo-figure > *'),
  ];
  assert.deepEqual(
    parts.map((part) => [part.classList.contains('composer-island-attention'), part.textContent]),
    [
      [true, ''],
      [false, '2'],
    ],
    'the attention mark, then the count: the agent waiting on the user is in progress'
  );
});

test("the Agents section is the island's list: a fold a kind, a line an agent with its step and state, the model in its tooltip; a row opens its session", async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  // The window's interval timers, run by hand.
  const intervals = [];
  const now = Date.now();
  const opened = [];
  const route = (model) => ({ provider: 'anthropic', model, effort: 'medium', fast: null, autoEffort: null });
  const pool = [
    {
      ...agent('fold-rules', 'running', 'streaming'),
      ...route('claude-opus'),
      startedAt: now - 712_000,
      turnStartedAt: now - 712_000,
      todo: { completed: 2, total: 8, current: 'Rewrite the fold rules' },
    },
    { ...agent('no-step', 'running', 'streaming'), ...route('claude-opus'), turnStartedAt: now - 4_565_000 },
    {
      ...agent('tasks', 'running', 'streaming'),
      ...route('claude-opus'),
      turnStartedAt: now - 30_000,
      awaitingTask: 'wait',
    },
    { ...agent('unconfirmed', 'cancel-unconfirmed'), ...route('claude-opus'), turnStartedAt: now - 30_000 },
    { ...agent('queued', 'running', 'resource_wait'), ...route('claude-opus') },
    {
      ...agent('ask', 'running', 'tool_running'),
      ...route('claude-opus'),
      turnStartedAt: now - 30_000,
      awaitingUser: 'approval',
    },
    {
      ...agent('audit', 'completed'),
      ...route('claude-fable'),
      turnStartedAt: now - 1_000_000,
      settledAt: now - 287_000,
    },
    { ...agent('review', 'completed'), agent: 'reviewer', ...route('claude-opus'), settledAt: now - 1_000 },
  ];
  const { document } = await mount(
    t,
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
      onOpenSession: (sessionId) => opened.push(sessionId),
    }),
    {},
    (window) => {
      window.setInterval = (run) => intervals.push(run);
      window.clearInterval = () => {};
    }
  );
  const section = document.querySelector('[data-category="agents"]');
  const list = section.querySelector('.session-rail-bd > .composer-island-jobs.composer-island-agents.agent-pool-list');
  assert.equal(list.getAttribute('role'), 'tree');
  assert.equal(section.querySelector('[role="tablist"]'), null, 'no state tabs');
  // The session panel's kinds start folded (the island's start open); the user's own fold wins from then on.
  assert.deepEqual(
    [...list.querySelectorAll('.composer-island-agent-fold')].map((fold) => fold.getAttribute('aria-expanded')),
    ['false', 'false', 'false']
  );
  assert.equal(list.querySelectorAll('.agent-pool-row').length, 0, 'no rows under a folded kind');
  await openKinds(document);
  // One fold a kind, in the order its first agent appeared, its agents under it; the state column's holder last.
  const outline = () =>
    [...list.children].map((child) =>
      child.matches('.composer-island-agent-group')
        ? `fold ${child.querySelector('.composer-island-agent-fold-name').textContent}`
        : child.matches('.composer-island-agent-item')
          ? child.querySelector('.agent-pool-name').textContent
          : 'sizer'
    );
  // A kind on another model is a kind of its own: Worker on Opus, then (by name, both with no start time) Reviewer and
  // Worker on Fable.
  assert.deepEqual(outline(), [
    'fold Worker',
    'fold-rules',
    'no-step',
    'tasks',
    'unconfirmed',
    'queued',
    'ask',
    'fold Reviewer',
    'review',
    'fold Worker',
    'audit',
    'sizer',
  ]);
  // A kind's line, as To-do's "Remaining 6": the provider's mark, the kind (with its model only where another kind
  // of that name and provider runs another), how many, the chevron; the route its tooltip.
  const folds = () => [...list.querySelectorAll(':scope > .composer-island-agent-group > .composer-island-agent-fold')];
  const fold = (kind) =>
    folds().find((node) => node.querySelector('.composer-island-agent-fold-name').textContent === kind);
  const parts = (node) =>
    [...node.children].map((part) =>
      part.matches('svg.composer-island-agent-fold-cv')
        ? [
            'svg',
            ['lucide-chevron-down', 'lucide-chevron-right'].filter((name) => part.classList.contains(name)).join(''),
          ]
        : [
            ['composer-island-attention', 'composer-island-mark-slot'].find((name) => part.classList.contains(name)) ??
              part.getAttribute('class').split(' ')[0],
            part.textContent,
          ]
    );
  assert.deepEqual(parts(fold('Worker')), [
    ['composer-island-agent-fold-name', 'Worker'],
    ['composer-island-agent-fold-model', ' · claude-opus'],
    ['svg', 'lucide-chevron-down'],
    // Open, the mark of its agent waiting on the user, in the same place as folded.
    ['composer-island-attention', ''],
    ['composer-island-agent-fold-count', '6'],
  ]);
  assert.equal(folds()[2].querySelector('.composer-island-agent-fold-model').textContent, ' · claude-fable');
  const review = list.querySelector('[data-agent-tag="review"]');
  // Its one agent finished: nothing in progress, so neither the mark nor a count; the row is still listed.
  assert.deepEqual(parts(fold('Reviewer')), [
    ['composer-island-agent-fold-name', 'Reviewer'],
    ['svg', 'lucide-chevron-down'],
  ]);
  assert.equal(fold('Reviewer').title, review.title.split('\n')[0], "the route is the kind line's tooltip");
  assert.deepEqual(
    folds().map((node) => [
      node.getAttribute('role'),
      node.getAttribute('aria-level'),
      node.getAttribute('aria-expanded'),
    ]),
    Array.from({ length: 3 }, () => ['treeitem', '1', 'true'])
  );
  assert.equal(fold('Worker').getAttribute('aria-label'), 'Worker · claude-opus: 6 agents, 6 not finished');
  // A row, as a to-do row: its ring where a to-do's state circle stands (a step list or none), the dot of a step in
  // hand at its centre while the agent is not finished, the agent's own name, then its step
  // figure and its state (a running clock in minutes past a minute) in their own columns.
  const rows = [...list.querySelectorAll(':scope > .composer-island-agent-item > [role="treeitem"]')];
  const read = (row) => ({
    name: row.querySelector('.agent-pool-name').textContent,
    ring: Boolean(row.querySelector(':scope > .agent-row-ring > svg')),
    dot: Boolean(row.querySelector(':scope > .agent-row-ring > svg > [data-glyph="active"]')),
    step: row.querySelector(':scope > .agent-row-steps').textContent,
    time: row.querySelector(':scope > .agent-activity-status > .agent-activity-elapsed').textContent,
    working: row.hasAttribute('data-working'),
  });
  assert.deepEqual(rows.map(read), [
    { name: 'fold-rules', ring: true, dot: true, step: '2/8', time: '11m', working: true },
    { name: 'no-step', ring: true, dot: true, step: '', time: '1h 16m', working: true },
    { name: 'tasks', ring: true, dot: true, step: '', time: '30s', working: true },
    { name: 'unconfirmed', ring: true, dot: true, step: '', time: 'Cancel unconfirmed', working: false },
    { name: 'queued', ring: true, dot: true, step: '', time: 'Queued', working: false },
    { name: 'ask', ring: true, dot: true, step: '', time: 'Waiting for approval', working: false },
    { name: 'review', ring: true, dot: false, step: '', time: 'Idle', working: false },
    { name: 'audit', ring: true, dot: false, step: '', time: 'Idle', working: false },
  ]);
  for (const row of rows) {
    assert.deepEqual(
      [...row.children].filter((part) => !part.hidden).map((part) => part.className),
      ['agent-row-ring', 'schedules-row-copy agent-pool-heading', 'agent-row-steps', 'agent-activity-status'],
      'one line: no brand mark, no model line'
    );
  }
  assert.equal(
    rows[0].querySelector('.agent-row-steps').getAttribute('aria-label'),
    'To-do 2 of 8 done: Rewrite the fold rules'
  );
  assert.deepEqual(
    rows.map((row) => [
      row.getAttribute('aria-level'),
      row.getAttribute('aria-posinset'),
      row.getAttribute('aria-setsize'),
    ]),
    [...Array.from({ length: 6 }, (_, index) => ['2', String(index + 1), '6']), ['2', '1', '1'], ['2', '1', '1']]
  );
  // The model is the row's tooltip and, after its state, its description, with the step in hand and a finished
  // agent's worked time.
  const described = (row) =>
    row
      .getAttribute('aria-describedby')
      .split(' ')
      .map((id) => document.getElementById(id).textContent);
  const [model, step] = rows[0].title.split('\n');
  assert.match(model, /\S/);
  assert.equal(step, 'To-do 2 of 8 done: Rewrite the fold rules');
  assert.deepEqual(described(rows[0]), ['11m', rows[0].title]);
  const [auditModel, worked] = rows[7].title.split('\n');
  assert.notEqual(auditModel, model, 'each its own model');
  assert.equal(worked, 'Worked 11m 53s');

  // A fold folds its kind alone, its chevron and aria-expanded following; open or folded it reads as a section head:
  // kind, count, the island's mark while any is not finished (an agent waiting on the user: the attention mark, named
  // in the head when folded), the chevron last, so a toggle moves nothing on the line.
  const lineParts = () => parts(fold('Worker')).map(([kind]) => kind.split(' ')[0]);
  const openParts = lineParts();
  await act(async () => fold('Worker').click());
  assert.deepEqual(lineParts(), openParts, 'the same parts open and folded');
  assert.deepEqual(outline(), ['fold Worker', 'fold Reviewer', 'review', 'fold Worker', 'audit', 'sizer']);
  assert.equal(fold('Worker').getAttribute('aria-expanded'), 'false');
  assert.ok(fold('Worker').querySelector('svg.lucide-chevron-right'));
  assert.equal(
    fold('Worker').getAttribute('aria-label'),
    'Worker · claude-opus: 6 agents, 6 not finished, Needs you 1'
  );
  assert.deepEqual(
    parts(fold('Worker')).map(([kind]) => kind.split(' ')[0]),
    [
      'composer-island-agent-fold-name',
      'composer-island-agent-fold-model',
      'svg',
      'composer-island-attention',
      'composer-island-agent-fold-count',
    ],
    'folded: kind, chevron, then the mark and the count at the end'
  );
  const mark = ':scope > :is(.composer-island-mark-slot, .composer-island-attention)';
  assert.equal(fold('Reviewer').querySelector(mark), null, 'all finished, open: no mark');
  await act(async () => fold('Reviewer').click());
  assert.equal(fold('Reviewer').querySelector(mark), null, 'all finished: no mark');
  await act(async () => fold('Reviewer').click());
  await act(async () => fold('Worker').click());
  assert.equal(outline().length, 12);
  const rowsAgain = [...list.querySelectorAll(':scope > .composer-island-agent-item > [role="treeitem"]')];
  rows.splice(0, rows.length, ...rowsAgain);
  // A row is described by its state column first.
  assert.equal(document.getElementById(rows[0].getAttribute('aria-describedby').split(' ')[0]).textContent, '11m');

  // A second's tick moves the working rows' clocks; their model lines do not read the catalog again.
  const storage = Object.getPrototypeOf(window.localStorage);
  const getItem = storage.getItem;
  let catalogReads = 0;
  storage.getItem = function (key) {
    if (String(key).includes('model-catalog')) catalogReads += 1;
    return getItem.call(this, key);
  };
  t.after(() => {
    storage.getItem = getItem;
  });
  await act(async () => {
    t.mock.timers.tick(1_000);
    for (const run of intervals) run();
  });
  storage.getItem = getItem;
  assert.equal(read(rows[2]).time, '31s', 'the clock ticked');
  assert.equal(read(rows[0]).time, '11m', 'past a minute, minutes alone');
  assert.equal(catalogReads, 0, 'a tick reads the catalog zero times');
  assert.equal(read(rows[7]).time, 'Idle');

  // Any row opens its agent's session.
  await act(async () => rows[0].click());
  await act(async () => rows[7].click());
  assert.deepEqual(opened, ['fold-rules', 'audit']);
});

test('a kind line names its model only where another listed kind of that name and provider runs another, less the brand word they share', async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const run = (id, provider, model, kind = 'worker') => ({
    ...agent(id, 'running', 'streaming'),
    agent: kind,
    provider,
    model,
    effort: 'medium',
  });
  const element = (pool) =>
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    });
  const lines = () =>
    [...document.querySelectorAll('[data-category="agents"] .composer-island-agent-fold')].map((fold) => [
      fold.querySelector('.composer-island-agent-fold-name').textContent,
      fold.querySelector('.composer-island-agent-fold-model')?.textContent ?? '',
    ]);
  const { document, root } = await mount(
    t,
    element([run('a', 'anthropic', 'claude-opus-4-5'), run('b', 'anthropic', 'claude-sonnet-4-5')])
  );
  assert.deepEqual(lines(), [
    ['Worker', ' · Opus 4.5'],
    ['Worker', ' · Sonnet 4.5'],
  ]);
  await act(async () => root.render(element([run('a', 'openai', 'gpt-5.5'), run('b', 'openai', 'gpt-5.4')])));
  assert.deepEqual(
    lines(),
    [
      ['Worker', ' · GPT-5.4'],
      ['Worker', ' · GPT-5.5'],
    ],
    'no brand word they share: the whole name'
  );
  // One kind on two providers: the mark tells them apart, no model; another kind's model is no reason either.
  await act(async () =>
    root.render(
      element([
        run('a', 'anthropic', 'claude-opus-4-5'),
        run('b', 'openai', 'gpt-5.5'),
        run('c', 'anthropic', 'claude-sonnet-4-5', 'reviewer'),
      ])
    )
  );
  assert.deepEqual(lines(), [
    ['Reviewer', ''],
    ['Worker', ''],
    ['Worker', ''],
  ]);
});

test('kinds stand in the order their first agent started: work starting or ending moves no kind', async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const now = Date.now();
  const element = (pool) =>
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    });
  const at = (startedAt, status) =>
    status === 'completed'
      ? { status, stage: status, settledAt: now - 1_000 }
      : { status, stage: 'streaming', startedAt };
  const review = (status) => ({
    ...agent('review', status),
    agent: 'reviewer',
    createdAt: now - 60_000,
    ...at(now - 60_000, status),
  });
  const build = (status) => ({ ...agent('build', status), createdAt: now - 30_000, ...at(now - 30_000, status) });
  const folds = () =>
    [...document.querySelectorAll('[data-category="agents"] .composer-island-agent-fold-name')].map(
      (name) => name.textContent
    );
  const { document, root } = await mount(t, element([review('completed'), build('running')]));
  assert.deepEqual(folds(), ['Reviewer', 'Worker'], 'the finished reviewer started first');
  await act(async () => root.render(element([review('running'), build('completed')])));
  assert.deepEqual(folds(), ['Reviewer', 'Worker']);
  // Kinds with no start time stand by name, whichever of them works.
  const timeless = (id, kind, working) =>
    working
      ? { ...agent(id, 'running', 'streaming'), agent: kind }
      : { ...agent(id, 'completed'), agent: kind, settledAt: now - 1_000 };
  await act(async () => root.render(element([timeless('w', 'worker', true), timeless('r', 'reviewer', false)])));
  assert.deepEqual(folds(), ['Reviewer', 'Worker']);
  await act(async () => root.render(element([timeless('w', 'worker', false), timeless('r', 'reviewer', true)])));
  assert.deepEqual(folds(), ['Reviewer', 'Worker']);
});

test("a kind's line carries the route its agents with a known route share as its tooltip, not on the line; one whose route is not known yet changes nothing", async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const route = { provider: 'anthropic', model: 'claude-opus', effort: 'medium', fast: null, autoEffort: null };
  const pool = [
    { ...agent('a', 'running', 'streaming'), ...route },
    { ...agent('b', 'completed'), ...route, settledAt: Date.now() - 1_000 },
    { ...agent('lost', 'running', 'unknown') },
  ];
  const { document } = await mount(
    t,
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    })
  );
  await openKinds(document);
  const known = document.querySelector('[data-category="agents"] [data-agent-tag="a"]').title;
  assert.match(known, /\S/);
  const folds = [...document.querySelectorAll('.composer-island-agent-fold')];
  assert.equal(folds.length, 1, 'one kind');
  assert.equal(folds[0].querySelector('.composer-island-agent-fold-model'), null, 'no model on the line');
  assert.equal(folds[0].title, known);
});

test("an agent's ledger total is its row's tooltip and description, a lower bound saying it is one", async (context) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const usage = (tokens, unmeasured) => ({
    turns: 2,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens,
    unmeasuredTurns: unmeasured,
    costUsd: 0,
    costKnownTurns: 2,
    costUnpricedTurns: 0,
  });
  const answer = {
    ...usage(1_000, 0),
    agents: usage(1_700, 1),
    sessions: { floored: usage(1_500, 1), exact: usage(200, 0) },
  };
  const pool = [
    { ...agent('floored', 'completed'), settledAt: Date.now() - 1_000 },
    { ...agent('exact', 'completed'), settledAt: Date.now() - 1_000 },
  ];
  const element = React.createElement(AgentsSection, {
    sessionId: LEAD,
    agents: islandAgentRows(pool, LEAD),
    poolRows: pool,
    busy: false,
    shellKeys: null,
    open: true,
    onToggle() {},
  });
  const { document } = await mount(context, element, {
    invokeCapability: async (request) => ({ value: request.capability === 'getSessionUsage' ? answer : null }),
  });
  await act(async () => {});
  await openKinds(document);
  const row = (tag) =>
    [...document.querySelectorAll('[data-category="agents"] [role="treeitem"]')].find(
      (node) => node.dataset.agentTag === tag
    );
  const description = (tag) =>
    row(tag)
      .getAttribute('aria-describedby')
      .split(' ')
      .slice(1)
      .map((id) => document.getElementById(id).textContent)
      .join('');
  // Not on the line: the words of the ledger's total are the row's tooltip and description.
  const worded = (tokens) => t('Total {{tokens}} tokens', { tokens, defaultValue: '{{tokens}} tokens' });
  const floored = `${worded('1.5k')}\n${t('Some usage was not reported by its provider or has no known price; this figure is a lower bound.')}`;
  assert.equal(row('floored').querySelector('.composer-island-agent-tokens, .agent-pool-figures'), null);
  assert.equal(row('floored').title, floored);
  assert.equal(description('floored'), floored);
  assert.equal(row('exact').title, worded('200'));
  assert.equal(description('exact'), worded('200'));
  // The Lead's usage is Info's row: the foot holds the agents' own total (1.7k, not the Lead's 1k added), then Clean up.
  const foot = document.querySelector('[data-category="agents"] .session-rail-ft');
  assert.deepEqual(
    [...foot.children].map((part) => part.className),
    ['composer-usage-readout composer-island-summary', 'composer-island-button session-rail-tidy']
  );
  assert.equal(foot.firstElementChild.firstElementChild.textContent.replace(/·$/, ''), worded('1.7k'));
});

test('a lone agent the pool lost contact with is listed as Unknown and counted as not finished', async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const pool = [{ ...agent('lost', 'running', 'unknown'), turnStartedAt: Date.now() - 30_000 }];
  const { document } = await mount(
    t,
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    })
  );
  assert.equal(
    document.querySelector('.session-rail-tg .session-rail-ct > .session-rail-todo-figure').textContent,
    '1'
  );
  await openKinds(document);
  const row = document.querySelector('[data-category="agents"] .agent-pool-row');
  assert.equal(row.querySelector('.agent-pool-name').textContent, 'lost');
  assert.equal(row.querySelector('.agent-activity-elapsed').textContent, 'Unknown');
});

test("a catalog that arrives after the section is drawn reaches its rows' model tooltips", async (t) => {
  const { AgentsSection } = await import('./session-rail-jobs.tsx');
  const { writeCachedModelCatalog } = await import('./model-catalog-cache.ts');
  const { publishAutoEffort } = await import('./auto-effort-store.ts');
  publishAutoEffort({ autoEffort: { installed: true, enabled: true } });
  t.after(() => publishAutoEffort({ autoEffort: { installed: true, enabled: false } }));
  const pool = [
    {
      ...agent('audit', 'completed'),
      provider: 'anthropic',
      model: 'claude-opus',
      effort: 'medium',
      fast: null,
      autoEffort: null,
    },
  ];
  const { document } = await mount(
    t,
    React.createElement(AgentsSection, {
      sessionId: LEAD,
      agents: islandAgentRows(pool, LEAD),
      poolRows: pool,
      busy: false,
      shellKeys: null,
      open: true,
      onToggle() {},
    })
  );
  await openKinds(document);
  const line = () => document.querySelector('[data-category="agents"] .agent-pool-row').title;
  assert.doesNotMatch(line(), /Auto/, 'the catalog does not know the model yet');
  await act(async () =>
    writeCachedModelCatalog([{ provider: 'anthropic', model: 'claude-opus', autoEffortCapable: true }])
  );
  assert.match(line(), /Auto/, 'the agents did not change; the catalog did');
});

test("folds are one record per session: a fold made in one place shows in every other at once, no write drops another's, and a fresh mount reads them back", async (t) => {
  const { useSessionRailFolds, SESSION_RAIL_CATEGORIES } = await import('./session-rail-folds.ts');
  // The panel and the island showing one session.
  const folds = {};
  function Probe({ name, sessionId }) {
    folds[name] = useSessionRailFolds(sessionId);
    return null;
  }
  const both = (sessionId, key) =>
    React.createElement(
      React.Fragment,
      { key },
      React.createElement(Probe, { name: 'panel', sessionId }),
      React.createElement(Probe, { name: 'island', sessionId })
    );
  const { root } = await mount(t, both('one'));
  // Agents, Shells, Changes and Git start folded and the rest open, until the user turns one; a to-do fold stands
  // as its list asks until the user sets it.
  const foldedFirst = ['agents', 'shells', 'changes', 'git'];
  for (const category of SESSION_RAIL_CATEGORIES)
    assert.equal(folds.panel.isOpen(category), !foldedFirst.includes(category), category);
  assert.equal(folds.panel.groupOpen('done', false), false);
  assert.equal(folds.panel.groupOpen('done', true), true);
  await act(async () => folds.panel.setGroups({ 'agents:Worker': false }));
  assert.equal(folds.island.groupOpen('agents:Worker', true), false, 'the island shows the panel’s fold');
  await act(async () => folds.island.setGroups({ done: true }));
  await act(async () => folds.panel.toggle('agents'));
  await act(async () => folds.island.toggle('info'));
  for (const name of ['panel', 'island']) {
    assert.equal(folds[name].groupOpen('agents:Worker', true), false, name);
    assert.equal(folds[name].groupOpen('done', false), true, name);
    assert.equal(folds[name].isOpen('agents'), true, `${name}: opened against its default`);
    assert.equal(folds[name].isOpen('info'), false, `${name}: folded against its default`);
  }
  await act(async () => root.render(both('two')));
  assert.equal(folds.panel.isOpen('agents'), false, 'another session starts from the defaults');
  assert.equal(folds.panel.isOpen('info'), true);
  assert.equal(folds.panel.groupOpen('agents:Worker', true), true);
  await act(async () => root.render(both('one', 'again')));
  assert.equal(folds.island.isOpen('agents'), true);
  assert.equal(folds.island.isOpen('info'), false);
  assert.equal(folds.island.groupOpen('agents:Worker', true), false);
  assert.equal(folds.island.groupOpen('done', false), true);
});

test('a stored arrangement keeps the categories it names in its order, drops one the panel no longer has, and completes the rest', async () => {
  const { sessionRailOrder, SESSION_RAIL_CATEGORIES } = await import('./session-rail-folds.ts');
  // Written while the panel had a Worktrees category.
  const order = sessionRailOrder(['changes', 'worktrees', 'info']);
  assert.deepEqual(
    order.filter((id) => id === 'changes' || id === 'info'),
    ['changes', 'info']
  );
  assert.deepEqual([...order].sort(), [...SESSION_RAIL_CATEGORIES].sort(), 'every category once, nothing else');
});

test('a category the stored arrangement does not know takes its default place, right above its default next neighbour, whatever the arrangement', async () => {
  const { sessionRailOrder, SESSION_RAIL_CATEGORIES } = await import('./session-rail-folds.ts');
  const without = (id) => SESSION_RAIL_CATEGORIES.filter((other) => other !== id);
  // Written before Outputs: it stands directly above Changes, in the default order and in a rearranged one.
  assert.deepEqual(sessionRailOrder(without('outputs')), [...SESSION_RAIL_CATEGORIES]);
  const arranged = ['git', 'changes', 'info', 'context', 'goal', 'todo', 'shells', 'agents'];
  assert.deepEqual(sessionRailOrder(arranged), [
    'git',
    'outputs',
    'changes',
    'info',
    'context',
    'goal',
    'todo',
    'shells',
    'agents',
  ]);
  // With none of its default followers in the arrangement, right below the last default one before it.
  assert.deepEqual(sessionRailOrder(['shells', 'info']), [
    'context',
    'goal',
    'todo',
    'agents',
    'shells',
    'outputs',
    'changes',
    'git',
    'info',
  ]);
});

test("a draft's folds are kept under the drafts' own key, never under the empty session id", async (t) => {
  const { useSessionRailFolds, SESSION_RAIL_DRAFT_FOLDS, SESSION_RAIL_FOLDS_KEY } = await import(
    './session-rail-folds.ts'
  );
  let folds;
  function Probe({ sessionId }) {
    folds = useSessionRailFolds(sessionId);
    return null;
  }
  const stored = () => JSON.parse(window.localStorage.getItem(SESSION_RAIL_FOLDS_KEY) || '{}');
  const { root } = await mount(t, React.createElement(Probe, { sessionId: SESSION_RAIL_DRAFT_FOLDS }));
  window.localStorage.removeItem(SESSION_RAIL_FOLDS_KEY);
  await act(async () => folds.toggle('info'));
  assert.deepEqual(stored()[SESSION_RAIL_DRAFT_FOLDS]?.closed, ['info']);
  assert.equal(stored()[''], undefined);
  // Every draft reads the same folds back; a session does not.
  await act(async () =>
    root.render(React.createElement(Probe, { key: 'next draft', sessionId: SESSION_RAIL_DRAFT_FOLDS }))
  );
  assert.equal(folds.isOpen('info'), false);
  await act(async () => root.render(React.createElement(Probe, { sessionId: 'session-after' })));
  assert.equal(folds.isOpen('info'), true);
  // Info opened again: the drafts' folds are kept, so the panels drawn after this test start open.
  await act(async () => root.render(React.createElement(Probe, { sessionId: SESSION_RAIL_DRAFT_FOLDS })));
  await act(async () => folds.toggle('info'));
});

test('To-do lists five remaining steps and every working one, folding the rest and the done ones', async (t) => {
  const step = (content, status = 'pending') => ({ content, status });
  const todo = {
    phases: [
      {
        name: 'Fix',
        tasks: [
          step('shipped', 'completed'),
          ...['a', 'b', 'c', 'd', 'e', 'f'].map((name) => step(name)),
          step('working', 'in_progress'),
          step('dropped', 'abandoned'),
        ],
      },
    ],
    completed: 1,
    abandoned: 1,
    total: 9,
  };
  const { document } = await goalSection(t, goalSnapshot(goalOf('active'), todo));
  const rows = (group) =>
    [...document.querySelectorAll(`[data-category="todo"] [data-group="${group}"] .session-rail-row`)].map(
      (row) => row.textContent
    );
  const fold = (key) => document.querySelector(`[data-category="todo"] [data-fold="${key}"]`);
  assert.equal(document.querySelector('[data-group="remaining"] > .session-rail-gl').textContent, 'Remaining 7');
  assert.deepEqual(rows('remaining'), ['a', 'b', 'c', 'd', 'working']);
  assert.equal(fold('rest').textContent, 'Rest 2');
  assert.equal(fold('done').textContent, 'Done 1 · 1 dropped');
  assert.deepEqual(rows('done'), [], 'the done steps stay folded while steps remain');
  await act(async () => fold('rest').click());
  assert.deepEqual(rows('remaining'), ['a', 'b', 'c', 'd', 'working', 'e', 'f']);
  await act(async () => fold('done').click());
  assert.deepEqual(rows('done'), ['shipped', 'dropped']);
});

test('a model picker request while the panel is shown is answered by its Model row, Info unfolding for it', async (t) => {
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
  function Panel({ answers }) {
    const [infoOpen, setInfoOpen] = React.useState(false);
    useFoldedModelPickerRequest(answers, infoOpen, () => setInfoOpen(true));
    return infoOpen ? React.createElement(ModelRow) : null;
  }
  const { root } = await mount(t, React.createElement(Panel, { answers: false }));
  let answered;
  await act(async () => {
    answered = requestOpenModelPicker();
  });
  assert.equal(answered, false, 'a room or a conversation not shown: the composer pill answers, not the panel');
  await act(async () => root.render(React.createElement(Panel, { answers: true })));
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

test('the island is not drawn while the panel is shown, the composer is', async (t) => {
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
  assert.ok(document.querySelector('.probe-goal'), 'no panel: the island carries the goal');
  await act(async () => root.render(element(true)));
  assert.equal(document.querySelector('.probe-goal'), null, 'panel shown: no island');
  assert.ok(document.querySelector('form.composer'));
  assert.equal(document.querySelector('.composer-island'), null);

  // Under the panel the island still holds what the panel has no place for.
  const withIsland = (extra) =>
    React.cloneElement(element(true), extra, React.createElement('form', { className: 'composer' }));
  let cancelled = 0;
  await act(async () =>
    root.render(
      withIsland({ quotaResume: { model: 'Model', resetAt: Date.now() + 60_000, onCancel: () => cancelled++ } })
    )
  );
  assert.ok(document.querySelector('.composer-island'), 'a waiting quota resume keeps its cancel');
  assert.equal(document.querySelector('.probe-goal'), null);
  await act(async () => root.render(element(true)));
  await act(async () =>
    root.render(withIsland({ islandFlash: { key: 'approval:1', text: 'Approved on another device' } }))
  );
  assert.ok(
    document.querySelector('.composer-island'),
    "an approval's result notice has its island from the first frame"
  );
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

async function goalSection(t, snapshot, { goalOpen = true, todoOpen = true } = {}) {
  const { useSessionGoal } = await import('./SessionGoalIsland.tsx');
  const { GoalSection, TodoSection } = await import('./session-rail-goal.tsx');
  const { useSessionRailFolds } = await import('./session-rail-folds.ts');
  function Goal({ snapshot: shown }) {
    const model = useSessionGoal(shown);
    const folds = useSessionRailFolds(LEAD);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(GoalSection, { model, open: goalOpen, onToggle() {} }),
      React.createElement(TodoSection, { model, folds, open: todoOpen, onToggle() {} })
    );
  }
  const mounted = await mount(t, React.createElement(Goal, { snapshot }));
  return {
    ...mounted,
    render: (next) => act(async () => mounted.root.render(React.createElement(Goal, { snapshot: next }))),
  };
}

test('a paused or blocked goal can be dismissed, as on the island; an active one cannot', async (t) => {
  const { document, render } = await goalSection(t, goalSnapshot(goalOf('active')));
  const dismiss = () => document.querySelector('[data-category="goal"] [aria-label="Dismiss goal"]');
  assert.equal(dismiss(), null);
  // The goal line starts with its state, no ring before it.
  const line = document.querySelector('[data-category="goal"] .session-rail-goal-line');
  assert.ok(line.firstElementChild.matches('.session-rail-goal-state'), line.innerHTML);
  assert.equal(line.querySelector('.session-goal-state'), null);
  await render(goalSnapshot(goalOf('paused')));
  assert.ok(dismiss(), 'paused');
  await render(goalSnapshot({ ...goalOf('blocked'), blocker: 'Waiting for the soak machine' }));
  assert.ok(dismiss(), 'blocked');
});

test("a goal title that is only its objective cut short reads the objective, cut at the row's end, and unfolds to the whole of it; another title keeps its own row and the objective under it", async (t) => {
  const objective = 'Find the relay memory leak under a long relay connection, then bisect it';
  const { document, render } = await goalSection(
    t,
    goalSnapshot({ ...goalOf('active'), title: 'Find the relay memory…', objective })
  );
  const row = () => document.querySelector('[data-category="goal"] .session-rail-goal-title');
  const repeated = () => document.querySelector('[data-category="goal"] .session-rail-goal-text.session-rail-muted');
  // The goal's own mark (14px) leads its text; the progress ring stays out of the section.
  const mark = (node) => {
    const first = node.firstElementChild;
    return first.tagName.toLowerCase() === 'svg' && first.classList.contains('session-rail-ic')
      ? first.getAttribute('width')
      : null;
  };
  assert.equal(mark(row()), '14');
  assert.equal(document.querySelector('[data-category="goal"] .session-goal-state'), null, 'no progress ring');
  assert.equal(row().getAttribute('aria-expanded'), 'false');
  assert.equal(
    row().querySelector(':scope > .session-rail-cut').textContent,
    objective,
    'the objective, cut by the row'
  );
  assert.equal(row().dataset.whole, undefined);
  await act(async () => row().click());
  assert.equal(row().getAttribute('aria-expanded'), 'true');
  assert.equal(row().dataset.whole, 'true');
  assert.equal(mark(row()), '14');
  assert.equal(row().querySelector(':scope > .session-rail-cut'), null, 'unfolded, nothing cut');
  assert.equal(row().querySelector(':scope > span').textContent, objective);
  assert.equal(repeated(), null, 'no second paragraph repeating it');

  // A title that says something else: the title on the row, the objective under it once unfolded.
  await render(goalSnapshot({ ...goalOf('paused') }));
  assert.equal(row().querySelector(':scope > .session-rail-cut').textContent, 'Find the leak');
  await act(async () => row().click());
  assert.equal(row().dataset.whole, undefined);
  assert.equal(row().querySelector(':scope > .session-rail-cut').textContent, 'Find the leak');
  assert.equal(repeated()?.textContent, 'Find the relay memory leak');

  // With no title of its own the goal is plain text, led by the same mark.
  await render(goalSnapshot({ ...goalOf('active'), title: '' }));
  assert.equal(row(), null);
  const plain = document.querySelector('[data-category="goal"] p.session-rail-goal-text.session-rail-goal-marked');
  assert.equal(mark(plain), '14');
  assert.deepEqual(
    [...plain.children].map((part) => part.tagName.toLowerCase()),
    ['svg', 'span']
  );
  assert.equal(plain.lastElementChild.textContent, 'Find the relay memory leak');
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

test("a category's head is its name, the fold's chevron right after it, then its figures; no action or menu in it; a fold inside keeps its chevron after its name", async (t) => {
  const todo = {
    phases: [
      {
        name: 'Fix',
        tasks: [
          { content: 'one', status: 'pending' },
          { content: 'two', status: 'completed' },
        ],
      },
    ],
    completed: 1,
    abandoned: 0,
    total: 2,
  };
  // The Goal folded, so its head shows the state it is in.
  const { document } = await goalSection(t, goalSnapshot(goalOf('paused'), todo), { goalOpen: false });
  // The category's own head and each fold inside it.
  const [head, ...folds] = document.querySelectorAll('[data-category="todo"] :is(.session-rail-tg, .session-rail-gh)');
  // A child's class and text; an icon by the classes that say which it is.
  const marks = ['session-rail-cv', 'lucide-chevron-down', 'lucide-chevron-right'];
  const parts = (node) =>
    [...node.children].map((part) =>
      part.tagName.toLowerCase() === 'svg'
        ? ['svg', marks.filter((name) => part.classList.contains(name)).join(' ')]
        : [part.className, part.textContent]
    );
  // The category's head, one control: the name, the fold's chevron (12px), what it holds, then the count.
  assert.deepEqual(parts(head), [
    ['session-rail-tt', 'To-do'],
    ['svg', 'session-rail-cv lucide-chevron-down'],
    ['session-rail-sm', ''],
    ['session-rail-ct', '1/2'],
  ]);
  const chevron = head.querySelector(':scope > .session-rail-cv');
  assert.equal(chevron.getAttribute('width'), '12');
  assert.equal(chevron.getAttribute('aria-hidden'), 'true');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  // The count is the island's figure: its progress ring and n/m, tinted by the Goal's state as on the island.
  const figure = head.querySelector(':scope > .session-rail-ct > .session-rail-todo-figure');
  assert.ok(figure.querySelector(':scope > .session-goal-state svg'), "the island's ring");
  assert.equal(figure.textContent, '1/2');
  const goalState = document.querySelector('[data-category="goal"] .session-rail-goal-state');
  assert.equal(figure.dataset.state, 'paused');
  assert.equal(figure.dataset.state, goalState.dataset.state, "the Goal's state");
  // The head holds its fold control alone: no Clean up, no "…" menu.
  for (const hd of document.querySelectorAll('.session-rail-hd')) {
    assert.deepEqual(
      [...hd.children].map((part) => part.className),
      ['session-rail-tg']
    );
  }
  assert.equal(document.querySelector('[aria-haspopup="menu"]'), null, 'no menu anywhere');
  // The Goal's state has no ring before it, in its folded head or (open) on the goal line.
  const goalHead = document.querySelector('[data-category="goal"] .session-rail-tg');
  assert.deepEqual(
    parts(goalHead).map(([name, text]) => (name === 'svg' ? text : name)),
    ['session-rail-tt', 'session-rail-cv lucide-chevron-right', 'session-rail-sm'],
    'folded: the chevron points right'
  );
  assert.equal(goalHead.querySelector('.session-rail-sm').firstElementChild, goalState);
  assert.equal(
    goalHead.querySelector('.session-rail-sm svg, .session-rail-sm .session-goal-state'),
    null,
    'no ring in the head'
  );
  assert.ok(folds.length > 0);
  for (const fold of folds) {
    const kids = [...fold.children];
    assert.ok(kids[1].classList.contains('session-rail-cv'), `chevron right after the name in "${fold.textContent}"`);
    const count = fold.querySelector(':scope > .session-rail-ct');
    if (count) assert.equal(kids.at(-1), count, `the count last in "${fold.textContent}"`);
  }
});

test("the To-do head, folded or open, ends in its figure alone: never the working step's name", async (t) => {
  const todo = {
    phases: [
      {
        name: 'Fix',
        tasks: [
          { content: 'Bisect the relay leak', status: 'in_progress' },
          { content: 'two', status: 'completed' },
        ],
      },
    ],
    completed: 1,
    abandoned: 0,
    total: 2,
  };
  // Folded (the open head is the head-order test's): the same head as open.
  const { document } = await goalSection(t, goalSnapshot(goalOf('active'), todo), { todoOpen: false });
  const head = document.querySelector('[data-category="todo"] .session-rail-tg');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(head.querySelector('.session-rail-sm').textContent, '', 'no summary');
  assert.doesNotMatch(head.textContent, /Bisect/, 'not the working step');
  assert.ok(head.lastElementChild.matches('.session-rail-ct'), 'the count last');
  assert.deepEqual(
    [...head.lastElementChild.children].map((part) => part.className),
    ['session-rail-todo-figure'],
    'the figure alone'
  );
});

test("pressing a category's head folds and unfolds it, its chevron and aria-expanded following", async (t) => {
  const { RailSection } = await import('./session-rail-parts.tsx');
  function Section() {
    const [open, setOpen] = React.useState(true);
    return React.createElement(
      RailSection,
      { category: 'changes', title: 'Changes', count: 3, open, onToggle: () => setOpen((value) => !value) },
      React.createElement('p', null, 'body')
    );
  }
  const { document } = await mount(t, React.createElement(Section));
  const head = () => document.querySelector('.session-rail-tg');
  const state = () => {
    const chevron = head().querySelector(':scope > svg.session-rail-cv');
    return [
      head().getAttribute('aria-expanded'),
      ['lucide-chevron-down', 'lucide-chevron-right'].find((name) => chevron.classList.contains(name)),
      Boolean(document.querySelector('.session-rail-bd')),
    ];
  };
  assert.deepEqual(state(), ['true', 'lucide-chevron-down', true]);
  await act(async () => head().click());
  assert.deepEqual(state(), ['false', 'lucide-chevron-right', false], 'folded');
  await act(async () => head().click());
  assert.deepEqual(state(), ['true', 'lucide-chevron-down', true], 'open again');
});

test("Info's usage row opens usage; a bot's home thread or a room reads its routines, and a room shows no model", async (t) => {
  const { InfoSection } = await import('./session-rail-info.tsx');
  const opened = [];
  const noop = () => {};
  const element = (sessionId) =>
    React.createElement(InfoSection, {
      open: true,
      onToggle: noop,
      snapshot: {
        sessionId,
        contextPercent: 40,
        contextTokens: 200000,
        stats: { usageReadout: { input: 1200, output: 300 }, costUsd: 1.25 },
      },
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
  // A session that cannot be moved shows its project on a plain row.
  const project = document.querySelector('[data-category="info"] .session-rail-row[title="Project"]');
  assert.equal(project.tagName, 'DIV');
  assert.equal(project.textContent, 'ProjectNo project');
  assert.equal(
    document.querySelector('[data-category="info"] [role="combobox"], [data-category="info"] .session-rail-select'),
    null
  );
  const usage = document.querySelector('[data-category="info"] .session-rail-usage');
  assert.equal(usage.tagName, 'BUTTON', 'reachable by Tab');
  assert.match(usage.textContent, /\$1\.25/, 'the cost the footer shows');
  await act(async () => usage.click());
  assert.deepEqual(opened, ['stats']);
  assert.ok(document.querySelector('[data-category="info"] .session-rail-model'));

  await act(async () => root.render(element('sess_home_helper')));
  assert.notEqual(document.querySelector('[data-category="info"] .session-rail-usage').tagName, 'BUTTON');
  assert.ok(document.querySelector('[data-category="info"] .session-rail-model'), "a bot's thread keeps its model");

  await act(async () => root.render(element('sess_room_abcdef12')));
  assert.equal(
    document.querySelector('[data-category="info"] .session-rail-model'),
    null,
    'each room member runs its own'
  );
});

const optionNamed = (document, label) =>
  [...document.querySelectorAll('.mx-menu [role="option"]')].find((option) => option.textContent.trim() === label);

test("a session's Project row is the composer's project select: a pick moves the session; a pending move stands in it with Cancel beside it, a failed one under it", async (t) => {
  const { InfoSection } = await import('./session-rail-info.tsx');
  const calls = [];
  const noop = () => {};
  const element = (workspace) =>
    React.createElement(InfoSection, {
      open: true,
      onToggle: noop,
      snapshot: { sessionId: LEAD },
      sessionId: LEAD,
      workspace,
      projectPath: 'C:/work/app',
      projectLabel: 'app',
      projects: RAIL_PROJECTS,
      locked: false,
      agentMode: true,
      answersModelPickerRequests: false,
      model: {
        provider: 'anthropic',
        model: 'model',
        effort: '',
        fast: false,
        fastCapable: false,
        sessionId: LEAD,
        modelDisabled: false,
        tuningDisabled: false,
        invokeResult: async (action) => action(),
        applySnapshot: noop,
        onOpenSettings: noop,
      },
      sessionChoices: [],
      onFlash: noop,
      onOpenCommandSurface: noop,
      onMoveSessionToProject: async (sessionId, path) => {
        calls.push(['move', sessionId, path]);
      },
      onAddProject: (onAdded) => {
        calls.push(['add']);
        onAdded?.('C:/work/new');
      },
    });
  const { document, root } = await mount(t, element(null), {}, (window) => {
    window.HTMLElement.prototype.scrollIntoView ??= noop;
  });
  const trigger = () =>
    document.querySelector(
      '[data-category="info"] .session-rail-project > .session-rail-select button.mx-select-trigger'
    );
  assert.equal(trigger().getAttribute('role'), 'combobox');
  assert.equal(trigger().getAttribute('aria-label'), 'Project');
  assert.ok(trigger().querySelector('.mx-select-leading > svg'), 'the folder mark');
  assert.equal(trigger().querySelector('.mx-select-value').textContent, 'app');
  const pick = async (label) => {
    await act(async () => trigger().click());
    await act(async () => optionNamed(document, label).click());
  };
  // The listbox opens in the body: no project, the projects (the current one chosen), then New project… set apart.
  await act(async () => trigger().click());
  const listbox = document.querySelector('.mx-menu[role="listbox"]');
  assert.equal(listbox.parentElement, document.body);
  const options = [...listbox.querySelectorAll('[role="option"]')];
  assert.deepEqual(
    options.map((option) => [option.textContent.trim(), option.getAttribute('aria-selected')]),
    [
      ['No project', 'false'],
      ['app', 'true'],
      ['other', 'false'],
      ['New project…', 'false'],
    ]
  );
  assert.equal(options.at(-1).previousElementSibling?.getAttribute('role'), 'separator');
  assert.equal(document.querySelector('[role="menu"]'), null, 'no move menu');
  await act(async () => optionNamed(document, 'other').click());
  await pick('No project');
  await pick('New project…');
  assert.deepEqual(calls.splice(0), [
    ['move', LEAD, 'C:/work/other'],
    ['move', LEAD, ''],
    ['add'],
    ['move', LEAD, 'C:/work/new'],
  ]);

  // A move kept for the end of the turn: its note in the select, Cancel beside it moving the session back.
  await act(async () => root.render(element({ pendingProjectMove: { projectPath: 'C:/work/other', requestedAt: 1 } })));
  assert.equal(
    trigger().querySelector('.mx-select-value + [data-pending]').textContent,
    'Moving to other after this turn'
  );
  const cancel = document.querySelector(
    '.session-rail-project > .session-rail-select + button[aria-label="Cancel move"]'
  );
  await act(async () => cancel.click());
  assert.deepEqual(calls.splice(0), [['move', LEAD, 'C:/work/app']]);
  // One the core could not carry out says why under the row.
  await act(async () =>
    root.render(element({ projectMoveFailed: { projectPath: 'C:/work/other', message: 'Folder is gone', at: 9 } }))
  );
  assert.equal(trigger().querySelector('[data-pending]'), null);
  const note = document.querySelector('.session-rail-project + .session-rail-note[data-tone="warning"]');
  assert.equal(note.textContent, 'Folder is gone');
});

test("Context is a category of its own: the share, a bar and the two actions; absent until the window's size is known", async (t) => {
  const { ContextSection } = await import('./session-rail-info.tsx');
  const opened = [];
  const element = (snapshot) =>
    React.createElement(ContextSection, {
      open: true,
      onToggle() {},
      snapshot,
      onViewDetails: () => opened.push('context'),
    });
  const asked = [];
  const tokens = (count) => ({ tokens: count });
  const { document, root } = await mount(t, element({ sessionId: LEAD }), {
    invokeCapability: async (request) => {
      asked.push(request);
      return {
        value: {
          messages: { semantic: { system: tokens(20000), chat: tokens(50000) } },
          request: { toolSchemaBreakdown: { code: tokens(10000) } },
        },
      };
    },
  });
  assert.equal(document.querySelector('[data-category="context"]'), null);
  assert.deepEqual(asked, [], 'nothing is read before the session has a reading');
  const reading = { currentContextTokens: 80000, currentContextSource: 'last_api_request' };
  await act(async () => root.render(element({ sessionId: LEAD, contextTokens: 200000, stats: reading })));
  const section = document.querySelector('[data-category="context"]');
  // What the window holds, by kind and largest first: a segment each in the bar, a row each, then the free space.
  assert.deepEqual(asked, [{ capability: 'contextStatus', sessionId: LEAD }]);
  assert.deepEqual(
    [...section.querySelectorAll('[role="meter"] > b')].map((part) => part.dataset.contextKey),
    ['messages', 'system', 'tools']
  );
  assert.deepEqual(
    [...section.querySelectorAll('.session-rail-part')].map((row) => [
      row.dataset.contextKey,
      row.querySelector('.session-rail-share').textContent,
    ]),
    [
      ['messages', '25.0%'],
      ['system', '10.0%'],
      ['tools', '5.0%'],
      // MCP tools keep their row with nothing loaded.
      ['mcp', '0.0%'],
      ['free', '60.0%'],
    ]
  );
  // A kind holding nothing is marked so (its figure reads muted).
  assert.deepEqual(
    [...section.querySelectorAll('.session-rail-part[data-zero]')].map((row) => row.dataset.contextKey),
    ['mcp']
  );
  assert.equal(section.querySelector('.session-rail-sm').textContent, '80k / 200k · 40.0%');
  // 40% is not toned: the percent stands in the text ink.
  assert.equal(section.querySelector('.session-rail-sm .session-rail-context-percent').dataset.tone, undefined);
  assert.equal(section.querySelector('[role="meter"]').getAttribute('aria-valuenow'), '40');
  const buttons = [...section.querySelectorAll('.session-rail-ft button')];
  assert.equal(buttons.length, 2, 'Compact and the details');
  await act(async () => buttons[1].click());
  assert.deepEqual(opened, ['context']);
});

test("Context's kinds divide the head's reading in their estimated proportions, whether the estimates fall short of it or overrun it", async (t) => {
  const { ContextSection } = await import('./session-rail-info.tsx');
  const element = (used) =>
    React.createElement(ContextSection, {
      open: true,
      onToggle() {},
      snapshot: {
        sessionId: LEAD,
        contextTokens: 500000,
        stats: { currentContextTokens: used, currentContextSource: 'last_api_request' },
      },
      onViewDetails() {},
    });
  // The kinds are estimated at 240k together.
  const { document, root } = await mount(t, element(480000), {
    invokeCapability: async () => ({
      value: {
        messages: { semantic: { system: { tokens: 10000 }, chat: { tokens: 220000 } } },
        request: { toolSchemaBreakdown: { code: { tokens: 10000 } } },
      },
    }),
  });
  const section = () => document.querySelector('[data-category="context"]');
  const rows = () =>
    [...section().querySelectorAll('.session-rail-part')].map((row) => [
      row.dataset.contextKey,
      row.querySelector('.session-rail-num').textContent,
      row.querySelector('.session-rail-share').textContent,
    ]);
  const filled = () =>
    [...section().querySelectorAll('[role="meter"] > b')].reduce(
      (sum, part) => sum + Number.parseFloat(part.style.width),
      0
    );
  assert.equal(section().querySelector('.session-rail-sm').textContent, '480k / 500k · 96.0%');
  // A reading twice the estimates: every kind's figure and segment doubles, the rows add up to the reading, and the
  // free space is what the reading leaves.
  assert.deepEqual(rows(), [
    ['messages', '440k', '88.0%'],
    ['system', '20k', '4.0%'],
    ['tools', '20k', '4.0%'],
    ['mcp', '0', '0.0%'],
    ['free', '20k', '4.0%'],
  ]);
  assert.deepEqual(
    [...section().querySelectorAll('[role="meter"] > b')].map((part) => part.dataset.contextKey),
    ['messages', 'system', 'tools']
  );
  assert.ok(Math.abs(filled() - 96) < 0.01, `the bar is filled to the reading: ${filled()}`);
  // A reading half the estimates: the same proportions of the smaller figure.
  await act(async () => root.render(element(120000)));
  assert.deepEqual(rows(), [
    ['messages', '110k', '22.0%'],
    ['system', '5.0k', '1.0%'],
    ['tools', '5.0k', '1.0%'],
    ['mcp', '0', '0.0%'],
    ['free', '380k', '76.0%'],
  ]);
  assert.ok(Math.abs(filled() - 24) < 0.01, `the bar is filled to the reading: ${filled()}`);
});

test("An external agent's context shows Mixdog's own parts as they are, and the rest of the reading as what the agent holds", async () => {
  const { contextMix, ContextBody } = await import('./ContextBody.tsx');
  const status = {
    messages: { semantic: { system: { tokens: 100 }, chat: { tokens: 50 } } },
    request: { toolSchemaBreakdown: { code: { tokens: 30 }, skills: { tokens: 20 }, mcp: { tokens: 10 } }, requestOverheadTokens: 7 },
  };
  const rows = (mix) => Object.fromEntries(mix.categories.map((category) => [category.key, category.tokens]));
  assert.deepEqual(rows(contextMix(status, 1000, 900, true)), {
    system: 100,
    mcp: 60,
    memory: 0,
    messages: 50,
    reasoning: 0,
    host: 690,
  });
  const mix = contextMix(status, 1000, 900, true);
  assert.equal(mix.held, 900);
  assert.equal(mix.free, 100);
  assert.equal(rows(contextMix(status, 1000, null, true)).host, 0, 'no reading, nothing to say the agent holds');
  // An estimate (210) above the agent's own count (100): the count is the measurement, the parts divide within it, and
  // parts plus free space never pass the window.
  const over = contextMix(status, 1000, 100, true);
  const sum = (mix) => mix.categories.reduce((total, category) => total + category.tokens, 0);
  assert.equal(rows(over).host, 0);
  assert.equal(sum(over), 100);
  assert.equal(sum(over) + over.free, 1000);
  const tight = contextMix(status, 120, 120, true);
  assert.ok(sum(tight) + tight.free <= 120, 'a window the reading fills has no free space and no overflow');
  // A reading with no local estimate yet is all the agent's, and its rows show.
  const bare = contextMix({}, 1000, 300, true);
  assert.deepEqual([rows(bare).host, bare.categorized, bare.free], [300, 300, 700]);
  assert.equal(rows(contextMix(status, 1000, 900, false)).host, undefined, 'a provider session has no row for the agent');

  const { renderToStaticMarkup } = await import('react-dom/server');
  const label = (provider) =>
    renderToStaticMarkup(
      React.createElement(ContextBody, {
        status: { sessionId: 'label', contextWindow: 1000, measurement: { source: 'last_api_request', tokens: 900 } },
        snapshot: { provider },
      })
    );
  // The dialog reads `contextStatus` with an inspection attached: an agent's session still shows the rail's composition.
  const inspected = renderToStaticMarkup(
    React.createElement(ContextBody, {
      status: {
        sessionId: 'inspected',
        contextWindow: 1000,
        measurement: { source: 'last_api_request', tokens: 900 },
        messages: { semantic: { system: { tokens: 100 } } },
        inspection: {
          revision: 'r',
          entries: [],
          categories: [{ key: 'system', label: 'System prompt', tokens: 100, count: 1 }],
          estimatedTokens: 100,
        },
      },
      snapshot: { provider: 'acp-antigravity' },
    })
  );
  assert.match(inspected, /context-mix-row[^>]*data-context-key="host"/);
  assert.doesNotMatch(inspected, /<button[^>]*data-context-key/);
  assert.match(label('acp-antigravity'), /Last call, prompt and output/);
  assert.doesNotMatch(label('acp-antigravity'), /Last measured input/);
  assert.match(label('openai'), /Last measured input/);
});

test('Context divides a reading into whole tokens that add up to it, and shows no rows for one it cannot divide', async (t) => {
  const { contextMix } = await import('./ContextBody.tsx');
  const thirds = {
    messages: { semantic: { system: { tokens: 1 }, chat: { tokens: 1 } } },
    request: { toolSchemaBreakdown: { code: { tokens: 1 } } },
  };
  assert.equal(
    contextMix(thirds, 1000, 500).categories.reduce((sum, category) => sum + category.tokens, 0),
    500,
    'the rounding remainder is shared out'
  );
  const { ContextSection } = await import('./session-rail-info.tsx');
  const { document } = await mount(
    t,
    React.createElement(ContextSection, {
      open: true,
      onToggle() {},
      snapshot: {
        sessionId: 'sess_no_estimates',
        contextTokens: 500000,
        stats: { currentContextTokens: 120000, currentContextSource: 'last_api_request' },
      },
      onViewDetails() {},
    }),
    { invokeCapability: async () => ({ value: {} }) }
  );
  const section = document.querySelector('[data-category="context"]');
  assert.equal(section.querySelector('.session-rail-sm').textContent, '120k / 500k · 24.0%');
  assert.equal(section.querySelectorAll('.session-rail-part').length, 0, 'no row claims the window is free');
  assert.equal(section.querySelector('[role="meter"] > i').style.width, '24%');
});

test('Context reads its rows again with each reading of a running turn, and keeps them through a compaction', async (t) => {
  const { ContextSection } = await import('./session-rail-info.tsx');
  const element = (stats) =>
    React.createElement(ContextSection, {
      open: true,
      onToggle() {},
      snapshot: { sessionId: LEAD, busy: true, contextTokens: 200000, stats },
      onViewDetails() {},
    });
  const chats = [70000, 110000, 4000];
  let reads = 0;
  const reading = (tokens) => ({ currentContextTokens: tokens, currentContextSource: 'last_api_request' });
  const { document, root } = await mount(t, element(reading(80000)), {
    invokeCapability: async () => ({
      value: {
        messages: { semantic: { system: { tokens: 6000 }, chat: { tokens: chats[reads++] } } },
        request: { toolSchemaBreakdown: { code: { tokens: 4000 } } },
      },
    }),
  });
  const section = () => document.querySelector('[data-category="context"]');
  const messages = () => section().querySelector('.session-rail-part[data-context-key="messages"] .session-rail-num');
  assert.equal(messages().textContent, '70k');
  await act(async () => root.render(element(reading(120000))));
  assert.equal(reads, 2, 'a new reading of the running turn reads the rows again');
  assert.equal(section().querySelector('.session-rail-sm').textContent, '120k / 200k · 60.0%');
  assert.equal(messages().textContent, '110k');
  // A compaction voids the reading until the next request measures the compacted window.
  await act(async () => root.render(element({ currentContextTokens: null, currentContextSource: 'pending' })));
  assert.ok(section(), 'the category stays while the compacted window awaits its measurement');
  assert.equal(reads, 3, 'the compaction reads the rows again');
  // With no reading the head shows what the rows are estimated to hold, marked as an estimate.
  assert.equal(section().querySelector('.session-rail-sm').textContent, '~14k / 200k · 7.0%');
  assert.equal(messages().textContent, '4.0k');
});

test('Context mounted on an unmeasured window shows its rows and their estimated sum in the head', async (t) => {
  const { ContextSection } = await import('./session-rail-info.tsx');
  const asked = [];
  const pending = { currentContextTokens: null, currentContextSource: 'pending' };
  const { document } = await mount(
    t,
    React.createElement(ContextSection, {
      open: true,
      onToggle() {},
      snapshot: { sessionId: 'compacted-rail', contextTokens: 500000, stats: pending },
      onViewDetails() {},
    }),
    {
      invokeCapability: async (request) => {
        asked.push(request);
        return { value: { messages: { semantic: { chat: { tokens: 9600 } } } } };
      },
    }
  );
  const section = document.querySelector('[data-category="context"]');
  assert.ok(section, 'a fresh card on a compacted session still shows');
  assert.equal(section.querySelector('.session-rail-sm').textContent, '~9.6k / 500k · 1.9%');
  assert.deepEqual(asked, [{ capability: 'contextStatus', sessionId: 'compacted-rail' }]);
  assert.equal(
    section.querySelector('.session-rail-part[data-context-key="messages"] .session-rail-num').textContent,
    '9.6k'
  );
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
      renderTrigger: (button) =>
        React.createElement('button', { ...button, type: 'button', className: 'probe-branch-row' }, 'Branch'),
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
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) =>
    node.textContent.includes('Open folder')
  );
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

test("the Branch row's tab is a popup in the body: its row and its own presses or scrolls keep it; a press outside, Escape or a scroll outside closes it", async (t) => {
  const { BranchIslandSegment, clearBranchSegmentCache } = await import('./WorktreeIslandSegment.tsx');
  clearBranchSegmentCache();
  const menu = {
    workspace: worktreeWorkspace(),
    branches: [{ name: 'main' }, { name: 'feature' }],
    occupancy: [{ branch: 'main', kind: 'current' }],
    retainedWorktree: null,
  };
  const { document } = await mount(
    t,
    React.createElement(
      'div',
      { className: 'probe-info' },
      React.createElement(BranchIslandSegment, {
        sessionId: LEAD,
        workspace: worktreeWorkspace(),
        projectPath: worktreeProject,
        renderTrigger: (button) =>
          React.createElement('button', { ...button, type: 'button', className: 'probe-branch-row' }, 'Branch'),
      })
    ),
    { invokeCapability: async ({ capability }) => ({ value: capability === 'getBranchMenu' ? menu : null }) }
  );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const row = () => document.querySelector('.probe-branch-row');
  const host = () => document.querySelector('.branch-tab-host');
  const open = async () => {
    await act(async () => row().click());
    await settle();
    assert.ok(host(), 'open');
  };
  const dispatch = (target, event) => act(async () => target.dispatchEvent(event));
  await open();
  // Portalled out of the row's section, the island's own branch panel in it.
  assert.equal(host().parentElement, document.body);
  assert.equal(document.querySelector('.probe-info .branch-tab-host'), null, 'nothing drawn inside the section');
  assert.ok(host().querySelector(':scope > section.composer-island-panel.composer-island-branch-panel'));
  // No head and no close button: Escape, a press outside or a scroll outside close it.
  assert.equal(host().querySelector('.composer-island-phead, .composer-island-close'), null);
  assert.equal(row().getAttribute('aria-expanded'), 'true');
  // Its own presses and wheel, and a press on its row's way to toggling it, keep it.
  await dispatch(host().querySelector('section'), new window.PointerEvent('pointerdown', { bubbles: true }));
  await dispatch(host().querySelector('section'), new window.WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
  await dispatch(row(), new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.ok(host(), 'its own presses, its own scroll and its row keep it');
  // A user scroll outside closes it.
  await dispatch(document.body, new window.WheelEvent('wheel', { bubbles: true, deltaY: 40 }));
  assert.equal(host(), null, 'a wheel outside');
  await open();
  await dispatch(document.body, new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(host(), null, 'a press outside');
  await open();
  await dispatch(
    host().querySelector('section'),
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  assert.equal(host(), null, 'Escape');
});

test("the Changes head reads the island's files head: Files N and the lines added and removed, with no count; its foot's View changes carries an icon", async (context) => {
  const { ChangesSection } = await import('./session-rail-changes.tsx');
  const entry = (additions, deletions) => ({
    additions,
    deletions,
    lineStats: true,
    status: 'M',
    binary: false,
    parts: [],
  });
  const files = new Map([
    ['README.md', entry(1, 0)],
    ['src/app/main.ts', entry(9, 3)],
    ['src/app/util.ts', entry(2, 1)],
  ]);
  const view = {
    label: 'Uncommitted',
    fileCount: 3,
    files,
    headlineStats: { additions: 12, deletions: 4, hasLineStats: true },
    emptyText: '',
  };
  const opened = [];
  const { document } = await mount(
    context,
    React.createElement(ChangesSection, {
      view,
      cwd: 'C:/work/app',
      open: true,
      onToggle() {},
      onOpenChanges: () => opened.push('changes'),
      onOpenChangeFile: (path) => opened.push(path),
    })
  );
  const section = document.querySelector('[data-category="changes"]');
  assert.deepEqual(
    [...section.querySelector('.session-rail-sm').children].map((part) => part.textContent),
    ['Files 3', '+12', '−4']
  );
  assert.equal(section.querySelector('.session-rail-tg .session-rail-ct'), null);
  // No source menu: the foot's View changes, its icon before its words.
  assert.equal(section.querySelector('[aria-haspopup]'), null);
  const viewChanges = section.querySelector('.session-rail-ft button.composer-island-button');
  assert.deepEqual(
    [...viewChanges.children].map((part) => part.tagName.toLowerCase()),
    ['svg', 'span']
  );
  assert.equal(viewChanges.textContent, t('Island: View changes'));
  await act(async () => viewChanges.click());
  // The island's file rows, most changed first: the folder, the name, then the line counts.
  const rows = [...section.querySelectorAll('.session-rail-bd > .session-rail-row')];
  assert.deepEqual(
    rows.map((row) => [
      row.querySelector('.turn-review-files-path > .turn-review-files-dir')?.textContent ?? '',
      row.querySelector('.turn-review-files-path > .turn-review-files-name').textContent,
      row.querySelector('.diff-stats').textContent,
    ]),
    [
      ['src/app/', 'main.ts', '+9 −3'],
      ['src/app/', 'util.ts', '+2 −1'],
      ['', 'README.md', '+1'],
    ]
  );
  // Each row starts with the plain file mark (14px, the rows' mark), then the path.
  for (const row of rows) {
    const mark = row.firstElementChild;
    assert.equal(mark.tagName.toLowerCase(), 'svg');
    assert.match(mark.getAttribute('class'), /\bsession-rail-ic\b/);
    assert.match(mark.getAttribute('class'), /\blucide-file\b/);
    assert.equal(mark.getAttribute('width'), '14');
    assert.equal(mark.nextElementSibling.className, 'turn-review-files-path');
  }
  await act(async () => rows[0].click());
  assert.deepEqual(opened, ['changes', 'src/app/main.ts']);
});

test('a clean branch with commits not pushed keeps Git and its actions', async (context) => {
  const { GitSection } = await import('./session-rail-changes.tsx');
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
  const Host = () => {
    const [open, setOpen] = React.useState(false);
    return React.createElement(GitSection, { sessionId: LEAD, cwd, open, onToggle: () => setOpen(!open) });
  };
  const { document } = await mount(context, React.createElement(Host), {
    gitStatus: async () => status(2),
    gitReview: async () => ({ repository: true, root: cwd, base: 'HEAD', files: [] }),
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  const section = document.querySelector('[data-category="git"]');
  assert.ok(section, 'two commits ahead: the category stays');
  // The closed head shows the commits to push, with no file count and without the branch's name (Info's row).
  const head = section.querySelector('.session-rail-tg');
  assert.equal(head.querySelector('.session-rail-sm').textContent, '↑2');
  assert.doesNotMatch(head.textContent, /main/);
  const run = () => section.querySelector('.session-rail-hd > .composer-island-git-run');
  // Folded: the Run of the picked action stands at the head's end, after the count.
  assert.equal(run().getAttribute('aria-label'), `${t('Run')}: ${t('Commit')}`, 'closed: the Run is shown');
  // Open: the actions as one choice (Commit until another is picked), and the one Run at the head's end.
  await act(async () => head.click());
  const picks = () =>
    [...section.querySelectorAll('.composer-island-git-row')].map((row) => [
      row.dataset.action,
      row.getAttribute('role'),
      row.getAttribute('aria-checked'),
      Boolean(row.querySelector('.session-rail-git-on')),
    ]);
  assert.deepEqual(picks(), [
    ['pr', 'radio', 'false', false],
    ['commit-push', 'radio', 'false', false],
    ['commit', 'radio', 'true', true],
  ]);
  assert.equal(run().getAttribute('aria-label'), `${t('Run')}: ${t('Commit')}`);
  assert.equal(head.querySelector('.session-rail-sm').textContent, '', 'open: Run stands where the count stood');
  await act(async () => section.querySelector('.composer-island-git-row[data-action="pr"]').click());
  assert.deepEqual(
    picks().map(([action, , checked]) => [action, checked]),
    [
      ['pr', 'true'],
      ['commit-push', 'false'],
      ['commit', 'false'],
    ]
  );
  assert.equal(run().getAttribute('aria-label'), `${t('Run')}: ${t('Create PR')}`);
});

// ── A New Task's panel: panes whose conversations are the real composer dock ──

const RAIL_MODEL = {
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
const RAIL_PROJECTS = [
  { path: 'C:/work/app', name: 'app' },
  { path: 'C:/work/other', name: 'other' },
];
const railBranch = (name, current = false) => ({ name, current, remote: false, upstream: '' });
const RAIL_PROJECT_MENU = {
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
  branches: [railBranch('main', true), railBranch('dev')],
  occupancy: [
    { branch: 'main', kind: 'current' },
    { branch: 'dev', kind: 'free' },
  ],
  retainedWorktree: null,
};

/** Panes of a cell each: the session panel and the pane's conversation (the composer dock), with a retained one behind
 *  it when asked. `calls` records what the draft's controls staged. */
async function railPanes(t) {
  const { ConversationComposerDock } = await import('./conversation-pane-composer-dock.tsx');
  const { SessionRailCard } = await import('./SessionRailCard.tsx');
  const { SurfaceActiveContext } = await import('./surface-activity.ts');
  const { storeWorkflowOptions } = await import('./workflow-options-cache.ts');
  const { clearBranchMenuCache } = await import('./branch-menu.tsx');
  // The dock loads the panel's body lazily: loaded here, it resolves within a render's settling.
  await import('./SessionRail.tsx');
  const calls = [];
  const noop = () => {};
  const mounted = await mount(
    t,
    null,
    {
      rendererDiagnostic: noop,
      listProviderModels: async () => [RAIL_MODEL],
      sessionStreamPosition: async () => ({ epoch: 'unfed', seq: 1, order: 1 }),
      invokeCapability: async (request) => {
        if (request.capability === 'getProviderSetup')
          return { value: { api: [{ id: 'openai', authenticated: true }] } };
        if (request.capability === 'getProjectBranchMenu') return { value: RAIL_PROJECT_MENU };
        return { value: null };
      },
    },
    (window) => {
      window.HTMLElement.prototype.scrollIntoView ??= noop;
      // React's input-event fallback for an engine without `input` events, which jsdom looks like to it.
      window.HTMLElement.prototype.attachEvent ??= noop;
      window.HTMLElement.prototype.detachEvent ??= noop;
      if (!globalThis.ResizeObserver) {
        globalThis.ResizeObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
        t.after(() => delete globalThis.ResizeObserver);
      }
    }
  );
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
        if (!actionCache.has(name))
          actionCache.set(name, name === 'composerInvokeResult' ? (action) => action() : noop);
        return actionCache.get(name);
      },
    }
  );
  const island = {
    wrapSubmit: (submit) => submit,
    approval: null,
    islandFlash: null,
    quotaCard: null,
    quotaResume: null,
  };
  const submission = {
    goalSubmissionId: '',
    reviewItems: [],
    steerItems: [],
    pendingPromptIds: [],
    holdSlashCommand: noop,
    actions,
  };
  const conversation = (selection, leafId) => {
    const draft = selection.kind === 'new';
    const snapshot = draft ? {} : { sessionId: selection.id };
    return React.createElement(ConversationComposerDock, {
      snapshot,
      routeSnapshot: snapshot,
      sessionAddress: draft ? '' : selection.id,
      transitioning: false,
      composerFocusRequest: 0,
      projects: RAIL_PROJECTS,
      showProjectSelector: draft,
      activeProjectPath: 'C:/work/app',
      activeProjectLabel: 'app',
      onClearProject: () => calls.push(['clear']),
      onSelectProject: (path) => calls.push(['project', path]),
      draftWorkflow: null,
      onDraftWorkflow: draft ? (workflow) => calls.push(['workflow', workflow]) : undefined,
      draftOrchestrationMode: draft ? 'none' : null,
      onDraftOrchestrationMode: draft ? (mode) => calls.push(['mode', mode]) : undefined,
      draftModelSelection: draft ? { provider: RAIL_MODEL.provider, model: RAIL_MODEL.model, effort: 'high' } : null,
      onDraftModelSelection: draft ? (selected) => calls.push(['model', selected]) : undefined,
      contextIndicator: null,
      usageReadout: null,
      goalIsland: null,
      onAddProject: (onAdded) => {
        calls.push(['add']);
        onAdded?.('C:/work/new');
      },
      onMoveSessionToProject: async (sessionId, path) => {
        calls.push(['move', sessionId, path]);
      },
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
    });
  };
  /** One pane: `selection` its shown tab; `retained` a conversation kept behind it; `rail` false for no panel. */
  const pane = ({ leafId, selection, retained = null, rail = true }) =>
    React.createElement(
      'div',
      { key: leafId, className: 'probe-cell', 'data-leaf': leafId },
      rail &&
        React.createElement(SessionRailCard, {
          leafId,
          sessionId: selection.kind === 'session' ? selection.id : '',
          draftId: selection.kind === 'new' ? selection.draftId : '',
          width: 400,
          reserve: 408,
        }),
      React.createElement('div', { 'data-conversation': 'shown' }, conversation(selection, leafId)),
      retained &&
        React.createElement(
          'div',
          { 'data-conversation': 'retained' },
          React.createElement(SurfaceActiveContext.Provider, { value: false }, conversation(retained, leafId))
        )
    );
  const settle = () =>
    act(async () => {
      for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const render = async (...panes) => {
    await act(async () => mounted.root.render(React.createElement(React.Fragment, null, ...panes.map(pane))));
    await settle();
  };
  const cell = (leafId) => mounted.document.querySelector(`[data-leaf="${leafId}"]`);
  const body = (leafId) => cell(leafId).querySelector('.session-rail-body');
  return { ...mounted, calls, pane, render, settle, cell, body };
}

const menuItemNamed = (document, label) =>
  [...document.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent.trim() === label);

test("a New Task's panel holds its Info alone, each row the draft's own; its composer draws none of them", async (t) => {
  const { getBranchIntent } = await import('./worktree-branch-model.ts');
  const view = await railPanes(t);
  const { document, calls } = view;
  const draft = { kind: 'new', draftId: 'd-rows' };
  // Without a panel the draft's composer carries its pickers and its model pill.
  await view.render({ leafId: 'bare', selection: draft, rail: false });
  const composer = () => view.cell('bare').querySelector('[data-conversation="shown"]');
  assert.ok(composer().querySelector('.composer-project-context'), 'the context bar, without a panel');
  assert.ok(composer().querySelector('.model-trigger'), 'the model pill, without a panel');

  await view.render({ leafId: 'bare', selection: draft });
  const rail = view.body('bare');
  assert.deepEqual(
    [...rail.querySelectorAll('[data-category]')].map((section) => section.dataset.category),
    ['info'],
    'Info alone: no usage, Context, Goal, To-do, Agents, Shells, Changes or Git'
  );
  assert.equal(rail.querySelector('.session-rail-usage'), null);
  const row = (title) => rail.querySelector(`button.session-rail-row.session-rail-pick[title="${title}"]`);
  for (const title of ['Branch and worktree', 'Workflow', 'Delegation mode']) {
    assert.ok(row(title), `the ${title} row`);
    assert.ok(row(title).querySelector(':scope > svg.session-rail-ic'), `${title}: the 14px mark`);
    assert.ok(row(title).querySelector(':scope > .session-rail-pk'), `${title}: the pick mark`);
  }
  // Project: the composer's project select, its folder mark before the draft's project.
  const project = rail.querySelector(
    '[data-category="info"] > .session-rail-bd > .session-rail-select button.mx-select-trigger'
  );
  assert.equal(project.getAttribute('role'), 'combobox');
  assert.equal(project.getAttribute('aria-label'), 'Project');
  assert.ok(project.querySelector('.mx-select-leading > svg'));
  assert.equal(project.querySelector('.mx-select-value').textContent, 'app');
  assert.equal(row('Workflow').querySelector('.session-rail-cut').textContent, 'Default');
  assert.equal(row('Delegation mode').querySelector('.session-rail-cut').textContent, 'Solo');
  assert.match(
    rail.querySelector('.session-rail-model button').textContent,
    /Rail draft model/,
    "the Model row: the draft's model"
  );
  // The composer draws none of it a second time.
  assert.equal(composer().querySelector('.composer-project-context'), null, 'no context bar');
  assert.equal(composer().querySelector('.composer-model-line'), null);
  assert.equal(composer().querySelector('.model-trigger'), null, 'no model pill');
  assert.ok(composer().querySelector('form.composer'), 'the composer itself');

  // Project: an arrow key opens its listbox in the body; a pick, no project and a new one stage the draft's.
  await act(async () =>
    project.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  );
  assert.equal(project.getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.mx-menu[role="listbox"]').parentElement, document.body);
  assert.deepEqual(
    [...document.querySelectorAll('.mx-menu [role="option"]')].map((option) => option.textContent.trim()),
    ['No project', 'app', 'other', 'New project…']
  );
  await act(async () => optionNamed(document, 'other').click());
  await act(async () => project.click());
  await act(async () => optionNamed(document, 'No project').click());
  await act(async () => project.click());
  await act(async () => optionNamed(document, 'New project…').click());
  assert.deepEqual(calls.splice(0), [['project', 'C:/work/other'], ['clear'], ['add'], ['project', 'C:/work/new']]);

  // Workflow and delegation: the draft's own.
  await act(async () => row('Workflow').click());
  await act(async () => menuItemNamed(document, 'Review').click());
  await act(async () => row('Delegation mode').click());
  const swarm = [...document.querySelectorAll('[role^="menuitem"]')].find((item) => item.textContent.includes('Swarm'));
  await act(async () => swarm.click());
  assert.deepEqual(calls.splice(0), [
    ['workflow', { id: 'review', name: 'Review' }],
    ['mode', 'swarm'],
  ]);

  // Branch: the New Task branch tab; a pick is the draft's branch.
  await act(async () => row('Branch and worktree').click());
  await act(async () => document.querySelector('.branch-tab-host [data-branch="dev"]').click());
  assert.equal(getBranchIntent('d-rows')?.branch, 'dev');

  // Model: a picker request is the panel's Model row's; a pick stages the draft's route.
  let answered;
  await act(async () => {
    answered = requestOpenModelPicker();
  });
  assert.equal(answered, true);
  const effort = [...document.querySelectorAll('.route-sheet-row')].find((button) =>
    button.textContent.includes('Reasoning effort')
  );
  await act(async () => effort.click());
  await act(async () => menuItemNamed(document, 'Low').click());
  assert.equal(calls.at(-1)[0], 'model');
  assert.equal(calls.at(-1)[1].effort, 'low');
  await act(async () => view.root.render(null));
});

test("a draft's first message keeps its panel: the same element, width and reserve, its Info now the session's", async (t) => {
  const { flushSync } = await import('react-dom');
  const view = await railPanes(t);
  await view.render({ leafId: 'promote', selection: { kind: 'new', draftId: 'd-send' } });
  const aside = view.cell('promote').querySelector('.session-rail');
  const width = aside.style.width;
  const reserve = view.cell('promote').style.getPropertyValue('--session-rail-reserve');
  assert.ok(view.body('promote').querySelector('[data-category="info"] .session-rail-select'), "the draft's Info");
  assert.equal(view.body('promote').querySelector('.session-rail-project'), null);
  let firstFrame;
  await act(async () => {
    flushSync(() =>
      view.root.render(view.pane({ leafId: 'promote', selection: { kind: 'session', id: 'sent-session' } }))
    );
    // What the commit paints: the panel with its Info, never an empty one.
    firstFrame = {
      aside: view.cell('promote').querySelector('.session-rail'),
      info: Boolean(view.body('promote').querySelector('[data-category="info"]')),
    };
  });
  await view.settle();
  assert.equal(firstFrame.aside, aside, 'the panel element is not remounted');
  assert.equal(firstFrame.info, true, 'no frame without its Info');
  assert.equal(view.cell('promote').querySelector('.session-rail'), aside);
  assert.equal(aside.style.width, width);
  assert.equal(view.cell('promote').style.getPropertyValue('--session-rail-reserve'), reserve);
  assert.ok(view.body('promote').querySelector('.session-rail-project'), "the session's Project row");
  const composer = view.cell('promote').querySelector('[data-conversation="shown"]');
  assert.equal(composer.querySelector('.model-trigger'), null, 'the composer stays bare');
  await act(async () => view.root.render(null));
});

test("a draft beside a session: each pane's panel draws its own conversation, never a retained or another one", async (t) => {
  const view = await railPanes(t);
  // A draft's Project select stands alone; a session's sits in its move row.
  const draftInfo = (leafId) =>
    Boolean(view.body(leafId).querySelector('.session-rail-select')) &&
    !view.body(leafId).querySelector('.session-rail-project');
  const sessionInfo = (leafId) => Boolean(view.body(leafId).querySelector('.session-rail-project'));
  const infos = (leafId) => view.body(leafId).querySelectorAll('[data-category="info"]').length;
  await view.render(
    { leafId: 'left', selection: { kind: 'new', draftId: 'd-left' } },
    { leafId: 'right', selection: { kind: 'session', id: 's-right' }, retained: { kind: 'new', draftId: 'd-right' } }
  );
  assert.deepEqual([infos('left'), draftInfo('left'), sessionInfo('left')], [1, true, false], 'the draft pane');
  assert.deepEqual(
    [infos('right'), sessionInfo('right')],
    [1, true],
    'the session pane, its retained draft drawing nothing'
  );
  const retainedComposer = view.cell('right').querySelector('[data-conversation="retained"]');
  assert.ok(retainedComposer.querySelector('.model-trigger'), 'the retained draft keeps its own controls');
  // The tabs swap kinds in each pane.
  await view.render(
    { leafId: 'left', selection: { kind: 'session', id: 's-left' } },
    { leafId: 'right', selection: { kind: 'new', draftId: 'd-right' }, retained: { kind: 'session', id: 's-right' } }
  );
  assert.deepEqual([infos('left'), sessionInfo('left')], [1, true]);
  assert.deepEqual([infos('right'), draftInfo('right'), sessionInfo('right')], [1, true, false]);
  await act(async () => view.root.render(null));
});
