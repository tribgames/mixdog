import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Event'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { CategoryPanel } = await import('./capability-panels.tsx');

async function render(category, extra = {}, data = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(CategoryPanel, {
        category,
        context: {
          api: {},
          data,
          snapshot: null,
          pending: '',
          run: async () => ({}),
          updaterState: { status: 'idle' },
          checkDesktopUpdate: () => {},
          installDesktopUpdate: () => {},
          ...extra,
        },
      })
    );
  });
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

const groupTitles = () => [...document.querySelectorAll('.settings-group > header h3')].map((n) => n.textContent);

test('shortcuts: grouped in order, every key its own kbd joined by "or"', async () => {
  const cleanup = await render('shortcuts');
  try {
    assert.deepEqual(groupTitles(), [
      'Tasks and tabs',
      'Find and move',
      'Layout',
      'Composer',
      'Conversation',
      'Editor',
    ]);
    const rendered = [...document.querySelectorAll('.settings-group')].map((group) => [
      group.querySelector('header h3').textContent,
      [...group.querySelectorAll('.settings-shortcut-row')].map((row) => [
        row.querySelector(':scope > span').textContent,
        [...row.querySelectorAll('kbd')].map((k) => k.textContent),
        row.querySelectorAll('.settings-shortcut-or').length,
      ]),
    ]);
    const expected = [
      [
        'Tasks and tabs',
        [
          ['New task', ['Ctrl+N']],
          ['New task without a project', ['Ctrl+Alt+N']],
          ['Close tab', ['Ctrl+W']],
          ['Next tab', ['Ctrl+Tab', 'Ctrl+Shift+]']],
          ['Previous tab', ['Ctrl+Shift+Tab', 'Ctrl+Shift+[']],
          ['Go to tab / last tab', ['Ctrl+1–8', 'Ctrl+9']],
          ['Go back / forward', ['Ctrl+[', 'Ctrl+]']],
        ],
      ],
      [
        'Find and move',
        [
          ['Quick Open', ['Ctrl+P']],
          ['Command Palette', ['Ctrl+Shift+P', 'Ctrl+K', 'Ctrl+/']],
          ['Search sessions (no tab open)', ['Ctrl+F']],
          ['Switch tab / pane', ['Ctrl+←', 'Ctrl+→']],
          ['Focus pane above / below', ['Ctrl+↑', 'Ctrl+↓']],
        ],
      ],
      [
        'Layout',
        [
          ['Toggle left side bar', ['Ctrl+Shift+B']],
          ['Toggle right utility panel', ['Ctrl+B']],
          ['Toggle terminal panel', ['Ctrl+`', 'Ctrl+T']],
          ['Open settings', ['Ctrl+,']],
          ['Close menus and popovers', ['Esc']],
        ],
      ],
      [
        'Composer',
        [
          ['Send message', ['Enter']],
          ['Insert new line', ['Shift+Enter', 'Ctrl+Enter', 'Ctrl+J']],
          ['Delete to line start', ['Ctrl+U']],
          ['Prompt history (empty draft)', ['↑', '↓']],
          ['Command palette', ['/']],
          ['File and context mentions', ['@']],
        ],
      ],
      [
        'Conversation',
        [
          ['Scroll conversation', ['PageUp', 'PageDown']],
          ['First / latest message', ['Home', 'End']],
          ['Expand or collapse all tool activity', ['Ctrl+O']],
        ],
      ],
      [
        'Editor',
        [
          ['Rename symbol', ['F2']],
          ['Quick Fix', ['Ctrl+.']],
          ['Format document', ['Shift+Alt+F']],
          ['Go to definition / references', ['F12', 'Shift+F12']],
        ],
      ],
    ];
    assert.deepEqual(
      rendered.map(([title, rows]) => [title, rows.map(([action, keys]) => [action, keys])]),
      expected
    );
    for (const [, rows] of rendered) {
      for (const [, keys, ors] of rows) assert.equal(ors, keys.length - 1);
    }
  } finally {
    await cleanup();
  }
});

test('system: one version row with state text; install row only while an update is staged', async () => {
  const data = { update: { currentVersion: '1.0.0', latestVersion: '', autoUpdate: true } };
  const cases = [
    [{ status: 'up-to-date' }, 'Up to date', false],
    [{ status: 'checking' }, 'Checking for update…', false],
    [{ status: 'error' }, 'Update unavailable', false],
    [{ status: 'ready', version: '1.1.0' }, 'Version 1.1.0 is available', true],
    [{ status: 'downloading', version: '1.1.0' }, 'Version 1.1.0 is available', true],
  ];
  for (const [updaterState, meta, install] of cases) {
    const cleanup = await render('system', { updaterState }, data);
    try {
      const text = document.body.textContent;
      assert.match(text, /Mixdog 1\.0\.0/);
      assert.ok(text.includes(meta), `${updaterState.status}: ${meta}`);
      assert.equal(text.includes('Install update'), install, updaterState.status);
      assert.equal(text.includes('Latest version'), false);
      assert.ok(groupTitles().includes('Diagnostics'));
      assert.ok(text.includes('Run diagnostics'));
    } finally {
      await cleanup();
    }
  }
});

test('system: an authoritative up-to-date state beats a differing cached latest version', async () => {
  const data = { update: { currentVersion: '1.0.0', latestVersion: '9.9.9', autoUpdate: true } };
  const cleanup = await render('system', { updaterState: { status: 'up-to-date' } }, data);
  try {
    const text = document.body.textContent;
    assert.ok(text.includes('Up to date'));
    assert.equal(text.includes('is available'), false);
  } finally {
    await cleanup();
  }
});

test('output style: group is titled and each style shows its description', async () => {
  const data = {
    outputStyles: { styles: [{ id: 'simple', label: 'Simple', description: 'Concise summary' }], configured: 'simple' },
  };
  const cleanup = await render('output-style', {}, data);
  try {
    assert.equal(groupTitles()[0], 'Response style');
    assert.equal(document.querySelector('.settings-resource-meta').textContent, 'Concise summary');
  } finally {
    await cleanup();
  }
});
