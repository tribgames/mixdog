import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: [
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'KeyboardEvent',
    'MouseEvent',
    'Image',
  ],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.HTMLElement.prototype.attachEvent = () => {};
dom.window.HTMLElement.prototype.detachEvent = () => {};

// React DOM reads the document once at load: typing into the search field only
// reaches onChange when it loads after the DOM exists.
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { findStudioTab, groupStudioAssets } = await import('./studio-panel-model.ts');
const { StudioPanel } = await import('./StudioPanel.tsx');
const { StudioPane } = await import('./StudioView.tsx');
const bridge = await import('./studio-panel-bridge.ts');
const boardsStore = await import('./studio-boards.ts');

const DAY = 86_400_000;
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M/wHwAEAQH/2kGLWQAAAABJRU5ErkJggg==';
const now = Date.now();
const asset = (id, prompt, age, boardId, kind = 'image') => ({
  id,
  kind,
  lane: 'gemini',
  model: 'image-model',
  prompt,
  mime: 'image/png',
  bytes: 100,
  createdAt: now - age,
  ...(boardId ? { boardId } : {}),
});
const lane = {
  id: 'gemini',
  label: 'Gemini',
  authType: 'api',
  authProvider: 'google',
  authenticated: true,
  kinds: ['image'],
  image: {
    models: [{ id: 'image-model', label: 'Image model' }],
    defaultModel: 'image-model',
    controls: { aspectRatio: ['1:1'], maxReferences: 3 },
  },
  video: null,
};

/** A Studio host with boards: results, boards and every call recorded. */
function studioApi(calls = []) {
  const works = [
    asset('today-1', 'A fox in the snow', 1000, 'b-gacha'),
    asset('yesterday-1', 'A red bicycle', DAY + 1000),
    asset('week-1', 'A quiet harbour', 4 * DAY, 'b-gacha'),
    asset('earlier-1', 'A paper crane', 30 * DAY),
  ];
  let boards = [
    { id: 'b-gacha', name: 'Gacha sprites', createdAt: 2 },
    { id: 'b-icons', name: 'Currency icons', createdAt: 1 },
  ];
  const value = (result) => ({ value: result, snapshot: null });
  return {
    works,
    mediaUrl: (id, variant) => `mixdog-media://asset/${id}?variant=${variant}`,
    invokeCapability: async ({ capability, args = [] }) => {
      calls.push({ capability, args });
      if (capability === 'listMediaLanes') return value([lane]);
      if (capability === 'listMediaAssets') {
        const { kind, offset, boardId } = args[0] ?? {};
        const rows = offset
          ? []
          : works.filter((entry) => entry.kind === kind && (!boardId || entry.boardId === boardId));
        return value({ assets: rows, total: rows.length });
      }
      if (capability === 'listMediaBoards') {
        return value({
          total: works.length,
          boards: boards.map((board) => {
            const members = works.filter((entry) => entry.boardId === board.id);
            return {
              ...board,
              count: members.length,
            };
          }),
        });
      }
      if (capability === 'createMediaBoard') {
        const board = { id: `b-${boards.length + 1}`, name: args[0], createdAt: Date.now() };
        boards = [board, ...boards];
        return value(board);
      }
      if (capability === 'renameMediaBoard') {
        boards = boards.map((board) => (board.id === args[0] ? { ...board, name: args[1] } : board));
        return value(null);
      }
      if (capability === 'setMediaAssetBoard') {
        for (const entry of works) if (args[0].includes(entry.id)) entry.boardId = args[1] || undefined;
        return value({ ids: args[0], boardId: args[1] });
      }
      if (capability === 'startMediaJob') {
        return value({
          id: 'job-1',
          status: 'running',
          kind: 'image',
          lane: 'gemini',
          model: 'image-model',
          progress: 0,
          assetId: null,
          error: null,
          startedAt: Date.now(),
        });
      }
      if (capability === 'getMediaJob') {
        return value({
          id: args[0],
          status: 'running',
          kind: 'image',
          lane: 'gemini',
          model: 'image-model',
          progress: 0,
          assetId: null,
          error: null,
        });
      }
      if (capability === 'readMediaAsset')
        return value({ base64: PIXEL.split(',')[1], mime: 'image/png', variant: args[1]?.variant });
      if (capability === 'cacheMediaThumbnail') return value({ id: args[0], available: true });
      if (capability === 'setMediaDefault') return value(args[0]);
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
    await settle();
  });
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function reset() {
  window.localStorage.clear();
  boardsStore.openStudioBoard('');
}

function typeInto(input, text) {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

const boardRow = (host, id) => host.querySelector(`.session-row[data-board-id="${id}"]`);
const menuItems = () => [...document.querySelectorAll('.dock-scm-context-menu [data-action-id]')];
const clickMenu = (label) =>
  act(async () => {
    menuItems()
      .find((node) => node.textContent.trim() === label)
      .click();
    await settle();
  });

test('results group by day', () => {
  const works = studioApi().works;
  assert.deepEqual(
    groupStudioAssets(works, now).map((group) => [group.id, group.assets.map((entry) => entry.id)]),
    [
      ['today', ['today-1']],
      ['yesterday', ['yesterday-1']],
      ['week', ['week-1']],
      ['earlier', ['earlier-1']],
    ]
  );
});

test('the Studio entry picks the focused pane’s shown Studio tab, then any Studio tab', () => {
  const studio = (id) => ({ kind: 'studio', id });
  const leaves = [
    { id: 'l1', tabs: [{ kind: 'session', id: 's' }, studio('a')], activeKey: 'session:s' },
    { id: 'l2', tabs: [studio('b'), studio('c')], activeKey: 'studio:b' },
  ];
  assert.deepEqual(findStudioTab(leaves, 'l1'), { leafId: 'l2', key: 'studio:b' }, 'a shown Studio tab wins');
  assert.deepEqual(findStudioTab(leaves, 'l2'), { leafId: 'l2', key: 'studio:b' });
  assert.deepEqual(findStudioTab([leaves[0]], 'l1'), { leafId: 'l1', key: 'studio:a' }, 'else the newest tab');
  assert.equal(findStudioTab([{ id: 'l', tabs: [{ kind: 'session', id: 's' }], activeKey: 'session:s' }], 'l'), null);
});

test('the panel lists "All" with the total, then each board with its icon, name and count; a row opens it', async () => {
  reset();
  let shown = 0;
  const view = await mount(
    React.createElement(StudioPanel, { active: true, api: studioApi(), onShowStudio: () => (shown += 1) })
  );
  const { host } = view;
  const all = boardRow(host, '');
  assert.equal(all.querySelector('.session-row-copy b').textContent, 'All');
  assert.equal(all.querySelector('.studio-board-count').textContent, '4');
  assert.ok(all.classList.contains('selected'), 'All is open at first');
  assert.equal(host.querySelector('.sidebar-recent-heading span').textContent, 'Boards');
  const gacha = boardRow(host, 'b-gacha');
  assert.equal(gacha.querySelector('.session-row-copy b').textContent, 'Gacha sprites');
  assert.equal(gacha.querySelector('.studio-board-count').textContent, '2');
  assert.ok(gacha.querySelector('.session-row-slot.studio-board-icon svg'), 'the board icon leads the row');
  assert.equal(boardRow(host, 'b-icons').querySelector('.studio-board-count').textContent, '0');

  await act(async () => gacha.querySelector('.session-row-main').click());
  assert.equal(shown, 1, 'Studio comes forward');
  assert.ok(boardRow(host, 'b-gacha').classList.contains('selected'));
  assert.equal(boardRow(host, '').classList.contains('selected'), false);

  // A run in flight for a board spins in place of its count.
  await act(async () => bridge.showStudioPane('owner', true));
  await act(async () =>
    bridge.publishStudioPaneState('owner', [
      { id: 'job-1', status: 'running', kind: 'image', request: { prompt: 'x', boardId: 'b-icons' } },
    ])
  );
  assert.ok(boardRow(host, 'b-icons').querySelector('.session-row-status[data-working]'));
  assert.equal(boardRow(host, 'b-icons').querySelector('.studio-board-count'), null);
  assert.ok(boardRow(host, '').querySelector('.studio-board-count'), 'All counts while only a board generates');
  await act(async () => bridge.hideStudioPane('owner'));
  assert.ok(boardRow(host, 'b-icons').querySelector('.studio-board-count'), 'the owner left: its runs are gone');
  await view.unmount();
});

test('the header + names a new board inline and opens it; rename and delete ride the row menu', async () => {
  reset();
  const calls = [];
  const view = await mount(
    React.createElement(StudioPanel, { active: true, api: studioApi(calls), onShowStudio() {} })
  );
  const { host } = view;
  await act(async () => host.querySelector('button[aria-label="New board"]').click());
  const input = host.querySelector('.studio-board-name-input');
  assert.ok(input, 'an inline name field');
  await act(async () => typeInto(input, 'Lobby backgrounds'));
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
  });
  assert.deepEqual(calls.find((call) => call.capability === 'createMediaBoard').args, ['Lobby backgrounds']);
  const created = boardRow(host, 'b-3');
  assert.equal(created.querySelector('.session-row-copy b').textContent, 'Lobby backgrounds');
  assert.ok(created.classList.contains('selected'), 'the new board opens');

  await act(async () =>
    boardRow(host, 'b-icons').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  );
  assert.deepEqual(
    menuItems().map((node) => node.textContent.trim()),
    ['Open', 'Rename', 'Delete board']
  );
  await clickMenu('Rename');
  const rename = boardRow(host, 'b-icons').querySelector('.studio-board-name-input');
  await act(async () => typeInto(rename, 'Coins'));
  await act(async () => {
    rename.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
  });
  assert.deepEqual(calls.find((call) => call.capability === 'renameMediaBoard').args, ['b-icons', 'Coins']);
  assert.equal(boardRow(host, 'b-icons').querySelector('.session-row-copy b').textContent, 'Coins');
  await view.unmount();
});

test('a hidden panel fetches nothing', async () => {
  reset();
  const calls = [];
  const view = await mount(
    React.createElement(StudioPanel, { active: false, api: studioApi(calls), onShowStudio() {} })
  );
  assert.deepEqual(calls, []);
  await view.unmount();
});

test('an open board shows only its results by day, takes results from All, and new runs join it', async () => {
  reset();
  const calls = [];
  const api = studioApi(calls);
  const view = await mount(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(StudioPane, { api, tabKey: 'studio:a' }),
      React.createElement(StudioPanel, { active: true, api, onShowStudio() {} })
    )
  );
  const { host } = view;
  const tiles = () =>
    [...host.querySelectorAll('.studio-tile[data-studio-asset-id]')].map((node) => node.dataset.studioAssetId);
  const days = () => [...host.querySelectorAll('.studio-day-heading')].map((node) => node.textContent);
  assert.deepEqual(tiles(), ['today-1', 'yesterday-1', 'week-1', 'earlier-1']);
  assert.deepEqual(days(), ['Today', 'Yesterday', 'This week', 'Earlier']);
  assert.equal(host.querySelector('.studio-board-trigger-label').textContent, 'No board');

  // From All, a result's menu adds it to a board.
  const bicycle = host.querySelector('.studio-tile[data-studio-asset-id="yesterday-1"] .studio-tile-open');
  await act(async () =>
    bicycle.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  );
  assert.deepEqual(
    menuItems().map((node) => node.textContent.trim()),
    ['Open', 'Add to board', 'Delete asset']
  );
  await clickMenu('Add to board');
  await clickMenu('Gacha sprites');
  assert.deepEqual(calls.find((call) => call.capability === 'setMediaAssetBoard').args, [['yesterday-1'], 'b-gacha']);
  assert.equal(boardRow(host, 'b-gacha').querySelector('.studio-board-count').textContent, '3');
  assert.deepEqual(tiles(), ['today-1', 'yesterday-1', 'week-1', 'earlier-1'], 'All keeps every result');

  // Opening the board shows only its results, still by day.
  await act(async () => {
    boardRow(host, 'b-gacha').querySelector('.session-row-main').click();
    await settle();
  });
  assert.deepEqual(tiles(), ['today-1', 'yesterday-1', 'week-1']);
  assert.deepEqual(days(), ['Today', 'Yesterday', 'This week']);
  assert.ok(
    calls.some((call) => call.capability === 'listMediaAssets' && call.args[0]?.boardId === 'b-gacha'),
    'the board is read from the store'
  );
  assert.equal(host.querySelector('.studio-board-trigger-label').textContent, 'Gacha sprites');
  assert.ok(host.querySelector('.studio-board-trigger .studio-board-icon svg'), 'the picker shows the board icon');

  // Moving a result out of the open board drops it from the view.
  const fox = host.querySelector('.studio-tile[data-studio-asset-id="today-1"] .studio-tile-open');
  await act(async () => fox.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await clickMenu('Move to board');
  await clickMenu('Remove from board');
  assert.deepEqual(tiles(), ['yesterday-1', 'week-1']);

  // A new generation joins the open board.
  const prompt = host.querySelector('.studio-composer textarea');
  await act(async () => typeInto(prompt, 'A glowing jellyfish'));
  await act(async () => {
    host.querySelector('button[aria-label="Generate"]').click();
    await settle();
  });
  assert.equal(calls.find((call) => call.capability === 'startMediaJob').args[0].boardId, 'b-gacha');
  assert.ok(boardRow(host, 'b-gacha').querySelector('.session-row-status[data-working]'), 'its row spins');

  // The composer's board picker switches the board (and the view) back to none.
  await act(async () => host.querySelector('.studio-board-trigger').click());
  await act(async () => {
    [...document.querySelectorAll('.studio-board-menu-item')].find((node) => node.textContent === 'No board').click();
    await settle();
  });
  assert.ok(boardRow(host, '').classList.contains('selected'));
  assert.deepEqual(tiles().slice(-4), ['today-1', 'yesterday-1', 'week-1', 'earlier-1']);
  await view.unmount();
});

test('a board list read answered before a rename does not leave the renamed board stale', async () => {
  reset();
  const host = studioApi();
  let hold = null;
  const api = {
    ...host,
    invokeCapability: async (request) => {
      // Snapshot the reply when asked, but release it only when the test says.
      const reply = await host.invokeCapability(request);
      if (request.capability === 'listMediaBoards' && hold) await hold;
      return reply;
    },
  };
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const older = boardsStore.refreshStudioBoards(api, { join: true });
  await settle();
  const renamed = boardsStore.renameStudioBoard(api, 'b-gacha', 'After');
  await settle();
  hold = null;
  release();
  await Promise.all([older, renamed]);
  const name = () => {
    let current;
    const Probe = () => {
      current = boardsStore.useStudioBoards(api, false).boards.find((board) => board.id === 'b-gacha')?.name;
      return null;
    };
    return { Probe, read: () => current };
  };
  const probe = name();
  const view = await mount(React.createElement(probe.Probe));
  assert.equal(probe.read(), 'After', 'the list read after the rename wins');
  await view.unmount();
});

test('results added outside this pane (agent tool, another window) reach a shown gallery', async () => {
  reset();
  const api = studioApi();
  const view = await mount(React.createElement(StudioPane, { api, tabKey: 'studio:a' }));
  const { host } = view;
  const tiles = () =>
    [...host.querySelectorAll('.studio-tile[data-studio-asset-id]')].map((node) => node.dataset.studioAssetId);
  assert.equal(tiles().length, 4);
  api.works.unshift(asset('outside-1', 'Saved by the agent media tool', 10));
  // jsdom reports a hidden document; the window coming back is a visible one.
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  try {
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      await settle(50);
    });
  } finally {
    delete document.visibilityState;
  }
  assert.equal(tiles()[0], 'outside-1', 'the gallery reloads when the shown count moves');
  await view.unmount();
});

// jsdom reports a hidden document; a shown window is a visible one.
async function whileVisible(run) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  try {
    return await run();
  } finally {
    delete document.visibilityState;
  }
}
const windowFocus = () =>
  whileVisible(() =>
    act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      await settle(50);
    })
  );
const shownTiles = (host) =>
  [...host.querySelectorAll('.studio-tile[data-studio-asset-id]')].map((node) => node.dataset.studioAssetId);

test('an outside result folds into a scrolled gallery without dropping its loaded pages or the open asset', async () => {
  reset();
  const works = Array.from({ length: 130 }, (_, index) => asset(`old-${index}`, `Old ${index}`, (index + 1) * 60_000));
  const base = studioApi();
  const value = (result) => ({ value: result, snapshot: null });
  const api = {
    ...base,
    invokeCapability: async (request) => {
      const { capability, args = [] } = request;
      if (capability === 'listMediaAssets') {
        const { kind, offset = 0, limit = 60 } = args[0] ?? {};
        const rows = works.filter((entry) => entry.kind === kind);
        return value({ assets: rows.slice(offset, offset + limit), total: rows.length });
      }
      if (capability === 'listMediaBoards') return value({ total: works.length, boards: [] });
      return base.invokeCapability(request);
    },
  };
  const view = await mount(React.createElement(StudioPane, { api, tabKey: 'studio:a' }));
  const { host } = view;
  for (let page = 0; page < 2; page += 1) {
    await act(async () => {
      host.querySelector('.studio-results').dispatchEvent(new window.Event('scroll'));
      await settle();
    });
  }
  assert.equal(shownTiles(host).length, 130, 'scrolling loaded every page');
  await act(async () => host.querySelector('.studio-tile[data-studio-asset-id="old-100"] .studio-tile-open').click());
  works.unshift(asset('outside-1', 'Saved by the agent media tool', 10));
  await windowFocus();
  const tiles = shownTiles(host);
  assert.equal(tiles[0], 'outside-1');
  assert.equal(tiles.length, 131, 'the pages loaded past the first stay');
  assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'Old 100', 'the open asset stays open');
  await view.unmount();
});

test('a count change during a sync queues one follow-up instead of counting the same additions twice', async () => {
  reset();
  const works = Array.from({ length: 150 }, (_, index) => asset(`old-${index}`, `Old ${index}`, (index + 1) * 60_000));
  const base = studioApi();
  const value = (result) => ({ value: result, snapshot: null });
  let hold = null;
  const api = {
    ...base,
    invokeCapability: async (request) => {
      const { capability, args = [] } = request;
      if (capability === 'listMediaAssets') {
        const { kind, offset = 0, limit = 60 } = args[0] ?? {};
        const rows = works.filter((entry) => entry.kind === kind);
        const reply = value({ assets: rows.slice(offset, offset + limit), total: rows.length });
        // The first-page read of a sync answers now but lands when released.
        if (hold && kind === 'image' && offset === 0) await hold;
        return reply;
      }
      if (capability === 'listMediaBoards') return value({ total: works.length, boards: [] });
      return base.invokeCapability(request);
    },
  };
  const view = await mount(React.createElement(StudioPane, { api, tabKey: 'studio:a' }));
  const { host } = view;
  const scrollToEnd = () =>
    act(async () => {
      host.querySelector('.studio-results').dispatchEvent(new window.Event('scroll'));
      await settle();
    });
  await scrollToEnd();
  assert.equal(shownTiles(host).length, 120, '120 of 150 loaded');
  let release;
  hold = new Promise((resolve) => (release = resolve));
  works.unshift(asset('outside-1', 'Outside 1', 20), asset('outside-2', 'Outside 2', 30));
  await windowFocus();
  works.unshift(asset('outside-3', 'Outside 3', 10));
  await windowFocus();
  hold = null;
  release();
  await act(async () => settle(50));
  assert.equal(shownTiles(host).length, 123, 'every outside result folded in once');
  await scrollToEnd();
  assert.equal(shownTiles(host).length, 153, 'the next page starts where the loaded rows end, skipping none');
  await view.unmount();
});

test('an unmounted gallery drops its queued sync and starts no read after', async () => {
  reset();
  const works = Array.from({ length: 80 }, (_, index) => asset(`old-${index}`, `Old ${index}`, (index + 1) * 60_000));
  const base = studioApi();
  const value = (result) => ({ value: result, snapshot: null });
  let hold = null;
  let reads = 0;
  const api = {
    ...base,
    invokeCapability: async (request) => {
      const { capability, args = [] } = request;
      if (capability === 'listMediaAssets') {
        reads += 1;
        const { kind, offset = 0, limit = 60 } = args[0] ?? {};
        const rows = works.filter((entry) => entry.kind === kind);
        const reply = value({ assets: rows.slice(offset, offset + limit), total: rows.length });
        if (hold && kind === 'image' && offset === 0) await hold;
        return reply;
      }
      if (capability === 'listMediaBoards') return value({ total: works.length, boards: [] });
      return base.invokeCapability(request);
    },
  };
  const view = await mount(React.createElement(StudioPane, { api, tabKey: 'studio:a' }));
  let release;
  hold = new Promise((resolve) => (release = resolve));
  works.unshift(asset('outside-1', 'Outside 1', 20));
  await windowFocus();
  works.unshift(asset('outside-2', 'Outside 2', 10));
  await windowFocus();
  await view.unmount();
  const atUnmount = reads;
  hold = null;
  release();
  await act(async () => settle(50));
  assert.equal(reads, atUnmount, 'no media read starts after unmount');
});

test('the count poll runs only while the window has focus', async (t) => {
  reset();
  const calls = [];
  const api = studioApi(calls);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const hasFocus = document.hasFocus;
  let focused = false;
  document.hasFocus = () => focused;
  const reads = () => calls.filter((call) => call.capability === 'listMediaBoards').length;
  const Probe = () => {
    boardsStore.useStudioBoardsWatch(api, true);
    return null;
  };
  const view = await mount(React.createElement(Probe));
  try {
    await whileVisible(async () => {
      t.mock.timers.tick(15_000);
      await act(async () => settle());
      assert.equal(reads(), 0, 'a visible but unfocused window does not poll');
      focused = true;
      t.mock.timers.tick(15_000);
      await act(async () => settle());
      assert.equal(reads(), 1, 'a focused window polls');
    });
    // Let any list read still in flight settle, so the focus read is a fresh one.
    await boardsStore.refreshStudioBoards(api, { join: true });
    const settled = reads();
    await windowFocus();
    assert.equal(reads(), settled + 1, 'the window coming back still re-reads');
  } finally {
    await view.unmount();
    document.hasFocus = hasFocus;
  }
});

test('an outside result waits until this view’s running generation settles', async () => {
  reset();
  const calls = [];
  const base = studioApi(calls);
  let jobDone = false;
  const api = {
    ...base,
    invokeCapability: async (request) => {
      if (request.capability === 'getMediaJob' && jobDone) {
        calls.push(request);
        return {
          value: {
            id: request.args[0],
            status: 'done',
            kind: 'image',
            lane: 'gemini',
            model: 'image-model',
            progress: 1,
            assetId: 'generated-1',
            error: null,
          },
          snapshot: null,
        };
      }
      return base.invokeCapability(request);
    },
  };
  const view = await mount(React.createElement(StudioPane, { api, tabKey: 'studio:a' }));
  const { host } = view;
  await act(async () => typeInto(host.querySelector('.studio-composer textarea'), 'A glowing jellyfish'));
  await act(async () => {
    host.querySelector('button[aria-label="Generate"]').click();
    await settle();
  });
  const assetReads = () => calls.filter((call) => call.capability === 'listMediaAssets').length;
  const before = assetReads();
  base.works.unshift(asset('outside-1', 'Saved by the agent media tool', 10));
  await windowFocus();
  assert.equal(shownTiles(host).includes('outside-1'), false, 'nothing folds in while the run is in flight');
  assert.equal(assetReads(), before);
  base.works.unshift(asset('generated-1', 'A glowing jellyfish', 5));
  jobDone = true;
  await act(async () => settle(1_800));
  const tiles = shownTiles(host);
  assert.ok(tiles.includes('generated-1') && tiles.includes('outside-1'), 'both land once the run settles');
  await view.unmount();
});
