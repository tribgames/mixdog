import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HostRpcError } from '../connection.ts';
import { checkPrecondition, documentIdOf, guardedSend, receiverKeyOf } from './precondition.ts';

const FACTS = { pageId: 'p1', seq: 7 };

function page(overrides = {}) {
  const state = {
    pageId: 'p1',
    documentGeneration: 3,
    cdpSessions: new Map([
      ['s1', {}],
      ['s2', {}],
    ]),
    pendingFileChooser: { mode: 'open', sessionId: 's1', frameId: 'f1', backendNodeId: 9, openedAt: 1 },
    accessibilityRefs: { snapshotId: 'snap-4', refs: new Map() },
    ...overrides.state,
  };
  return { guest: { getURL: () => overrides.url ?? 'https://a.example/x?y=1' }, state };
}

const facts = () => FACTS;

function refusal(expect, target = page()) {
  try {
    checkPrecondition(expect, target, facts);
  } catch (error) {
    assert.ok(error instanceof HostRpcError);
    assert.equal(error.code, -32010);
    assert.deepEqual(error.data.facts, FACTS);
    return error.data.reason;
  }
  return null;
}

test('a precondition that still holds passes, in every part', () => {
  const target = page();
  const expect = {
    documentId: documentIdOf(target.state),
    origin: 'https://a.example',
    url: 'https://a.example/x?y=1',
    childSessions: ['s2', 's1'],
    receiverKey: receiverKeyOf(target.state.pendingFileChooser),
    snapshotId: 'snap-4',
  };
  assert.equal(refusal(expect, target), null);
  assert.equal(refusal({ documentId: 'p1:3' }, target), null);
});

test('a retired document is refused as document', () => {
  assert.equal(refusal({ documentId: 'p1:2' }), 'document');
});

test('another origin is refused as origin, another url as url', () => {
  assert.equal(refusal({ documentId: 'p1:3', origin: 'https://b.example' }), 'origin');
  assert.equal(refusal({ documentId: 'p1:3', url: 'https://a.example/x?y=2' }), 'url');
});

test('a changed set of child sessions is refused as childSession', () => {
  assert.equal(refusal({ documentId: 'p1:3', childSessions: ['s1'] }), 'childSession');
  assert.equal(refusal({ documentId: 'p1:3', childSessions: ['s1', 's2', 's3'] }), 'childSession');
});

test('a chooser that is gone or has another receiver is refused as receiver', () => {
  assert.equal(refusal({ documentId: 'p1:3', receiverKey: 's1|f2|9' }), 'receiver');
  const gone = page({ state: { pendingFileChooser: null } });
  assert.equal(refusal({ documentId: 'p1:3', receiverKey: 's1|f1|9' }, gone), 'receiver');
});

test('another snapshot, or none, is refused as snapshot', () => {
  assert.equal(refusal({ documentId: 'p1:3', snapshotId: 'snap-3' }), 'snapshot');
  const none = page({ state: { accessibilityRefs: undefined } });
  assert.equal(refusal({ documentId: 'p1:3', snapshotId: 'snap-4' }, none), 'snapshot');
});

test('a DOM-fallback snapshot (refs in refSet) is the current snapshot when there are no accessibility refs', () => {
  const fallback = page({ state: { accessibilityRefs: undefined, refSet: { snapshotId: 'dom-2' } } });
  assert.equal(refusal({ documentId: 'p1:3', snapshotId: 'dom-2' }, fallback), null);
  assert.equal(refusal({ documentId: 'p1:3', snapshotId: 'snap-4' }, fallback), 'snapshot');
});

test('guardedSend starts the send in the same step as the check, and not at all when the check fails', async () => {
  const log = [];
  const target = page();
  const sent = guardedSend(target, facts, { documentId: 'p1:3' }, () => {
    log.push('send');
    return Promise.resolve('ok');
  });
  log.push('after call');
  assert.deepEqual(log, ['send', 'after call']);
  assert.equal(await sent, 'ok');

  let called = false;
  await assert.rejects(
    guardedSend(target, facts, { documentId: 'p1:0' }, () => {
      called = true;
      return Promise.resolve();
    }),
    (error) => error.code === -32010
  );
  assert.equal(called, false);
  assert.equal(await guardedSend(target, facts, undefined, () => Promise.resolve('free')), 'free');
});
