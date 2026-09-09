import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { BrowserTabStrip } = await import('./BrowserTabStrip.tsx');

test('tab chrome selects and closes exact pages, creates a tab, and exposes restore without reopening the page', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  let expanded = false;
  let tabs = [
    { id: 'p1', title: 'Original', url: 'https://a.test', active: true, loading: false, kind: 'page' },
    { id: 'p2', title: 'Login', url: 'https://a.test/login', active: false, loading: false, kind: 'popup' },
  ];
  const render = () => root.render(React.createElement(BrowserTabStrip, {
    tabs, expanded,
    async onSelect(id) { calls.push(['select', id]); tabs = tabs.map(tab => ({ ...tab, active: tab.id === id })); render(); },
    async onClose(id) { calls.push(['close', id]); },
    async onCreate() { calls.push(['create']); },
    onToggleExpanded() { expanded = !expanded; render(); },
  }));
  try {
    await act(async () => render());
    await act(async () => host.querySelectorAll('[role="tab"]')[1].click());
    assert.equal(host.querySelectorAll('[role="tab"]')[1].getAttribute('aria-selected'), 'true');
    await act(async () => host.querySelector('[role="tablist"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
      key: 'Home', bubbles: true,
    })));
    assert.equal(host.querySelector('[role="tab"]').getAttribute('aria-selected'), 'true');
    await act(async () => host.querySelector('[aria-label="Close tab: Login"]').click());
    await act(async () => host.querySelector('[aria-label="New tab"]').click());
    await act(async () => host.querySelector('[aria-label="Expand browser"]').click());
    assert.ok(host.querySelector('[aria-label="Restore browser"]'));
    assert.deepEqual(calls, [['select', 'p2'], ['select', 'p1'], ['close', 'p2'], ['create']]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
