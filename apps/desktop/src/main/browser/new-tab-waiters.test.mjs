import assert from 'node:assert/strict';
import test from 'node:test';

import { createNewTabWaiters } from './new-tab-waiters.ts';

test('only the waiter named by the created tab resolves, whatever order tabs arrive', async () => {
  const waiters = createNewTabWaiters(1000);
  const a = waiters.watch('s1', 'ra');
  const b = waiters.watch('s1', 'rb');
  const other = waiters.watch('s2', 'rc');
  waiters.created('s1', 'p5', 'rb');
  assert.equal(await b.page, 'p5');
  // B's tab says nothing about A: A's tab, from a slower pane, still names it.
  waiters.created('s1', 'p7', 'ra');
  assert.equal(await a.page, 'p7');
  waiters.created('s2', 'p6', 'rc');
  assert.equal(await other.page, 'p6');
});

test('a tab made without a request id (the user "+") resolves nobody', async () => {
  const waiters = createNewTabWaiters(30);
  const watch = waiters.watch('s1', 'ra');
  waiters.created('s1', 'p9');
  waiters.created('s1', 'p9', 'unknown-request');
  waiters.created('other-session', 'p9', 'ra');
  assert.equal(await watch.page, null, 'only the bounded wait ends it');
});

test('A then B where only B gets a tab: A ends with the wait, B has its own', async () => {
  const waiters = createNewTabWaiters(30);
  const a = waiters.watch('s1', 'ra');
  const b = waiters.watch('s1', 'rb');
  waiters.created('s1', 'p3', 'rb');
  assert.deepEqual(await Promise.all([a.page, b.page]), [null, 'p3']);
});

test('both opens get tabs in order: each its own page', async () => {
  const waiters = createNewTabWaiters(1000);
  const a = waiters.watch('s1', 'ra');
  const b = waiters.watch('s1', 'rb');
  waiters.created('s1', 'p3', 'ra');
  assert.equal(await a.page, 'p3');
  waiters.created('s1', 'p4', 'rb');
  assert.equal(await b.page, 'p4');
});

test('a released session or disposed host settles its waiters; timers are cleared', async () => {
  const waiters = createNewTabWaiters(60_000);
  const one = waiters.watch('s1', 'ra');
  const two = waiters.watch('s2', 'rb');
  waiters.cancelSession('s1');
  assert.equal(await one.page, null);
  waiters.cancelAll();
  assert.equal(await two.page, null);
  // A live 60 s timer would keep this process waiting; a later tab reaches nobody.
  waiters.created('s1', 'p1', 'ra');
});

test('a resolved watch clears its timer', async () => {
  const waiters = createNewTabWaiters(60_000);
  const watch = waiters.watch('s1', 'ra');
  waiters.created('s1', 'p1', 'ra');
  assert.equal(await watch.page, 'p1');
});

test('the new-tab control keeps a valid request id and refuses an invalid one', async () => {
  const { normalizeBrowserPageControl } = await import('../../shared/browser-page-control.ts');
  const documentId = 'p1:1';
  assert.deepEqual(normalizeBrowserPageControl({ type: 'new-tab', documentId }), { type: 'new-tab', documentId });
  assert.deepEqual(normalizeBrowserPageControl({ type: 'new-tab', documentId, requestId: 'r-1' }), {
    type: 'new-tab',
    documentId,
    requestId: 'r-1',
  });
  assert.throws(() => normalizeBrowserPageControl({ type: 'new-tab', documentId, requestId: '' }), /requestId/);
  assert.throws(() => normalizeBrowserPageControl({ type: 'new-tab', documentId, requestId: 5 }), /requestId/);
});
