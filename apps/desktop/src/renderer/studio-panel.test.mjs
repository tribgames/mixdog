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
              cover: members[0] ? { id: members[0].id, kind: members[0].kind } : null,
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

test('the panel lists "All" with the total, then each board with thumbnail, name and count; a row opens it', async () => {
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
  assert.ok(
    gacha.querySelector('.studio-panel-thumb .studio-thumbnail-image, .studio-panel-thumb img'),
    'the latest result leads the row'
  );
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

test('a board thumbnail the byte lane cannot serve yet is filled by the renderer fallback, not left blank', async () => {
  reset();
  const calls = [];
  const view = await mount(
    React.createElement(StudioPanel, { active: true, api: studioApi(calls), onShowStudio() {} })
  );
  const { host } = view;
  const thumb = () => boardRow(host, 'b-gacha').querySelector('.studio-panel-thumb img');
  // The desktop lane only serves renditions that exist: a cold cover 404s.
  const direct = [...host.querySelectorAll('.studio-panel-thumb img')].find((img) =>
    img.src.startsWith('mixdog-media:')
  );
  if (direct) {
    await act(async () => {
      direct.dispatchEvent(new window.Event('error'));
      await settle();
    });
  }
  await act(async () => settle(50));
  assert.ok(thumb(), 'the cover still shows a picture');
  assert.match(thumb().src, /^data:image\/png;base64,/, 'read through the renderer fallback');
  assert.ok(
    calls.some((call) => call.capability === 'readMediaAsset' && call.args[0] === 'today-1'),
    'the cover was read for its thumbnail'
  );
  assert.ok(
    calls.some((call) => call.capability === 'cacheMediaThumbnail' && call.args[0] === 'today-1'),
    'and cached so the byte lane serves it next time'
  );
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
