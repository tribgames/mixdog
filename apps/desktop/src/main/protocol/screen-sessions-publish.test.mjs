import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { registerScreenSessions, reportScreenSessions } from '../screen-sessions.ts';
import { onProtocolAttached, publishScreenSessions } from './screen-sessions-publish.ts';

function harness() {
  const window = Object.assign(new EventEmitter(), {
    state: { visible: true, minimized: false, focused: true, destroyed: false },
    isDestroyed: () => window.state.destroyed,
    isVisible: () => window.state.visible,
    isMinimized: () => window.state.minimized,
    isFocused: () => window.state.focused,
    webContents: new EventEmitter(),
  });
  const ipc = new EventEmitter();
  registerScreenSessions(window, ipc);
  const sent = [];
  const link = { down: false, listeners: new Set() };
  const protocol = { onEvent: (listener) => (link.listeners.add(listener), () => link.listeners.delete(listener)) };
  const status = (state) => {
    link.down = state !== 'ready';
    for (const listener of [...link.listeners]) listener({ type: 'status', status: { state } });
  };
  publishScreenSessions(
    window,
    (method, params) => {
      if (link.down) throw new Error('not connected');
      sent.push([method, params.sessionIds]);
    },
    (listener) => onProtocolAttached(protocol, listener)
  );
  const report = (ids) => ipc.emit('mixdog:report-screen-sessions', { sender: window.webContents }, ids);
  const set = (patch, event) => {
    Object.assign(window.state, patch);
    window.emit(event);
  };
  return { window, sent, report, set, status };
}

test('every reconnect is a new attach: the current set is sent again, and a change while down is not lost', () => {
  const { sent, report, set, status } = harness();
  report(['a']);
  assert.equal(sent.length, 2);
  status('ready');
  assert.deepEqual(sent.at(-1)[1], ['a'], 'the first ready attaches');
  status('ready');
  assert.equal(sent.length, 3, 'a repeated ready is not a new attach');
  status('reconnecting');
  assert.equal(sent.length, 3, 'nothing is sent while down');
  report(['b']);
  set({ focused: false }, 'blur');
  set({ focused: true }, 'focus');
  assert.equal(sent.length, 3, 'changes while down are dropped, not queued');
  status('ready');
  assert.deepEqual(sent.at(-1)[1], ['b'], 'the reattach carries the current set');
  assert.equal(sent.length, 4);
  status('reconnecting');
  set({ focused: false }, 'blur');
  status('ready');
  assert.deepEqual(sent.at(-1)[1], [], 'an unfocused window attaches with the empty set');
});

test('the on-screen set follows the report, focus, minimize, visibility and page loss', () => {
  const { window, sent, report, set } = harness();
  assert.deepEqual(sent, [['ui/screenSessions/changed', []]], 'sent once when the UI attaches');
  report(['b', 'a', '', 7]);
  assert.deepEqual(sent.at(-1)[1], ['a', 'b']);
  report(['a', 'b']);
  assert.equal(sent.length, 2, 'an unchanged set is not sent again');
  set({ focused: false }, 'blur');
  assert.deepEqual(sent.at(-1)[1], []);
  set({ focused: true }, 'focus');
  assert.deepEqual(sent.at(-1)[1], ['a', 'b']);
  set({ minimized: true }, 'minimize');
  assert.deepEqual(sent.at(-1)[1], []);
  set({ minimized: false }, 'restore');
  assert.deepEqual(sent.at(-1)[1], ['a', 'b']);
  set({ visible: false }, 'hide');
  assert.deepEqual(sent.at(-1)[1], []);
  set({ visible: true }, 'show');
  assert.deepEqual(sent.at(-1)[1], ['a', 'b']);
  window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.deepEqual(sent.at(-1)[1], [], 'a reload clears the report');
  report(['c']);
  assert.deepEqual(sent.at(-1)[1], ['c']);
  window.webContents.emit('render-process-gone');
  assert.deepEqual(sent.at(-1)[1], [], 'a renderer crash clears the report');
  report(['c']);
  window.state.destroyed = true;
  window.emit('closed');
  assert.deepEqual(sent.at(-1)[1], [], 'a closed window shows nothing');
});

test('a report before the window is focused is kept until it is', () => {
  const { sent, report, set } = harness();
  set({ focused: false }, 'blur');
  report(['a']);
  assert.deepEqual(sent.at(-1)[1], []);
  set({ focused: true }, 'focus');
  assert.deepEqual(sent.at(-1)[1], ['a']);
});
