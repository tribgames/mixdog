import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetClosedTabGuests, newBrowserGuestBook } from './browser-pane-page-state.ts';

const tab = (id, webContentsId) => ({ id, webContentsId, title: id, url: '', active: false, loading: false, kind: 'page' });

test('an unrelated tab closing keeps a live tab\'s viewport records', () => {
  const book = newBrowserGuestBook();
  book.agentViewports.set(11, { width: 1, height: 2 });
  book.appliedViewportPreset.set(11, 'x');
  book.agentViewports.set(12, null);
  forgetClosedTabGuests(book, [tab('t1', 11), tab('t2', 12)]);
  forgetClosedTabGuests(book, [tab('t1', 11)]);
  assert.equal(book.agentViewports.has(11), true);
  assert.equal(book.appliedViewportPreset.has(11), true);
  assert.equal(book.agentViewports.has(12), false);
});

test('a tab opened, emulated and closed between polls leaves nothing', () => {
  const book = newBrowserGuestBook();
  book.agentViewports.set(31, { width: 3, height: 4 });
  book.appliedViewportPreset.set(31, 'y');
  forgetClosedTabGuests(book, [tab('t1', 11)]);
  assert.equal(book.agentViewports.size, 0);
  assert.equal(book.appliedViewportPreset.size, 0);
});
