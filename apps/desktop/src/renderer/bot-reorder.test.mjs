// Bots reorder by drag and drop (and Alt+Arrow) in the Bots page and in the
// Sessions bot section, through ONE order stored on the host. Mixy stays
// first; agents (Worker, Reviewer, sub-agents) are a separate group that no
// bot is dropped among. Dragging a row out of the list still opens its session
// in a pane. Real components in jsdom, with a fake host.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [
  { AgentActivityPane },
  { agentsSection },
  { useSidebarAgents },
  { usePaneDropPreview },
  paneDrag,
  orderStore,
  { resetMixyStatus },
] = await Promise.all([
  import('./AgentActivityPane.tsx'),
  import('./session-sidebar-sections.tsx'),
  import('./session-sidebar-agents.ts'),
  import('./use-pane-workspace-interactions.ts'),
  import('./pane-drag-session.ts'),
  import('./bot-order-store.ts'),
  import('./mixy-identity.ts'),
]);

const NOW = Date.now();
const AGENTS = [
  { id: 'alpha', custom: true, kind: 'bot', label: 'Alpha', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'beta', custom: true, kind: 'bot', label: 'Beta', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'gamma', custom: true, kind: 'bot', label: 'Gamma', route: { provider: 'openai', model: 'gpt-5' } },
  { id: 'worker', custom: true, label: 'Worker', route: { provider: 'openai', model: 'gpt-5' } },
];
const home = (agentHome, age) => ({
  id: `sess_home_${agentHome}`,
  agentHome,
  title: 'x',
  preview: '',
  updatedAt: NOW - age,
  activityAt: NOW - age,
  messageCount: 2,
  readMessageCount: 2,
  cwd: '/tasks',
  classification: 'task',
  projectPath: null,
});
// Newest first: Mixy, Alpha, Beta, Gamma — the Bots page's order before any reorder.
const SESSIONS = [
  home('lead', 1000),
  home('alpha', 2000),
  home('beta', 3000),
  home('gamma', 4000),
  home('worker', 500),
];

function mount(t, { agents = AGENTS, sessions = SESSIONS, stored = [], pool = [] } = {}) {
  orderStore.resetBotOrder();
  resetMixyStatus();
  t.after(() => {
    orderStore.resetBotOrder();
    resetMixyStatus();
    paneDrag.finishPaneDrag();
  });
  const { dom, root } = installTestDom(t, {
    jsdom: { url: 'http://localhost/' },
    expose: ['HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'MouseEvent', 'navigator'],
    rootId: 'root',
  });
  const { window } = dom;
  const { document } = window;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const host = {
    agents,
    order: stored,
    refuse: false,
    calls: [],
    listeners: new Set(),
    announce: () => {
      for (const listener of host.listeners) listener({ scope: 'desktop' });
    },
  };
  window.mixdogDesktop = {
    listAgentPool: async () => pool,
    subscribeAgentPool: () => () => {},
    invokeCapability: async ({ capability, args }) => {
      host.calls.push([capability, ...args]);
      if (capability === 'listAgents') return { value: host.agents };
      if (capability === 'getLeadStatus') return { value: { created: true } };
      if (capability === 'getBotOrder') return { value: { order: host.order } };
      if (capability === 'setBotOrder') {
        if (host.refuse) throw new Error('refused');
        host.order = args[0];
        return { value: { order: host.order } };
      }
      return { value: null };
    },
    subscribeSettingsChanged: (listener) => {
      host.listeners.add(listener);
      return () => host.listeners.delete(listener);
    },
  };
  const opened = [];
  const frames = [];
  paneDrag.subscribePaneDrag((frame) => frames.push(frame));
  // The pane workspace: one empty pane whose area fills the panel.
  const leaf = { type: 'leaf', id: 'leaf-a', tabs: [], activeKey: '' };
  const workspace = {
    layout: leaf,
    leaves: [leaf],
    openInLeaf: (leafId, selection) => opened.push(['open-in-leaf', leafId, selection.id]),
    splitLeafAt: (leafId, zone, selection) => opened.push(['split', leafId, zone, selection.id]),
  };
  function Page() {
    usePaneDropPreview(workspace, () => {});
    const bots = useSidebarAgents(sessions, undefined, true, () => {}, undefined);
    return React.createElement(
      'div',
      null,
      React.createElement(
        'aside',
        { id: 'sidebar' },
        agentsSection({
          contacts: bots.contacts,
          open: true,
          onToggleOpen() {},
          selectedSessionId: '',
          onOpenAgent: bots.openAgent,
        })
      ),
      React.createElement(
        'div',
        { className: 'main-panel' },
        React.createElement(
          'div',
          { className: 'pane-leaf', 'data-pane-id': 'leaf-a', 'data-pane-path': '0' },
          React.createElement(AgentActivityPane, { active: true, sessions, onOpenSession: () => {} }),
          React.createElement('div', { id: 'workspace' }),
          // Workflow agents: a separate group, not part of the bot order.
          React.createElement(
            'ul',
            { id: 'agent-group' },
            React.createElement('li', { id: 'agent-row', 'data-agent-row': 'worker' }, 'Worker')
          )
        )
      )
    );
  }
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const render = async () => {
    await act(async () => root.render(React.createElement(Page)));
    await act(async () => {});
    document.querySelector('.main-panel').getBoundingClientRect = () => rect(0, 0, 800, 600);
    document.querySelector('.pane-leaf').getBoundingClientRect = () => rect(0, 0, 800, 600);
  };
  const dataTransfer = {
    effectAllowed: 'none',
    dropEffect: 'none',
    setData() {},
    getData: () => '',
    setDragImage() {},
  };
  const fire = async (type, target, extra = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    for (const [key, value] of Object.entries({ clientX: 300, clientY: 200, ...extra })) {
      Object.defineProperty(event, key, { value });
    }
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const paneRows = () => [...document.querySelectorAll('.agent-contact-list [data-agent-contact]')];
  const sideRows = () => [...document.querySelectorAll('#sidebar [data-agent-contact]')];
  const ids = (rows) => rows.map((row) => row.dataset.agentContact);
  const main = (rows, id) => rows.find((row) => row.dataset.agentContact === id).querySelector('button');
  const key = (target, name, altKey = true) =>
    act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, altKey, bubbles: true, cancelable: true }));
    });
  /** Drag `fromId`'s pane row onto `target` and release there. */
  const dragRow = async (rows, fromId, target, { release = true, clientY = -1 } = {}) => {
    const button = main(rows, fromId);
    await fire('dragstart', button);
    await fire('dragenter', target);
    const over = await fire('dragover', target, { clientY });
    if (release) {
      await fire('drop', target);
      await fire('dragend', button);
    }
    return over;
  };
  return { document, window, host, opened, frames, render, fire, paneRows, sideRows, ids, main, key, dragRow };
}

test('before any reorder both lists keep the current order, Mixy first', async (t) => {
  const m = mount(t);
  await m.render();
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
});

test('dropping a bot on another reorders the Bots page and the sidebar, and the host stores ids only', async (t) => {
  const m = mount(t);
  await m.render();
  const over = await m.dragRow(m.paneRows(), 'gamma', m.paneRows()[1].querySelector('button'), { release: false });
  assert.equal(over.defaultPrevented, true, 'the list accepts the drop');
  assert.equal(
    m.paneRows()[1].dataset.dropPosition,
    'before',
    'the sidebar-style insertion line marks where it would land'
  );
  assert.deepEqual(
    m.frames.filter((frame) => frame.phase === 'move'),
    [],
    'no split preview while reordering'
  );
  await m.fire('drop', m.paneRows()[1].querySelector('button'));
  await m.fire('dragend', m.main(m.paneRows(), 'gamma'));
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'gamma', 'alpha', 'beta']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'gamma', 'alpha', 'beta'], 'one shared order');
  assert.deepEqual(m.host.order, ['gamma', 'alpha', 'beta']);
  assert.equal(
    m.paneRows().some((row) => row.dataset.dropPosition || row.dataset.reordering),
    false,
    'the marks clear'
  );
  assert.equal(
    m.frames.some((frame) => frame.phase === 'drop'),
    false,
    'and no pane drop followed'
  );
  assert.equal(paneDrag.currentPaneDrag(), null);
});

test('a drop on the lower half of a Bots-page row lands after it, with the line below', async (t) => {
  const m = mount(t);
  await m.render();
  const target = m.paneRows()[2].querySelector('button'); // Beta
  await m.dragRow(m.paneRows(), 'alpha', target, { release: false, clientY: 1e6 });
  assert.equal(m.paneRows()[2].dataset.dropPosition, 'after');
  assert.equal(m.paneRows()[1].dataset.reordering, 'true', 'the dragged row dims like a session row');
  await m.fire('drop', target);
  await m.fire('dragend', m.main(m.paneRows(), 'alpha'));
  assert.deepEqual(m.host.order, ['beta', 'alpha', 'gamma']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'beta', 'alpha', 'gamma']);
});

test('a drag in the sidebar reorders the same order', async (t) => {
  const m = mount(t);
  await m.render();
  const target = m.sideRows()[3].querySelector('button'); // Gamma
  await m.dragRow(m.sideRows(), 'alpha', target);
  assert.deepEqual(m.host.order, ['beta', 'gamma', 'alpha']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'beta', 'gamma', 'alpha']);
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'beta', 'gamma', 'alpha']);
});

test('Mixy cannot be moved, and nothing can be dropped on or above it', async (t) => {
  const m = mount(t);
  await m.render();
  // Dragging Mixy onto a bot: refused.
  const refused = await m.dragRow(m.paneRows(), 'lead', m.paneRows()[2].querySelector('button'), { release: false });
  assert.equal(m.paneRows()[2].dataset.dropPosition, undefined);
  assert.equal(refused.dataTransfer.dropEffect, 'none');
  await m.fire('drop', m.paneRows()[2].querySelector('button'));
  await m.fire('dragend', m.main(m.paneRows(), 'lead'));
  // A bot dragged onto Mixy's row: refused.
  await m.dragRow(m.sideRows(), 'beta', m.sideRows()[0].querySelector('button'));
  await m.dragRow(m.paneRows(), 'beta', m.paneRows()[0].querySelector('button'));
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  // Alt+Arrow: Mixy's row has no reorder keys; the first bot cannot go above Mixy.
  await m.key(m.main(m.paneRows(), 'lead'), 'ArrowDown');
  await m.key(m.main(m.paneRows(), 'alpha'), 'ArrowUp');
  await m.key(m.main(m.sideRows(), 'alpha'), 'ArrowUp');
  await m.key(m.main(m.paneRows(), 'gamma'), 'ArrowDown');
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  assert.equal(m.paneRows()[0].querySelector('button').getAttribute('aria-keyshortcuts'), null);
});

test('Alt+Arrow moves the focused bot one place in both lists; a plain arrow does nothing', async (t) => {
  const m = mount(t);
  await m.render();
  await m.key(m.main(m.paneRows(), 'beta'), 'ArrowUp', false);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  await m.key(m.main(m.paneRows(), 'beta'), 'ArrowUp');
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'beta', 'alpha', 'gamma']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'beta', 'alpha', 'gamma']);
  await m.key(m.main(m.sideRows(), 'beta'), 'ArrowDown');
  await m.key(m.main(m.sideRows(), 'beta'), 'ArrowDown');
  assert.deepEqual(m.host.order, ['alpha', 'gamma', 'beta']);
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'gamma', 'beta']);
});

test('a new bot goes to the end, a deleted one drops out, unknown ids are ignored, no setting = current order', async (t) => {
  const m = mount(t, { stored: ['gamma', 'ghost', 'alpha'] });
  await m.render();
  // Beta is new to the stored order: after the known bots.
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'gamma', 'alpha', 'beta']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'gamma', 'alpha', 'beta']);
});

test('a deleted bot drops out of the stored order; one created since goes last', async (t) => {
  const agents = [
    ...AGENTS.filter((row) => row.id !== 'gamma'),
    { id: 'delta', custom: true, kind: 'bot', label: 'Delta' },
  ];
  const m = mount(t, { agents, stored: ['gamma', 'beta', 'alpha'] });
  await m.render();
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'beta', 'alpha', 'delta']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'beta', 'alpha', 'delta']);
});

test('a bot dropped among agents, or an agent among bots, is refused', async (t) => {
  const m = mount(t);
  await m.render();
  // A bot released on the agent group (outside the bot list) is no reorder:
  // the order does not change (it is the ordinary drop on the workspace).
  await m.dragRow(m.paneRows(), 'beta', m.document.getElementById('agent-row'));
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  assert.deepEqual(m.opened, [['open-in-leaf', 'leaf-a', 'sess_home_beta']]);
  m.opened.length = 0;
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  // An agent's session dragged over the bot list and released on a bot: refused, no order, no pane open.
  const worker = { kind: 'session', id: 'sess_home_worker', title: 'Worker' };
  const begin = () =>
    paneDrag.beginPaneDrag(
      { dataTransfer: { setData() {}, setDragImage() {}, effectAllowed: '' }, clientX: 1, clientY: 1 },
      { kind: 'session', key: 'session:sess_home_worker', title: 'Worker', selection: worker },
      m.document.body
    );
  begin();
  const target = m.sideRows()[2].querySelector('button');
  const over = await m.fire('dragover', target);
  assert.equal(over.dataTransfer.dropEffect, 'none');
  assert.equal(m.sideRows()[2].dataset.botDrop, undefined);
  await m.fire('drop', target);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  assert.deepEqual(m.opened, []);
  begin();
  await m.fire('drop', m.paneRows()[2].querySelector('button'));
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  assert.deepEqual(m.opened, []);
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  assert.equal(
    m.paneRows().some((row) => row.dataset.agentContact === 'worker'),
    false,
    'agents are no bot rows'
  );
});

test('a bot row dragged out of the list still opens its session in a pane', async (t) => {
  const m = mount(t);
  await m.render();
  const button = m.main(m.paneRows(), 'beta');
  assert.equal(button.draggable, true);
  await m.fire('dragstart', button);
  assert.equal(paneDrag.currentPaneDrag()?.key, 'session:sess_home_beta');
  await m.fire('dragover', m.document.getElementById('workspace'));
  assert.ok(
    m.frames.some((frame) => frame.phase === 'move'),
    'the workspace previews the drop'
  );
  await m.fire('drop', m.document.getElementById('workspace'));
  await m.fire('dragend', button);
  assert.deepEqual(m.opened, [['open-in-leaf', 'leaf-a', 'sess_home_beta']]);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  // The sidebar's bot rows are pane sources too.
  const side = m.main(m.sideRows(), 'gamma');
  await m.fire('dragstart', side);
  await m.fire('drop', m.document.getElementById('workspace'));
  await m.fire('dragend', side);
  assert.deepEqual(m.opened[1], ['open-in-leaf', 'leaf-a', 'sess_home_gamma']);
});

test('a bot with no home session yet is a reorder-only drag source: it reorders, and opens nothing outside the list', async (t) => {
  const sessions = SESSIONS.filter((session) => session.agentHome !== 'gamma');
  const m = mount(t, { sessions });
  await m.render();
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'alpha', 'beta', 'gamma']);
  const button = m.main(m.paneRows(), 'gamma');
  assert.equal(button.draggable, true, 'draggable without a session');
  assert.equal(m.main(m.sideRows(), 'gamma').draggable, true);
  // Dropped outside the list: nothing opens, no order, no pane frames.
  await m.fire('dragstart', button);
  const drag = paneDrag.currentPaneDrag();
  assert.equal(drag?.reorderOnly, true, 'the same drag session, flagged');
  assert.equal(drag?.botId, 'gamma');
  const workspace = m.document.getElementById('workspace');
  const over = await m.fire('dragover', workspace);
  assert.equal(over.defaultPrevented, false, 'the workspace does not claim it');
  assert.equal(over.dataTransfer.dropEffect, 'none');
  await m.fire('drop', workspace);
  await m.fire('dragend', button);
  assert.deepEqual(m.opened, []);
  assert.deepEqual(m.frames, [], 'no preview or drop frame reached the workspace');
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    []
  );
  assert.equal(paneDrag.currentPaneDrag(), null);
  // Dropped on another bot in the Bots page: it reorders.
  await m.dragRow(m.paneRows(), 'gamma', m.paneRows()[1].querySelector('button'));
  assert.deepEqual(m.host.order, ['gamma', 'alpha', 'beta']);
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'gamma', 'alpha', 'beta']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'gamma', 'alpha', 'beta']);
  assert.deepEqual(m.opened, []);
  // And from the sidebar row too.
  await m.dragRow(m.sideRows(), 'gamma', m.sideRows()[3].querySelector('button'));
  assert.deepEqual(m.host.order, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(m.opened, []);
  // Mixy with a session stays an ordinary pane source (the list refuses it as a reorder).
  assert.equal(m.main(m.paneRows(), 'lead').draggable, true, 'Mixy has a session: an ordinary pane source');
});

test('Mixy with no session is no drag source', async (t) => {
  const m = mount(t, { sessions: SESSIONS.filter((session) => session.agentHome !== 'lead') });
  await m.render();
  assert.equal(m.main(m.paneRows(), 'lead').draggable, false);
  assert.equal(m.main(m.sideRows(), 'lead').draggable, false);
});

test('a change another device made reorders every list live; a refused write shows what the host holds', async (t) => {
  const m = mount(t);
  await m.render();
  m.host.order = ['gamma', 'beta', 'alpha']; // a phone reordered
  await act(async () => m.host.announce());
  await act(async () => {});
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'gamma', 'beta', 'alpha']);
  assert.deepEqual(m.ids(m.sideRows()), ['lead', 'gamma', 'beta', 'alpha']);
  m.host.refuse = true;
  await m.key(m.main(m.paneRows(), 'alpha'), 'ArrowUp');
  await act(async () => {});
  await act(async () => {});
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'gamma', 'beta', 'alpha'], 'rolled back to the host order');
});

test('moving within a filtered list keeps the bots it does not show in their slots', () => {
  const { movedBotOrder, applyBotOrder } = orderStore;
  assert.deepEqual(movedBotOrder(['a', 'h', 'b', 'c'], ['a', 'b', 'c'], 'c', 'a'), ['c', 'h', 'a', 'b']);
  assert.equal(movedBotOrder([], ['a', 'b'], 'a', 'a'), null);
  assert.equal(movedBotOrder([], ['a', 'b'], 'a', 'lead'), null);
  assert.equal(movedBotOrder([], ['a', 'b'], 'lead', 'a'), null);
  assert.equal(movedBotOrder([], ['a', 'b'], 'x', 'a'), null);
  const contacts = [
    { agentId: 'x', mixy: false },
    { agentId: 'lead', mixy: true },
    { agentId: 'b', mixy: false },
    { agentId: 'a', mixy: false },
  ];
  assert.deepEqual(
    applyBotOrder(contacts, ['a', 'zzz', 'b', 'lead']).map((c) => c.agentId),
    ['lead', 'a', 'b', 'x'],
    'Mixy first whatever the stored order says; new bots last'
  );
  assert.deepEqual(orderStore.parseBotOrder(['a', 7, ' b ', 'a', 'lead', '']), ['a', 'b']);
});

test('the face of a bot row with sub-agents drags the row and toggles on a plain click, never after a drag', async (t) => {
  const owner = 'sess_home_beta';
  const pool = [
    { tag: `lead:${owner}`, agent: 'lead', sessionId: owner, ownerSessionId: owner, status: 'idle', stage: 'idle' },
    {
      tag: 'w:s1',
      agent: 'worker',
      sessionId: 's1',
      ownerSessionId: owner,
      parentSessionId: owner,
      status: 'idle',
      stage: 'idle',
    },
  ];
  const m = mount(t, { pool });
  await m.render();
  const rowOf = (id) => m.paneRows().find((row) => row.dataset.agentContact === id);
  const face = () => rowOf('beta').querySelector(':scope > .agent-subtree-toggle');
  assert.ok(face(), 'the bot with a sub-agent has a face button');
  assert.equal(face().draggable, true, 'the face is a drag source like the row');
  assert.equal(m.main(m.paneRows(), 'alpha').draggable, true);
  assert.equal(rowOf('alpha').querySelector('.agent-subtree-toggle'), null, 'no face button without sub-agents');
  // A click without movement toggles.
  assert.equal(face().getAttribute('aria-expanded'), 'false');
  await act(async () => face().click());
  assert.equal(face().getAttribute('aria-expanded'), 'true');
  await act(async () => face().click());
  assert.equal(face().getAttribute('aria-expanded'), 'false');
  // A drag from the face reorders (Beta onto Alpha) through the shared session...
  await m.fire('dragstart', face());
  assert.equal(paneDrag.currentPaneDrag()?.botId, 'beta', 'the bot drag session');
  assert.equal(paneDrag.currentPaneDrag()?.key, `session:${owner}`);
  const target = rowOf('alpha').querySelector('.agent-chat-row-main');
  await m.fire('dragenter', target);
  await m.fire('dragover', target, { clientY: -1 });
  // ...and a click landing in the same tick as the drop does not toggle.
  await act(async () => {
    const drop = new m.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { dropEffect: 'none', getData: () => '' } });
    Object.defineProperty(drop, 'clientX', { value: 300 });
    Object.defineProperty(drop, 'clientY', { value: 200 });
    target.dispatchEvent(drop);
    face().click();
  });
  await m.fire('dragend', face());
  assert.deepEqual(m.ids(m.paneRows()), ['lead', 'beta', 'alpha', 'gamma']);
  assert.deepEqual(m.host.order, ['beta', 'alpha', 'gamma']);
  assert.equal(face().getAttribute('aria-expanded'), 'false', 'no toggle right after a drag');
  await new Promise((resolve) => setTimeout(resolve, 5));
  await act(async () => face().click());
  assert.equal(face().getAttribute('aria-expanded'), 'true', 'a later plain click toggles again');
});
