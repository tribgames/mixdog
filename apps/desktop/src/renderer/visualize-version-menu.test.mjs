import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DockHeaderRow } from './pane-dock-chrome.tsx';
import { visualizeVersionActions } from './VisualizePanelExtras.tsx';

const versions = [
  { n: 1, at: 1000 },
  { n: 2, at: 2000 },
  { n: 3, at: 3000 },
];
const baseTab = { id: 't1', label: 'a.html', revision: 0, panes: [{ target: 'a.html', version: undefined }], versions };

async function mount(tab, { confirm = () => true, setNotice = () => {} } = {}) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window'],
  });
  const sent = [];
  window.confirm = confirm;
  window.mixdogDesktop = { visualizeCommand: async (command) => (sent.push(command), {}) };
  const action = visualizeVersionActions('s1', tab, setNotice);
  const root = createRoot(document.getElementById('root'));
  await act(async () =>
    root.render(React.createElement(DockHeaderRow, { left: 'x', actions: action ? [action] : [] }))
  );
  return { sent, action, root, restore };
}
const button = () => document.querySelector('button[aria-label="Versions"]');
const items = () => [...document.querySelectorAll('.dock-header-menu button')];

async function close({ root, restore }) {
  await act(async () => root.unmount());
  restore();
}

test('no version button with fewer than two versions', async () => {
  const m = await mount({ ...baseTab, versions: [{ n: 1, at: 1 }] });
  try {
    assert.equal(m.action, null);
    assert.equal(button(), null);
  } finally {
    await close(m);
  }
});

test('the menu lists versions newest first, with Compare and no Restore while live', async () => {
  const m = await mount({ ...baseTab, version: null });
  try {
    assert.ok(button());
    assert.equal(button().dataset.attention, undefined);
    await act(async () => button().click());
    const list = items();
    assert.deepEqual(
      list.map((item) => item.querySelector('span:nth-child(2)').textContent),
      ['v3 · current', 'v2', 'v1', 'Compare']
    );
    assert.equal(list[0].getAttribute('aria-checked'), 'true');
    assert.equal(list[1].getAttribute('aria-checked'), 'false');
    await act(async () => list[2].click());
    assert.deepEqual(
      m.sent.map((c) => [c.action, c.version]),
      [['version', 1]]
    );
  } finally {
    await close(m);
  }
});

test('a past version: attention icon, read-only tooltip, Back to current first, restore confirms', async () => {
  const asked = [];
  const m = await mount(
    { ...baseTab, version: 2, panes: [{ target: 'a.html', version: 2 }] },
    {
      confirm: (message) => (asked.push(message), true),
    }
  );
  try {
    assert.equal(button().dataset.attention, 'true');
    assert.equal(button().dataset.tooltip, 'Viewing v2 · read-only');
    await act(async () => button().click());
    const list = items();
    assert.equal(list[0].textContent, 'Back to current version');
    assert.equal(list.at(-1).textContent, 'Restore');
    assert.equal(list.find((item) => item.textContent.startsWith('v2')).getAttribute('aria-checked'), 'true');
    await act(async () => list.at(-1).click());
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Restore v2\?/);
    assert.equal(m.sent.at(-1).action, 'restore');
  } finally {
    await close(m);
  }
});

test('declining the restore confirm sends nothing; Back to current shows live', async () => {
  const m = await mount(
    { ...baseTab, version: 1, panes: [{ target: 'a.html', version: 1 }] },
    { confirm: () => false }
  );
  try {
    await act(async () => button().click());
    await act(async () => items().at(-1).click());
    assert.deepEqual(m.sent, []);
    await act(async () => button().click());
    await act(async () => items()[0].click());
    assert.deepEqual(
      m.sent.map((c) => [c.action, c.version]),
      [['version', null]]
    );
  } finally {
    await close(m);
  }
});

test('the old full-width VersionBar row is gone', () => {
  const pane = readFileSync(new URL('./VisualizePane.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./visualize.css', import.meta.url), 'utf8');
  assert.doesNotMatch(pane, /VersionBar|visualize-versionbar|visualize-snapshot-strip/);
  assert.doesNotMatch(css, /visualize-versionbar|visualize-snapshot-strip|visualize-version-count/);
});
