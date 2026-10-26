import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'KeyboardEvent'],
  actEnvironment: false,
});
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.React = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createRoot } = await import('react-dom/client');
const { StudioRouteMenu } = await import('./StudioRouteMenu.tsx');

const ENTRIES = [
  { lane: 'alpha', laneLabel: 'Alpha', authType: 'oauth', model: 'alpha-1', label: 'Alpha One' },
  { lane: 'alpha', laneLabel: 'Alpha', authType: 'oauth', model: 'alpha-2', label: 'Alpha Two', description: 'Fast' },
  { lane: 'beta', laneLabel: 'Beta', authType: 'api-key', model: 'beta-1', label: 'Beta One', unavailable: 'Off' },
];

const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const click = (node) => act(async () => node.click());
const sheetRow = (label) =>
  [...document.querySelectorAll('.route-sheet-row')].find((row) => row.textContent.startsWith(label));
const titles = () => [...document.querySelectorAll('.model-option-row strong')].map((node) => node.textContent);
const hover = (node) => act(async () => node.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true })));

async function mount(props) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = (next) =>
    act(async () =>
      root.render(
        React.createElement(StudioRouteMenu, {
          entries: ENTRIES,
          lane: 'alpha',
          model: 'alpha-1',
          onSelect() {},
          ...props,
          ...next,
        })
      )
    );
  await render();
  return {
    render,
    trigger: () => host.querySelector('button'),
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
      document.body.replaceChildren();
    },
  };
}

test('the model pane groups by lane, filters by query, clears and reports no match', async () => {
  const picked = [];
  const view = await mount({ auto: { label: 'Auto', selected: false, onSelect: () => picked.push('auto') } });
  try {
    await click(view.trigger());
    assert.equal(view.trigger().getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.route-sheet').getAttribute('aria-label'), 'Generation options');
    await click(sheetRow('Model'));
    assert.deepEqual(titles(), ['Auto', 'Alpha One', 'Alpha Two', 'Beta One']);
    const headings = [...document.querySelectorAll('.model-group--provider h3')].map((node) => node.textContent);
    assert.deepEqual(headings, ['AlphaAccount', 'BetaAPI key']);
    const checked = [...document.querySelectorAll('.model-option-row[aria-checked="true"]')];
    assert.deepEqual(
      checked.map((node) => node.querySelector('strong').textContent),
      ['Alpha One']
    );
    const beta = [...document.querySelectorAll('.model-option-row')].at(-1);
    assert.equal(beta.disabled, true);
    assert.equal(beta.hasAttribute('data-unavailable'), true);
    assert.equal(beta.hasAttribute('data-tooltip'), false);

    const search = document.querySelector('.model-search input');
    const type = (value) =>
      act(async () => {
        search.value = value;
        search.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    await type('two');
    assert.deepEqual(titles(), ['Alpha Two']);
    await type('zzz');
    assert.deepEqual(titles(), []);
    assert.equal(document.querySelector('.model-empty').textContent, 'No matching models.');
    await click(document.querySelector('[aria-label="Clear picker search"]'));
    assert.equal(search.value, '');
    assert.equal(document.activeElement, search);
    assert.equal(titles().length, 4);

    await click(document.querySelector('.model-option-row'));
    assert.deepEqual(picked, ['auto']);
    assert.equal(document.querySelector('.route-sheet').dataset.state, 'closing');
    assert.equal(view.trigger().getAttribute('aria-expanded'), 'false');
    await wait(150);
    assert.equal(document.querySelector('.route-sheet'), null, 'the close animation unmounts the sheet');
  } finally {
    await view.dispose();
  }
});

test('option rows pick only a new value, and hovering another row with a pane open switches after a dwell', async () => {
  const picks = [];
  const rows = [
    {
      id: 'aspect',
      label: 'Aspect',
      value: '1:1',
      valueLabel: 'Square',
      options: [
        { value: '1:1', label: 'Square' },
        { value: '16:9', label: 'Wide' },
      ],
      onPick: (value) => picks.push(value),
    },
    {
      id: 'size',
      label: 'Size',
      value: 'm',
      valueLabel: 'Medium',
      options: [{ value: 'm', label: 'Medium' }],
      onPick: (value) => picks.push(value),
    },
  ];
  const view = await mount({ rows });
  try {
    await click(view.trigger());
    await hover(sheetRow('Aspect'));
    assert.equal(sheetRow('Aspect').getAttribute('aria-expanded'), 'true', 'hover opens with no pane open');
    const options = () => [...document.querySelectorAll('.route-sheet-option')];
    assert.deepEqual(
      options().map((node) => [node.textContent, node.getAttribute('aria-checked')]),
      [
        ['Square', 'true'],
        ['Wide', 'false'],
      ]
    );
    await click(options()[0]);
    assert.deepEqual(picks, []);
    await click(options()[1]);
    assert.deepEqual(picks, ['16:9']);

    await hover(sheetRow('Size'));
    assert.equal(sheetRow('Aspect').getAttribute('aria-expanded'), 'true', 'no switch before the dwell');
    await wait(200);
    assert.equal(sheetRow('Size').getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.route-sheet-flyout').getAttribute('aria-label'), 'Size');

    await act(async () =>
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    assert.equal(document.querySelector('.route-sheet-flyout'), null, 'Escape closes the pane first');
    assert.ok(document.querySelector('.route-sheet[data-state="open"]'), 'the sheet stays open');
  } finally {
    await view.dispose();
  }
});

test('a narrow surface drills the pane into the sheet; Back returns to the rows and refocuses the row', async () => {
  const innerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 300 });
  const values = [];
  const view = await mount({
    slider: { label: 'Duration', min: 1, max: 10, value: 4, onChange: (value) => values.push(value) },
  });
  try {
    view.trigger().getBoundingClientRect = () => ({
      left: 10,
      right: 110,
      top: 600,
      bottom: 632,
      width: 100,
      height: 32,
    });
    await click(view.trigger());
    assert.match(sheetRow('Duration').textContent, /4s/);
    await click(sheetRow('Duration'));
    const sheet = document.querySelector('.route-sheet');
    assert.equal(sheet.hasAttribute('data-drilled'), true);
    assert.equal(sheet.getAttribute('aria-label'), 'Duration');
    assert.equal(document.querySelector('.route-sheet-flyout'), null);
    const range = sheet.querySelector('input[type="range"]');
    assert.equal(range.getAttribute('aria-label'), 'Duration seconds');
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(range, '7');
      range.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(values, [7]);

    await click(sheet.querySelector('.route-sheet-back[aria-label="Back"]'));
    assert.equal(sheet.hasAttribute('data-drilled'), false);
    await wait(10);
    assert.equal(document.activeElement, sheetRow('Duration'));
  } finally {
    await view.dispose();
    if (innerWidth) Object.defineProperty(window, 'innerWidth', innerWidth);
    else delete window.innerWidth;
  }
});

test('the field variant wraps the menu, shows the suffix and keeps its natural width', async () => {
  const view = await mount({ variant: 'field', triggerLabel: 'Custom', suffix: 'Work', ariaLabel: 'Pick' });
  try {
    const wrapper = document.querySelector('.workflows-dialog-route > .route-editor.studio-model-menu');
    assert.ok(wrapper);
    const trigger = wrapper.querySelector('.model-trigger');
    assert.equal(trigger.getAttribute('aria-label'), 'Pick');
    assert.equal(trigger.textContent, 'CustomWork');
    await click(trigger);
    assert.equal(trigger.style.width, '');
    assert.equal(trigger.hasAttribute('data-morph'), false);
    assert.match(sheetRow('Model').textContent, /Custom/);
  } finally {
    await view.dispose();
  }
});
