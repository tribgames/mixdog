// Per-conversation notification controls (issue #221): menu wording and writes,
// the list-row mark, expiry and refresh on a settings change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const NOW = new Date(2026, 9, 25, 0, 44, 10).getTime();
const HOUR = 3_600_000;
const HOME = 'sess_home_marketer';
const ROOM_ID = 'abc123';
const ROOM = `sess_room_${ROOM_ID}`;

function mockApi(window, { overrides = [], scope = 'all' } = {}) {
  const state = { overrides, scope, writes: [], lists: 0 };
  window.mixdogDesktop = {
    listConversationNotifications: async () => {
      state.lists += 1;
      return state.overrides;
    },
    getNotificationPreferences: async () => ({
      devices: [],
      currentDeviceId: 'pc',
      preferences: { pc: { scope: state.scope } },
    }),
    setConversationNotification: async (target, setting) => {
      state.writes.push([target, setting]);
      state.overrides = state.overrides.filter((o) => o.target.kind !== target.kind || o.target.id !== target.id);
      if (setting.mode !== 'inherit') state.overrides = [...state.overrides, { target, setting }];
      return state.overrides;
    },
  };
  return state;
}

const muted = (kind, id, until) => ({ target: { kind, id }, setting: { mode: 'muted', until } });
const labels = (items) => items.map((item) => item.label);

async function setup(t, options, fixedClock = true) {
  const dom = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const api = mockApi(dom.window, options);
  const clock = { now: NOW };
  if (fixedClock) t.mock.method(Date, 'now', () => clock.now);
  const controls = await import('./notification-controls.tsx');
  const store = await import('./notification-overrides.ts');
  await store.refreshConversationNotifications();
  return { ...dom, api, clock, controls, store };
}

test('menu wording follows the state; none without host support', async (t) => {
  const { api, controls, store, window } = await setup(t, { scope: 'bots' });
  const session = { kind: 'session', id: 'sess_code' };
  assert.deepEqual(labels(controls.notificationMenuItems({ kind: 'agent', id: 'marketer' })), ['Mute notifications']);
  assert.deepEqual(labels(controls.notificationMenuItems({ kind: 'room', id: ROOM_ID })), ['Mute notifications']);
  // Scope 'bots': a coding session is outside, a bot's home chat and a room are not.
  assert.deepEqual(labels(controls.notificationMenuItems(session)), ['Get notifications']);
  assert.deepEqual(labels(controls.notificationMenuItems({ kind: 'session', id: HOME })), ['Mute notifications']);
  assert.deepEqual(labels(controls.notificationMenuItems({ kind: 'session', id: ROOM })), ['Mute notifications']);
  const [mute] = controls.notificationMenuItems({ kind: 'agent', id: 'marketer' }, { separated: true });
  assert.equal(mute.separatorBefore, true);
  assert.deepEqual(labels(mute.children), [
    'For 1 hour',
    'For 8 hours',
    'Until tomorrow morning',
    'Until I turn it back on',
  ]);

  api.overrides = [{ target: session, setting: { mode: 'always' } }, muted('agent', 'marketer', null)];
  await store.refreshConversationNotifications();
  assert.deepEqual(labels(controls.notificationMenuItems(session)), ['Use notification settings']);
  assert.deepEqual(labels(controls.notificationMenuItems({ kind: 'agent', id: 'marketer' })), ['Unmute notifications']);
  // An expired mute no longer counts.
  api.overrides = [muted('agent', 'marketer', NOW - 1)];
  await store.refreshConversationNotifications();
  assert.deepEqual(labels(controls.notificationMenuItems({ kind: 'agent', id: 'marketer' })), ['Mute notifications']);

  window.mixdogDesktop = {};
  assert.deepEqual(controls.notificationMenuItems(session), []);
});

test('menus place the item: bot/room between Rename and Hide, session after Archive', async (t) => {
  await setup(t, {});
  const { agentContactMenuItems, agentRoomMenuItems } = await import('./agent-profile-actions.ts');
  const { sessionMenuItems } = await import('./session-sidebar-menus.tsx');
  const contact = { agentId: 'marketer', name: 'Marketer', mixy: false };
  const ids = (items) => items.map((item) => item.id);
  const bot = agentContactMenuItems(contact, { onOpen() {}, onProfile() {} }, {}, 'sidebar');
  assert.deepEqual(ids(bot), ['agent-profile', 'agent-rename', 'notify-mute', 'agent-hide-from-list']);
  assert.equal(bot[2].separatorBefore, true);
  assert.equal(bot[3].separatorBefore, true);
  assert.deepEqual(ids(agentRoomMenuItems({ id: ROOM_ID }, { confirm: () => true })).slice(0, 3), [
    'room-rename',
    'notify-mute',
    'room-reset',
  ]);
  const session = { id: 'sess_code', title: 'Code', updatedAt: 1 };
  const menu = ids(
    sessionMenuItems(session, 'k', {
      onResumeSession() {},
      onArchiveSession: async () => {},
      onFavoriteSession: async () => {},
      openSessionEditor() {},
      closeSessionEditor() {},
      requestDelete() {},
      sessionGroupKeys: new Map(),
      projectGroups: [],
      moveSession() {},
    })
  );
  assert.equal(menu[menu.indexOf('archive') + 1], 'notify-mute');
});

test('a session resolves its own override, else its room, else its bot', async (t) => {
  const { api, store } = await setup(t, {
    overrides: [muted('agent', 'marketer', null), muted('room', ROOM_ID, NOW + HOUR)],
  });
  const state = (id) => store.resolveNotificationState(store.notificationSnapshot(), { kind: 'session', id });
  assert.deepEqual(state(HOME), { kind: 'muted', until: null, source: { kind: 'agent', id: 'marketer' } });
  assert.deepEqual(state(ROOM), { kind: 'muted', until: NOW + HOUR, source: { kind: 'room', id: ROOM_ID } });
  assert.deepEqual(state('sess_code'), { kind: 'on' });
  api.overrides = [muted('agent', 'marketer', null), muted('room', ROOM_ID, NOW + HOUR)];
  const withOwn = {
    ...store.notificationSnapshot(),
    overrides: [...api.overrides, { target: { kind: 'session', id: ROOM }, setting: { mode: 'always' } }],
  };
  assert.deepEqual(store.resolveNotificationState(withOwn, { kind: 'session', id: ROOM }), {
    kind: 'always',
    source: { kind: 'session', id: ROOM },
  });
});

test('seats resolve session → room → bot, fall back when a mute expires, and count as bot conversations', async (t) => {
  const { roomMemberSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-room.mjs');
  const seat = roomMemberSessionId(ROOM_ID, 'marketer');
  assert.ok(seat, 'a seat id');
  const { store } = await setup(t, { scope: 'bots' });
  const at = (overrides, now = NOW) =>
    store.resolveNotificationState({ overrides, scope: 'bots', now }, { kind: 'session', id: seat }, now);
  const own = { target: { kind: 'session', id: seat }, setting: { mode: 'always' } };
  const room = muted('room', ROOM_ID, NOW + HOUR);
  const agent = muted('agent', 'marketer', null);
  // A seat is a room conversation: in scope 'bots' it is notified, not "outside".
  assert.deepEqual(at([]), { kind: 'on' });
  assert.equal(at([own, room, agent]).kind, 'always', 'session wins over room and bot');
  assert.deepEqual(at([room, agent]).source, { kind: 'room', id: ROOM_ID }, 'room wins over bot');
  assert.deepEqual(at([agent]).source, { kind: 'agent', id: 'marketer' });
  // The room's mute ends: the bot's applies; the session mute ends: the room's applies.
  assert.deepEqual(at([room, agent], NOW + HOUR).source, { kind: 'agent', id: 'marketer' });
  const ownMute = { target: own.target, setting: { mode: 'muted', until: NOW + 1000 } };
  assert.equal(at([ownMute, room, agent]).source.kind, 'session');
  assert.equal(at([ownMute, room, agent], NOW + 1000).source.kind, 'room');
  // Room log and home chat fall back the same way.
  const log = (id, overrides, now) =>
    store.resolveNotificationState({ overrides, scope: 'all', now }, { kind: 'session', id }, now);
  const logMute = { target: { kind: 'session', id: ROOM }, setting: { mode: 'muted', until: NOW + 1000 } };
  assert.equal(log(ROOM, [logMute, room, agent], NOW).source.kind, 'session');
  assert.equal(log(ROOM, [logMute, room, agent], NOW + 1000).source.kind, 'room');
  assert.equal(log(HOME, [agent], NOW).source.kind, 'agent');
});

test("scope 'off' leaves every kind outside; an override still wins", async (t) => {
  const { roomMemberSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-room.mjs');
  const { controls, store } = await setup(t, { scope: 'off' });
  const targets = [
    { kind: 'session', id: 'sess_code' },
    { kind: 'session', id: HOME },
    { kind: 'session', id: ROOM },
    { kind: 'session', id: roomMemberSessionId(ROOM_ID, 'marketer') },
    { kind: 'agent', id: 'marketer' },
    { kind: 'room', id: ROOM_ID },
  ];
  for (const target of targets) {
    assert.equal(store.resolveNotificationState(store.notificationSnapshot(), target).kind, 'outside', target.id);
    assert.deepEqual(labels(controls.notificationMenuItems(target)), ['Get notifications'], target.id);
  }
  const snap = {
    ...store.notificationSnapshot(),
    overrides: [
      muted('agent', 'marketer', null),
      { target: { kind: 'room', id: ROOM_ID }, setting: { mode: 'always' } },
    ],
  };
  assert.equal(store.resolveNotificationState(snap, targets[4]).kind, 'muted');
  assert.equal(store.resolveNotificationState(snap, targets[5]).kind, 'always');
  assert.equal(store.resolveNotificationState(snap, targets[1]).kind, 'muted');
});

test('a shown timed mute wakes at the next local midnight, DST days included', async (t) => {
  const { store } = await setup(t, {});
  const until = new Date(2026, 9, 27, 8, 0).getTime();
  const overrides = [muted('agent', 'marketer', until)];
  // Before midnight: the midnight comes first, not the 8:00 end.
  const late = new Date(2026, 9, 25, 22, 0).getTime();
  assert.equal(store.nextNotificationWake(overrides, late), new Date(2026, 9, 26, 0, 0).getTime());
  // A mute ending before midnight wakes at its end; no timed mute, no wake.
  const soon = [muted('agent', 'marketer', late + HOUR)];
  assert.equal(store.nextNotificationWake(soon, late), late + HOUR);
  assert.equal(store.nextNotificationWake([muted('agent', 'marketer', null)], late), null);
  assert.equal(store.nextNotificationWake([muted('agent', 'marketer', late - 1)], late), null);

  // The 25-hour fall-back day in New York: midnight is 23.5h... of wall time away, not 24h.
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = 'America/New_York';
  t.after(() => {
    process.env.TZ = zone;
  });
  const night = new Date(2026, 10, 1, 0, 30).getTime(); // Nov 1, 2026: clocks go back at 2:00
  assert.equal(new Date(2026, 10, 2).getTime() - new Date(2026, 10, 1).getTime(), 25 * HOUR, 'a 25h day');
  const long = [muted('agent', 'marketer', new Date(2026, 10, 5, 8).getTime())];
  assert.equal(store.nextNotificationWake(long, night), new Date(2026, 10, 2, 0, 0).getTime());
  assert.equal(new Date(2026, 10, 2, 0, 0).getTime() - night, 24.5 * HOUR);
  // The 23h spring-forward day.
  const spring = new Date(2026, 2, 8, 0, 30).getTime();
  assert.equal(
    store.nextNotificationWake([muted('agent', 'marketer', new Date(2026, 2, 12, 8).getTime())], spring),
    new Date(2026, 2, 9, 0, 0).getTime()
  );
  assert.equal(new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime(), 23 * HOUR, 'a 23h day');
});

test('the store arms one timer to the nearer of expiry and midnight, and re-renders at midnight', async (t) => {
  const { clock, controls, document, root, store, window } = await setup(t, {
    overrides: [muted('agent', 'marketer', new Date(2026, 9, 26, 8, 0).getTime())],
  });
  const { createElement } = await import('react');
  const delays = [];
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, delay, ...rest) => {
    delays.push(delay);
    return realSetTimeout(fn, delay, ...rest);
  };
  await act(async () =>
    root.render(createElement(controls.NotificationMuteMark, { target: { kind: 'agent', id: 'marketer' } }))
  );
  const midnight = new Date(2026, 9, 26, 0, 0).getTime();
  assert.ok(delays.includes(midnight - NOW), `armed for midnight: ${delays.join(',')}`);
  // Crossing midnight re-renders "until tomorrow" as "until 8:00" of that day.
  const mark = () => document.querySelector('.session-row-muted');
  assert.match(mark().dataset.tooltip, /^Notifications off until tomorrow /);
  clock.now = midnight + 1;
  await act(async () => store.refreshConversationNotifications());
  assert.match(mark().dataset.tooltip, /^Notifications off until [^t]/);
  assert.equal(mark().getAttribute('aria-label'), mark().dataset.tooltip);
});

test('each item writes the right target and setting', async (t) => {
  const { api, controls, store } = await setup(t, { scope: 'bots' });
  const run = async (target, id, child, before = []) => {
    api.overrides = before;
    await store.refreshConversationNotifications();
    const item = controls.notificationMenuItems(target).find((entry) => entry.id === id);
    (child ? item.children.find((entry) => entry.id === child) : item).onSelect();
    await act(async () => {});
  };
  const agent = { kind: 'agent', id: 'marketer' };
  const room = { kind: 'room', id: ROOM_ID };
  const session = { kind: 'session', id: 'sess_code' };
  await run(agent, 'notify-mute', 'notify-mute-1h');
  await run(room, 'notify-mute', 'notify-mute-8h');
  await run({ kind: 'session', id: HOME }, 'notify-mute', 'notify-mute-tomorrow');
  await run(session, 'notify-get');
  await run(agent, 'notify-unmute', undefined, [muted('agent', 'marketer', null)]);
  await run(session, 'notify-use-settings', undefined, [{ target: session, setting: { mode: 'always' } }]);
  await run(room, 'notify-unmute', undefined, [muted('room', ROOM_ID, null)]);
  await run(room, 'notify-mute', 'notify-mute-forever');
  assert.deepEqual(api.writes, [
    [agent, { mode: 'muted', until: NOW + HOUR }],
    [room, { mode: 'muted', until: NOW + 8 * HOUR }],
    [
      { kind: 'session', id: HOME },
      { mode: 'muted', until: new Date(2026, 9, 26, 8, 0, 0, 0).getTime() },
    ],
    [session, { mode: 'always' }],
    [agent, { mode: 'inherit' }],
    [session, { mode: 'inherit' }],
    [room, { mode: 'inherit' }],
    [room, { mode: 'muted', until: null }],
  ]);
  // The store took the returned list.
  assert.equal(store.resolveNotificationState(store.notificationSnapshot(), room).kind, 'muted');
});

test('a muted row shows the mark; an expired mute removes it; a settings change refreshes', async (t) => {
  const { api, controls, document, root, window } = await setup(t, {}, false);
  const { createElement } = await import('react');
  const { announceSetupChange } = await import('./setup-change-refresh.ts');
  const mark = () => document.querySelector('.session-row-muted');
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(controls.NotificationMuteMark, { target: { kind: 'agent', id: 'marketer' } })
      )
    )
  );
  assert.equal(mark(), null);
  const lists = api.lists;
  api.overrides = [muted('agent', 'marketer', Date.now() + 120)];
  await act(async () => announceSetupChange('settings_changed'));
  assert.ok(api.lists > lists, 'a settings change re-reads the list');
  assert.ok(mark(), 'muted rows show the bell-off');
  assert.match(mark().dataset.tooltip, /^Notifications off until /);
  assert.equal(mark().getAttribute('aria-label'), mark().dataset.tooltip);
  // The mute runs out with no refresh from the PC.
  for (let waited = 0; mark() && waited < 100; waited += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
  }
  assert.equal(mark(), null, 'expired mute disappears');
});

const seatOf = async (agent) => {
  const { roomMemberSessionId } = await import('../../../../src/runtime/agent/orchestrator/session/agent-room.mjs');
  return roomMemberSessionId(ROOM_ID, agent);
};

async function nameRoomAndBot() {
  const { publishAgentRooms } = await import('./agent-room-store.ts');
  const { updateSidebarReference } = await import('./sidebar-reference-cache.ts');
  publishAgentRooms([{ id: ROOM, agentRoom: { id: ROOM_ID, name: 'Launch room', members: ['marketer', 'writer'] } }]);
  updateSidebarReference('agents', [
    { id: 'marketer', custom: true, kind: 'bot', label: 'Marketer', route: { provider: 'openai', model: 'gpt-5' } },
  ]);
}

test('a seat in a muted room: "Get notifications here" writes only the seat, "Unmute {{name}}" the room', async (t) => {
  const roomMute = muted('room', ROOM_ID, null);
  const { api, controls, store } = await setup(t, { overrides: [roomMute] });
  await nameRoomAndBot();
  const seatA = { kind: 'session', id: await seatOf('marketer') };
  const seatB = { kind: 'session', id: await seatOf('writer') };
  const items = () => controls.notificationMenuItems(seatA);
  assert.deepEqual(labels(items()), ['Get notifications here', 'Unmute Launch room']);

  await act(async () => items()[0].onSelect());
  assert.deepEqual(api.writes, [[seatA, { mode: 'always' }]]);
  const snap = store.notificationSnapshot();
  assert.ok(
    snap.overrides.some((o) => o.target.kind === 'room' && o.setting.mode === 'muted'),
    'room stays muted'
  );
  assert.equal(store.resolveNotificationState(snap, seatA).kind, 'always');
  assert.equal(store.resolveNotificationState(snap, seatB).kind, 'muted', 'the sibling seat stays muted');
  // The seat now owns an override: it offers "Use notification settings", not the parent.
  assert.deepEqual(labels(items()), ['Use notification settings']);

  api.overrides = [roomMute];
  await store.refreshConversationNotifications();
  await act(async () => items()[1].onSelect());
  assert.deepEqual(api.writes[1], [{ kind: 'room', id: ROOM_ID }, { mode: 'inherit' }]);
});

test('muted by the bot: the parent item names the bot; a home-chat session row offers the same', async (t) => {
  const { api, controls, store } = await setup(t, { overrides: [muted('agent', 'marketer', null)] });
  await nameRoomAndBot();
  const { sessionMenuItems } = await import('./session-sidebar-menus.tsx');
  const rowItems = sessionMenuItems({ id: HOME, title: 'Marketer', updatedAt: 1 }, 'k', {
    onResumeSession() {},
    onArchiveSession: async () => {},
    onFavoriteSession: async () => {},
    openSessionEditor() {},
    closeSessionEditor() {},
    requestDelete() {},
    sessionGroupKeys: new Map(),
    projectGroups: [],
    moveSession() {},
  });
  const notify = rowItems.filter((item) => item.id.startsWith('notify-'));
  assert.deepEqual(labels(notify), ['Get notifications here', 'Unmute Marketer']);
  assert.equal(rowItems[rowItems.findIndex((item) => item.id === 'archive') + 1].id, 'notify-get-here');
  await act(async () => notify[0].onSelect());
  await act(async () => notify[1].onSelect());
  assert.deepEqual(api.writes, [
    [{ kind: 'session', id: HOME }, { mode: 'always' }],
    [{ kind: 'agent', id: 'marketer' }, { mode: 'inherit' }],
  ]);
  void controls;
  void store;
});

test('an inherited "always" is notified: Mute writes the own target', async (t) => {
  const { api, controls } = await setup(t, {
    overrides: [{ target: { kind: 'room', id: ROOM_ID }, setting: { mode: 'always' } }],
  });
  const seat = { kind: 'session', id: await seatOf('marketer') };
  const [mute] = controls.notificationMenuItems(seat);
  assert.equal(mute.label, 'Mute notifications');
  await act(async () => mute.children[0].onSelect());
  assert.deepEqual(api.writes, [[seat, { mode: 'muted', until: NOW + HOUR }]]);
});
