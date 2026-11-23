import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

import { waitUntil } from '../bounded-wait.mjs';
import { remoteVisualizeState, versionProducedAt } from '../../shared/visualize.ts';
import { TURN_END_THUMBNAIL_MS } from './thumbnails.ts';
import { VISIBLE_PASSWORD_SCRIPT } from './export-render.ts';
import { exportTabBytes, thumbnailRenderers } from './host-export-path.ts';
import { createVisualizeService } from './service.ts';

const SESSION = 's1';
const png = (text) => Buffer.from(text);
const dataUrl = (text) => `data:image/png;base64,${png(text).toString('base64')}`;

function setup(overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-turn-thumbs-')));
  const cwd = join(root, 'project');
  const versions = join(root, 'versions');
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'a.html'), '<h1>one</h1>');
  writeFileSync(join(cwd, 'site', 'b.html'), '<h1>b</h1>');
  const log = [];
  const events = [];
  const hostEvents = [];
  let pictures = 0;
  const service = createVisualizeService({
    versions: { directory: versions },
    windowAvailable: () => true,
    browserAvailable: () => true,
    preparePane: async (target) => `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}`,
    publish(event) {
      events.push(event);
      if (!event.held) log.push(`publish${event.reveal ? ':reveal' : ''}`);
    },
    publishHost: (event) => hostEvents.push(event),
    watch: () => () => {},
    annotate: async () => [],
    inspect: async () => [],
    capture: async () => png('SCREEN'),
    onScreen: async () => 'visible',
    async thumbnail(_sessionId, tab) {
      log.push(`onscreen:${tab.id}`);
      return png('ONSCREEN');
    },
    async thumbnailOffscreen(_sessionId, tab, files) {
      pictures += 1;
      log.push(`offscreen:${tab.id}:${files.length}`);
      return png(`PIC${pictures}`);
    },
    delay: async () => {},
    reloadDebounceMs: 5,
    ...overrides,
  });
  const run = (action, input) => service.execute({ sessionId: SESSION, cwd, action, input });
  const shownTabs = () => events.filter((event) => !event.held).at(-1)?.state.tabs ?? [];
  return {
    cwd,
    versions,
    log,
    events,
    hostEvents,
    service,
    run,
    shownTabs,
    thumbnailOf: (tabId, version) =>
      service.command({ sessionId: SESSION, tabId, action: 'thumbnail', version }).then((result) => result?.thumbnail),
    cleanup() {
      service.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('no picture while the turn runs; its end takes one per opened tab, then shows the cards', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>two</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>three</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'] });
    await t.service.settled();
    assert.deepEqual(t.log, [], 'nothing captured (nor shown) mid-turn');
    assert.ok(t.events.every((event) => !event.state?.tabs.some((tab) => tab.thumbnail)));

    await t.service.setTurnActive(SESSION, false);
    await t.service.settled();
    assert.deepEqual(t.log, ['offscreen:v1:1', 'offscreen:v2:1', 'publish:reveal'], 'pictures first, one publish');
    const [a, b] = t.shownTabs();
    assert.equal(a.versions.at(-1).n, 3);
    assert.deepEqual([a.thumbnail, a.thumbnailVersion], [dataUrl('PIC1'), 3], 'the final version');
    assert.deepEqual([b.thumbnail, b.thumbnailVersion], [dataUrl('PIC2'), 1]);
    // A paired device gets the same picture and version.
    const remote = remoteVisualizeState(t.hostEvents.at(-1).state);
    assert.deepEqual([remote.tabs[0].thumbnail, remote.tabs[0].thumbnailVersion], [dataUrl('PIC1'), 3]);
  } finally {
    t.cleanup();
  }
});

test('each version keeps its own picture; an earlier card asks for it by version', async () => {
  const t = setup();
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, false);
    await t.service.setTurnActive(SESSION, true);
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>two</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, false);
    await t.service.settled();

    assert.equal(t.shownTabs()[0].thumbnailVersion, 2);
    assert.equal(await t.thumbnailOf('v1', 1), dataUrl('PIC1'));
    assert.equal(await t.thumbnailOf('v1', 2), dataUrl('PIC2'));
    assert.equal(await t.thumbnailOf('v1', 7), undefined);
    assert.equal(await t.thumbnailOf('v9', 1), undefined);
    // Kept beside each version's folder too.
    const folder = readdirSync(t.versions, { recursive: true });
    assert.equal(folder.filter((name) => /[\\/][12]\.png$/.test(String(name))).length, 2);

    // A turn that opens the unchanged tab again keeps its picture (no capture).
    t.log.length = 0;
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(t.log, ['publish:reveal']);
  } finally {
    t.cleanup();
  }
});

test('a later turn that only changes the open tab takes the picture of its new version', async () => {
  const changes = [];
  const t = setup({
    watch: (_path, onChange) => {
      changes.push(onChange);
      return () => {};
    },
  });
  try {
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, false);
    await t.service.settled();
    t.log.length = 0;
    await t.service.setTurnActive(SESSION, true);
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>two</h1>');
    for (const onChange of changes) onChange();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.service.settled();
    await t.service.setTurnActive(SESSION, false);
    await t.service.settled();
    const tab = t.shownTabs()[0];
    assert.equal(tab.versions.at(-1).n, 2);
    assert.equal(tab.thumbnailVersion, 2);
    assert.equal(await t.thumbnailOf('v1', 1), dataUrl('PIC1'), 'the old turn keeps its picture');
    assert.equal(await t.thumbnailOf('v1', 2), dataUrl('PIC2'));
    // Each turn's version is recorded with the version, in the state every card reads.
    const [first, second] = tab.versions;
    assert.equal(first.turns.length, 1);
    assert.equal(second.turns.length, 1);
    assert.ok(first.turns[0].end <= second.turns[0].since + 5, 'turns in order');
    const mid = (turn) => Math.floor((turn.since + turn.end) / 2);
    assert.equal(versionProducedAt(tab.versions, mid(first.turns[0])), 1);
    assert.equal(versionProducedAt(tab.versions, mid(second.turns[0])), 2);
    // A paired device gets the same record.
    const remote = remoteVisualizeState(t.hostEvents.at(-1).state);
    assert.deepEqual(
      remote.tabs[0].versions.map((v) => v.turns?.length),
      [1, 1]
    );
  } finally {
    t.cleanup();
  }
});

test('a turn starting while the previous turn flushes keeps its own span; versions are not merged', async () => {
  const changes = [];
  let gate = null;
  let reached = null;
  const t = setup({
    watch: (_path, onChange) => {
      changes.push(onChange);
      return () => {};
    },
    async preparePane(target) {
      if (gate) {
        reached?.();
        await gate;
      }
      return `http://127.0.0.1:1/${'t'.repeat(32)}/${target.label}`;
    },
  });
  const edit = async (text) => {
    writeFileSync(join(t.cwd, 'site', 'a.html'), text);
    for (const onChange of changes) onChange();
    await new Promise((resolve) => setTimeout(resolve, 100));
  };
  try {
    // Turn A opens the page (version 1) and edits it (version 2, made by its end's reload).
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/a.html'] });
    await edit('<h1>two</h1>');
    let release;
    gate = new Promise((resolve) => {
      release = resolve;
    });
    const blocked = new Promise((resolve) => {
      reached = resolve;
    });
    const flushA = t.service.setTurnActive(SESSION, false);
    await blocked;
    // Turn B starts while A's reload is still running.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await t.service.setTurnActive(SESSION, true);
    gate = null;
    release();
    await flushA;
    // Turn B edits the page again (version 3) and ends.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await edit('<h1>three</h1>');
    await t.service.setTurnActive(SESSION, false);
    await t.service.settled();

    const tab = t.shownTabs()[0];
    const spans = tab.versions.map((version) => version.turns ?? []);
    assert.deepEqual(
      spans.map((list) => list.length),
      [0, 1, 1],
      'turn A on version 2, turn B on version 3'
    );
    const [a] = spans[1];
    const [b] = spans[2];
    assert.ok(a.end <= b.since, 'A ended before B began');
    const mid = (turn) => Math.floor((turn.since + turn.end) / 2);
    assert.equal(versionProducedAt(tab.versions, mid(a)), 2);
    assert.equal(versionProducedAt(tab.versions, mid(b)), 3);
  } finally {
    t.cleanup();
  }
});

test('a picture that arrives after the next turn started shows when it arrives; the turn’s own work takes none', async () => {
  let arrive;
  const asked = [];
  const t = setup({
    thumbnail: (_sessionId, tab) =>
      new Promise((resolve) => {
        asked.push(tab.id);
        arrive = () => resolve(png('LATE'));
      }),
  });
  try {
    // A tab shown before the turn; its picture is still being taken when the next turn starts.
    await t.run('open', { targets: ['site/a.html'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(asked, ['v1']);
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { targets: ['site/b.html'] });
    assert.deepEqual(asked, ['v1'], 'no picture of the running turn’s tab');
    t.events.length = 0;
    t.hostEvents.length = 0;
    arrive();
    await t.service.settled();
    for (const published of [t.events, t.hostEvents]) {
      assert.deepEqual(
        published.map((event) => [event.held, event.state.tabs.map((tab) => [tab.id, tab.thumbnail])]),
        [[true, [['v1', dataUrl('LATE')]]]],
        'the picture joins what the session shows, which stays held'
      );
    }
    for (const snapshot of [t.service.snapshot(), t.service.hostSnapshot()]) {
      assert.deepEqual(
        snapshot[0].tabs.map((tab) => [tab.id, tab.thumbnail]),
        [['v1', dataUrl('LATE')]]
      );
    }
  } finally {
    t.cleanup();
  }
});

test('a version, a network switch and a restore during a turn change their own tab in what the session shows, and nothing of the turn shows', async () => {
  const t = setup();
  try {
    const page = join(t.cwd, 'site', 'a.html');
    await t.run('open', { targets: ['site/a.html'] });
    writeFileSync(page, '<h1>two</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    await t.run('open', { targets: ['site/b.html'] });
    await t.service.settled();
    await t.service.setTurnActive(SESSION, true);
    await t.run('open', { content: { kind: 'svg', source: '<svg/>', title: 'Flow' } });

    const cases = [
      [{ action: 'version', version: 1 }, (tab) => tab.version === 1 && tab.panes[0].version === 1],
      [{ action: 'version', version: null }, (tab) => tab.version === null && tab.panes[0].version === undefined],
      [{ action: 'network', allow: false }, (tab) => tab.networkAllowed === undefined],
      [{ action: 'restore', version: 1 }, (tab) => tab.versions.length === 3 && tab.version === null],
    ];
    for (const [command, applied] of cases) {
      const name = JSON.stringify(command);
      t.events.length = 0;
      t.hostEvents.length = 0;
      await t.service.command({ sessionId: SESSION, tabId: 'v1', ...command });
      for (const published of [t.events, t.hostEvents]) {
        assert.ok(published.length > 0, name);
        assert.ok(
          published.every((event) => event.held === true && !event.reveal),
          `${name}: the hold is never lifted`
        );
        assert.ok(
          published.every((event) => event.state.tabs.map((tab) => tab.id).join() === 'v1,v2'),
          `${name}: the turn's own tab v3 is never shown`
        );
      }
      for (const state of [t.events.at(-1).state, t.service.snapshot()[0], remoteVisualizeState(t.service.hostSnapshot()[0])]) {
        assert.ok(applied(state.tabs[0]), `${name}: the tab shows the command's result at once`);
        assert.equal(state.active, 'v2', name);
      }
    }
    assert.equal(readFileSync(page, 'utf8'), '<h1>one</h1>', 'the restore wrote the kept version back');

    await t.service.setTurnActive(SESSION, false);
    assert.deepEqual(
      t.shownTabs().map((tab) => tab.id),
      ['v1', 'v2', 'v3']
    );
  } finally {
    t.cleanup();
  }
});

test('a picture refused leaves the card its placeholder, never an older picture', async () => {
  const t = setup({
    async thumbnailOffscreen() {
      throw new Error('the page shows a password field');
    },
  });
  try {
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.settled();
    await t.service.setTurnActive(SESSION, true);
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>two</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, false);
    assert.equal(t.shownTabs()[0].thumbnail, undefined);
  } finally {
    t.cleanup();
  }
});

test('a picture not ready in time leaves the card its placeholder, never an older picture', async () => {
  let started = 0;
  let requestSignal;
  const t = setup({
    async thumbnailOffscreen(_sessionId, _tab, _files, signal) {
      started += 1;
      requestSignal = signal;
      // Never ready: only the deadline ends it.
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      assert.equal(signal.aborted, true);
      return png('LATE');
    },
  });
  try {
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.settled();
    assert.equal(t.shownTabs()[0].thumbnail, dataUrl('ONSCREEN'), 'outside a turn: the panel picture, as before');

    await t.service.setTurnActive(SESSION, true);
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>two</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    // The turn-end deadline is a fake timer: pending until advanced, complete exactly at it.
    mock.timers.enable({ apis: ['setTimeout'] });
    let ended = false;
    const ending = t.service.setTurnActive(SESSION, false).then(() => (ended = true));
    await waitUntil(() => started === 1, 'the picture to be requested');
    // The deadline aborts the request synchronously when its timer fires.
    mock.timers.tick(TURN_END_THUMBNAIL_MS - 1);
    assert.equal(requestSignal.aborted, false, 'still waiting one millisecond before the deadline');
    assert.equal(ended, false);
    mock.timers.tick(1);
    assert.equal(requestSignal.aborted, true, 'complete exactly at the deadline');
    await ending;
    mock.timers.reset();
    const tab = t.shownTabs()[0];
    assert.equal(tab.versions.at(-1).n, 2);
    assert.equal(tab.thumbnail, undefined, 'version 1 picture is not shown as version 2');
    assert.equal(await t.thumbnailOf('v1', 1), dataUrl('ONSCREEN'), 'version 1 keeps its own');
  } finally {
    mock.timers.reset();
    t.cleanup();
  }
});

function tileFixture() {
  const drawn = [];
  const pages = [];
  const base = {
    page: async () => png('PAGE'),
    readFile: async () => png('\x89PNG\r\n\x1a\nIMG'),
    mermaidSource: async () => '',
    documentPages: async (_file, wanted) => {
      pages.push(wanted);
      return { pageCount: 9, pages: wanted.map(() => ({ mime: 'image/png', bytes: png('P1') })) };
    },
    document: async (document) => {
      drawn.push(document);
      return png('DOC');
    },
  };
  const renderers = { ...thumbnailRenderers(base, new AbortController().signal), document: base.document };
  const tab = (panes) => ({ id: 'v1', label: '', revision: 0, panes });
  return { drawn, pages, renderers, tab };
}

test("a split tab's card picture tiles its panes on one screen", async () => {
  const { drawn, renderers, tab } = tileFixture();
  const split = await exportTabBytes(
    () => Promise.reject(new Error('panel')),
    tab([
      { kind: 'html', url: 'http://127.0.0.1:1/x/a.html', label: 'a', target: 'a' },
      { kind: 'image', url: '', label: 'b', target: 'b' },
    ]),
    'png',
    0,
    { files: ['/p/a.html', '/p/b.png'], renderers: { ...renderers, page: async () => png('PAGE') }, tiles: true }
  );
  assert.equal(split.toString(), 'DOC');
  const tiles = drawn.at(-1).files;
  const html = Object.values(tiles).find((file) => String(file.type).startsWith('text/html'));
  assert.match(String(html.body), /grid-template-columns:repeat\(2,1fr\)/);
});

test('a document card picture is its first page', async () => {
  const { pages, renderers, tab } = tileFixture();
  const pdf = await exportTabBytes(
    () => Promise.reject(new Error('panel')),
    tab([{ kind: 'pdf', url: '', label: 'r', target: 'r' }]),
    'png',
    0,
    { files: ['/p/r.pdf'], renderers, tiles: true }
  );
  assert.equal(pdf.toString(), 'P1');
  assert.deepEqual(pages, [[1]], 'only the first page is drawn');
});

test('a tab only the panel can draw has no card picture', async () => {
  const { renderers, tab } = tileFixture();
  await assert.rejects(
    exportTabBytes(
      () => Promise.reject(new Error('only the panel can draw this tab')),
      tab([{ kind: 'video', url: '', label: 'v', target: 'v' }]),
      'png',
      0,
      { files: ['/p/v.mp4'], renderers, tiles: true }
    ),
    /only the panel/
  );
});

test('the privacy check sees only a visible password field', () => {
  const check = (inputs) =>
    new Function('document', 'getComputedStyle', `return ${VISIBLE_PASSWORD_SCRIPT}`)(
      { querySelectorAll: () => inputs },
      (input) => input.style
    );
  const field = (box, style = {}) => ({
    getBoundingClientRect: () => box,
    style: { visibility: 'visible', display: 'inline-block', opacity: '1', ...style },
  });
  assert.equal(check([]), false);
  assert.equal(check([field({ width: 120, height: 24 })]), true);
  assert.equal(check([field({ width: 0, height: 0 })]), false);
  assert.equal(check([field({ width: 120, height: 24 }, { visibility: 'hidden' })]), false);
  assert.equal(check([field({ width: 120, height: 24 }, { opacity: '0' })]), false);
});
