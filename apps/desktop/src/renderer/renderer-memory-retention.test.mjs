import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { deleteSessionImagePreviews } from './image-preview-store.ts';
import { totalBudgetedChars } from './renderer-cache-budget.ts';
import { createSessionLaneStore } from './session-lane-store.ts';
import {
  createTranscriptSnapshotDecorator,
  sharedTranscriptSnapshotDecorator,
} from './snapshot-transcript-decoration.ts';
import { createTranscriptIdentityReconciler } from './transcript-identity.ts';
import { loadAttachmentThumbnail } from './transcript-row.tsx';
import { CompletionStatus, completionActivityKey } from './transcript-status.tsx';
import './i18n.ts';

const BULK = 'y'.repeat(2_000);
// Rows carry bulky payloads the identity baseline must not need to keep.
const row = (index, prefix) => {
  const turn = Math.floor(index / 4);
  const kind = ['user', 'tool', 'assistant', 'turndone'][index % 4];
  return {
    id: `${prefix}${index}`,
    kind,
    ...(kind === 'user' ? { text: `${turn}: question ${BULK}` } : {}),
    ...(kind === 'assistant' ? { text: `${turn}: answer ${BULK}` } : {}),
    ...(kind === 'tool' ? { name: 'read', args: { blob: BULK }, result: BULK } : {}),
    ...(kind === 'turndone' ? { status: 'done', label: `Worked ${turn}s` } : {}),
  };
};
const rows = (from, to, prefix) => Array.from({ length: to - from }, (_, i) => row(from + i, prefix));
const ids = (snapshot) => snapshot.items.map((item) => item.id);

test('identity stays stable across tail-window frames with the reduced baseline record', () => {
  const reconciler = createTranscriptIdentityReconciler();
  reconciler.reconcile({ sessionId: 's', items: rows(0, 40, 'a') });
  // A tail window from another id namespace adopts the displayed ids.
  const windowed = reconciler.reconcile({ sessionId: 's', items: rows(20, 40, 'b') });
  assert.deepEqual(
    ids(windowed),
    rows(20, 40, 'a').map((item) => item.id)
  );
  // The merged superset survives: the full frame in the other namespace still adopts every id.
  const full = reconciler.reconcile({ sessionId: 's', items: rows(0, 40, 'c') });
  assert.deepEqual(
    ids(full),
    rows(0, 40, 'a').map((item) => item.id)
  );
  // A streaming append keeps ids and the same array arriving again is a no-op.
  const appended = rows(0, 41, 'd');
  assert.deepEqual(ids(reconciler.reconcile({ sessionId: 's', items: appended })), [
    ...rows(0, 40, 'a').map((item) => item.id),
    'd40',
  ]);
  const again = reconciler.reconcile({ sessionId: 's', items: appended });
  assert.equal(again.items.length, 41);
});

test('long texts sharing the clipped prefix never align to each other', () => {
  const prefix = 'shared prompt prefix '.repeat(40); // > 512 chars
  const turn = (name, u, t) => [
    { id: u, kind: 'user', text: `${prefix}Task ${name}` },
    { id: t, kind: 'tool', name: 'read', args: { blob: BULK } },
  ];
  const seeded = () => {
    const reconciler = createTranscriptIdentityReconciler();
    reconciler.reconcile({ sessionId: 's', items: [...turn('A', 'u1', 't1'), ...turn('B', 'u2', 't2')] });
    return reconciler;
  };
  assert.deepEqual(ids(seeded().reconcile({ sessionId: 's', items: turn('A', 'x1', 'x2') })), ['u1', 't1']);
  assert.deepEqual(ids(seeded().reconcile({ sessionId: 's', items: turn('B', 'y1', 'y2') })), ['u2', 't2']);
});

test('a 750-char common prefix with different endings never aligns, in either direction', () => {
  const prefix = 'p'.repeat(750);
  const A = `${prefix}Task A long version`;
  const B = `${prefix}Task B`;
  const rowsOf = (text, tag, count = 120) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${tag}${i}`,
      kind: i % 2 ? 'tool' : 'user',
      name: 'read',
      text: i === 0 ? text : `q${i}`,
    }));
  for (const [baseText, incomingText] of [
    [A, B],
    [B, A],
  ]) {
    const reconciler = createTranscriptIdentityReconciler();
    reconciler.reconcile({ sessionId: 's', items: rowsOf(baseText, 'a') });
    // Tail window whose first row is the other text: it must keep its own id.
    const tail = reconciler.reconcile({ sessionId: 's', items: rowsOf(incomingText, 'b').slice(0, 1) });
    assert.equal(ids(tail)[0], 'b0');
    const fresh = createTranscriptIdentityReconciler();
    fresh.reconcile({ sessionId: 's', items: rowsOf(baseText, 'a') });
    const full = fresh.reconcile({ sessionId: 's', items: rowsOf(incomingText, 'c') });
    assert.ok(
      ids(full).every((id, i) => id === `c${i}`),
      'a different history keeps every id'
    );
  }
});

test('a long streaming prefix still aligns to its grown text', () => {
  const prefix = 'streamed answer '.repeat(80);
  const reconciler = createTranscriptIdentityReconciler();
  reconciler.reconcile({
    sessionId: 's',
    items: [{ id: 'a1', kind: 'assistant', text: `${prefix}${'x'.repeat(700)}` }],
  });
  const grown = reconciler.reconcile({
    sessionId: 's',
    items: [{ id: 'z9', kind: 'assistant', text: `${prefix}${'x'.repeat(900)}` }],
  });
  assert.deepEqual(ids(grown), ['a1']);
});

test('every visible lane (9+) keeps stable row ids while sources alternate', () => {
  const reconciler = createTranscriptIdentityReconciler();
  const lanes = Array.from({ length: 10 }, (_, lane) => `lane-${lane}`);
  for (const sessionId of lanes) reconciler.reconcile({ sessionId, items: rows(0, 12, `${sessionId}-a`) });
  for (const sessionId of lanes) {
    const next = reconciler.reconcile({ sessionId, items: rows(4, 12, `${sessionId}-b`) });
    assert.deepEqual(
      ids(next),
      rows(4, 12, `${sessionId}-a`).map((item) => item.id)
    );
  }
});

test('forgetting a session frees its identity baseline', () => {
  const reconciler = createTranscriptIdentityReconciler();
  reconciler.reconcile({ sessionId: 's', items: rows(0, 12, 'a') });
  reconciler.forget('s');
  const next = reconciler.reconcile({ sessionId: 's', items: rows(0, 12, 'b') });
  assert.equal(ids(next)[0], 'b0', 'no baseline left to adopt from');
});

test('the decorator forgets a session and its failure scope; scopes are on the shared budget', () => {
  const decorator = createTranscriptSnapshotDecorator({ register: false });
  const failed = (prefix) => [
    { id: `${prefix}0`, kind: 'user', text: 'go' },
    { id: `${prefix}1`, kind: 'turndone', status: 'failed' },
  ];
  const first = decorator.decorate({ sessionId: 's', items: failed('a') });
  assert.equal(first.failedTurnKeys.length, 1);
  assert.deepEqual(ids(decorator.decorate({ sessionId: 's', items: failed('b') })), ['a0', 'a1']);
  decorator.forget('s');
  const fresh = decorator.decorate({ sessionId: 's', items: failed('c') });
  assert.deepEqual(ids(fresh), ['c0', 'c1']);
  assert.equal(fresh.failedTurnKeys.length, 1);
  for (let index = 0; index < 30; index += 1)
    decorator.decorate({ sessionId: `many-${index}`, items: failed(`m${index}`) });
  assert.equal(decorator.decorate({ sessionId: 's', items: failed('c') }).failedTurnKeys.length, 1);

  sharedTranscriptSnapshotDecorator.decorate({ sessionId: 'shared', items: failed('z') });
  assert.ok(totalBudgetedChars() > 0);
});

test('the lane store forgets a session on lane teardown and on an uncached unmount', () => {
  const forgotten = [];
  const decorator = { decorate: (snapshot) => snapshot, clear() {}, forget: (id) => forgotten.push(id) };
  const store = createSessionLaneStore({ decorator });
  store.apply({ sessionId: 'kept', snapshot: { sessionId: 'kept', items: [] }, frameSource: 'session.read' });
  store.subscribe('kept', () => {})();
  assert.deepEqual(forgotten, [], 'a cached lane keeps its baseline for re-entry');
  store.subscribe('never-cached', () => {})();
  assert.deepEqual(forgotten, ['never-cached']);
  store.apply({ sessionId: 'kept', snapshot: null, laneEnd: 'gone', frameSource: 'session.read' });
  assert.deepEqual(forgotten, ['never-cached', 'kept']);
});

test('a deleted session drops its failed-thumbnail and completed-turn records', async () => {
  globalThis.window ??= {};
  const calls = [];
  globalThis.window.mixdogDesktop = {
    readAttachmentThumbnail: (ref) => {
      calls.push(ref);
      return Promise.resolve(null);
    },
  };
  const asIs = async (value) => value;
  assert.equal(await loadAttachmentThumbnail('chat-gone', 'ref-1', asIs), undefined);
  assert.equal(await loadAttachmentThumbnail('chat-gone', 'ref-1', asIs), undefined);
  assert.deepEqual(calls, ['ref-1'], 'a miss is remembered while the session lives');
  deleteSessionImagePreviews('chat-gone');
  assert.equal(await loadAttachmentThumbnail('chat-gone', 'ref-1', asIs), undefined);
  assert.deepEqual(calls, ['ref-1', 'ref-1'], 'deleting the session forgot the miss');

  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' }, expose: ['navigator'] });
  const root = createRoot(document.getElementById('root'));
  const animates = async () => {
    await act(async () => {
      root.render(
        React.createElement(CompletionStatus, {
          item: { kind: 'turndone', verb: 'Done' },
          animateComplete: true,
          completionActivityKey: completionActivityKey('sess-gone', 'turn:1'),
        })
      );
    });
    const value = document.querySelector('.turn-status.complete')?.getAttribute('data-animate');
    await act(async () => root.render(null));
    return value;
  };
  try {
    assert.equal(await animates(), 'true');
    assert.equal(await animates(), null, 'a completed turn does not animate again');
    deleteSessionImagePreviews('sess-gone');
    assert.equal(await animates(), 'true', 'the ended session was forgotten');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});
