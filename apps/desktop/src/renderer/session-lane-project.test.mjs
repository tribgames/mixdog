import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLaneStore } from './session-lane-store';

const first = 'C:/Project/ProjectAA';
const second = 'C:/Project/GamerScroll';
const items = [{ id: 'row', kind: 'message', role: 'assistant', text: '`favicon.svg`' }];

function storeAfterCwdSwitch() {
  const store = createSessionLaneStore({ decorator: { decorate: (snapshot) => snapshot, clear() {} } });
  store.apply({
    sessionId: 'a',
    frameSource: 'live',
    snapshot: {
      sessionId: 'a',
      cwd: first,
      currentProject: first,
      items,
      contentRevision: 1,
    },
  });
  store.apply({
    sessionId: 'b',
    frameSource: 'live',
    snapshot: {
      sessionId: 'b',
      cwd: first,
      currentProject: first,
      items: [],
      contentRevision: 1,
    },
  });
  store.apply({
    sessionId: 'a',
    frameSource: 'live',
    snapshot: {
      sessionId: 'a',
      cwd: second,
      items,
      contentRevision: 1,
    },
  });
  return store;
}

test('cwd switches update only the owning lane', () => {
  const store = storeAfterCwdSwitch();
  assert.equal(store.get('a').currentProject, second);
  assert.equal(store.get('a').project, second);
  assert.equal(store.get('a').cwd, second);
  assert.equal(store.get('b').currentProject, first);
  assert.deepEqual(store.get('a').items, items);
  store.clear();
});

test('a cwd switch survives a subsequent replay', () => {
  const store = storeAfterCwdSwitch();
  store.apply({
    sessionId: 'a',
    frameSource: 'replay',
    snapshot: {
      sessionId: 'a',
      cwd: second,
      items,
      contentRevision: 2,
    },
  });
  assert.equal(store.get('a').currentProject, second);
  assert.equal(store.get('b').currentProject, first);
  store.clear();
});
