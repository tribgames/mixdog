// A verify open (`input.verify`) is the agent's own check: its tab is made so
// check / inspect / capture work on it off screen, but it is never revealed,
// gets no chat card, and is closed at the session's next turn end (or when the
// session closes), with or without a turn hold (turn-hold.ts).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createVisualizeService } from './service.ts';

const SESSION = 's1';

function setup(overrides = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-turn-verify-')));
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'a.html'), '<h1>a</h1>');
  writeFileSync(join(cwd, 'site', 'b.html'), '<h1>b</h1>');
  const events = [];
  const calls = { capture: 0, inspect: 0 };
  let prepared = 0;
  const service = createVisualizeService({
    windowAvailable: () => true,
    browserAvailable: () => true,
    async preparePane(target) {
      prepared += 1;
      return `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}?${prepared}`;
    },
    publish: (event) => events.push(event),
    publishHost: () => {},
    watch: () => () => {},
    annotate: async () => [],
    async inspectOffscreen() {
      return {
        result: { elements: [], findings: [], outline: [], viewport: {}, page: {} },
        problems: ['error: boom (line 3)'],
      };
    },
    async capture() {
      calls.capture += 1;
      return Buffer.from('SCREEN');
    },
    async inspect() {
      calls.inspect += 1;
      return [];
    },
    async exportBytes() {
      return Buffer.from('OFFSCREEN');
    },
    async onScreen() {
      return 'visible';
    },
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  });
  const run = (action, input, callId) =>
    service.execute({ sessionId: SESSION, cwd, action, input, ...(callId ? { callId } : {}) });
  const state = () => service.snapshot().find((entry) => entry.sessionId === SESSION);
  // The tabs a client is given: a verify-only tab is never among them.
  const tabIds = () => (state()?.tabs ?? []).map((tab) => tab.id);
  // Whether the session still holds the tab at all (shown or not).
  const alive = (id) => service.tabView(SESSION, id) !== null;
  const reveals = () => events.filter((event) => event.reveal);
  return {
    cwd,
    events,
    calls,
    service,
    run,
    state,
    tabIds,
    alive,
    reveals,
    cleanup() {
      service.dispose();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const endings = {
  done: (t) => t.service.setTurnActive(SESSION, false),
  stopped: (t) => t.service.observeTurns([{ id: SESSION, working: false }]),
  'left the roster': (t) => t.service.observeTurns([]),
};

for (const [kind, end] of Object.entries(endings)) {
  test(`a verify open in a turn is not revealed and is closed when the turn ends (${kind})`, async () => {
    const t = setup();
    try {
      await t.service.setTurnActive(SESSION, true);
      const shown = await t.run('open', { targets: ['site/b.html'] }, 'call-shown');
      assert.match(shown.text, /as tab v1\b/);
      const file = await t.run('open', { targets: ['site/a.html'], verify: true }, 'call-file');
      const inline = await t.run(
        'open',
        { content: { kind: 'svg', source: '<svg/>', title: 'Flow' }, verify: true },
        'call-inline'
      );
      for (const result of [file, inline]) {
        assert.doesNotMatch(result.text, /as tab /, 'no chat card reads this result');
        assert.equal(result.tabs, undefined, 'no tab line for a chat card either');
        assert.match(result.text, /\(tab v\d\); the user is not shown it, it closes when the turn ends\./);
      }
      assert.deepEqual(t.tabIds(), ['v1'], 'a client is only given the deliverable');
      assert.ok(t.alive('v2') && t.alive('v3'));
      assert.equal(t.reveals().length, 0);
      assert.ok(t.events.every((event) => event.held === true));

      await end(t);
      assert.ok(!t.alive('v2') && !t.alive('v3'), 'the check tabs are closed');
      assert.deepEqual(t.tabIds(), ['v1'], 'only the deliverable stays');
      assert.equal(t.state().active, 'v1');
      const reveal = t.reveals();
      assert.equal(reveal.length, 1);
      assert.equal(reveal[0].tab, 'v1', 'the turn end reveals the deliverable, never a check tab');
      assert.deepEqual(t.state().goneOpens ?? [], [], 'a verify open names no call');
      assert.ok(!t.state().history?.some((item) => item.label === 'Flow' || item.label === 'a.html'));
    } finally {
      t.cleanup();
    }
  });
}

test('a failing turn-end step still closes the verify tabs', async () => {
  const { createTurnHolds } = await import('./turn-hold.ts');
  const sessions = new Map([[SESSION, { tabs: [{ id: 'v1', targets: [] }], active: null }]]);
  const closed = [];
  const holds = new Map();
  const turns = createTurnHolds({
    holds,
    sessions,
    publish: () => {},
    tabs: { closeVerify: (sessionId) => closed.push(sessionId) },
    reloads: { reload: async () => {} },
    thumbnails: {
      async takeAtTurnEnd() {
        throw new Error('thumbnail failed');
      },
    },
    versions: null,
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await turns.setTurnActive(SESSION, true);
    holds.get(SESSION).reveal.push('v1');
    await turns.setTurnActive(SESSION, false);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(closed, [SESSION]);
  assert.equal(holds.has(SESSION), false);
});

test('a turn with only verify opens reveals nothing at its end', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'], verify: true });
    assert.ok(t.alive('v1'));
    await t.service.setTurnActive(SESSION, false);
    assert.ok(!t.alive('v1'));
    assert.equal(t.reveals().length, 0);
    assert.equal(t.state(), undefined, 'no tab is left in the session');
  } finally {
    t.cleanup();
  }
});

test('a verify tab opened while the turn end is still flushing is closed with it', async () => {
  let release;
  let started;
  const taking = new Promise((resolve) => {
    started = resolve;
  });
  const t = setup({
    thumbnailOffscreen: () =>
      new Promise((resolve) => {
        started();
        release = () => resolve(null);
      }),
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/b.html'] });
    const ending = t.service.setTurnActive(SESSION, false);
    await taking;
    // Another turn starts, opens a tab only to check its work, and ends,
    // all while the first turn's end is still taking its pictures.
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'], verify: true });
    assert.ok(t.alive('v2'));
    await t.service.setTurnActive(SESSION, false);
    release();
    await ending;
    assert.ok(!t.alive('v2'), 'no hold is left to close it later');
    assert.deepEqual(t.tabIds(), ['v1']);
  } finally {
    t.cleanup();
  }
});

test('a verify tab of a still-running successor turn survives the earlier flush, then closes at its own end', async () => {
  let release;
  let started;
  let first = true;
  const taking = new Promise((resolve) => {
    started = resolve;
  });
  const t = setup({
    thumbnailOffscreen: () => {
      // Only the first turn end waits; the successor's end answers at once.
      if (!first) return Promise.resolve(null);
      first = false;
      return new Promise((resolve) => {
        started();
        release = () => resolve(null);
      });
    },
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/b.html'] });
    await t.run('open', { targets: ['site/a.html'], verify: true });
    const ending = t.service.setTurnActive(SESSION, false);
    await taking;
    // The next turn starts during that flush and keeps running.
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' }, verify: true });
    release();
    await ending;
    assert.ok(!t.alive('v2'), 'the first turn’s own check tab is closed');
    assert.ok(t.alive('v3'), 'the running turn can still check its tab');
    assert.match((await t.run('capture', { tab: 'v3', output: 'shot.png' })).text, /drawn off screen/);
    await t.service.setTurnActive(SESSION, false);
    assert.ok(!t.alive('v3'), 'its own turn end closes it');
  } finally {
    t.cleanup();
  }
});

test('verify tabs never count toward the tab limit, so they never evict a shown tab', async () => {
  const t = setup();
  try {
    const inline = (title, verify) => ({
      content: { kind: 'svg', source: '<svg/>', title },
      ...(verify ? { verify } : {}),
    });
    await t.run('open', inline('shown'));
    for (let i = 0; i < 12; i += 1) await t.run('open', inline(`check ${i}`, true));
    assert.deepEqual(t.tabIds(), ['v1'], 'the shown tab is still there');
    for (let id = 2; id <= 13; id += 1) assert.ok(t.alive(`v${id}`), `check tab v${id} is not evicted either`);
  } finally {
    t.cleanup();
  }
});

test('promoting a verify tab by a plain open enforces the tab limit then', async () => {
  const t = setup();
  try {
    const inline = (title, verify) => ({
      content: { kind: 'svg', source: '<svg/>', title },
      ...(verify ? { verify } : {}),
    });
    for (let i = 0; i < 8; i += 1) await t.run('open', inline(`shown ${i}`));
    await t.run('open', inline('check', true));
    await t.run('open', inline('check 2', true));
    assert.equal(t.tabIds().length, 8);
    assert.ok(t.alive('v1'), 'verify opens evicted nothing');
    await t.run('open', inline('check'));
    assert.ok(!t.alive('v1'), 'the oldest shown tab went when the check tab became shown');
    assert.ok(t.alive('v9') && t.alive('v10'));
    assert.deepEqual(t.tabIds(), ['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9']);
  } finally {
    t.cleanup();
  }
});

test('a verify open with no turn hold is never shown, active, carded or kept in history', async () => {
  const t = setup();
  try {
    const result = await t.run('open', { targets: ['site/a.html'], verify: true }, 'call-v');
    assert.doesNotMatch(result.text, /as tab |Showing /);
    assert.equal(result.tabs, undefined);
    assert.ok(t.alive('v1'));
    assert.equal(t.reveals().length, 0);
    assert.ok(t.events.length > 0 && t.events.every((event) => !event.held));
    assert.ok(t.events.every((event) => event.state.tabs.length === 0 && event.state.active === null));
    assert.deepEqual(t.service.snapshot(), [], 'a renderer that loads is given nothing');
    assert.deepEqual(t.service.hostSnapshot(), [], 'neither is a paired device');

    await t.run('close', { tab: 'v1' });
    assert.ok(!t.alive('v1'));
    assert.deepEqual(t.service.snapshot(), [], 'a manual close leaves no history entry');
    assert.deepEqual(t.service.hostSnapshot(), []);
  } finally {
    t.cleanup();
  }
});

test('with no turn hold, check, inspect, capture and export of a verify tab stay off screen', async () => {
  const t = setup({
    async renderExport() {
      return { data: Buffer.from('PAGE'), problems: [] };
    },
  });
  try {
    await t.run('open', { targets: ['site/a.html'], verify: true });
    await t.run('open', { content: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' }, verify: true });
    assert.match((await t.run('check', { tab: 'v1' })).text, /Checked tab v1 \(checked off screen\)/);
    assert.match((await t.run('inspect', { tab: 'v1' })).text, /laid out off screen at 1280×900:/);
    const captured = await t.run('capture', { tab: 'v2', output: 'shot.png' });
    assert.match(captured.text, /drawn off screen\./);
    assert.equal(readFileSync(join(t.cwd, 'shot.png'), 'utf8'), 'OFFSCREEN');
    assert.match((await t.run('export', { tab: 'v2', format: 'png', output: 'out.png' })).text, /drawn off screen/);
    await assert.rejects(t.run('annotate', { tab: 'v1', clear: true }), /never shown/);
    assert.deepEqual([t.calls.capture, t.calls.inspect], [0, 0], 'the panel was never used');
    assert.equal(t.events.filter((event) => event.reveal).length, 0);
    assert.deepEqual(t.service.snapshot(), [], 'nothing was activated');
  } finally {
    t.cleanup();
  }
});

test('a verify tab from a hold-less open closes at the next turn end', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'], verify: true });
    await t.service.setTurnActive(SESSION, true);
    assert.ok(t.alive('v1'), 'a turn starting does not close it');
    await t.service.setTurnActive(SESSION, false);
    assert.ok(!t.alive('v1'));
    assert.equal(t.reveals().length, 0);
  } finally {
    t.cleanup();
  }
});

test('a verify tab from a hold-less open closes when its session leaves the roster', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'], verify: true });
    await t.service.observeTurns([{ id: 'other', working: false }]);
    assert.ok(!t.alive('v1'));
  } finally {
    t.cleanup();
  }
});

test('a plain open of a hold-less verify tab makes it a shown tab that stays', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'], verify: true });
    await t.run('open', { targets: ['site/a.html'] });
    assert.deepEqual(t.tabIds(), ['v1']);
    assert.equal(t.state().active, 'v1');
    assert.equal(t.reveals().length, 1);
    await t.service.setTurnActive(SESSION, true);
    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(t.tabIds(), ['v1']);
  } finally {
    t.cleanup();
  }
});

test('verify then a plain open of the same target: it is a shown tab and stays', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'], verify: true });
    const plain = await t.run('open', { targets: ['site/a.html'] }, 'call-plain');
    assert.match(plain.text, /as tab v1\b/);
    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(t.tabIds(), ['v1']);
    assert.equal(t.reveals().at(-1).tab, 'v1');
    assert.equal(t.state().active, 'v1');
  } finally {
    t.cleanup();
  }
});

test('a verify open after a plain open of the same target leaves it shown', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    const again = await t.run('open', { targets: ['site/a.html'], verify: true });
    assert.match(again.text, /already open and stays as it is/);
    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(t.tabIds(), ['v1']);
    assert.equal(t.reveals().at(-1).tab, 'v1');
  } finally {
    t.cleanup();
  }
});

test('a verify open of a tab the user already has shown neither hides nor closes it', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'] });
    assert.equal(t.state().active, 'v1');
    await t.service.setTurnActive(SESSION, true);
    t.events.length = 0;
    await t.run('open', { targets: ['site/a.html'], verify: true });
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' }, verify: true });
    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(t.tabIds(), ['v1', 'v2']);
    assert.equal(t.reveals().length, 1, 'only the plain open of the new tab is revealed');
    assert.equal(t.reveals()[0].tab, 'v2');
  } finally {
    t.cleanup();
  }
});

test('check, inspect and capture still work on a verify tab, off screen', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    const opened = await t.run('open', { targets: ['site/a.html'], verify: true });
    assert.match(opened.text, /Page problems while it loaded off screen:\n- error: boom \(line 3\)/);
    assert.match(opened.text, /check, inspect and capture work on the tab now, off screen/);
    await t.run('open', { content: { kind: 'mermaid', source: 'graph TD; A-->B', title: 'Flow' }, verify: true });

    assert.match((await t.run('check', { tab: 'v1' })).text, /Checked tab v1 \(checked off screen/);
    assert.match((await t.run('inspect', { tab: 'v1' })).text, /Inspection of tab v1, laid out off screen/);
    const captured = await t.run('capture', { tab: 'v2', output: 'shot.png' });
    assert.match(captured.text, /drawn off screen/);
    assert.equal(readFileSync(join(t.cwd, 'shot.png'), 'utf8'), 'OFFSCREEN');
    assert.equal(t.events.filter((event) => !event.held).length, 0, 'nothing reached the panel');
  } finally {
    t.cleanup();
  }
});

test('a file change of a verify tab does not keep a version or reload it at the turn end', async () => {
  const watched = new Map();
  const t = setup({
    watch(path, onChange) {
      watched.set(path, onChange);
      return () => watched.delete(path);
    },
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'], verify: true });
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>edit</h1>');
    watched.get(join(t.cwd, 'site', 'a.html'))();
    await t.service.settled();
    await t.service.setTurnActive(SESSION, false);
    assert.ok(!t.alive('v1'));
    assert.equal(t.reveals().length, 0);
  } finally {
    t.cleanup();
  }
});

test('a verify open outside a turn reveals nothing', async () => {
  const t = setup();
  try {
    await t.run('open', { targets: ['site/a.html'], verify: true });
    assert.equal(t.reveals().length, 0);
    assert.ok(t.events.every((event) => !event.reveal && !event.held));
  } finally {
    t.cleanup();
  }
});

test('verify must be a boolean, and does not apply to a web URL', async () => {
  const t = setup();
  try {
    await assert.rejects(t.run('open', { targets: ['site/a.html'], verify: 'yes' }), /verify must be a boolean/);
    await assert.rejects(t.run('open', { targets: ['http://localhost:3000'], verify: true }), /input\.verify applies/);
  } finally {
    t.cleanup();
  }
});
