// Visualize during an agent turn (turn-hold.ts): opens and file changes are
// kept from the panel until the turn ends; check / inspect / capture still
// answer mid-turn, off screen.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import {
  applyVisualizeEvent,
  hydrateVisualizeStates,
  resyncVisualizeStates,
  visualizeHeldSince,
  visualizeStateFor,
  visualizeUpdatedTabs,
} from '../../renderer/visualize-store.ts';
import { visualizeCardsShown } from '../../renderer/visualize-card-model.ts';
import { remoteVisualizeState } from '../../shared/visualize.ts';
import { createVisualizeService } from './service.ts';

const SESSION = 's1';

/** A turn end's first card picture waits for `release`; `asked` resolves once that end asks for it. */
function heldPicture() {
  let reached;
  let release;
  let first = true;
  const asked = new Promise((resolve) => {
    reached = resolve;
  });
  return {
    asked,
    release: () => release(),
    take() {
      if (!first) return Promise.resolve(null);
      first = false;
      reached();
      return new Promise((resolve) => {
        release = () => resolve(null);
      });
    },
  };
}

/** Everything that can run without the clock or a release has run. */
const idle = () => new Promise((resolve) => setImmediate(resolve));

/** What a window shows of the session: its tabs and whether a turn's work is kept back, since when. */
const windowShows = () => ({ state: visualizeStateFor(SESSION), heldSince: visualizeHeldSince(SESSION) });

function setup(overrides = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-turn-hold-')));
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'a.html'), '<h1>a</h1>');
  writeFileSync(join(cwd, 'site', 'b.html'), '<h1>b</h1>');
  writeFileSync(join(cwd, 'chart.png'), 'png');
  const events = [];
  const hostEvents = [];
  const watched = new Map();
  const calls = { capture: 0, inspect: 0, offscreen: [], exportBytes: [] };
  let prepared = 0;
  const deps = {
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane(target) {
      prepared += 1;
      return `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}?${prepared}`;
    },
    publish: (event) => events.push(event),
    publishHost: (event) => hostEvents.push(event),
    watch(path, onChange) {
      watched.set(path, onChange);
      return () => watched.delete(path);
    },
    annotate: async () => [],
    async inspect() {
      calls.inspect += 1;
      return [];
    },
    async inspectOffscreen(pane, allowNetwork, options) {
      calls.offscreen.push({ pane: pane.label, allowNetwork, options });
      return {
        result: { elements: [], findings: [], outline: [], viewport: {}, page: {} },
        problems: ['error: boom (line 3)'],
      };
    },
    async capture() {
      calls.capture += 1;
      return Buffer.from('SCREEN');
    },
    async exportBytes(_sessionId, tab, format, pane, files) {
      calls.exportBytes.push({ tab: tab.id, format, pane, files });
      return Buffer.from('OFFSCREEN');
    },
    async onScreen() {
      return 'visible';
    },
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  };
  const service = createVisualizeService(deps);
  const run = (action, input) => service.execute({ sessionId: SESSION, cwd, action, input });
  const reveals = () => events.filter((event) => event.reveal);
  const shown = () => events.filter((event) => !event.held);
  return {
    cwd,
    events,
    hostEvents,
    watched,
    calls,
    service,
    run,
    reveals,
    shown,
    cleanup() {
      service.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

test('several opens during a turn publish nothing visible; the turn end reveals the last tab once', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    const first = await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'], label: 'B draft' });
    await t.run('open', { targets: ['site/a.html'], label: 'A final' });
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
    await t.run('open', { targets: ['site/b.html'], label: 'B final' });
    assert.match(first.text, /as tab v1\b/);
    assert.match(first.text, /when this turn ends/);
    assert.equal(t.reveals().length, 0, 'no reveal while the turn runs');
    assert.equal(t.shown().length, 0, 'every mid-turn publish is held');
    assert.ok(t.events.every((event) => event.held === true));
    assert.ok(t.hostEvents.every((event) => event.held === true && !event.reveal));

    await t.service.setTurnActive(SESSION, false);
    const visible = t.shown();
    assert.equal(visible.length, 1, 'one publish at the turn end');
    assert.equal(visible[0].reveal, true);
    const state = visible[0].state;
    // De-duplicated per target, in open order, with the last label.
    assert.deepEqual(
      state.tabs.map((tab) => [tab.id, tab.label]),
      [
        ['v1', 'A final'],
        ['v3', 'Flow'],
        ['v2', 'B final'],
      ]
    );
    assert.equal(visible[0].tab, 'v2');
    assert.equal(state.active, 'v2');
    assert.equal(t.hostEvents.filter((event) => event.reveal).length, 1);
  } finally {
    t.cleanup();
  }
});

test('a snapshot taken during a held turn carries what the session shows, the hold and since when; after the release it carries none', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/b.html'] });
    const since = t.events.at(-1).heldSince;
    assert.ok(Number.isFinite(since));
    // What a reclaim publishes (the host's snapshot) and what a reloaded window reads: both say the turn is held, and
    // neither holds anything of it.
    for (const snapshot of [t.service.hostSnapshot(), t.service.snapshot()]) {
      assert.equal(snapshot.length, 1);
      assert.deepEqual([snapshot[0].held, snapshot[0].heldSince], [true, since]);
      assert.deepEqual(
        snapshot[0].tabs.map((tab) => tab.id),
        ['v1']
      );
    }
    await t.service.setTurnActive(SESSION, false);
    for (const snapshot of [t.service.hostSnapshot(), t.service.snapshot()]) {
      assert.deepEqual([snapshot[0].held, snapshot[0].heldSince], [undefined, undefined], 'released: the state alone');
      assert.deepEqual(
        snapshot[0].tabs.map((tab) => tab.id),
        ['v1', 'v2']
      );
    }
  } finally {
    t.cleanup();
  }
});

test('a hold a window read from a snapshot ends with the turn, though the turn published nothing', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, true);
    t.events.length = 0;
    t.hostEvents.length = 0;
    // A window reloads mid-turn, and the remote mirror is claimed again: both now know of the hold.
    assert.equal(t.service.snapshot()[0].held, true);
    assert.equal(t.service.hostSnapshot()[0].held, true);
    await t.service.setTurnActive(SESSION, false);
    for (const published of [t.events, t.hostEvents]) {
      assert.equal(published.length, 1, 'the end is told');
      assert.equal(published[0].held, undefined);
      assert.deepEqual(
        published[0].state.tabs.map((tab) => tab.id),
        ['v1']
      );
    }
  } finally {
    t.cleanup();
  }
});

test('a failed or cancelled turn still shows what it opened', async () => {
  const t = setup();
  try {
    await t.service.observeTurns([{ id: SESSION, working: true, leadWorking: true }]);
    await t.run('open', { targets: ['site/a.html'] });
    assert.equal(t.reveals().length, 0);
    // The session went idle (stopped or failed alike), or left the roster.
    await t.service.observeTurns([]);
    assert.equal(t.reveals().length, 1);
    assert.equal(t.reveals()[0].tab, 'v1');
  } finally {
    t.cleanup();
  }
});

test('turns that follow one another without a pause each show what they opened at their own end', async () => {
  const picture = heldPicture();
  const t = setup({ thumbnailOffscreen: picture.take });
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  try {
    const firstStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await t.run('open', { targets: ['site/a.html'] });
    // The turn ends; a task notification starts the next one while that end is still being applied.
    mock.timers.tick(100);
    const ending = t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    await picture.asked;
    mock.timers.tick(100);
    const secondStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    // What the next turn asks for meanwhile waits for that end.
    mock.timers.tick(100);
    const secondOpen = Date.now();
    const opening = t.run('open', { targets: ['site/b.html'] });
    // The same turn's next row says it still runs.
    mock.timers.tick(100);
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await idle();
    assert.ok(
      t.events.every((event) => event.held === true && event.heldSince === firstStart && !event.reveal),
      'until the first turn’s end is applied its own cards wait too'
    );
    picture.release();
    await ending;
    await opening;

    const firstEnd = t.reveals();
    assert.deepEqual(
      firstEnd.map((event) => [event.held, event.heldSince, event.tab, event.state.tabs.map((tab) => tab.id)]),
      [[true, secondStart, 'v1', ['v1']]],
      'the first turn’s end shows its own tab only, and the session stays held for the second'
    );
    assert.ok(secondStart < secondOpen, 'so the second turn’s own open’s card waits for its end');
    const after = t.events.slice(t.events.indexOf(firstEnd[0]) + 1);
    assert.ok(after.length > 0);
    assert.ok(
      after.every(
        (event) => event.held === true && event.heldSince === secondStart && event.state.tabs.length === 1
      ),
      'held from the second turn’s first start signal, never released while it runs'
    );

    await t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    const secondEnd = t.reveals().at(-1);
    assert.equal(secondEnd.held, undefined);
    assert.deepEqual([secondEnd.tab, secondEnd.state.tabs.map((tab) => tab.id)], ['v2', ['v1', 'v2']]);
  } finally {
    mock.timers.reset();
    t.cleanup();
  }
});

test('a page the next turn opens again while the earlier turn’s end is applied shows as the earlier turn left it', async () => {
  const picture = heldPicture();
  const t = setup({ thumbnailOffscreen: picture.take });
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  try {
    const flow = (source) => ({ content: { kind: 'svg', source, title: 'Flow' } });
    const pages = (state) => state.tabs.map((tab) => [tab.id, tab.panes[0].inline.source, tab.versions.length]);
    const one = [['v1', '<svg>one</svg>', 1]];
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await t.run('open', flow('<svg>one</svg>'));
    mock.timers.tick(100);
    const ending = t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    await picture.asked;
    mock.timers.tick(100);
    const secondStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    // The next turn reworks the page and opens it again before the first turn's end is applied.
    const reopening = t.run('open', flow('<svg>two</svg>'));
    await idle();
    picture.release();
    await ending;
    await reopening;

    for (const published of [t.events, t.hostEvents]) {
      const firstEnd = published.filter((event) => event.reveal);
      assert.deepEqual(
        firstEnd.map((event) => [event.held, event.heldSince, event.tab]),
        [[true, secondStart, 'v1']]
      );
      assert.deepEqual(pages(firstEnd[0].state), one, 'the first turn’s end carries its own page');
      assert.ok(
        published.every((event) => pages(event.state).every(([, source]) => source === '<svg>one</svg>')),
        'nothing published while the second turn runs carries its page'
      );
    }
    for (const snapshot of [t.service.snapshot(), t.service.hostSnapshot()]) {
      assert.deepEqual(pages(snapshot[0]), one, 'nor does a read');
    }

    await t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    const secondEnd = t.reveals().at(-1);
    assert.equal(secondEnd.held, undefined);
    assert.deepEqual(pages(secondEnd.state), [['v1', '<svg>two</svg>', 2]], 'the second turn’s page shows at its end');
  } finally {
    mock.timers.reset();
    t.cleanup();
  }
});

test('a window that loads and a paired device that reconnects while the next turn runs show the earlier turn’s result, as the live window does', async () => {
  const published = [];
  const t = setup({ publish: (event) => published.push(structuredClone(event)) });
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  resyncVisualizeStates([]);
  try {
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await t.run('open', { targets: ['site/a.html'] });
    mock.timers.tick(100);
    const ending = t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    mock.timers.tick(100);
    const secondStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await ending;
    mock.timers.tick(100);
    await t.run('open', { targets: ['site/b.html'] });

    // The window that was live through all of it.
    for (const event of published.splice(0)) applyVisualizeEvent(event);
    const live = windowShows();
    assert.deepEqual(
      live.state.tabs.map((tab) => tab.id),
      ['v1'],
      'the first turn’s tab, nothing of the running turn'
    );
    assert.equal(live.state.active, 'v1');
    assert.equal(live.heldSince, secondStart);

    // A window opened or reloaded now, one that reads again, and a phone that reconnects.
    const snapshot = structuredClone(t.service.snapshot());
    resyncVisualizeStates([]);
    hydrateVisualizeStates(snapshot);
    assert.deepEqual(windowShows(), live, 'a window that loads');
    resyncVisualizeStates(snapshot);
    assert.deepEqual(windowShows(), live, 'a window that reads again');
    resyncVisualizeStates(structuredClone(t.service.hostSnapshot()).map(remoteVisualizeState));
    const phone = windowShows();
    assert.deepEqual(
      [phone.heldSince, phone.state.active, phone.state.tabs.map((tab) => tab.id)],
      [secondStart, 'v1', ['v1']],
      'a paired device'
    );

    // The running turn's end, in the window that was live and in a read after it.
    resyncVisualizeStates(snapshot);
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    for (const event of published.splice(0)) applyVisualizeEvent(event);
    const ended = windowShows();
    assert.deepEqual(
      [ended.heldSince, ended.state.active, ended.state.tabs.map((tab) => tab.id)],
      [null, 'v2', ['v1', 'v2']]
    );
    resyncVisualizeStates(structuredClone(t.service.snapshot()));
    assert.deepEqual(windowShows(), ended);
  } finally {
    resyncVisualizeStates([]);
    mock.timers.reset();
    t.cleanup();
  }
});

test('a tab the user opens while a turn runs (a chat card, an ended turn’s previews) joins what the session shows; the turn’s work stays kept back', async () => {
  const t = setup();
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  try {
    const ids = (state) => state.tabs.map((tab) => tab.id);
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await t.run('open', { targets: ['site/a.html'] });
    mock.timers.tick(100);
    const ending = t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    mock.timers.tick(100);
    const secondStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await ending;
    await t.run('open', { targets: ['site/b.html'] });
    t.events.length = 0;
    t.hostEvents.length = 0;

    // The first turn's end is shown: its preview of a file it changed opens now, as its cards appeared.
    await t.service.command({ sessionId: SESSION, tabId: 'preview', action: 'reopen', targets: ['chart.png'] });
    for (const published of [t.events, t.hostEvents]) {
      assert.deepEqual(
        published.map((event) => [event.held, event.heldSince, event.reveal, event.tab, ids(event.state)]),
        [[true, secondStart, true, 'v3', ['v1', 'v3']]],
        'the preview tab shows beside the first turn’s tab; the second turn’s is not shown'
      );
      assert.equal(published[0].state.active, 'v3');
    }
    for (const snapshot of [t.service.snapshot(), t.service.hostSnapshot()]) {
      assert.deepEqual([snapshot[0].held, snapshot[0].active, ids(snapshot[0])], [true, 'v3', ['v1', 'v3']]);
    }

    await t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    const end = t.shown().at(-1);
    assert.deepEqual([end.reveal, end.tab, ids(end.state)], [true, 'v2', ['v1', 'v2', 'v3']]);
  } finally {
    mock.timers.reset();
    t.cleanup();
  }
});

test('a turn that only changed files shows them at its own end when the next turn starts at once', async () => {
  const t = setup({ publish: (event) => applyVisualizeEvent(structuredClone(event)) });
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  resyncVisualizeStates([]);
  try {
    const page = join(t.cwd, 'site', 'a.html');
    const change = (text) => {
      writeFileSync(page, text);
      t.watched.get(page)();
    };
    const shown = () => visualizeStateFor(SESSION).tabs[0];
    await t.run('open', { targets: ['site/a.html'] });
    const opened = shown();

    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    change('<h1>first turn</h1>');
    assert.equal(shown().revision, opened.revision, 'nothing reloads while the turn runs');
    mock.timers.tick(100);
    const ending = t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    mock.timers.tick(100);
    const secondStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    await ending;

    const first = shown();
    assert.ok(first.revision > opened.revision, 'the first turn’s change shows at its end');
    assert.notEqual(first.panes[0].url, opened.panes[0].url);
    assert.equal(visualizeHeldSince(SESSION), secondStart, 'while the second turn stays held');
    assert.equal(t.service.snapshot()[0].tabs[0].revision, first.revision, 'a read says the same');

    change('<h1>second turn</h1>');
    assert.equal(shown().revision, first.revision, 'the second turn’s change waits for its own end');
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    assert.ok(shown().revision > first.revision);
    assert.equal(visualizeHeldSince(SESSION), null);
  } finally {
    resyncVisualizeStates([]);
    mock.timers.reset();
    t.cleanup();
  }
});

test('a Lead gone idle ends its turn while its child agents still run', async () => {
  const t = setup();
  try {
    await t.service.observeTurns([{ id: SESSION, working: true, leadWorking: true }]);
    await t.run('open', { targets: ['site/a.html'] });
    assert.equal(t.reveals().length, 0);
    // The roster omits leadWorking for an idle Lead; `working` still counts its agents.
    await t.service.observeTurns([{ id: SESSION, working: true, agentWorking: true }]);
    assert.equal(t.reveals().length, 1, 'the turn ended: its tab shows and its cards appear');
    // An agent working alone never starts a turn of the Lead.
    await t.service.observeTurns([{ id: 'other', working: true, agentWorking: true }]);
    assert.equal(t.reveals().length, 1);
  } finally {
    t.cleanup();
  }
});

test('outside a turn an open shows at once, as before', async () => {
  const t = setup();
  try {
    const result = await t.run('open', { targets: ['site/a.html'] });
    assert.match(result.text, /^Showing /);
    assert.equal(t.reveals().length, 1);
    assert.equal(t.events[0].held, undefined);
  } finally {
    t.cleanup();
  }
});

test('file edits of an open tab during a turn only mark it; it reloads once when the turn ends', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    const revision = (await t.shown().at(-1)).state.tabs[0].revision;
    t.events.length = 0;
    await t.service.setTurnActive(SESSION, true);
    const onChange = t.watched.get(join(t.cwd, 'site', 'a.html'));
    for (let edit = 0; edit < 3; edit += 1) {
      writeFileSync(join(t.cwd, 'site', 'a.html'), `<h1>edit ${edit}</h1>`);
      onChange();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await t.service.settled();
    assert.equal(t.shown().length, 0, 'no reload reaches the panel mid-turn');
    const marked = t.events.filter((event) => event.held && event.updated === 'v1');
    assert.equal(marked.length, 1, 'the tab is marked updated once');
    assert.equal(marked[0].state.tabs[0].revision, revision, 'the mark carries no new content');

    await t.service.setTurnActive(SESSION, false);
    const visible = t.shown();
    assert.equal(visible.length, 1, 'one publish at the turn end');
    assert.ok(visible[0].state.tabs[0].revision > revision, 'reloaded once');
    assert.equal(visible[0].reveal, undefined, 'a reload alone reveals nothing');
  } finally {
    t.cleanup();
  }
});

test('file edits outside a turn keep the debounced reload', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    t.events.length = 0;
    t.watched.get(join(t.cwd, 'site', 'a.html'))();
    await t.service.settled();
    assert.equal(t.shown().length, 1);
    assert.equal(t.shown()[0].updated, 'v1');
  } finally {
    t.cleanup();
  }
});

test('check, inspect and capture answer mid-turn off screen, without showing the panel', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { content: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' } });

    const checked = await t.run('check', { tab: 'v1' });
    assert.match(checked.text, /Checked tab v1 \(checked off screen/);
    assert.match(checked.text, /error: boom \(line 3\)/);

    const inspected = await t.run('inspect', { tab: 'v1', viewport: { width: 390, height: 844 } });
    assert.match(inspected.text, /Inspection of tab v1, laid out off screen at 390×844/);
    assert.deepEqual(t.calls.offscreen.at(-1).options.viewport, { width: 390, height: 844 });

    const captured = await t.run('capture', { tab: 'v2', output: 'shot.png' });
    assert.match(captured.text, /drawn off screen/);
    assert.equal(readFileSync(join(t.cwd, 'shot.png'), 'utf8'), 'OFFSCREEN');

    const inlineCheck = await t.run('check', { tab: 'v2' });
    assert.match(inlineCheck.text, /No page problems on tab v2/);

    assert.equal(t.calls.capture, 0, 'the panel was never captured');
    assert.equal(t.calls.inspect, 0, 'the panel frames were never read');
    assert.equal(t.shown().length, 0, 'nothing was shown or activated');
  } finally {
    t.cleanup();
  }
});

test('off-screen inspect / check lay out at the remembered side panel size, else 1280×900; explicit viewport wins', async () => {
  const exported = [];
  const t = setup({
    async renderExport(_pane, format, _allowNetwork, options) {
      exported.push({ format, options });
      return { data: Buffer.from('PAGE'), problems: [] };
    },
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });

    // (b) no panel size known yet: the default.
    const fallback = await t.run('inspect', { tab: 'v1' });
    assert.match(fallback.text, /laid out off screen at 1280×900/);
    assert.doesNotMatch(fallback.text, /side panel's width/);
    assert.deepEqual(t.calls.offscreen.at(-1).options.viewport, { width: 1280, height: 900 });
    const fallbackCheck = await t.run('check', { tab: 'v1' });
    assert.doesNotMatch(fallbackCheck.text, /side panel's width/);
    assert.deepEqual(t.calls.offscreen.at(-1).options.viewport, { width: 1280, height: 900 });

    // (a) the remembered panel size (the last one reported wins).
    t.service.setPanelSize({ width: 600, height: 700 });
    t.service.setPanelSize({ width: 440, height: 820 });
    const inspected = await t.run('inspect', { tab: 'v1' });
    assert.match(inspected.text, /laid out off screen at the side panel's width 440×820/);
    assert.deepEqual(t.calls.offscreen.at(-1).options.viewport, { width: 440, height: 820 });
    const checked = await t.run('check', { tab: 'v1' });
    assert.match(checked.text, /checked off screen at the side panel's width 440×820/);
    assert.deepEqual(t.calls.offscreen.at(-1).options.viewport, { width: 440, height: 820 });

    // (c) an explicit viewport wins over the panel.
    const explicit = await t.run('inspect', { tab: 'v1', viewport: { width: 390, height: 844 } });
    assert.match(explicit.text, /laid out off screen at 390×844/);
    assert.doesNotMatch(explicit.text, /side panel's width/);
    assert.deepEqual(t.calls.offscreen.at(-1).options.viewport, { width: 390, height: 844 });

    // (d) exports keep their own width: no viewport is passed, the render default is 1280.
    await t.run('export', { tab: 'v1', format: 'png', output: 'shot.png' });
    assert.equal(exported.length, 1);
    assert.equal('viewport' in exported[0].options, false);
    const { OFFSCREEN_VIEWPORT, THUMBNAIL_VIEWPORT } = await import('./export-render.ts');
    assert.equal(OFFSCREEN_VIEWPORT.width, 1280);
    assert.equal(THUMBNAIL_VIEWPORT.width, 1280);
  } finally {
    t.cleanup();
  }
});

test('a held open says whether the user can reach the session when the turn ends', async () => {
  let reach = 'shown';
  const asked = [];
  const t = setup({
    async sessionReach(sessionId) {
      asked.push(sessionId);
      return reach;
    },
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    const open = async () => (await t.run('open', { targets: ['chart.png'] })).text;
    const shown = await open();
    assert.match(shown, /^Prepared chart\.png \(image\) as tab v1; the side panel shows it when this turn ends \(/);
    reach = 'not-open';
    const absent = await open();
    assert.match(absent, /as tab v1, but this session is not open in the Mixdog window/);
    assert.match(absent, /tell the user/);
    assert.doesNotMatch(absent, /the side panel shows it when this turn ends/);
    reach = 'background';
    assert.match(await open(), /when this turn ends, but the Mixdog window is in the background.*tell the user/);
    reach = 'hidden';
    assert.match(await open(), /when this turn ends, but the Mixdog window is minimized or hidden; tell the user/);
    assert.deepEqual(asked, [SESSION, SESSION, SESSION, SESSION]);
  } finally {
    t.cleanup();
  }
});

test('a held open is checked off screen: its load and render problems ride the result', async () => {
  const t = setup({
    async exportBytes() {
      throw new Error('bad mermaid');
    },
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    const page = await t.run('open', { targets: ['site/a.html'] });
    assert.match(page.text, /Page problems while it loaded off screen:\n- error: boom \(line 3\)/);
    assert.equal(t.calls.offscreen.length, 1, 'the page loaded once in a hidden window');
    const inline = await t.run('open', { content: { kind: 'mermaid', source: 'graph TD; A-->', title: 'Flow' } });
    assert.match(inline.text, /- render failed: bad mermaid/);
    const image = await t.run('open', { targets: ['chart.png'] });
    assert.doesNotMatch(image.text, /off screen:/, 'an image has nothing to check');
    assert.equal(t.shown().length, 0, 'the panel is still left alone');
  } finally {
    t.cleanup();
  }
});

test('a failed turn-end step still publishes the final state, then reports the failure', async () => {
  const { createTurnHolds } = await import('./turn-hold.ts');
  const tab = { id: 'v1', url: undefined, targets: [] };
  const sessions = new Map([[SESSION, { tabs: [tab], active: null, counter: 1, history: [] }]]);
  const published = [];
  const holds = new Map();
  const turns = createTurnHolds({
    holds,
    sessions,
    publish: (sessionId, reveal) => published.push([sessionId, reveal]),
    views: {
      stateOf: (sessionId) => ({ sessionId, tabs: [], active: null }),
      hostStateOf: (sessionId) => ({ sessionId, tabs: [], active: null }),
    },
    tabs: { closeVerify() {} },
    reloads: { reload: async () => {} },
    thumbnails: {
      async takeAtTurnEnd() {
        throw new Error('thumbnail failed');
      },
    },
    versions: null,
  });
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    await turns.setTurnActive(SESSION, true);
    holds.get(SESSION).reveal.push('v1');
    await turns.setTurnActive(SESSION, false);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(published, [[SESSION, 'v1']], 'the turn end reveals its tab (and its cards) anyway');
  assert.equal(sessions.get(SESSION).active, 'v1');
  assert.equal(holds.has(SESSION), false);
  assert.ok(
    warned.some((line) => line.includes('thumbnail failed')),
    'the failure is still reported'
  );
});

test("the user's own panel commands apply at once during a turn", async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'] });
    t.events.length = 0;
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
    t.events.length = 0;
    // A selection moves among what the session shows; the turn's work stays kept back.
    await t.service.command({ sessionId: SESSION, tabId: 'v1', action: 'activate' });
    assert.equal(t.events.length, 1);
    assert.deepEqual(
      [t.events[0].held, t.events[0].state.active, t.events[0].state.tabs.map((tab) => tab.id)],
      [true, 'v1', ['v1', 'v2']]
    );
    assert.equal(t.service.snapshot()[0].active, 'v1');
    // A command on a tab applies to that tab at once; the turn's work stays kept back.
    await t.service.command({ sessionId: SESSION, tabId: 'v2', action: 'close' });
    assert.equal(t.shown().length, 0);
    assert.deepEqual(
      t.events.at(-1).state.tabs.map((tab) => tab.id),
      ['v1']
    );
    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(
      t.shown().at(-1).state.tabs.map((tab) => tab.id),
      ['v1', 'v3']
    );
  } finally {
    t.cleanup();
  }
});

test('the first turn of a session that shows nothing yet reads as held: a window that loads draws none of its cards, as the live window', async () => {
  const published = [];
  const t = setup({ publish: (event) => published.push(structuredClone(event)) });
  mock.timers.enable({ apis: ['Date'], now: 1_000 });
  resyncVisualizeStates([]);
  try {
    const turnStart = Date.now();
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: true });
    mock.timers.tick(100);
    // The card of the open the turn makes now, once that call is done.
    const cards = [{ id: 'call-a', pending: false, targets: ['site/a.html'], label: '', tabId: 'v1', at: Date.now() }];
    await t.run('open', { targets: ['site/a.html'] });
    const drawn = () => visualizeCardsShown(cards, visualizeHeldSince(SESSION)).length;

    for (const event of published) applyVisualizeEvent(event);
    assert.deepEqual([visualizeHeldSince(SESSION), drawn()], [turnStart, 0], 'the window that was live');

    for (const [reader, snapshot] of [
      ['a window that loads', t.service.snapshot()],
      ['a paired device that reconnects', t.service.hostSnapshot().map(remoteVisualizeState)],
    ]) {
      assert.deepEqual(
        snapshot.map((state) => [state.sessionId, state.held, state.heldSince, state.tabs.length]),
        [[SESSION, true, turnStart, 0]],
        reader
      );
      resyncVisualizeStates([]);
      hydrateVisualizeStates(structuredClone(snapshot));
      assert.deepEqual([visualizeHeldSince(SESSION), drawn()], [turnStart, 0], reader);
      assert.equal(visualizeStateFor(SESSION).tabs.length, 0, reader);
    }

    published.length = 0;
    await t.service.observeTurnEdge({ id: SESSION, leadWorking: false });
    for (const event of published) applyVisualizeEvent(event);
    assert.deepEqual([visualizeHeldSince(SESSION), drawn()], [null, 1], 'its card appears at its end');
    assert.equal(visualizeStateFor(SESSION).tabs.length, 1);
  } finally {
    resyncVisualizeStates([]);
    mock.timers.reset();
    t.cleanup();
  }
});

test('a pick from “All visuals” during a turn selects or opens that visual and shows nothing else of the turn', async () => {
  const t = setup();
  try {
    const ids = (state) => state.tabs.map((tab) => tab.id);
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'] });
    await t.run('open', { targets: ['chart.png'] });
    await t.service.command({ sessionId: SESSION, tabId: 'v3', action: 'close' });
    const entry = (label) => t.service.snapshot()[0].history.find((item) => item.label === label).id;
    const [page, chart] = [entry('a.html'), entry('chart.png')];
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
    t.events.length = 0;
    t.hostEvents.length = 0;

    // An open tab: a selection.
    await t.service.command({ sessionId: SESSION, tabId: '', action: 'history', entry: page });
    // A closed one: the user's own open of it.
    await t.service.command({ sessionId: SESSION, tabId: '', action: 'history', entry: chart });
    for (const published of [t.events, t.hostEvents]) {
      assert.deepEqual(
        published.map((event) => [event.held, event.reveal, event.state.active, ids(event.state)]),
        [
          [true, undefined, 'v1', ['v1', 'v2']],
          [true, true, 'v5', ['v1', 'v2', 'v5']],
        ],
        'held throughout, and never the turn’s own tab v4'
      );
    }
    assert.deepEqual(
      [t.service.snapshot()[0].held, ids(t.service.snapshot()[0])],
      [true, ['v1', 'v2', 'v5']]
    );

    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(ids(t.shown().at(-1).state), ['v1', 'v2', 'v4', 'v5']);
  } finally {
    t.cleanup();
  }
});

test('a tab the user clicks while a turn’s end is applied shows at once and stays shown; the turn’s tab is marked beside it', async () => {
  const picture = heldPicture();
  const published = [];
  const t = setup({ thumbnailOffscreen: picture.take, publish: (event) => published.push(structuredClone(event)) });
  resyncVisualizeStates([]);
  try {
    const shows = (event) => [event.held, event.reveal, event.updated, event.state.active, event.state.tabs.map((tab) => tab.id)];
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'] });
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
    for (const event of published.splice(0)) applyVisualizeEvent(event);
    const ending = t.service.setTurnActive(SESSION, false);
    await picture.asked;

    await t.service.command({ sessionId: SESSION, tabId: 'v1', action: 'activate' });
    assert.deepEqual(published.map(shows), [[true, undefined, undefined, 'v1', ['v1', 'v2']]], 'the click shows at once');
    for (const event of published.splice(0)) applyVisualizeEvent(event);
    assert.equal(visualizeStateFor(SESSION).active, 'v1');

    picture.release();
    await ending;
    assert.deepEqual(
      published.map(shows),
      [[undefined, undefined, 'v3', 'v1', ['v1', 'v2', 'v3']]],
      'the end adds the turn’s tab and leaves the panel on the click'
    );
    for (const event of published.splice(0)) applyVisualizeEvent(event);
    assert.equal(visualizeStateFor(SESSION).active, 'v1');
    assert.equal(visualizeHeldSince(SESSION), null);
    assert.ok(visualizeUpdatedTabs(SESSION).has('v3'), 'the turn’s tab wears the mark');
    assert.equal(t.service.snapshot()[0].active, 'v1');
  } finally {
    resyncVisualizeStates([]);
    t.cleanup();
  }
});
