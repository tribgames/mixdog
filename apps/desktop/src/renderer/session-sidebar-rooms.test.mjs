// The Sessions 봇 section lists group rooms right under the bots; a click
// opens the room through the same callback as a bot row.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const AVATAR = { kind: 'mascot', species: 'dog', accessory: 'none', expression: 'calm', color: 'blue' };
const member = (id) => ({ id, name: id, avatar: AVATAR });
const room = (sessionId, name, indicator) => ({
  sessionId,
  name,
  indicator,
  room: { id: `room_${sessionId}`, members: ['a', 'b'] },
  members: [member('a'), member('b')],
});
const CONTACT = { agentId: 'watcher', name: 'Watcher', avatar: AVATAR, session: { id: 'sess_w' } };

test('rooms render after the bots, with indicators, and a click opens the room', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { agentsSection } = await import('./session-sidebar-sections.tsx');
  const opened = [];
  const render = (rooms) =>
    act(async () =>
      root.render(
        agentsSection({
          contacts: [CONTACT],
          rooms,
          open: true,
          onToggleOpen() {},
          selectedSessionId: 'sess_r1',
          onOpenAgent() {},
          onOpenRoom: (row) => opened.push(row.sessionId),
        })
      )
    );
  await render([room('sess_r1', 'Alpha', undefined), room('sess_r2', 'Beta', { kind: 'unread' })]);
  const rows = [...document.querySelectorAll('.sidebar-agents .agent-strip-item')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('button').getAttribute('aria-label')),
    ['Watcher', 'Alpha', 'Beta']
  );
  assert.ok(rows[1].classList.contains('selected'));
  assert.ok(rows[1].querySelector('.agent-room-tile'));
  assert.ok(rows[2].querySelector('.session-row-unread-dot'));
  await act(async () => rows[2].querySelector('button').click());
  assert.deepEqual(opened, ['sess_r2']);
  await render([]);
  assert.equal(document.querySelectorAll('[data-agent-room]').length, 0);
});

test('Bots render as one avatar per bot: click opens it, selected and status marks show', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { agentsSection } = await import('./session-sidebar-sections.tsx');
  const opened = [];
  const contact = (agentId, name) => ({ agentId, name, avatar: AVATAR, session: { id: `sess_${agentId}` } });
  const contacts = [contact('a', 'Alpha'), contact('b', 'Beta'), contact('c', 'Gamma'), contact('d', 'Delta')];
  const status = { sess_b: 'running', sess_c: 'needs-you', sess_d: 'unread' };
  await act(async () =>
    root.render(
      agentsSection({
        contacts,
        open: true,
        onToggleOpen() {},
        selectedSessionId: 'sess_a',
        attentionOf: (id) => status[id] ?? '',
        onOpenAgent: (c) => opened.push(c.agentId),
      })
    )
  );
  const items = [...document.querySelectorAll('.agent-session-strip > .agent-strip-item')];
  assert.equal(items.length, 4, 'one avatar per bot');
  assert.equal(document.querySelectorAll('.agent-session-strip .session-row').length, 0, 'no per-bot rows');
  assert.deepEqual(
    items.map((item) => item.querySelector('button').getAttribute('aria-label')),
    ['Alpha', 'Beta', 'Gamma', 'Delta']
  );
  assert.ok(items[0].classList.contains('selected'));
  assert.ok(!items[1].classList.contains('selected'));
  assert.ok(items[1].querySelector('.session-row-spinner'), 'running mark');
  assert.ok(items[2].querySelector('.session-attention-glyph[data-status="needs-you"]'), 'needs-you mark');
  assert.ok(items[3].querySelector('.session-row-unread-dot'), 'unread mark');
  await act(async () => items[2].querySelector('button').click());
  assert.deepEqual(opened, ['c']);
});

test('a muted bot keeps a mute mark in the strip; behind a status mark it moves into the name', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const muted = (id) => ({ target: { kind: 'agent', id }, setting: { mode: 'muted', until: null } });
  window.mixdogDesktop = {
    listConversationNotifications: async () => [muted('a'), muted('b')],
    getNotificationPreferences: async () => ({
      devices: [],
      currentDeviceId: 'pc',
      preferences: { pc: { scope: 'all' } },
    }),
  };
  await (await import('./notification-overrides.ts')).refreshConversationNotifications();
  const { agentsSection } = await import('./session-sidebar-sections.tsx');
  const contact = (agentId, name) => ({ agentId, name, avatar: AVATAR, session: { id: `sess_${agentId}` } });
  await act(async () =>
    root.render(
      agentsSection({
        contacts: [contact('a', 'Alpha'), contact('b', 'Beta'), contact('c', 'Gamma')],
        open: true,
        onToggleOpen() {},
        selectedSessionId: '',
        attentionOf: (id) => (id === 'sess_b' ? 'running' : ''),
        onOpenAgent() {},
      })
    )
  );
  const [a, b, c] = [...document.querySelectorAll('.agent-strip-item')];
  assert.ok(a.querySelector('.session-row-muted'), 'idle muted bot: the mute mark');
  assert.equal(b.querySelector('.session-row-muted'), null, 'the status mark wins the corner');
  assert.ok(b.querySelector('.session-row-spinner'));
  assert.match(b.querySelector('button').getAttribute('aria-label'), /^Beta · Notifications off/);
  assert.equal(c.querySelector('.session-row-muted'), null);
  assert.equal(c.querySelector('button').getAttribute('aria-label'), 'Gamma');
});

test('a muted room behind a status mark keeps the mute in its name; idle it shows the mark', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const muted = (id) => ({ target: { kind: 'room', id }, setting: { mode: 'muted', until: null } });
  window.mixdogDesktop = {
    listConversationNotifications: async () => [muted('room_sess_r1'), muted('room_sess_r2')],
    getNotificationPreferences: async () => ({
      devices: [],
      currentDeviceId: 'pc',
      preferences: { pc: { scope: 'all' } },
    }),
  };
  await (await import('./notification-overrides.ts')).refreshConversationNotifications();
  const { agentsSection } = await import('./session-sidebar-sections.tsx');
  await act(async () =>
    root.render(
      agentsSection({
        contacts: [],
        rooms: [room('sess_r1', 'Alpha', { kind: 'unread' }), room('sess_r2', 'Beta', undefined)],
        open: true,
        onToggleOpen() {},
        selectedSessionId: '',
        onOpenAgent() {},
      })
    )
  );
  const [alpha, beta] = [...document.querySelectorAll('[data-agent-room]')];
  assert.equal(alpha.querySelector('.session-row-muted'), null);
  assert.match(alpha.querySelector('button').getAttribute('aria-label'), /^Alpha · Notifications off/);
  assert.ok(beta.querySelector('.session-row-muted'));
  assert.equal(beta.querySelector('button').getAttribute('aria-label'), 'Beta');
});

test('a room row opens its menu on right-click: reset, leave, delete', async (t) => {
  const { root, document, window } = installTestDom(t, { rootId: 'root', expose: ['HTMLElement', 'CustomEvent'] });
  const { agentsSection } = await import('./session-sidebar-sections.tsx');
  const { agentRoomMenuItems } = await import('./agent-profile-actions.ts');
  const menus = [];
  await act(async () =>
    root.render(
      agentsSection({
        contacts: [],
        rooms: [room('sess_r1', 'Alpha', undefined)],
        open: true,
        onToggleOpen() {},
        selectedSessionId: '',
        onOpenAgent() {},
        onOpenRoomMenu: (row) => menus.push(row.sessionId),
      })
    )
  );
  const row = document.querySelector('[data-agent-room]');
  await act(async () => row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert.deepEqual(menus, ['sess_r1']);
  const calls = [];
  window.mixdogDesktop = { agentRoomAction: async (action, args) => calls.push([action, ...args]) };
  const items = agentRoomMenuItems({ id: 'abc123' }, { confirm: () => true });
  assert.deepEqual(
    items.map((item) => item.id),
    ['room-rename', 'room-reset', 'room-leave', 'room-delete']
  );
  const { BOT_DELETED_EVENT } = await import('./agent-profile-actions.ts');
  const closed = [];
  window.addEventListener(BOT_DELETED_EVENT, (event) => closed.push(event.detail.sessionId));
  items[2].onSelect();
  items[3].onSelect();
  await act(async () => {});
  assert.deepEqual(calls, [
    ['leave', 'abc123'],
    ['remove', 'abc123'],
  ]);
  // The deleted/left room's open tab closes, so no pane stays on a gone session.
  assert.deepEqual(closed, ['sess_room_abc123', 'sess_room_abc123']);
});
