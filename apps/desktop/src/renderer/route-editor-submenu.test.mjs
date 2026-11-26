// The route sheet's rows open their panes as submenus (submenu.tsx): a hover
// still waiting when the sheet or its pane closes must open nothing after it.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
after(restore);

const { createRoot } = await import('react-dom/client');
const { RouteEditor } = await import('./RouteEditor.tsx');

// Well past the hover delay and the sheet's close animation.
const REST = 400;
const noop = () => {};
const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

async function renderEditor(t, props = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(RouteEditor, {
        models: [],
        provider: 'openai-oauth',
        model: 'gpt-6-sol',
        triggerModel: 'GPT-6 Sol',
        effort: 'low',
        effortOptions: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
        fast: false,
        fastVisible: false,
        fastAvailable: false,
        contextVisible: false,
        contextPercent: 100,
        contextDefaultPercent: 100,
        contextTokens: 0,
        catalogLoaded: true,
        catalogRefreshing: false,
        catalogError: '',
        providerSetupError: '',
        modelDisabled: false,
        tuningDisabled: false,
        onSelectModel: noop,
        onChangeEffort: noop,
        onChangeSpeed: noop,
        onChangeContext: noop,
        ...props,
      })
    )
  );
  return host;
}

const row = (label) =>
  [...document.querySelectorAll('.route-sheet-row')].find((node) => node.textContent.startsWith(label));
const hover = (node) =>
  act(async () =>
    node.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
  );
const press = (key) =>
  act(async () => {
    (document.activeElement || document.body).dispatchEvent(
      new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    );
  });
const visibleFlyouts = () => [...document.querySelectorAll('.route-sheet-flyout:not([hidden])')];

test('a hover still pending when the sheet closes opens no pane after it', async (t) => {
  const host = await renderEditor(t);
  const trigger = host.querySelector('.model-trigger');
  for (const key of ['Escape', 'Tab']) {
    await act(async () => trigger.click());
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    await hover(row('Model'));
    await press(key);
    await wait(REST);
    assert.equal(document.querySelector('.route-sheet'), null, `${key} left the sheet up`);
    assert.deepEqual(
      visibleFlyouts().map((node) => node.className),
      [],
      `a pane opened after ${key} closed the sheet`
    );
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  }
});

test('a dialog field dropdown opens a row’s pane beside its sheet on hover', async (t) => {
  const host = await renderEditor(t, { dropdown: true, placement: 'below' });
  await act(async () => host.querySelector('.model-trigger').click());
  await hover(row('Reasoning effort'));
  await wait(REST);
  assert.equal(row('Reasoning effort').getAttribute('aria-expanded'), 'true');
  assert.equal(document.querySelector('.route-sheet[data-drilled]'), null, 'the pane took the rows’ place');
  assert.equal(visibleFlyouts().length, 1);
});

test('Escape closes the open pane and cancels the hover heading for another row', async (t) => {
  const host = await renderEditor(t);
  await act(async () => host.querySelector('.model-trigger').click());
  await hover(row('Model'));
  await wait(REST);
  assert.equal(row('Model').getAttribute('aria-expanded'), 'true');
  await hover(row('Reasoning effort'));
  await press('Escape');
  assert.equal(row('Model').getAttribute('aria-expanded'), 'false', 'Escape left the Model pane open');
  await wait(REST);
  assert.equal(row('Reasoning effort').getAttribute('aria-expanded'), 'false', 'the pending hover opened a pane');
  assert.deepEqual(visibleFlyouts(), []);
  assert.ok(document.querySelector('.route-sheet[data-state="open"]'), 'the sheet stays open');
});
