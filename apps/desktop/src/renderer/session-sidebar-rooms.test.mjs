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
  const rows = [...document.querySelectorAll('.sidebar-agents .agent-session-row')];
  assert.deepEqual(
    rows.map((row) => row.textContent.trim()),
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
    ['room-reset', 'room-leave', 'room-delete']
  );
  const { BOT_DELETED_EVENT } = await import('./agent-profile-actions.ts');
  const closed = [];
  window.addEventListener(BOT_DELETED_EVENT, (event) => closed.push(event.detail.sessionId));
  items[1].onSelect();
  items[2].onSelect();
  await act(async () => {});
  assert.deepEqual(calls, [
    ['leave', 'abc123'],
    ['remove', 'abc123'],
  ]);
  // The deleted/left room's open tab closes, so no pane stays on a gone session.
  assert.deepEqual(closed, ['sess_room_abc123', 'sess_room_abc123']);
});
