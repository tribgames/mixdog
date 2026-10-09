// Model-parameter panes share the option keyboard grammar of the effort and
// speed panes: arrows rove between options and ArrowLeft walks back out.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Node', 'HTMLElement', 'Event', 'KeyboardEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
after(restore);

const { createRoot } = await import('react-dom/client');
const { RouteEditor } = await import('./RouteEditor.tsx');

const noop = () => {};
const options = () => [...document.querySelectorAll('.route-sheet-option')];
const keydown = (target, key) =>
  act(async () => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

test('a model-parameter pane roves with the arrows and ArrowLeft closes it', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map((value) => String(value)).join(' '));
  t.after(async () => {
    console.error = originalError;
    await act(async () => root.unmount());
    host.remove();
  });

  await act(async () =>
    root.render(
      React.createElement(RouteEditor, {
        models: [],
        provider: 'openai',
        model: 'gpt-test',
        triggerModel: 'GPT Test',
        effort: '',
        effortOptions: [],
        fast: false,
        fastVisible: false,
        fastAvailable: false,
        contextVisible: false,
        contextPercent: 100,
        contextDefaultPercent: 100,
        contextTokens: 0,
        modelParameterOptions: [
          {
            id: 'verbosity',
            label: 'Verbosity',
            options: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' },
            ],
          },
        ],
        modelParameters: { verbosity: 'low' },
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
      })
    )
  );

  await act(async () => document.querySelector('.model-trigger').click());
  const parameterRow = [...document.querySelectorAll('.route-sheet-row')].find((row) =>
    row.textContent.includes('Verbosity')
  );
  assert.ok(parameterRow);
  await act(async () => parameterRow.click());

  const [low, high] = options();
  assert.ok(low && high);
  low.focus();
  await keydown(low, 'ArrowDown');
  // Compare labels, not elements: inspecting a jsdom node on failure never ends.
  assert.equal(document.activeElement?.textContent, high.textContent, 'ArrowDown moves to the next option');

  await keydown(high, 'ArrowLeft');
  assert.equal(options().length, 0, 'ArrowLeft closes the parameter pane');
  // Sheet rows (parameter rows included) carry stable keys.
  assert.deepEqual(
    errors.filter((message) => /unique "key" prop/.test(message)),
    []
  );
});
