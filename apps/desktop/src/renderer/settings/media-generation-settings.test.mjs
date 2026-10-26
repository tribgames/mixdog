import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Windows' } });
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { createRoot } = await import('react-dom/client');
const { BuiltInFeaturesPanel } = await import('./built-in-features-panel.tsx');
const { useMediaGeneration } = await import('./media-generation-settings.tsx');

const spec = (models) => ({ defaultModel: models[0].id, models, controls: {} });
const LANES = [
  {
    id: 'grok-oauth',
    label: 'Grok Imagine',
    authType: 'oauth',
    authProvider: 'grok-oauth',
    authenticated: true,
    supportedKinds: ['image', 'video'],
    kinds: ['image', 'video'],
    image: spec([{ id: 'grok-imagine-image', label: 'Grok Imagine Image' }]),
    video: spec([{ id: 'grok-imagine-video', label: 'Grok Imagine Video' }]),
  },
  {
    id: 'openai-oauth',
    label: 'OpenAI Images',
    authType: 'oauth',
    authProvider: 'openai-oauth',
    authenticated: true,
    supportedKinds: ['image'],
    kinds: ['image'],
    image: spec([{ id: 'gpt-image-2', label: 'GPT Image 2' }]),
    video: null,
  },
  {
    id: 'antigravity-oauth',
    label: 'Google Antigravity',
    authType: 'oauth',
    authProvider: 'antigravity-oauth',
    authenticated: false,
    supportedKinds: ['image'],
    kinds: [],
    image: null,
    video: null,
  },
];

function fakeApi({ pins = { image: null, video: null }, accounts = {}, lanes = LANES } = {}) {
  const saved = [];
  const state = { ...pins };
  return {
    saved,
    async invokeCapability({ capability, args }) {
      if (capability === 'listMediaLanes') return { value: lanes };
      if (capability === 'getMediaPins') return { value: { ...state } };
      if (capability === 'getProviderAccounts') return { value: { accounts: accounts[args[0]] ?? [] } };
      if (capability === 'setMediaPin') {
        const [{ kind, lane, model, account }] = args;
        saved.push(args[0]);
        state[kind] = lane ? { kind, lane, model, account } : null;
        return { value: state[kind] };
      }
      return { value: {} };
    },
  };
}

async function mount(api) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(BuiltInFeaturesPanel, {
        api,
        data: { toolModules: { media: { enabled: true, installed: true } } },
        snapshot: {},
        pending: '',
        run: async () => ({}),
      })
    )
  );
  await act(async () => document.querySelector('[data-built-in-feature="media"]').click());
  await act(async () => {});
  return {
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
      document.body.replaceChildren();
    },
  };
}

const click = (node) => act(async () => node.click());
const trigger = (kind) => document.querySelector(`[data-media-kind="${kind}"] .model-trigger`);
const sheetRow = (label) =>
  [...document.querySelectorAll('.route-sheet-row')].find((row) => row.textContent.startsWith(label));
const optionRows = () => [...document.querySelectorAll('.model-option-row')];
const name = (row) => row.querySelector('strong').textContent;

test('media is listed after Office, and its dialog offers an image and a video default on Auto', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(BuiltInFeaturesPanel, {
        api: fakeApi(),
        data: { toolModules: {} },
        snapshot: {},
        pending: '',
        run: async () => ({}),
      })
    )
  );
  const ids = [...document.querySelectorAll('[data-built-in-feature]')].map((node) =>
    node.getAttribute('data-built-in-feature')
  );
  assert.equal(ids[ids.indexOf('office') + 1], 'media');
  await act(async () => root.unmount());
  host.remove();
});

test('the model sheet lists Auto first, groups by provider, and mutes a provider that is signed out', async () => {
  const api = fakeApi();
  const view = await mount(api);
  try {
    assert.deepEqual(
      ['image', 'video'].map((kind) => trigger(kind).textContent),
      ['Auto', 'Auto']
    );
    await click(trigger('image'));
    assert.ok(sheetRow('Model'), 'model row');
    assert.equal(sheetRow('Account'), undefined, 'no account row while the generator is Auto');
    await click(sheetRow('Model'));
    const rows = optionRows();
    assert.equal(name(rows[0]), 'Auto');
    assert.equal(rows[0].getAttribute('aria-checked'), 'true');
    const labels = rows.map(name);
    assert.ok(labels.indexOf('GPT Image 2') < labels.indexOf('Grok Imagine Image'), 'ChatGPT first');
    const signedOut = rows.find((row) => name(row) === 'Google Antigravity');
    assert.match(signedOut.textContent, /Sign-in required/);
    assert.equal(signedOut.disabled, true);
    await click(signedOut);
    assert.deepEqual(api.saved, [], 'a signed-out provider cannot be pinned');
  } finally {
    await view.dispose();
  }
});

test('gateway image lanes group under their provider name and icon and can be pinned', async () => {
  const gateway = (id, label, models) => ({
    id,
    label,
    authType: 'api-key',
    authProvider: id,
    authenticated: true,
    supportedKinds: ['image'],
    kinds: ['image'],
    image: spec(models),
    video: null,
  });
  const api = fakeApi({
    lanes: [
      gateway('openrouter', 'OpenRouter', [{ id: 'qwen/qwen-image-2.1-turbo', label: 'Qwen Image 2.1 Turbo' }]),
      gateway('nano-gpt', 'NanoGPT', [
        { id: 'openai/gpt-image-2.5/sunburst/text-to-image', label: 'GPT Image 2.5 Sunburst' },
      ]),
    ],
  });
  const view = await mount(api);
  try {
    await click(trigger('image'));
    await click(sheetRow('Model'));
    const groups = [...document.querySelectorAll('.model-group--provider h3')].map((heading) => [
      heading.querySelector('svg').getAttribute('data-provider-icon'),
      heading.textContent,
    ]);
    assert.deepEqual(groups, [
      ['openrouter', 'OpenRouterAPI key'],
      ['synthetic', 'NanoGPTAPI key'],
    ]);
    await click(optionRows().find((row) => name(row) === 'GPT Image 2.5 Sunburst'));
    assert.deepEqual(api.saved, [
      { kind: 'image', lane: 'nano-gpt', model: 'openai/gpt-image-2.5/sunburst/text-to-image', account: '' },
    ]);
  } finally {
    await view.dispose();
  }
});

test('a slow gateway catalog lists as loading, re-polls until its models land, and a failure offers Retry', async () => {
  const nano = {
    id: 'nano-gpt',
    label: 'NanoGPT',
    authType: 'api-key',
    authProvider: 'nano-gpt',
    authenticated: true,
    supportedKinds: ['image'],
    kinds: [],
    image: null,
    video: null,
  };
  const loaded = {
    ...nano,
    kinds: ['image'],
    image: spec([{ id: 'hidream', label: 'HiDream' }]),
  };
  const failed = {
    ...nano,
    catalogErrorCode: 'MEDIA_CATALOG_TIMEOUT',
    catalogError: 'NanoGPT (API key): Model catalog request timed out. Retry after checking the connection.',
  };
  let nanoState = { ...nano, catalogPending: true };
  const laneCalls = [];
  const api = fakeApi();
  const base = api.invokeCapability;
  api.invokeCapability = async (request) => {
    if (request.capability !== 'listMediaLanes') return base(request);
    laneCalls.push(request.args);
    return { value: [LANES[1], nanoState] };
  };
  const pressEscape = () =>
    act(async () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const imageRows = async () => {
    await click(trigger('image'));
    await click(sheetRow('Model'));
    const rows = optionRows().map((row) => ({ name: name(row), text: row.textContent, disabled: row.disabled }));
    await pressEscape();
    await pressEscape();
    return rows;
  };
  const retryButton = () =>
    [...document.querySelectorAll('[data-media-generation] button')].find((button) => button.textContent === 'Retry');
  const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

  const view = await mount(api);
  try {
    assert.ok(laneCalls[0]?.[0]?.budgetMs > 0, 'the dialog bounds the listing so one slow catalog cannot hold it');
    let rows = await imageRows();
    assert.ok(
      rows.some((row) => row.name === 'GPT Image 2' && !row.disabled),
      'the ready provider stays choosable'
    );
    const loading = rows.find((row) => row.text.includes('NanoGPT'));
    assert.ok(loading, 'the slow provider is listed instead of vanishing');
    assert.match(loading.text, /Loading models…/);
    assert.equal(loading.disabled, true);

    nanoState = loaded;
    for (let waited = 0; laneCalls.length < 2 && waited < 10_000; waited += 50) await wait(50);
    assert.ok(laneCalls.length >= 2, 'a pending catalog is polled again');
    rows = await imageRows();
    assert.ok(
      rows.some((row) => row.name === 'HiDream' && !row.disabled),
      'the late models become choosable'
    );
    const settled = laneCalls.length;
    await wait(1_200);
    assert.equal(laneCalls.length, settled, 'polling stops once every catalog answered');
    assert.equal(retryButton(), undefined, 'no Retry while every catalog answered');
  } finally {
    await view.dispose();
  }

  nanoState = failed;
  const again = await mount(api);
  try {
    const rows = await imageRows();
    assert.match(rows.find((row) => row.text.includes('NanoGPT')).text, /Couldn't load models/);
    assert.match(document.querySelector('[data-media-generation]').textContent, /Model catalog request timed out/);
    const calls = laneCalls.length;
    nanoState = loaded;
    await click(retryButton());
    assert.equal(laneCalls.length, calls + 1, 'Retry lists the catalogs again');
    assert.ok((await imageRows()).some((row) => row.name === 'HiDream' && !row.disabled));
    assert.doesNotMatch(document.querySelector('[data-media-generation]').textContent, /timed out/);
    assert.equal(retryButton(), undefined, 'Retry leaves once the catalog answered');
  } finally {
    await again.dispose();
  }
});

test('choosing a model persists the pin and Auto clears it', async () => {
  const api = fakeApi();
  const view = await mount(api);
  try {
    await click(trigger('image'));
    await click(sheetRow('Model'));
    await click(optionRows().find((row) => name(row) === 'GPT Image 2'));
    assert.deepEqual(api.saved, [{ kind: 'image', lane: 'openai-oauth', model: 'gpt-image-2', account: '' }]);
    assert.equal(trigger('image').textContent, 'GPT Image 2');
    assert.equal(trigger('video').textContent, 'Auto', 'the other kind is untouched');

    await click(trigger('image'));
    await click(sheetRow('Model'));
    await click(optionRows()[0]);
    assert.deepEqual(api.saved.at(-1), { kind: 'image', lane: '', model: '', account: '' });
    assert.equal(trigger('image').textContent, 'Auto');
  } finally {
    await view.dispose();
  }
});

test('saved defaults load into the triggers', async () => {
  const api = fakeApi({ pins: { image: null, video: { kind: 'video', lane: 'grok-oauth', model: '', account: '' } } });
  const view = await mount(api);
  try {
    assert.equal(trigger('video').textContent, 'Grok Imagine Video', 'an empty model shows the lane default');
  } finally {
    await view.dispose();
  }
});

test('the account row appears only for a provider with two or more accounts', async () => {
  const two = [
    { id: 'acc-1', label: 'Personal' },
    { id: 'acc-2', label: 'Work' },
  ];
  const pinned = { kind: 'image', lane: 'openai-oauth', model: 'gpt-image-2', account: '' };
  const single = await mount(fakeApi({ pins: { image: pinned, video: null }, accounts: { 'openai-oauth': [two[0]] } }));
  try {
    await click(trigger('image'));
    assert.equal(sheetRow('Account'), undefined, 'one account → no account row');
  } finally {
    await single.dispose();
  }

  const api = fakeApi({ pins: { image: pinned, video: null }, accounts: { 'openai-oauth': two } });
  const view = await mount(api);
  try {
    await click(trigger('image'));
    assert.match(sheetRow('Account').textContent, /Current account/);
    await click(sheetRow('Account'));
    const options = [...document.querySelectorAll('.route-sheet-option')].map((row) => row.textContent);
    assert.deepEqual(options, ['Current account', 'Personal', 'Work']);
    await click([...document.querySelectorAll('.route-sheet-option')][2]);
    assert.deepEqual(api.saved.at(-1), { kind: 'image', lane: 'openai-oauth', model: 'gpt-image-2', account: 'acc-2' });
    assert.match(trigger('image').textContent, /GPT Image 2\s*Work/);
  } finally {
    await view.dispose();
  }
});

test('the model field sheet opens below its trigger with the right edges aligned; its flyout hangs from the row', async () => {
  const view = await mount(fakeApi());
  try {
    const field = trigger('image');
    field.getBoundingClientRect = () => ({ left: 700, right: 860, top: 200, bottom: 232, width: 160, height: 32 });
    await click(field);
    const sheet = document.querySelector('.route-sheet');
    // One Model row (Auto): 36px + 4px padding on each side, 6px under the field.
    assert.equal(sheet.dataset.placement, 'below');
    assert.equal(sheet.style.top, '238px');
    assert.equal(parseFloat(sheet.style.left) + parseFloat(sheet.style.width), 860);
    const row = sheetRow('Model');
    row.getBoundingClientRect = () => ({ left: 640, right: 856, top: 242, bottom: 278, width: 216, height: 36 });
    // The flyout hangs from the row's settled (layout) top, not its transformed rectangle.
    Object.defineProperties(row, {
      offsetTop: { configurable: true, value: 242 },
      offsetParent: { configurable: true, value: null },
    });
    await click(row);
    const flyout = document.querySelector('.route-sheet-flyout');
    // No room for a 280px column on the right of the sheet: it opens on the left.
    assert.equal(flyout.dataset.placement, 'left');
    assert.equal(parseFloat(flyout.style.left) + parseFloat(flyout.style.width), parseFloat(sheet.style.left) - 6);
    assert.equal(flyout.style.top, '242px');
    // Its height follows its content up to the model list cap.
    assert.equal(flyout.style.height, '');
    assert.equal(flyout.style.maxHeight, '360px');
  } finally {
    await view.dispose();
  }
});

test('only the latest save of a kind sets or rolls back its pin', async () => {
  const replies = [];
  const api = {
    async invokeCapability({ capability, args }) {
      if (capability === 'listMediaLanes') return { value: LANES };
      if (capability === 'getMediaPins') return { value: { image: null, video: null } };
      if (capability === 'setMediaPin') {
        return new Promise((resolve, reject) => replies.push({ pin: args[0], resolve, reject }));
      }
      return { value: {} };
    },
  };
  let data;
  function Probe() {
    data = useMediaGeneration(api, true);
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Probe)));
    const grok = { lane: 'grok-oauth', model: 'grok-imagine-image', account: '' };
    const openai = { lane: 'openai-oauth', model: 'gpt-image-2', account: '' };
    let first;
    let second;
    await act(async () => {
      first = data.save('image', grok);
      second = data.save('image', openai);
    });
    await act(async () => {
      replies[1].resolve({ value: { kind: 'image', ...openai } });
      await second;
    });
    await act(async () => {
      replies[0].resolve({ value: { kind: 'image', ...grok } });
      await first;
    });
    assert.equal(data.pins.image.lane, 'openai-oauth', 'a late older reply does not undo the newer pick');

    let third;
    let fourth;
    await act(async () => {
      third = data.save('image', grok);
      fourth = data.save('image', null);
    });
    await act(async () => {
      replies[3].reject(new Error('host refused'));
      await fourth;
    });
    assert.equal(data.pins.image?.lane, 'openai-oauth', 'a failed latest save rolls back to what the host kept');
    assert.equal(data.error, 'host refused');
    await act(async () => {
      replies[2].reject(new Error('stale'));
      await third;
    });
    assert.equal(data.error, 'host refused', 'a stale failure neither rolls back nor reports');

    let fifth;
    let sixth;
    await act(async () => {
      fifth = data.save('image', grok);
      sixth = data.save('image', null);
    });
    await act(async () => {
      replies[5].reject(new Error('host refused again'));
      await sixth;
    });
    await act(async () => {
      replies[4].resolve({ value: { kind: 'image', ...grok } });
      await fifth;
    });
    assert.equal(data.pins.image?.lane, 'grok-oauth', 'an older save that lands after a failed newer one is shown');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
