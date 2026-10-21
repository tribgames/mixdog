import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createPageFullscreen } from './page-fullscreen.ts';

const fakeGuest = () => {
  const guest = new EventEmitter();
  guest.destroyed = false;
  guest.scripts = [];
  guest.isDestroyed = () => guest.destroyed;
  guest.executeJavaScript = async (script) => {
    guest.scripts.push(script);
    // The page leaves fullscreen when asked to.
    if (script === 'document.exitFullscreen()') guest.emit('leave-html-full-screen');
  };
  return guest;
};

const fakeShell = ({ fullscreen = false, visible = true } = {}) => {
  const shell = new EventEmitter();
  shell.fullscreen = fullscreen;
  shell.isDestroyed = () => false;
  shell.isVisible = () => visible;
  shell.isFullScreen = () => shell.fullscreen;
  shell.setFullScreen = (on) => {
    shell.fullscreen = on;
    if (!on) shell.emit('leave-full-screen');
  };
  shell.webContents = new EventEmitter();
  shell.webContents.off = shell.webContents.removeListener;
  return shell;
};

const setup = (shellOptions) => {
  const shell = fakeShell(shellOptions);
  const guest = fakeGuest();
  const other = fakeGuest();
  const current = { s1: guest };
  const changes = [];
  const fullscreen = createPageFullscreen({
    shell,
    sessionIdForGuest: (g) => (g === guest ? 's1' : g === other ? 's1' : undefined),
    currentGuest: (sessionId) => current[sessionId] ?? null,
    changed: (sessionId, active) => changes.push([sessionId, active]),
  });
  fullscreen.watch(guest);
  fullscreen.watch(other);
  return { shell, guest, other, current, changes, fullscreen };
};

const escape = (shell) => {
  let prevented = false;
  shell.webContents.emit(
    'before-input-event',
    { preventDefault: () => (prevented = true) },
    { type: 'keyDown', key: 'Escape' }
  );
  return prevented;
};

test('the shown page entering fullscreen makes the window fullscreen and tells the pane', () => {
  const { shell, guest, changes } = setup();
  guest.emit('enter-html-full-screen');
  assert.equal(shell.fullscreen, true);
  assert.deepEqual(changes, [['s1', true]]);
});

test('the page leaving fullscreen restores the window and the pane', () => {
  const { shell, guest, changes } = setup();
  guest.emit('enter-html-full-screen');
  guest.emit('leave-html-full-screen');
  assert.equal(shell.fullscreen, false);
  assert.deepEqual(changes, [
    ['s1', true],
    ['s1', false],
  ]);
  assert.equal(shell.webContents.listenerCount('before-input-event'), 0);
  assert.equal(shell.listenerCount('leave-full-screen'), 0);
});

test('Escape exits the page fullscreen and is not passed on', () => {
  const { shell, guest, changes } = setup();
  guest.emit('enter-html-full-screen');
  assert.equal(escape(shell), true);
  assert.deepEqual(guest.scripts, ['document.exitFullscreen()']);
  assert.equal(shell.fullscreen, false);
  assert.deepEqual(changes, [
    ['s1', true],
    ['s1', false],
  ]);
  // Back to normal: Escape is the page's again.
  assert.equal(escape(shell), false);
});

test('leaving the window fullscreen by hand leaves the page fullscreen', () => {
  const { shell, guest, changes } = setup();
  guest.emit('enter-html-full-screen');
  shell.fullscreen = false;
  shell.emit('leave-full-screen');
  assert.deepEqual(guest.scripts, ['document.exitFullscreen()']);
  assert.deepEqual(changes, [
    ['s1', true],
    ['s1', false],
  ]);
});

test('a window the person already made fullscreen stays fullscreen afterwards', () => {
  const { shell, guest } = setup({ fullscreen: true });
  guest.emit('enter-html-full-screen');
  guest.emit('leave-html-full-screen');
  assert.equal(shell.fullscreen, true);
});

test('showing another tab or closing the page leaves fullscreen', () => {
  const first = setup();
  first.guest.emit('enter-html-full-screen');
  first.fullscreen.reconcile('s1');
  assert.deepEqual(first.guest.scripts, []);
  first.current.s1 = first.other;
  first.fullscreen.reconcile('s1');
  assert.deepEqual(first.guest.scripts, ['document.exitFullscreen()']);
  assert.equal(first.shell.fullscreen, false);
  assert.deepEqual(first.changes, [
    ['s1', true],
    ['s1', false],
  ]);

  const second = setup();
  second.guest.emit('enter-html-full-screen');
  second.guest.destroyed = true;
  second.guest.emit('destroyed');
  assert.equal(second.shell.fullscreen, false);
  assert.deepEqual(second.changes, [
    ['s1', true],
    ['s1', false],
  ]);
});

test('a page nobody is looking at does not take the window', () => {
  const background = setup();
  background.other.emit('enter-html-full-screen');
  assert.equal(background.shell.fullscreen, false);
  assert.deepEqual(background.changes, []);

  const hidden = setup({ visible: false });
  hidden.guest.emit('enter-html-full-screen');
  assert.equal(hidden.shell.fullscreen, false);
  assert.deepEqual(hidden.changes, []);
});
