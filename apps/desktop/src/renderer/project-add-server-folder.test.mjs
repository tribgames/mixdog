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

const settle = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 20)));
const button = (name) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === name);

async function addFlow(t, connection) {
  const chosen = [];
  const created = [];
  const listed = [];
  window.mixdogDesktop = {
    ...(connection ? { connection } : {}),
    listServerDirectories: async (path) => {
      listed.push(path);
      return path === ''
        ? { path: '/root', entries: [{ name: 'demo', git: true }], truncated: false }
        : { path, entries: [], truncated: false };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  });
  await act(async () =>
    root.render(
      React.createElement(ProjectListSection, {
        projects: [],
        selectedProjectPath: '',
        onChooseFolder: async () => {
          chosen.push(true);
          return '/c/native';
        },
        onCreateProject: async (path, name) => created.push([path, name]),
        onRename() {},
        onRemove() {},
      })
    )
  );
  await act(async () => document.querySelector('.projects-add').click());
  await settle();
  return { chosen, created, listed };
}

test('Add project in a server window picks the folder on the server, not with the native chooser', async (t) => {
  const { chosen, created, listed } = await addFlow(t, { id: 'vps', kind: 'ssh', name: 'My VPS' });
  await act(async () => button('Browse…').click());
  await settle();
  assert.deepEqual(chosen, [], 'the native chooser is never opened');
  assert.deepEqual(listed, ['']);
  assert.equal(document.querySelector('.conn-dialog header p').textContent, 'These folders are on My VPS.');
  const demo = [...document.querySelectorAll('.conn-list .conn-row')].find((row) => row.textContent.startsWith('demo'));
  await act(async () => demo.click());
  await settle();
  await act(async () => button('Choose').click());
  assert.equal(document.querySelector('.conn-dialog'), null, 'the server dialog closes once chosen');
  assert.equal(document.querySelector('.projects-folder-row code').textContent, '/root/demo');
  await act(async () => button('Add').click());
  await settle();
  assert.deepEqual(created, [['/root/demo', 'demo']]);
});

test('Add project in a local window keeps the native chooser', async (t) => {
  const { chosen, listed } = await addFlow(t, { id: 'local', kind: 'local', name: '' });
  await act(async () => button('Browse…').click());
  await settle();
  assert.deepEqual(chosen, [true]);
  assert.deepEqual(listed, []);
  assert.equal(document.querySelector('.conn-dialog'), null);
  assert.equal(document.querySelector('.projects-folder-row code').textContent, '/c/native');
});
