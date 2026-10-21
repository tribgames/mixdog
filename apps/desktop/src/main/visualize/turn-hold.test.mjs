// Visualize during an agent turn (turn-hold.ts): opens and file changes are
// kept from the panel until the turn ends; check / inspect / capture still
// answer mid-turn, off screen.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createVisualizeService } from './service.ts';

const SESSION = 's1';

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

test("the user's own panel commands apply at once during a turn", async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'] });
    t.events.length = 0;
    await t.service.setTurnActive(SESSION, true);
    await t.service.command({ sessionId: SESSION, tabId: 'v1', action: 'activate' });
    assert.equal(t.shown().length, 1);
    assert.equal(t.shown()[0].state.active, 'v1');
  } finally {
    t.cleanup();
  }
});
