import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import i18n from './i18n';
import { buildAppWorkbenchCommands } from './app-workbench-commands';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { BROWSER_VIEWPORT_PRESETS } from './browser-viewport-mode';
import { buildSourceControlCommitMenu } from './source-control-history-menu';
import { viewSortMenuItems } from './source-control-changes-header';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'Element', 'Node'],
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { WorkbenchQuickAccess } = await import('./WorkbenchOverlays.tsx');

const ko = JSON.parse(readFileSync(new URL('./locales/ko.json', import.meta.url), 'utf8'));
i18n.addResourceBundle('ko', 'translation', ko);

const noop = () => {};
const menuFor = (entry) =>
  buildSourceControlCommitMenu({
    actions: Object.fromEntries(
      [
        'amend',
        'checkout',
        'cherryPick',
        'copySha',
        'copyTags',
        'createBranch',
        'createTag',
        'deleteTag',
        'openHostedCommit',
        'reset',
        'revert',
        'undo',
      ].map((name) => [name, noop])
    ),
    capabilities: Object.fromEntries(
      [
        'amend',
        'checkout',
        'cherryPick',
        'createBranch',
        'createTag',
        'deleteTag',
        'openExternal',
        'reset',
        'revert',
        'undo',
      ].map((name) => [name, true])
    ),
    commitUrl: '',
    conflictCount: 0,
    entry,
    entryIndex: 0,
    historyBusyReason: '',
    missingChannel: (action) => action,
    statusUnborn: false,
  });

async function searchPalette(commands, query) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(WorkbenchQuickAccess, {
        mode: 'commands',
        projectPath: '',
        recentFiles: [],
        commands,
        onOpenFile: noop,
        onClose: noop,
      })
    )
  );
  const input = document.querySelector('.workbench-quick-input input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, `>${query}`);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const rows = [...document.querySelectorAll('.workbench-quick-results [role="option"]')].map((row) => row.textContent);
  await act(async () => root.unmount());
  host.remove();
  return rows;
}

test('app-authored source-control, command and viewport copy localizes at its source', async () => {
  await i18n.changeLanguage('ko');
  try {
    const menu = menuFor({ hash: 'a', shortHash: 'a', subject: 'x', pushed: false, tags: ['Settings'] });
    assert.equal(menu.find((item) => item.id === 'copy-sha').label, i18n.t('Copy SHA'));
    assert.notEqual(menu.find((item) => item.id === 'copy-sha').label, 'Copy SHA');
    assert.equal(viewSortMenuItems('path', noop)[0].label, i18n.t('Sort by Path'));
    assert.notEqual(BROWSER_VIEWPORT_PRESETS[1].label, 'Fit to pane');
    const commands = buildAppWorkbenchCommands({
      quickAccessMode: 'commands',
      editorNavigationHistory: { current: { entries: [], index: -1 } },
      editorSaveHandles: { current: new Map() },
      dirtyFileKeys: new Set(),
      focusedLeafTabs: [],
      editorCommandCapabilities: {},
    });
    assert.notEqual(commands[0].label, 'Go Back');
    assert.equal(commands[0].label, i18n.t('Go Back'));
    for (const query of ['save all', i18n.t('Save All')]) {
      const rows = await searchPalette(commands, query);
      assert.ok(
        rows.some((row) => row.includes(i18n.t('Save All'))),
        query
      );
    }
    assert.deepEqual(await searchPalette(commands, 'zzzz-nothing'), []);
  } finally {
    await i18n.changeLanguage('en');
  }
});

test('custom names that equal catalog keys are never translated', async () => {
  await i18n.changeLanguage('ko');
  try {
    const menu = menuFor({ hash: 'a', shortHash: 'a', subject: 'x', pushed: false, tags: ['Settings', 'History'] });
    const labels = menu.filter((item) => item.id.startsWith('delete-tag:')).map((item) => item.label);
    assert.equal(labels.length, 2);
    assert.ok(labels[0].includes('Settings') && labels[1].includes('History'));
  } finally {
    await i18n.changeLanguage('en');
  }
});
