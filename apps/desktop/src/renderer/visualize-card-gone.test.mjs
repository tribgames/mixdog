// A turn's preview card follows the host's turn-end record (`goneOpens` on the
// session's visualize state): an open whose tab had nothing left to show when
// its turn ended draws no tile. The card holds no decision of its own, so a
// remount, a fresh renderer and a remote client all agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesContext } from './TurnChangesCard.tsx';
import { ToolVisualizeCards } from './transcript-visualize-card.tsx';
import { resetVisualizeCardMemory, visualizeCardGone } from './visualize-card-model.ts';
import {
  applyVisualizeEvent,
  hydrateVisualizeStates,
  resetVisualizePanelMemory,
  resyncVisualizeStates,
} from './visualize-store.ts';

const h = React.createElement;
const TARGET = 'C:/Temp/mockup/index.html';
const OTHER = 'C:/Temp/other/index.html';

const tabView = (id, label, target, extra = {}) => ({
  id,
  label,
  revision: 0,
  panes: [{ kind: 'html', label: 'index.html', target, url: '' }],
  ...extra,
});

const historyOf = (label) => [{ id: `h-${label}`, label, kind: 'html', versions: 1, at: 1, open: false }];

const openItem = (id, tab, target, at, label) => ({
  id,
  kind: 'tool',
  name: 'visualize',
  args: { action: 'open', input: { targets: [target], label } },
  result: `Showing ${target} (html) in the side panel as tab ${tab}.`,
  status: 'done',
  startedAt: at,
  completedAt: at + 1,
});

/** Mounts the cards of each `{ sessionId, items }` side by side. */
async function mountCards(t, sessions) {
  resetVisualizeCardMemory();
  resyncVisualizeStates([]);
  resetVisualizePanelMemory();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = { visualizeCommand: async () => {} };
  t.after(() => {
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  });
  const mount = () =>
    act(async () => {
      root.render(
        sessions.map(({ sessionId, items }) =>
          h(
            'div',
            { key: sessionId, 'data-session': sessionId },
            h(
              TurnChangesContext.Provider,
              { value: { sessionId, busy: false, turnRunning: false, onOpenSessionDiff() {}, onOpenFile() {} } },
              h(ToolVisualizeCards, { items, sessionId })
            )
          )
        )
      );
    });
  await mount();
  const send = (sessionId, event) => act(async () => applyVisualizeEvent({ sessionId, ...event }));
  const tiles = (sessionId) =>
    [...document.querySelectorAll(`[data-session="${sessionId}"] .transcript-visualize-tile`)].map((tile) => [
      tile.querySelector('b').textContent,
      tile.dataset.visualizeCard,
    ]);
  const card = (sessionId) => document.querySelector(`[data-session="${sessionId}"] .transcript-visualize-turn`);
  const unmount = () => act(async () => root.render(null));
  return { send, tiles, card, mount, unmount };
}

const state = (sessionId, tabs, extra = {}) => ({ sessionId, tabs, active: tabs[0]?.id ?? null, ...extra });
const ONE = (sessionId) => [{ sessionId, items: [openItem('o1', 'v4', TARGET, 10, '실제 CSS 확인')] }];

test('deleted in the same turn: the turn end hands over the record and the tile is absent', async (t) => {
  const view = await mountCards(t, ONE('gone-deleted'));
  const open = state('gone-deleted', [tabView('v4', '실제 CSS 확인', TARGET)]);
  await view.send('gone-deleted', { state: open, held: true, heldSince: 5 });
  assert.deepEqual(view.tiles('gone-deleted'), [], 'no card while the turn runs');
  await view.send('gone-deleted', {
    state: state('gone-deleted', [tabView('v4', '실제 CSS 확인', TARGET, { missing: true })], {
      goneOpens: [{ tab: 'v4', call: 'o1' }],
    }),
  });
  assert.deepEqual(view.tiles('gone-deleted'), []);
  assert.equal(view.card('gone-deleted'), null, 'every tile removed: no card');
});

test('opened and closed in the same turn: the tile is absent', async (t) => {
  const view = await mountCards(t, ONE('gone-closed'));
  await view.send('gone-closed', {
    state: state('gone-closed', [tabView('v4', '실제 CSS 확인', TARGET)]),
    held: true,
    heldSince: 5,
  });
  await view.send('gone-closed', {
    state: state('gone-closed', [], { history: historyOf('x'), goneOpens: [{ tab: 'v4', call: 'o1' }] }),
  });
  assert.deepEqual(view.tiles('gone-closed'), []);
  assert.equal(view.card('gone-closed'), null);
});

test('the record outlives the card: a remount, and a fresh renderer that never saw the turn, agree', async (t) => {
  const view = await mountCards(t, ONE('gone-fresh'));
  const final = state('gone-fresh', [], { history: historyOf('x'), goneOpens: [{ tab: 'v4', call: 'o1' }] });
  await view.send('gone-fresh', {
    state: state('gone-fresh', [tabView('v4', '실제 CSS 확인', TARGET)]),
    held: true,
    heldSince: 5,
  });
  await view.send('gone-fresh', { state: final });
  assert.deepEqual(view.tiles('gone-fresh'), []);
  // The user left the conversation and came back: the cards mount again.
  await view.unmount();
  await view.mount();
  assert.deepEqual(view.tiles('gone-fresh'), [], 'a remounted card');
  // A restarted window, or a phone connecting after the turn: nothing was seen
  // running; the state read from the host carries the record.
  await view.unmount();
  resetVisualizeCardMemory();
  resyncVisualizeStates([]);
  resetVisualizePanelMemory();
  hydrateVisualizeStates([final]);
  await view.mount();
  assert.deepEqual(view.tiles('gone-fresh'), [], 'a fresh renderer');
  assert.equal(view.card('gone-fresh'), null);
});

test('an earlier turn keeps its tile: the record covers only the turn it was made for', async (t) => {
  const items = [openItem('o1', 'v1', TARGET, 9500, 'Earlier'), openItem('o2', 'v2', OTHER, 10500, 'Later')];
  const view = await mountCards(t, [{ sessionId: 'gone-earlier', items }]);
  // The later turn (10000..11000) lost its tab v2, and also v1, which it reopened by another call.
  await view.send('gone-earlier', {
    state: state('gone-earlier', [], {
      history: historyOf('x'),
      goneOpens: [
        { tab: 'v1', call: 'later-open' },
        { tab: 'v2', call: 'o2' },
      ],
    }),
  });
  assert.deepEqual(view.tiles('gone-earlier'), [['Earlier', 'closed']], 'only the later turn’s tile goes');
});

test('adjacent turns on one tab: a record names its own open, never an earlier one a moment before', () => {
  const call = (id, at) => ({ id, callId: id, pending: false, targets: [TARGET], label: '', tabId: 'v1', at });
  // Turn A's open (9500) ends just before turn B (10000..11000) reopens the same tab (10100).
  const earlier = call('open-a', 9500);
  const later = call('open-b', 10100);
  const goneOpens = [{ tab: 'v1', call: 'open-b' }];
  assert.equal(visualizeCardGone(goneOpens, earlier), false);
  assert.equal(visualizeCardGone(goneOpens, later), true);
  assert.equal(visualizeCardGone(undefined, later), false, 'a host without the record drops nothing');
  assert.equal(visualizeCardGone([{ tab: 'v2', call: 'open-b' }], later), false, 'another tab');
});

test('a file deleted after its turn ended: the earlier tile stays, whatever happens next', async (t) => {
  const view = await mountCards(t, ONE('gone-later'));
  const name = '실제 CSS 확인';
  await view.send('gone-later', { state: state('gone-later', [tabView('v4', '실제 CSS 확인', TARGET)]) });
  assert.deepEqual(view.tiles('gone-later'), [[name, 'open']]);
  await view.send('gone-later', {
    state: state('gone-later', [tabView('v4', '실제 CSS 확인', TARGET, { missing: true })]),
  });
  assert.deepEqual(view.tiles('gone-later'), [[name, 'open']]);
  await view.send('gone-later', { state: state('gone-later', [], { history: historyOf('x') }) });
  assert.deepEqual(view.tiles('gone-later'), [[name, 'closed']]);
});

test('sessions are isolated: another session’s records never hide, or bring back, a tile', async (t) => {
  const view = await mountCards(t, [...ONE('iso-a'), ...ONE('iso-b')]);
  // Far more records than any shared cap would hold, all in session A.
  const crowd = Array.from({ length: 600 }, (_, index) => ({ tab: `v${index + 10}`, call: `x${index}` }));
  await view.send('iso-a', {
    state: state('iso-a', [], {
      history: historyOf('x'),
      goneOpens: [{ tab: 'v4', call: 'o1' }, ...crowd],
    }),
  });
  await view.send('iso-b', { state: state('iso-b', [tabView('v4', '실제 CSS 확인', TARGET)]) });
  assert.deepEqual(view.tiles('iso-a'), []);
  assert.deepEqual(
    view.tiles('iso-b'),
    [['실제 CSS 확인', 'open']],
    'the same tab id and time in another session stays'
  );
  // A's record is not evicted by anything B does.
  await view.send('iso-b', {
    state: state('iso-b', [tabView('v4', '실제 CSS 확인', TARGET)], { history: historyOf('y') }),
  });
  assert.deepEqual(view.tiles('iso-a'), []);
});
