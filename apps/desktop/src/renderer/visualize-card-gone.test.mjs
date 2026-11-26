import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { TurnChangesContext, TurnRowsContext } from './TurnChangesCard.tsx';
import {
  ToolVisualizeCards,
  TrailingTurnKeyContext,
  isTrailingTurnTools,
  trailingOpenTurnKey,
} from './transcript-visualize-card.tsx';
import { enforceRendererCacheBudget } from './renderer-cache-budget.ts';
import { resetVisualizeCardMemory, visualizeCardGone } from './visualize-card-model.ts';
import {
  applyVisualizeEvent,
  hydrateVisualizeStates,
  isVisualizeStateRehydrating,
  releaseVisualizeSession,
  resetVisualizePanelMemory,
  resyncVisualizeStates,
  setVisualizePanelOnScreen,
  useVisualizeState,
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

test('ToolVisualizeCards holds agent opens while its turn is still running even before held IPC arrives', async (t) => {
  resetVisualizeCardMemory();
  resyncVisualizeStates([]);
  resetVisualizePanelMemory();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = { visualizeCommand: async () => {} };
  t.after(() => {
    act(() => root.unmount());
    resetVisualizeCardMemory();
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  });

  const sessionId = 'held-race';
  const earlierOpen = openItem('o-prev', 'v1', OTHER, 100, 'Earlier');
  const currentOpen = openItem('o-cur', 'v2', TARGET, 200, 'Current');
  const rows = [
    { _tag: 'UserMessage', key: 'u1', turnKey: 't1', item: { kind: 'user', id: 'u1', text: 'first' } },
    { _tag: 'ToolActivity', key: 'ta1', turnKey: 't1', items: [earlierOpen] },
    { _tag: 'UserMessage', key: 'u2', turnKey: 't2', item: { kind: 'user', id: 'u2', text: 'second' } },
    { _tag: 'ToolActivity', key: 'ta2', turnKey: 't2', items: [currentOpen] },
  ];
  await act(async () =>
    applyVisualizeEvent({
      sessionId,
      state: state(sessionId, [tabView('v1', 'Earlier', OTHER), tabView('v2', 'Current', TARGET)]),
    })
  );

  const render = (surface, turnChanges) =>
    act(async () =>
      root.render(
        h(
          TurnChangesContext.Provider,
          { value: { sessionId, busy: true, onOpenSessionDiff() {}, onOpenFile() {}, ...surface } },
          h(
            TurnRowsContext.Provider,
            { value: () => rows },
            h(
              'div',
              null,
              h('div', { 'data-slot': 'earlier' }, h(ToolVisualizeCards, { items: [earlierOpen], sessionId })),
              h(
                'div',
                { 'data-slot': 'current' },
                h(ToolVisualizeCards, { items: [currentOpen], sessionId, turnChanges })
              )
            )
          )
        )
      )
    );
  const titles = (slot) =>
    [...document.querySelectorAll(`[data-slot="${slot}"] .transcript-visualize-tile b`)].map(
      (node) => node.textContent
    );

  // Visualize-only turn (no turnChanges ref) while running and heldSince is still null:
  // the trailing turn's card stays hidden, while the earlier turn's card stays visible.
  await render({ turnRunning: true, trailingCheckpointShown: false }, undefined);
  assert.deepEqual(titles('earlier'), ['Earlier'], 'earlier finished turn stays visible');
  assert.deepEqual(titles('current'), [], 'trailing turn holds even without heldSince or turnChanges');

  // Queuing a mid-turn steer (`steer: 'pending'`) must not cut off the trailing-turn scan and flash the card.
  rows.push({
    _tag: 'UserMessage',
    key: 'steer-1',
    turnKey: 'pending:steer-1',
    item: { kind: 'user', id: 'steer-1', text: 'also check header', pending: true, steer: 'pending' },
  });
  await render({ turnRunning: true, trailingCheckpointShown: false }, undefined);
  assert.deepEqual(titles('earlier'), ['Earlier'], 'earlier turn remains visible while steer is queued');
  assert.deepEqual(titles('current'), [], 'queued mid-turn steer does not flash trailing visualize cards');

  // Reclosed checkpoint that never stood idle also stays held while running.
  const reclosed = { checkpointId: 'cp2', boundary: 'd2', trailing: true, reclosed: true };
  await render({ turnRunning: true, trailingCheckpointShown: false }, reclosed);
  assert.deepEqual(titles('current'), [], 'unshown reclosed trailing turn stays held');

  // Once the turn finishes, the card attaches cleanly.
  await render({ turnRunning: false, trailingCheckpointShown: true }, reclosed);
  assert.deepEqual(titles('current'), ['Current'], 'attaches once at true turn end');
});

test('isTrailingTurnTools stops at completed turn boundaries and TrailingTurnKeyContext reactively reveals prior turn cards', async (t) => {
  resetVisualizeCardMemory();
  resyncVisualizeStates([]);
  resetVisualizePanelMemory();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  dom.window.mixdogDesktop = { visualizeCommand: async () => {} };
  t.after(() => {
    act(() => root.unmount());
    resetVisualizeCardMemory();
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  });

  const sessionId = 'wake-boundary';
  const turn1Open = openItem('o-t1', 'v1', OTHER, 100, 'Turn 1 Preview');
  const wakeShell = { id: 'sh-2', kind: 'tool', name: 'shell', args: {}, result: 'ok', status: 'done' };

  // Promptless wake after AssistantPart(completion) or Error must not classify Turn 1's tools as trailing.
  const wakeAfterCompletion = [
    { _tag: 'UserMessage', key: 'u1', turnKey: 't1', item: { kind: 'user', id: 'u1', text: 'first' } },
    { _tag: 'ToolActivity', key: 'ta1', turnKey: 't1', items: [turn1Open] },
    {
      _tag: 'AssistantPart',
      key: 'a1',
      turnKey: 't1',
      item: { kind: 'assistant', id: 'a1', text: 'done' },
      completion: { kind: 'turndone', id: 'd1', status: 'done' },
    },
    { _tag: 'TurnGap', key: 'g1', turnKey: 't2' },
    { _tag: 'ToolActivity', key: 'ta2', turnKey: 't2', items: [wakeShell] },
    { _tag: 'Thinking', key: 'th2', turnKey: 't2' },
  ];
  assert.equal(isTrailingTurnTools(wakeAfterCompletion, [turn1Open]), false, 'completion boundary stops scan');
  assert.equal(isTrailingTurnTools(wakeAfterCompletion, [wakeShell]), true, 'wake tools are still trailing');

  const wakeAfterError = [
    { _tag: 'UserMessage', key: 'u1', turnKey: 't1', item: { kind: 'user', id: 'u1', text: 'first' } },
    { _tag: 'ToolActivity', key: 'ta1', turnKey: 't1', items: [turn1Open] },
    { _tag: 'Error', key: 'e1', turnKey: 't1', item: { kind: 'error', id: 'e1', text: 'boom' } },
    { _tag: 'ToolActivity', key: 'ta2', turnKey: 't2', items: [wakeShell] },
  ];
  assert.equal(isTrailingTurnTools(wakeAfterError, [turn1Open]), false, 'Error boundary stops scan');

  // Constant-identity rowsOf + memoized child still updates immediately when TrailingTurnKeyContext transitions.
  await act(async () =>
    applyVisualizeEvent({
      sessionId,
      state: state(sessionId, [tabView('v1', 'Turn 1 Preview', OTHER)]),
    })
  );
  const rowsRef = {
    current: [
      { _tag: 'UserMessage', key: 'u1', turnKey: 't1', item: { kind: 'user', id: 'u1', text: 'first' } },
      { _tag: 'ToolActivity', key: 'ta1', turnKey: 't1', items: [turn1Open] },
    ],
  };
  const constantRowsOf = () => rowsRef.current;
  const constantSurface = { sessionId, busy: true, turnRunning: true, onOpenSessionDiff() {}, onOpenFile() {} };
  const constantItems = [turn1Open];
  const MemoCard = React.memo(function MemoCard() {
    return h(ToolVisualizeCards, { items: constantItems, sessionId, rowTurnKey: 't1' });
  });
  const renderRows = (rows) => {
    rowsRef.current = rows;
    return act(async () =>
      root.render(
        h(
          TurnChangesContext.Provider,
          { value: constantSurface },
          h(
            TurnRowsContext.Provider,
            { value: constantRowsOf },
            h(TrailingTurnKeyContext.Provider, { value: trailingOpenTurnKey(rows) }, h(MemoCard))
          )
        )
      )
    );
  };
  const tiles = () => [...document.querySelectorAll('.transcript-visualize-tile b')].map((n) => n.textContent);

  await renderRows(rowsRef.current);
  assert.deepEqual(tiles(), [], 'held while Turn 1 is the trailing open turn');

  // Transition to a promptless wake after Turn 1 completes while turnRunning stays true.
  await renderRows(wakeAfterCompletion);
  assert.deepEqual(
    tiles(),
    ['Turn 1 Preview'],
    'memoized prior row reveals immediately via TrailingTurnKeyContext when next turn starts'
  );
});

test('returning to an evicted session with goneOpens does not flash suppressed cards while rehydrating', async (t) => {
  resetVisualizeCardMemory();
  resyncVisualizeStates([]);
  resetVisualizePanelMemory();
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  let resolveSnapshot;
  dom.window.mixdogDesktop = {
    visualizeCommand: async () => {},
    visualizeState: () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
  };
  const sessionId = 'evict-no-flash';
  const goneOpen = openItem('o-gone', 'v1', OTHER, 100, 'Removed Tab');
  const keptOpen = openItem('o-kept', 'v2', TARGET, 200, 'Kept Tab');
  const heavyState = state(
    sessionId,
    [
      {
        ...tabView('v2', 'Kept Tab', TARGET),
        panes: [{ kind: 'html', target: TARGET, inline: { kind: 'html', source: `<p>${'a'.repeat(120_000)}</p>` } }],
      },
    ],
    { goneOpens: [{ tab: 'v1', call: 'o-gone' }] }
  );
  t.after(() => {
    act(() => root.unmount());
    releaseVisualizeSession(sessionId);
    resetVisualizeCardMemory();
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  });

  await act(async () => applyVisualizeEvent({ sessionId, state: heavyState }));
  enforceRendererCacheBudget(0);

  await act(async () => root.render(h(ToolVisualizeCards, { items: [goneOpen, keptOpen], sessionId })));
  const tiles = () => [...document.querySelectorAll('.transcript-visualize-tile b')].map((n) => n.textContent);
  assert.deepEqual(tiles(), [], 'neither goneOpens nor evicted tiles flash while rehydration IPC is in flight');

  await act(async () => {
    resolveSnapshot([heavyState]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(tiles(), ['Kept Tab'], 'only live card renders after rehydration settles');
});

test('failed rehydration mounts transcript tiles without resetting retries or looping without navigation', async (t) => {
  resetVisualizeCardMemory();
  resyncVisualizeStates([]);
  resetVisualizePanelMemory();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  const { dom, document, root } = installTestDom(t, {
    expose: ['HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent'],
    rootId: 'root',
  });
  const sessionId = 'evict-no-loop';
  const keptOpen = openItem('o-kept', 'v2', TARGET, 200, 'Kept Tab');
  const heavyState = state(sessionId, [
    {
      ...tabView('v2', 'Kept Tab', TARGET),
      panes: [{ kind: 'html', target: TARGET, inline: { kind: 'html', source: `<p>${'b'.repeat(120_000)}</p>` } }],
    },
  ]);
  let calls = 0;
  let shouldFail = true;
  dom.window.mixdogDesktop = {
    visualizeCommand: async () => {},
    visualizeState: () => {
      calls += 1;
      if (shouldFail) return Promise.reject(new Error(`ipc failure ${calls}`));
      return Promise.resolve([heavyState]);
    },
  };
  function PassiveReader({ id }) {
    useVisualizeState(id);
    return null;
  }
  t.after(() => {
    act(() => root.unmount());
    releaseVisualizeSession(sessionId);
    resetVisualizeCardMemory();
    resyncVisualizeStates([]);
    resetVisualizePanelMemory();
  });

  await act(async () => applyVisualizeEvent({ sessionId, state: heavyState }));
  enforceRendererCacheBudget(0);
  assert.equal(isVisualizeStateRehydrating(sessionId), true);

  // Initial mount starts attempt 1; failure mounts VisualizeTile without triggering an immediate retry loop.
  await act(async () => {
    root.render(h(ToolVisualizeCards, { items: [keptOpen], sessionId }));
    await flushMicrotasks();
  });
  const tiles = () => [...document.querySelectorAll('.transcript-visualize-tile b')].map((n) => n.textContent);
  assert.equal(calls, 1);
  assert.deepEqual(tiles(), ['Kept Tab'], 'tile renders after failed attempt without hiding in a loop');

  // Automatic bounded retries run on schedule (attempt 2, attempt 3) and then stop completely.
  await act(async () => {
    t.mock.timers.tick(1_500);
    await flushMicrotasks();
  });
  assert.equal(calls, 2);
  await act(async () => {
    t.mock.timers.tick(1_500);
    await flushMicrotasks();
  });
  assert.equal(calls, 3);
  assert.deepEqual(tiles(), ['Kept Tab']);

  // Advancing time and mounting another passive useVisualizeState reader must not reset retries.
  await act(async () => {
    root.render(
      h(
        React.Fragment,
        null,
        h(ToolVisualizeCards, { items: [keptOpen], sessionId }),
        h(PassiveReader, { id: sessionId })
      )
    );
    t.mock.timers.tick(10_000);
    await flushMicrotasks();
  });
  assert.equal(calls, 3, 'passive subscriptions never reset retry bounds or loop reads');

  // A genuine panel visit resets retries and recovers the session.
  shouldFail = false;
  await act(async () => {
    setVisualizePanelOnScreen(sessionId, true);
    await flushMicrotasks();
  });
  assert.equal(calls, 4);
  assert.equal(isVisualizeStateRehydrating(sessionId), false);
});
