import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { DESKTOP_IPC } from '../shared/contract-ipc.ts';
import { isSessionOnScreen, registerScreenSessions, reportScreenSessions } from './screen-sessions.ts';

function wired() {
  const webContents = new EventEmitter();
  const ipcMain = new EventEmitter();
  const window = { ...windowState(), webContents };
  const dispose = registerScreenSessions(window, ipcMain);
  const report = (ids, sender = webContents) => ipcMain.emit(DESKTOP_IPC.reportScreenSessions, { sender }, ids);
  return { window, webContents, ipcMain, dispose, report };
}

const windowState = (overrides = {}) => ({
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  isFocused: () => true,
  ...overrides,
});

test('only the sessions the focused window reports are on screen', () => {
  const window = windowState();
  reportScreenSessions(window, ['a']);
  assert.equal(isSessionOnScreen(window, 'a'), true);
  assert.equal(isSessionOnScreen(window, 'b'), false);
});

test('every split pane session is on screen', () => {
  const window = windowState();
  reportScreenSessions(window, ['left', 'right']);
  assert.equal(isSessionOnScreen(window, 'left'), true);
  assert.equal(isSessionOnScreen(window, 'right'), true);
  assert.equal(isSessionOnScreen(window, 'background-tab'), false);
});

test('a new report replaces the previous one', () => {
  const window = windowState();
  reportScreenSessions(window, ['a']);
  reportScreenSessions(window, ['b']);
  assert.equal(isSessionOnScreen(window, 'a'), false);
  assert.equal(isSessionOnScreen(window, 'b'), true);
});

for (const [name, overrides] of [
  ['unfocused', { isFocused: () => false }],
  ['hidden', { isVisible: () => false }],
  ['minimized', { isMinimized: () => true }],
  ['destroyed', { isDestroyed: () => true }],
]) {
  test(`a ${name} window shows nothing`, () => {
    const window = windowState(overrides);
    reportScreenSessions(window, ['a']);
    assert.equal(isSessionOnScreen(window, 'a'), false);
  });
}

test('a window that never reported, or no window, shows nothing', () => {
  assert.equal(isSessionOnScreen(windowState(), 'a'), false);
  assert.equal(isSessionOnScreen(null, 'a'), false);
});

test('malformed reports are ignored instead of widening what is on screen', () => {
  const window = windowState();
  reportScreenSessions(window, ['a']);
  reportScreenSessions(window, 'b');
  assert.equal(isSessionOnScreen(window, 'a'), false);
  reportScreenSessions(window, ['a', 7, '', null]);
  assert.equal(isSessionOnScreen(window, 'a'), true);
  assert.equal(isSessionOnScreen(window, ''), false);
});

test('an empty report (a covered workspace) puts the session off screen, a later one puts it back', () => {
  const h = wired();
  h.report(['a']);
  assert.equal(isSessionOnScreen(h.window, 'a'), true);
  h.report([]);
  assert.equal(isSessionOnScreen(h.window, 'a'), false);
  h.report(['a']);
  assert.equal(isSessionOnScreen(h.window, 'a'), true);
});

test('only this window’s own page can report', () => {
  const h = wired();
  h.report(['a'], new EventEmitter());
  assert.equal(isSessionOnScreen(h.window, 'a'), false);
});

test('a reload or navigation of the main frame clears the report until the new page reports', () => {
  const h = wired();
  h.report(['a']);
  h.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  h.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  assert.equal(isSessionOnScreen(h.window, 'a'), true, 'a subframe or in-page navigation keeps the page');
  h.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  assert.equal(isSessionOnScreen(h.window, 'a'), false);
  h.report(['a']);
  assert.equal(isSessionOnScreen(h.window, 'a'), true);
});

test('a renderer crash clears the report', () => {
  const h = wired();
  h.report(['a']);
  h.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(isSessionOnScreen(h.window, 'a'), false);
});

test('teardown detaches every listener and forgets the report', () => {
  const h = wired();
  h.report(['a']);
  h.dispose();
  assert.equal(isSessionOnScreen(h.window, 'a'), false);
  assert.equal(h.ipcMain.listenerCount(DESKTOP_IPC.reportScreenSessions), 0);
  assert.equal(h.webContents.listenerCount('did-start-navigation'), 0);
  assert.equal(h.webContents.listenerCount('render-process-gone'), 0);
});

test('windows are tracked independently', () => {
  const first = windowState();
  const second = windowState();
  reportScreenSessions(first, ['a']);
  reportScreenSessions(second, ['b']);
  assert.equal(isSessionOnScreen(first, 'b'), false);
  assert.equal(isSessionOnScreen(second, 'a'), false);
});
