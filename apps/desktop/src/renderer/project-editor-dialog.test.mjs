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
const { ProjectEditorDialog } = await import('./ProjectEditorDialog.tsx');
const { ProjectListSection } = await import('./ProjectListSection.tsx');

const projects = [{ path: '/work/alpha', name: 'alpha', alias: '' }];

test('opening project settings by path shows the dialog while no Projects panel is active', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const ref = React.createRef();
  await act(async () =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        // The Projects panel exists but is inactive.
        React.createElement(ProjectListSection, {
          active: false,
          projects,
          selectedProjectPath: '',
          onChooseFolder: async () => '',
          onCreateProject() {},
          onRename() {},
          onRemove() {},
        }),
        React.createElement(ProjectEditorDialog, { ref, projects, onRename() {}, onRemove() {} })
      )
    )
  );
  assert.equal(document.querySelector('.projects-edit-dialog'), null);
  await act(async () => ref.current.open('/work/alpha'));
  assert.ok(document.querySelector('.projects-edit-dialog'), 'dialog shows for the opened project');
  assert.equal(document.querySelector('input[name="project-alias"]').value, 'alpha');
});

test('project settings switch a connector off for the project; every other one stays on', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const calls = [];
  let rows = [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: true },
  ];
  const connectorApi = {
    invokeCapability: async ({ capability, args }) => {
      calls.push([capability, ...args]);
      if (capability === 'setProjectConnectorEnabled') {
        rows = rows.map((row) => (row.id === args[1] ? { ...row, enabled: args[2] } : row));
      }
      return { value: rows };
    },
  };
  const ref = React.createRef();
  await act(async () =>
    root.render(React.createElement(ProjectEditorDialog, { ref, projects, connectorApi, onRename() {}, onRemove() {} }))
  );
  await act(async () => ref.current.open('/work/alpha'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const list = document.querySelector('[data-connector-switches="project"]');
  assert.ok(list);
  assert.deepEqual(calls[0], ['getProjectConnectors', '/work/alpha']);
  const inputs = () => [...list.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(
    inputs().map((input) => input.checked),
    [true, true]
  );
  await act(async () => inputs()[0].click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  assert.deepEqual(calls.at(-1), ['setProjectConnectorEnabled', '/work/alpha', 'github', false]);
  assert.deepEqual(
    inputs().map((input) => input.checked),
    [false, true]
  );
});
