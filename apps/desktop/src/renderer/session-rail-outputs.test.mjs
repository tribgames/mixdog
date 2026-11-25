import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main id="root"></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window', 'MouseEvent'],
  actEnvironment: false,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
const commands = [];
window.mixdogDesktop = {
  visualizeCommand: async (command) => {
    commands.push(command);
    return {};
  },
};

const { OutputsSection } = await import('./session-rail-outputs.tsx');
const { applyVisualizeEvent, resetVisualizePanelMemory, setVisualizePanelOnScreen } = await import(
  './visualize-store.ts'
);

const MINUTE = 60_000;
const html = (label) => ({ kind: 'html', label, target: label, url: `http://127.0.0.1:1/${label}` });
const image = (label) => ({ kind: 'image', label, target: label, url: `x://${label}` });
const page = (id, label, minutesAgo) => ({
  id,
  label,
  revision: 0,
  panes: [html(`${id}.html`)],
  versions: [
    { n: 1, at: Date.now() - 2 * 60 * MINUTE },
    { n: 2, at: Date.now() - minutesAgo * MINUTE },
  ],
});
const picture = (id, label) => ({ id, label, revision: 0, panes: [image(`${id}.png`)] });

function put(sessionId, tabs, active, extra = {}) {
  applyVisualizeEvent({ sessionId, state: { sessionId, tabs, active, ...extra } });
}

async function mount(t, sessionId) {
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(OutputsSection, { sessionId, open: true, onToggle() {} })));
  t.after(async () => {
    await act(async () => root.unmount());
    resetVisualizePanelMemory();
  });
  return root;
}
const click = (element) => act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
const rowByName = (name) =>
  [...document.querySelectorAll('.session-outputs-row')].find(
    (node) => node.querySelector('.session-outputs-name')?.textContent === name
  );

test('the section is absent while the session shows no outputs', async (t) => {
  await mount(t, 'none');
  assert.equal(document.querySelector('.session-rail-sec'), null);
  assert.equal(document.getElementById('root').textContent, '');
});

test('each output is one row with its kind, name, version and time, newest first', async (t) => {
  put('rows', [page('t1', 'Agent list', 31), picture('t2', 'session-list.png')], 't1', {
    history: [
      { id: 'h2', label: 'session-list.png', kind: 'image', versions: 1, at: Date.now() - 3 * 60 * MINUTE, open: true },
    ],
  });
  await mount(t, 'rows');
  const section = document.querySelector('.session-rail-sec[data-category="outputs"]');
  assert.equal(section.getAttribute('aria-label'), 'Outputs');
  // How many, at the head's end; nothing between the title and the chevron.
  assert.equal(section.querySelector('.session-rail-ct').textContent, '2');
  assert.equal(section.querySelector('.session-rail-badge'), null);
  const rows = [...document.querySelectorAll('.session-outputs-row')].map((node) => ({
    kind: node.dataset.kind,
    icon: Boolean(node.querySelector('svg.session-rail-ic')),
    name: node.querySelector('.session-outputs-name').textContent,
    version: node.querySelector('.session-outputs-version')?.textContent ?? null,
    time: node.querySelector('time')?.textContent ?? null,
  }));
  assert.deepEqual(rows, [
    { kind: 'html', icon: true, name: 'Agent list', version: 'v2', time: '31m ago' },
    { kind: 'image', icon: true, name: 'session-list.png', version: null, time: '3h ago' },
  ]);
});

test('the output open in the side panel is the selected row', async (t) => {
  put('open', [page('t1', 'One', 5), page('t2', 'Two', 1)], 't1');
  await mount(t, 'open');
  assert.equal(document.querySelector('[data-selected]'), null, 'nothing is selected while the panel is off screen');
  await act(async () => setVisualizePanelOnScreen('open', true));
  const selected = [...document.querySelectorAll('[data-selected]')];
  assert.deepEqual(selected, [rowByName('One')]);
  assert.equal(rowByName('One').querySelector('.session-outputs-open').getAttribute('aria-current'), 'true');
  assert.equal(rowByName('Two').querySelector('.session-outputs-open').hasAttribute('aria-current'), false);
});

test('an update the user has not seen wears the dot until its row opens it', async (t) => {
  const tabs = (revision) => [page('t1', 'One', 5), { ...page('t2', 'Two', 1), revision }];
  put('dot', tabs(0), 't1');
  await act(async () => setVisualizePanelOnScreen('dot', true));
  await mount(t, 'dot');
  const dot = (name) => rowByName(name).querySelector('.session-outputs-dot');
  assert.equal(document.querySelector('.session-outputs-dot'), null);
  await act(async () =>
    applyVisualizeEvent({ sessionId: 'dot', state: { sessionId: 'dot', tabs: tabs(1), active: 't1' }, updated: 't2' })
  );
  assert.ok(dot('Two'), 'the updated output wears the dot');
  assert.equal(dot('One'), null);
  assert.ok(document.querySelector('.session-rail-ct .session-outputs-dot'), 'the head shows an unseen update');
  commands.length = 0;
  await click(rowByName('Two').querySelector('.session-outputs-open'));
  assert.equal(dot('Two'), null, 'opening it clears the dot');
  assert.equal(document.querySelector('.session-outputs-dot'), null);
  assert.ok(rowByName('Two').hasAttribute('data-selected'), 'and it is the open one now');
  assert.deepEqual(commands, [{ sessionId: 'dot', tabId: 't2', action: 'activate' }]);
});

test("a row's X closes that output's tab", async (t) => {
  put('close', [page('t1', 'One', 5), page('t2', 'Two', 1)], 't1');
  await mount(t, 'close');
  commands.length = 0;
  await click(rowByName('Two').querySelector('.session-outputs-close'));
  assert.deepEqual(commands, [{ sessionId: 'close', tabId: 't2', action: 'close' }]);
});
