import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { DockHeaderRow } from './pane-dock-chrome.tsx';
import { visualizeTurnWorkAction, visualizeVersionActions } from './VisualizePanelExtras.tsx';
const { overrideConfirmAction } = await import('./app-confirm.tsx');

const versions = [
  { n: 1, at: 1000 },
  { n: 2, at: 2000 },
  { n: 3, at: 3000 },
];
const baseTab = { id: 't1', label: 'a.html', revision: 0, panes: [{ target: 'a.html', version: undefined }], versions };

async function mount(tab, { confirm = () => true, setNotice = () => {}, answer = () => ({}) } = {}) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window'],
  });
  const sent = [];
  overrideConfirmAction(confirm);
  window.mixdogDesktop = {
    visualizeCommand: async (command) => {
      sent.push(command);
      return answer(command);
    },
  };
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

test('a version step, Back to current and Compare the host refuses each show its reason as the panel’s notice', async () => {
  const notices = [];
  const refusal = 'The running turn has changed or closed tab t1; the panel shows it as it was before. Try again when the turn ends.';
  const m = await mount(
    { ...baseTab, version: 2, panes: [{ target: 'a.html', version: 2 }] },
    {
      setNotice: (notice) => notices.push(notice),
      answer: () => {
        throw new Error(`Error invoking remote method 'visualize-command': Error: ${refusal}`);
      },
    }
  );
  try {
    for (const label of ['v1', 'Back to current version', 'Compare']) {
      await act(async () => button().click());
      const control = items().find((item) => item.textContent.startsWith(label));
      await act(async () => control.click());
      assert.equal(m.sent.at(-1).action, 'version', label);
      assert.deepEqual(notices.at(-1), { error: true, text: refusal }, label);
    }
    assert.equal(notices.length, 3, 'one notice per refused control');
  } finally {
    await close(m);
  }
});

test('a tab of the running turn the user asked to see carries a mark in the panel’s header; any other tab none', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'window'],
  });
  const root = createRoot(document.getElementById('root'));
  try {
    const notices = [];
    assert.equal(visualizeTurnWorkAction(baseTab, () => {}), null);
    const action = visualizeTurnWorkAction({ ...baseTab, turnWork: true }, (notice) => notices.push(notice));
    await act(async () => root.render(React.createElement(DockHeaderRow, { left: 'x', actions: [action] })));
    const mark = document.querySelector('button[aria-label="In progress"]');
    assert.equal(mark?.dataset.attention, 'true');
    await act(async () => mark.click());
    assert.deepEqual(notices, [{ error: false, text: 'In progress' }]);
  } finally {
    await close({ root, restore });
  }
});

test('a past version: attention icon, read-only tooltip, Back to current first, restore confirms', async () => {
  const asked = [];
  const m = await mount(
    { ...baseTab, version: 2, panes: [{ target: 'a.html', version: 2 }] },
    {
      confirm: (message) => {
        asked.push(message);
        return true;
      },
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
