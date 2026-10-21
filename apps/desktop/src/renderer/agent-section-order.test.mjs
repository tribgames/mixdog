// The Bots page's sections (Bots, Rooms, Agents under the pinned Mixy row):
// no heading rows; the order lives in the SAME host-stored list as the bot
// order (reserved `section:<id>` entries) and reaches every device.
// Real components in jsdom, with a fake host.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore: restoreBootstrapDom } = installTestDom(null);
after(restoreBootstrapDom);
const [{ AgentActivityPane }, paneDrag, orderStore, { resetMixyStatus }, { publishAgentModeSessions }] =
  await Promise.all([
    import('./AgentActivityPane.tsx'),
    import('./pane-drag-session.ts'),
    import('./bot-order-store.ts'),
    import('./mixy-identity.ts'),
    import('./agent-chat-mode.ts'),
  ]);

const NOW = Date.now();
const ROOM = {
  id: 'sess_room_abc123',
  title: 'Release check',
  preview: '',
  updatedAt: 2,
  messageCount: 3,
  lastMessagePreview: 'Looks good',
  agentRoom: {
    id: 'abc123',
    name: 'Release check',
    members: ['lead', 'gh'],
    maxRounds: 3,
    maxMessages: 8,
    shareTools: false,
    lastSpeaker: 'user',
  },
};
const CODING = { id: 'c1', title: 'Code c1', preview: '', updatedAt: 1, messageCount: 1 };
const POOL = [
  {
    tag: 'lead:c1',
    agent: 'lead',
    sessionId: 'c1',
    ownerSessionId: 'c1',
    status: 'running',
    stage: 'running',
    turnStartedAt: NOW - 5_000,
  },
];

function mount(t, { sessions = [ROOM, CODING], pool = POOL, stored = [], mixy = true } = {}) {
  orderStore.resetBotOrder();
  resetMixyStatus();
  publishAgentModeSessions([]);
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
    order: stored,
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
      if (capability === 'listAgents') return { value: [] };
      if (capability === 'getLeadStatus') return { value: { created: mixy } };
      if (capability === 'getBotOrder') return { value: { order: host.order } };
      if (capability === 'setBotOrder') {
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
  paneDrag.subscribePaneDrag(() => {});
  const render = async () => {
    await act(async () =>
      root.render(React.createElement(AgentActivityPane, { active: true, sessions, onOpenSession: () => {} }))
    );
    await act(async () => {});
  };
  /** The page top to bottom: each section once ('bots' | 'rooms' | 'agents') and every hairline ('hr'). */
  const layout = () => {
    const seq = [];
    for (const node of document.querySelectorAll(
      '[data-agent-contact], [data-agent-room], [data-agent-lead], .agent-chat-divider'
    )) {
      const name = node.matches('.agent-chat-divider')
        ? 'hr'
        : node.dataset.agentContact
          ? 'bots'
          : node.dataset.agentRoom
            ? 'rooms'
            : 'agents';
      if (seq.at(-1) !== name) seq.push(name);
    }
    return seq;
  };
  return { document, window, host, render, layout };
}

test('default order is Bots, Rooms, Agents with one hairline between sections, Mixy first', async (t) => {
  const m = mount(t);
  await m.render();
  assert.deepEqual(m.layout(), ['bots', 'hr', 'rooms', 'hr', 'agents']);
  assert.equal(m.document.querySelector('[data-agent-contact]').dataset.agentContact, 'lead', 'Mixy is on top');
  assert.deepEqual(orderStore.paneSectionOrder(), ['bots', 'rooms', 'agents']);
  assert.deepEqual(
    m.host.calls.filter(([name]) => name === 'setBotOrder'),
    [],
    'nothing stored until a change'
  );
});

test('the sections have no heading rows and the "…" menu has no Section order item', async (t) => {
  const m = mount(t);
  await m.render();
  assert.equal(m.document.querySelector('.agent-section-header'), null);
  assert.doesNotMatch(m.document.querySelector('.agent-activity-page').textContent, /Reorder/);
  await act(async () => m.document.querySelector('.agent-activity-page .row-overflow-trigger').click());
  assert.equal(m.document.querySelector('[data-action-id="order-agent-sections"]'), null);
  assert.doesNotMatch(m.document.querySelector('.row-overflow-menu').textContent, /Section order/);
  assert.ok(m.document.querySelector('[data-action-id^="show-group-"]'), 'the toggles stay');
  assert.ok(m.document.querySelector('[data-action-id="retain-1h"]'), 'Keep finished agents stays');
});

test('a synced value applies live and on first read; bot order and section order share one list', async (t) => {
  const m = mount(t, { stored: ['section:agents', 'section:rooms', 'section:bots'] });
  await m.render();
  assert.deepEqual(m.layout(), ['agents', 'hr', 'rooms', 'hr', 'bots']);
  m.host.order = ['section:rooms', 'section:bots', 'section:agents']; // a phone reordered
  await act(async () => m.host.announce());
  await act(async () => {});
  assert.deepEqual(m.layout(), ['rooms', 'hr', 'bots', 'hr', 'agents']);
  assert.equal(
    m.document.querySelector('.agent-activity-page [data-agent-contact]').dataset.agentContact,
    'lead',
    'Mixy leads its Bots section whatever the order'
  );
});

test('pure helpers: unknown ids are ignored, missing sections follow in default order', () => {
  const { paneSectionOrder, applyBotOrder } = orderStore;
  assert.deepEqual(paneSectionOrder([]), ['bots', 'rooms', 'agents']);
  assert.deepEqual(paneSectionOrder(['b1', 'section:agents', 'section:nope', 'section:agents']), [
    'agents',
    'bots',
    'rooms',
  ]);
  const contacts = [
    { agentId: 'b1', mixy: false },
    { agentId: 'lead', mixy: true },
    { agentId: 'b2', mixy: false },
  ];
  assert.deepEqual(
    applyBotOrder(contacts, ['b2', 'section:agents', 'b1']).map((c) => c.agentId),
    ['lead', 'b2', 'b1'],
    'section entries do not disturb bots'
  );
});

test('empty sections are skipped: no double or missing divider', async (t) => {
  const noRooms = mount(t, { sessions: [CODING] });
  await noRooms.render();
  assert.deepEqual(noRooms.layout(), ['bots', 'hr', 'agents']);
  const agentsFirst = mount(t, { sessions: [CODING], stored: ['section:agents', 'section:rooms', 'section:bots'] });
  await agentsFirst.render();
  assert.deepEqual(agentsFirst.layout(), ['agents', 'hr', 'bots'], 'the empty Rooms leaves no line');
});

test('only Bots present: no divider whatever the order', async (t) => {
  const m = mount(t, { sessions: [], pool: [], stored: ['section:agents', 'section:rooms', 'section:bots'] });
  await m.render();
  assert.deepEqual(m.layout(), ['bots']);
});

test('no Lead block, and no divider for it, before Mixy exists', async (t) => {
  const m = mount(t, { mixy: false, stored: ['section:agents', 'section:bots', 'section:rooms'] });
  await m.render();
  assert.equal(m.document.querySelector('[data-agent-lead]'), null);
  assert.equal(m.document.querySelector('[data-agent-section="leads"]'), null);
  assert.equal(
    m.document.querySelector('.agent-chat-divider:not(.agent-room-section-divider)'),
    null,
    'no Lead divider'
  );
  assert.ok(m.document.querySelector('.mixy-empty'), 'the create prompt shows');
});

// Show/hide groups: the "…" menu's four check items; hidden ones ride in the same stored list as `hidden:<id>`.
const toggle = async (m, id) => {
  if (!m.document.querySelector('.row-overflow-menu')) {
    await act(async () => m.document.querySelector('.agent-activity-page .row-overflow-trigger').click());
  }
  await act(async () => m.document.querySelector(`[data-action-id="show-group-${id}"]`).click());
};
const roomCount = (m) => m.document.querySelectorAll('[data-agent-room]').length;

test('all four groups are shown by default, as four checked menu items', async (t) => {
  const m = mount(t);
  await m.render();
  await act(async () => m.document.querySelector('.agent-activity-page .row-overflow-trigger').click());
  const items = [...m.document.querySelectorAll('[data-action-id^="show-group-"]')];
  assert.deepEqual(
    items.map((item) => [item.dataset.actionId, item.textContent, item.getAttribute('aria-checked')]),
    [
      ['show-group-representative', 'Representative bot', 'true'],
      ['show-group-bots', 'Bots', 'true'],
      ['show-group-rooms', 'Rooms', 'true'],
      ['show-group-agents', 'Agents', 'true'],
      ['show-group-connectors', 'Connectors', 'true'],
    ]
  );
  assert.deepEqual(m.layout(), ['bots', 'hr', 'rooms', 'hr', 'agents']);
});

test('each toggle hides only its group, with no double or missing hairline', async (t) => {
  const rooms = mount(t);
  await rooms.render();
  await toggle(rooms, 'rooms');
  assert.deepEqual(rooms.layout(), ['bots', 'hr', 'agents']);
  assert.equal(roomCount(rooms), 0);
  assert.deepEqual(rooms.host.order, ['hidden:rooms']);
  await toggle(rooms, 'rooms');
  assert.deepEqual(rooms.layout(), ['bots', 'hr', 'rooms', 'hr', 'agents']);
  assert.deepEqual(rooms.host.order, []);
});

test('hiding Agents leaves Bots and Rooms with one hairline', async (t) => {
  const agents = mount(t);
  await agents.render();
  await toggle(agents, 'agents');
  assert.deepEqual(agents.layout(), ['bots', 'hr', 'rooms']);
});

test('hiding the representative bot removes only the Mixy row', async (t) => {
  const rep = mount(t);
  await rep.render();
  await toggle(rep, 'representative');
  assert.equal(rep.document.querySelector('[data-agent-contact="lead"]'), null, 'Mixy row gone');
  assert.equal(roomCount(rep), 1);
  assert.ok(rep.document.querySelector('[data-agent-lead], .agent-chat-divider'), 'other groups stay');
});

test('Connectors: the foot bar shows by default, hides on toggle, persists, and is not a list group', async (t) => {
  const m = mount(t);
  await m.render();
  assert.ok(m.document.querySelector('.connectors-pill'), 'shown by default');
  await toggle(m, 'connectors');
  assert.equal(m.document.querySelector('.connectors-pill'), null);
  assert.deepEqual(m.host.order, ['hidden:connectors']);
  assert.deepEqual(m.layout(), ['bots', 'hr', 'rooms', 'hr', 'agents'], 'the lists are untouched');
  const again = mount(t, { stored: ['hidden:connectors'] });
  await again.render();
  assert.equal(again.document.querySelector('.connectors-pill'), null, 'persisted');
  const all = mount(t, { stored: ['hidden:representative', 'hidden:bots', 'hidden:rooms', 'hidden:agents'] });
  await all.render();
  assert.match(all.document.querySelector('.agent-activity-page').textContent, /All groups are hidden/);
  assert.ok(all.document.querySelector('.connectors-pill'), 'the bar stays when only the lists are hidden');
});

test('dividers and menu separators are straight 1px lines, not rounded', async () => {
  const { readFileSync } = await import('node:fs');
  const rail = readFileSync(new URL('./desktop/10-rail-pages.css', import.meta.url), 'utf8');
  assert.match(rail, /agent-contact-divider\)[^}]*border-radius: 0;/);
  const menu = readFileSync(new URL('./desktop/20-automation.css', import.meta.url), 'utf8');
  assert.doesNotMatch(menu, /menu-separator \{[^}]*box-shadow/);
  assert.match(menu, /menu-separator::before \{[^}]*height: 1px;/);
});

test('hiding Bots keeps the Mixy row', async (t) => {
  const bots = mount(t);
  await bots.render();
  await toggle(bots, 'bots');
  assert.ok(bots.document.querySelector('[data-agent-contact="lead"]'), 'Mixy stays when only Bots is hidden');
  assert.equal(roomCount(bots), 1);
});

test('the choice persists across a remount (host-stored) and the section order survives it', async (t) => {
  const first = mount(t, { stored: ['section:agents', 'section:bots', 'section:rooms'] });
  await first.render();
  await toggle(first, 'bots');
  const saved = first.host.order;
  assert.deepEqual(saved, ['section:agents', 'section:bots', 'section:rooms', 'hidden:bots']);
  const second = mount(t, { stored: saved });
  await second.render();
  assert.equal(second.document.querySelectorAll('[data-agent-contact="lead"]').length, 1, 'Mixy still shown');
  await toggle(second, 'rooms');
  assert.deepEqual(orderStore.hiddenPaneGroups(), new Set(['bots', 'rooms']));
  assert.deepEqual(
    second.layout().filter((name) => name !== 'hr'),
    ['agents', 'bots']
  );
});

test('all four hidden: a short hint instead of a blank pane; a search still finds rows', async (t) => {
  const m = mount(t, {
    stored: ['hidden:representative', 'hidden:bots', 'hidden:rooms', 'hidden:agents'],
  });
  await m.render();
  assert.deepEqual(m.layout(), []);
  assert.match(m.document.querySelector('.agent-activity-page').textContent, /All groups are hidden/);
  await act(async () => m.document.querySelector('.agent-activity-page [aria-label="Search"]').click());
  const input = m.document.querySelector('.agent-pane-search');
  const setter = Object.getOwnPropertyDescriptor(m.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, 'Release');
    input.dispatchEvent(new m.window.Event('input', { bubbles: true }));
  });
  assert.equal(roomCount(m), 1, 'search looks through hidden groups');
  assert.doesNotMatch(m.document.querySelector('.agent-activity-page').textContent, /All groups are hidden/);
});
