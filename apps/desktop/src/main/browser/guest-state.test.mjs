import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserGuestStateStore } from './guest-state.ts';

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
  store.rememberSecret(page, 'another-secret-value');
  store.forgetSecrets(page);
  assert.match(store.redactText(page, 'another-secret-value'), /another-secret-value/);
});
