import assert from 'node:assert/strict';
import test from 'node:test';

import { browserDocumentId, BrowserGuestStateStore } from './guest-state.ts';
import { unreportedDownloads } from './reply.ts';

const guest = () => ({ id: Math.random() });

test('page ids are stable per guest and snapshot ids advance from them', () => {
  const store = new BrowserGuestStateStore();
  const first = guest();
  const second = guest();
  assert.equal(store.pageId(first), 'p1');
  assert.equal(store.pageId(second), 'p2');
  assert.equal(store.pageId(first), 'p1');
  assert.equal(store.nextSnapshotId(first), 'p1-s1');
  assert.equal(store.nextSnapshotId(first), 'p1-s2');
  assert.equal(store.nextSnapshotId(second), 'p2-s1');
});

test('document ids name one page generation and retire when the document changes', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const other = guest();
  assert.equal(browserDocumentId(store, page), `${store.pageId(page)}:0`);
  assert.notEqual(browserDocumentId(store, other), browserDocumentId(store, page));
  const before = browserDocumentId(store, page);
  store.beginDocument(page);
  assert.notEqual(browserDocumentId(store, page), before);
  assert.equal(browserDocumentId(store, page), `${store.pageId(page)}:1`);
});

test('a new document reports only its own network failures and console errors', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  record.networkFailures.push('GET https://previous.test/ad — net::ERR_ABORTED');
  record.console.recordError('error: the previous page failed to load a resource');

  store.beginDocument(page, true);
  assert.equal(record.networkFailures.length, 1, 'an in-document navigation reloads nothing');
  assert.equal(record.console.errorCount(), 1, 'and keeps what the same document logged');

  store.beginDocument(page);
  assert.deepEqual(record.networkFailures, [], 'the previous page must not explain the current one');
  assert.equal(record.console.errorCount(), 0);
  assert.deepEqual(record.console.newErrors(10), [], 'a cleared log has nothing left to report');
});

test('a page opened after a download does not announce it as news', () => {
  const store = new BrowserGuestStateStore();
  const older = { id: 'older', startedAt: Date.now() - 5_000, completedAt: Date.now() - 4_000 };
  const record = store.for(guest());
  // Downloads belong to the session, not to one page; a page that never saw
  // this file saved must not open by reporting it.
  assert.deepEqual(unreportedDownloads([older], record.downloadsReportedAt), []);

  const saved = { id: 'later', startedAt: Date.now() + 1_000 };
  assert.deepEqual(
    unreportedDownloads([older, saved], record.downloadsReportedAt),
    [saved],
    'a file saved while this page is open still reaches it'
  );
});

test('invalidating interaction forgets document-bound state only', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const record = store.for(page);
  record.refSet = { snapshotId: 'p1-s1' };
  record.accessibilityRefs = { refs: [] };
  record.visualGrounding = { snapshotId: 'p1-s1' };
  record.remoteFrame = { frameId: 'rbf_1' };
  record.fault = 'kept';
  record.performanceTrace = { trace: [] };
  store.invalidateInteraction(page);
  assert.equal(record.refSet, undefined);
  assert.equal(record.accessibilityRefs, undefined);
  assert.equal(record.visualGrounding, undefined);
  assert.equal(record.remoteFrame, undefined);
  assert.equal(record.fault, 'kept');
  assert.ok(record.performanceTrace);
});

test('crash marking records the fault once and clears on take', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  store.for(page).refSet = { snapshotId: 'p1-s1' };
  assert.equal(store.takeCrashed(page), false);
  store.markCrashed(page, 'renderer crashed');
  assert.equal(store.for(page).fault, 'renderer crashed');
  assert.equal(store.for(page).refSet, undefined);
  assert.equal(store.takeCrashed(page), true);
  assert.equal(store.takeCrashed(page), false);
});

test('slots read and write one field of the guest record', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const refSets = store.slot('refSet');
  assert.equal(refSets.has(page), false);
  assert.equal(refSets.delete(page), false);
  refSets.set(page, { snapshotId: 'p1-s1' });
  assert.equal(refSets.has(page), true);
  assert.equal(store.for(page).refSet.snapshotId, 'p1-s1');
  assert.equal(refSets.get(page).snapshotId, 'p1-s1');
  assert.equal(refSets.delete(page), true);
  assert.equal(store.for(page).refSet, undefined);
});

test('remembered secrets are redacted from guest text until forgotten', () => {
  const store = new BrowserGuestStateStore();
  const page = guest();
  const other = guest();
  store.rememberSecret(page, 'hunter2-secret');
  assert.doesNotMatch(store.redactText(page, 'password is hunter2-secret ok'), /hunter2-secret/);
  assert.match(store.redactText(other, 'password is hunter2-secret ok'), /hunter2-secret/);
  store.forgetSecret(page, 'hunter2-secret');
  assert.match(store.redactText(page, 'password is hunter2-secret ok'), /hunter2-secret/);
  assert.equal(store.for(page).sensitiveValues, undefined, 'forgetting the last secret releases the set');
});
