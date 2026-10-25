// Chat-card pictures and agent turns (thumbnails.ts `takeAtTurnEnd`): none is
// taken while a turn runs; its end takes one per opened tab, off screen, on
// the final version, before the publish that shows the cards, and each is
// kept per version so an earlier card keeps its own.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

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

test('a picture not ready in time (or refused) leaves the card its placeholder, never an older picture', async () => {
  let refuse = false;
  let started = 0;
  const t = setup({
    async thumbnailOffscreen(_sessionId, _tab, _files, signal) {
      if (refuse) throw new Error('the page shows a password field');
      started += 1;
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
    for (let turn = 0; turn < 5_000 && started === 0; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, 1, 'the picture was requested');
    const drain = async () => {
      for (let turn = 0; turn < 25; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    mock.timers.tick(TURN_END_THUMBNAIL_MS - 1);
    await drain();
    assert.equal(ended, false, 'still waiting one millisecond before the deadline');
    mock.timers.tick(1);
    await ending;
    mock.timers.reset();
    const tab = t.shownTabs()[0];
    assert.equal(tab.versions.at(-1).n, 2);
    assert.equal(tab.thumbnail, undefined, 'version 1 picture is not shown as version 2');
    assert.equal(await t.thumbnailOf('v1', 1), dataUrl('ONSCREEN'), 'version 1 keeps its own');

    refuse = true;
    await t.service.setTurnActive(SESSION, true);
    writeFileSync(join(t.cwd, 'site', 'a.html'), '<h1>three</h1>');
    await t.run('open', { targets: ['site/a.html'] });
    await t.service.setTurnActive(SESSION, false);
    assert.equal(t.shownTabs()[0].thumbnail, undefined);
  } finally {
    mock.timers.reset();
    t.cleanup();
  }
});

test("a split tab's card picture tiles its panes on one screen; a document gives its first page", async () => {
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
  const pdf = await exportTabBytes(
    () => Promise.reject(new Error('panel')),
    tab([{ kind: 'pdf', url: '', label: 'r', target: 'r' }]),
    'png',
    0,
    { files: ['/p/r.pdf'], renderers, tiles: true }
  );
  assert.equal(pdf.toString(), 'P1');
  assert.deepEqual(pages, [[1]], 'only the first page is drawn');
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
