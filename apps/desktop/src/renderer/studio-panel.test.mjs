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
const { findStudioTab, filterStudioAssets, groupStudioAssets } = await import('./studio-panel-model.ts');
const { StudioPanel } = await import('./StudioPanel.tsx');
const { StudioPane } = await import('./StudioView.tsx');
const bridge = await import('./studio-panel-bridge.ts');

const DAY = 86_400_000;
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mNk+M/wHwAEAQH/2kGLWQAAAABJRU5ErkJggg==';
const now = Date.now();
const asset = (id, prompt, age, kind = 'image') => ({
  id,
  kind,
  lane: 'gemini',
  model: 'image-model',
  prompt,
  mime: 'image/png',
  bytes: 100,
  createdAt: now - age,
});
const works = [
  asset('today-1', 'A fox in the snow', 1000),
  asset('yesterday-1', 'A red bicycle', DAY + 1000),
  asset('week-1', 'A quiet harbour', 4 * DAY),
  asset('earlier-1', 'A paper crane', 30 * DAY, 'video'),
];
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

function studioApi(calls = []) {
  return {
    mediaUrl: () => PIXEL,
    invokeCapability: async ({ capability, args = [] }) => {
      calls.push({ capability, args });
      if (capability === 'listMediaLanes') return { value: [lane], snapshot: null };
      if (capability === 'listMediaAssets') {
        const kind = args[0]?.kind;
        const rows = args[0]?.offset ? [] : works.filter((entry) => entry.kind === kind);
        return { value: { assets: rows, total: rows.length }, snapshot: null };
      }
      if (capability === 'readMediaAsset')
        return { value: { base64: PIXEL.split(',')[1], mime: 'image/png' }, snapshot: null };
      if (capability === 'setMediaDefault') return { value: args[0], snapshot: null };
      if (capability === 'deleteMediaAsset') return { value: { id: args[0], deleted: true }, snapshot: null };
      throw new Error(`unexpected capability: ${capability}`);
    },
  };
}

async function mount(element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  return {
    host,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const rowOf = (host, id) => host.querySelector(`.session-row[data-asset-id="${id}"]`);
const headings = (host) => [...host.querySelectorAll('.sidebar-recent-heading span')].map((node) => node.textContent);

test('works group by day and match the Sessions row grammar', () => {
  const groups = groupStudioAssets(works, now);
  assert.deepEqual(
    groups.map((group) => [group.id, group.assets.map((entry) => entry.id)]),
    [
      ['today', ['today-1']],
      ['yesterday', ['yesterday-1']],
      ['week', ['week-1']],
      ['earlier', ['earlier-1']],
    ]
  );
  assert.deepEqual(
    groupStudioAssets([works[0]], now).map((group) => group.id),
    ['today']
  );
  assert.deepEqual(
    filterStudioAssets(works, '  BICYCLE ').map((entry) => entry.id),
    ['yesterday-1']
  );
  assert.equal(filterStudioAssets(works, '').length, 4);
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

test('the panel lists runs in progress and dated works as Sessions-sized rows, and a row opens its work', async () => {
  window.localStorage.clear();
  const opened = [];
  let created = 0;
  const calls = [];
  const view = await mount(
    React.createElement(StudioPanel, {
      active: true,
      api: studioApi(calls),
      onNewStudio: () => {
        created += 1;
      },
      onOpenAsset: (entry) => opened.push(entry.id),
    })
  );
  const { host } = view;
  assert.deepEqual(headings(host), ['Today', 'Yesterday', 'This week', 'Earlier']);
  const row = rowOf(host, 'today-1');
  assert.equal(row.querySelectorAll('.session-row-copy b').length, 1, 'one line: the prompt');
  assert.equal(row.querySelector('.session-row-copy b').textContent, 'A fox in the snow');
  assert.equal(row.querySelector('.session-row-copy small'), null, 'no second line');
  assert.ok(row.querySelector('.session-row-main .studio-panel-thumb'), 'a thumbnail leads the row');
  const label = row.querySelector('.session-row-main').getAttribute('aria-label');
  assert.match(label, /A fox in the snow · image · /, 'kind and time ride the label');
  assert.match(rowOf(host, 'earlier-1').querySelector('.session-row-main').getAttribute('aria-label'), / · video · /);

  await act(async () => row.querySelector('.session-row-main').click());
  assert.deepEqual(opened, ['today-1']);

  // Search filters by prompt.
  await act(async () => host.querySelector('button[aria-label="Search"]').click());
  const input = host.querySelector('input[type="search"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'crane');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(
    [...host.querySelectorAll('.session-row')].map((node) => node.dataset.assetId),
    ['earlier-1']
  );

  await act(async () => host.querySelector('button[aria-label="New Studio"]').click());
  assert.equal(created, 1);

  // Runs in flight lead, with the running spinner in the status slot.
  await act(async () => bridge.showStudioPane('owner', true));
  await act(async () =>
    bridge.publishStudioPaneState(
      'owner',
      [
        {
          id: 'job-1',
          status: 'running',
          kind: 'image',
          lane: 'gemini',
          model: 'm',
          progress: 0,
          assetId: null,
          error: null,
          request: { prompt: 'A glowing jellyfish' },
        },
      ],
      ''
    )
  );
  assert.equal(headings(host)[0], 'In progress');
  const running = host.querySelector('.session-row.working');
  assert.equal(running.querySelector('.session-row-copy b').textContent, 'A glowing jellyfish');
  assert.ok(running.querySelector('.session-row-status[data-working]'));
  await act(async () => bridge.hideStudioPane('owner'));
  assert.equal(headings(host)[0], 'Earlier', 'the owner left: its runs are gone');
  await view.unmount();
});

test('a hidden panel fetches nothing', async () => {
  const calls = [];
  const view = await mount(
    React.createElement(StudioPanel, { active: false, api: studioApi(calls), onNewStudio() {}, onOpenAsset() {} })
  );
  assert.deepEqual(calls, []);
  await view.unmount();
});

test('a panel row opens its work in the Studio pane, shows selected, and Delete asset drops it everywhere', async () => {
  window.localStorage.clear();
  const calls = [];
  const api = studioApi(calls);
  const view = await mount(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(StudioPane, { api, tabKey: 'studio:a' }),
      React.createElement(StudioPanel, {
        active: true,
        api,
        onNewStudio() {},
        onOpenAsset: (entry) => bridge.requestStudioOpenAsset('studio:a', entry),
      })
    )
  );
  const { host } = view;
  assert.equal(host.querySelector('.studio-detail-prompt'), null);
  await act(async () => {
    rowOf(host, 'yesterday-1').querySelector('.session-row-main').click();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  assert.equal(host.querySelector('.studio-detail-prompt')?.textContent, 'A red bicycle');
  assert.ok(rowOf(host, 'yesterday-1').classList.contains('selected'), 'the open work shows selected');
  assert.equal(rowOf(host, 'today-1').classList.contains('selected'), false);

  await act(async () => {
    rowOf(host, 'week-1').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.trim());
  assert.deepEqual(items, ['Open', 'Delete asset']);
  await act(async () => {
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((node) => node.textContent.includes('Delete asset'))
      .click();
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  assert.deepEqual(
    calls.filter((call) => call.capability === 'deleteMediaAsset').map((call) => call.args[0]),
    ['week-1']
  );
  assert.equal(rowOf(host, 'week-1'), null);
  assert.equal(host.querySelectorAll('.studio-tile-open').length, 2, 'the gallery dropped it too');
  await view.unmount();
});

/** Two Studio panes (each in its own box) and the rail panel, rendered again
 *  with new per-pane props: `{ active, focused }`. */
async function mountTwoPanes(api, onOpenAsset) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (a, b) => {
    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          ...[
            ['a', a],
            ['b', b],
          ].map(([id, props]) =>
            props
              ? React.createElement(
                  'section',
                  { key: id, 'data-pane': id },
                  React.createElement(StudioPane, { api, tabKey: `studio:${id}`, ...props })
                )
              : null
          ),
          React.createElement(StudioPanel, { active: true, api, onNewStudio() {}, onOpenAsset })
        )
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  };
  const request = (id, entry) => act(async () => bridge.requestStudioOpenAsset(`studio:${id}`, entry));
  const detail = (id) => host.querySelector(`[data-pane="${id}"] .studio-detail-prompt`)?.textContent ?? null;
  const selected = () => [...host.querySelectorAll('.session-row.selected')].map((row) => row.dataset.assetId);
  return {
    host,
    render,
    request,
    detail,
    selected,
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('with two shown Studio panes, a work opens only in the pane it was aimed at, once', async () => {
  window.localStorage.clear();
  const view = await mountTwoPanes(studioApi());
  await view.render({ active: true, focused: true }, { active: true, focused: false });
  await view.request('b', works[1]);
  assert.equal(view.detail('b'), 'A red bicycle');
  assert.equal(view.detail('a'), null, 'the other shown pane does not also open it');
  // The request was taken: later renders and a second request do not repeat it.
  await view.request('a', works[0]);
  assert.equal(view.detail('a'), 'A fox in the snow');
  assert.equal(view.detail('b'), 'A red bicycle', 'the first pane keeps what it had');
  // A request aimed at a pane whose tab is not shown waits for it.
  await view.render({ active: false, focused: false }, { active: true, focused: true });
  await view.request('a', works[2]);
  assert.equal(view.detail('a'), 'A fox in the snow');
  await view.render({ active: true, focused: true }, { active: true, focused: false });
  assert.equal(view.detail('a'), 'A quiet harbour');
  await view.unmount();
});

test('the rail panel mirrors the Studio pane the user focused last, handing over and clearing with it', async () => {
  window.localStorage.clear();
  const view = await mountTwoPanes(studioApi());
  const both = (focused) =>
    view.render({ active: true, focused: focused === 'a' }, { active: true, focused: focused === 'b' });
  await both('a');
  await view.request('b', works[0]);
  assert.equal(view.detail('b'), 'A fox in the snow');
  assert.deepEqual(view.selected(), [], 'a pane the user has not focused does not drive the panel');

  await both('b');
  assert.deepEqual(view.selected(), ['today-1'], 'focusing it makes it the owner, and it republishes');
  await both('a');
  assert.deepEqual(view.selected(), [], 'the owner is the pane focused last');
  await both('b');
  assert.deepEqual(view.selected(), ['today-1']);

  // The owner's tab is no longer shown: its selection leaves with it.
  await view.render({ active: true, focused: false }, { active: false, focused: false });
  assert.deepEqual(view.selected(), [], 'no stale selection after switching to a non-Studio tab');
  await view.render({ active: true, focused: false }, { active: true, focused: true });
  assert.deepEqual(view.selected(), ['today-1'], 'it owns again once shown and focused, and republishes');

  // Closing a pane that is not the owner leaves the owner's state alone.
  await view.render(null, { active: true, focused: true });
  assert.deepEqual(view.selected(), ['today-1'], 'the surviving owner keeps its state');
  await view.render(null, null);
  assert.deepEqual(view.selected(), [], 'closing the owner clears it');
  await view.unmount();
});
