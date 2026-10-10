import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  expose: ['HTMLElement', 'Element', 'Node', 'navigator'],
});
test.after(restore);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);

const { createRoot } = await import('react-dom/client');
const { ProjectListSection } = await import('./ProjectListSection.tsx');
const { initUiLanguage, setUiLanguagePreference } = await import('./i18n.ts');

// Custom names that collide with app catalog keys ("History", "Settings",
// "Agent" all translate in the app's own UI) must render exactly as typed.
const projects = [
  { path: '/work/history', name: 'dir-a', alias: ' History ' },
  { path: '/work/settings', name: 'Settings', alias: '' },
  { path: '/work/agent', name: 'Agent', alias: '' },
];
const customLabels = ['History', 'Settings', 'Agent'];

async function onMemoryControl() {
  return {
    entries: [{ id: 1, summary: 'remember', project_id: null, index_revision: 'r1' }],
    projectScopes: projects.map((project) => ({ path: project.path, projectId: project.path })),
    nextOffset: null,
  };
}

test('custom project names stay literal in rows and the memory scope picker under a non-English UI', async (t) => {
  setUiLanguagePreference('ko');
  await initUiLanguage();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    setUiLanguagePreference('en');
    await initUiLanguage();
  });
  await act(async () =>
    root.render(
      React.createElement(ProjectListSection, {
        projects,
        selectedProjectPath: '',
        onChooseFolder: async () => '',
        onCreateProject() {},
        onRename() {},
        onRemove() {},
        onMemoryControl,
      })
    )
  );
  assert.deepEqual(
    [...host.querySelectorAll('.projects-list:not(.projects-common-instructions) b')].map((node) => node.textContent),
    customLabels
  );
  // App-authored copy still translates.
  assert.equal(host.querySelector('.projects-common-instructions b').textContent, '공통 지침');

  await act(async () => host.querySelector('.projects-common-instructions button').click());
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
  await act(async () => document.querySelector('button[aria-label="메모리 추가"]').click());
  const select = document.querySelector('select[aria-label="메모리 범위"]');
  assert.ok(select, 'memory scope picker renders');
  assert.deepEqual(
    [...select.options].map((option) => option.textContent),
    ['공통', ...projects.map((project) => project.alias || project.name)]
  );
});

test('project row context menu edits, and Remove opens the editor with confirmation armed', async (t) => {
  const removed = [];
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(ProjectListSection, {
        projects,
        selectedProjectPath: '',
        onChooseFolder: async () => '',
        onCreateProject() {},
        onRename() {},
        onRemove: (path) => removed.push(path),
      })
    )
  );
  const row = () => host.querySelector('.projects-list button.projects-row');
  const items = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
  const settle = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));

  await act(async () =>
    row().dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }))
  );
  assert.deepEqual(
    items().map((item) => item.textContent),
    ['Edit', 'Remove']
  );
  await act(async () => items()[0].click());
  await settle();
  assert.ok(document.querySelector('.projects-edit-dialog'), 'Edit opens the editor');
  assert.ok(![...document.querySelectorAll('button')].some((b) => b.textContent === 'Confirm remove'));
  await act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click());

  await act(async () =>
    row().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
  );
  await act(async () => items()[1].click());
  await settle();
  assert.deepEqual(removed, [], 'Remove never removes without the confirmation click');
  const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm remove');
  assert.ok(confirm, 'confirmation is armed');
  await act(async () => confirm.click());
  assert.deepEqual(removed, ['/work/history']);
});
