// Discard from the changed-file list: a confirmed discard removes each row's
// whole change, and a selection never hands it a row the action refuses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
    return next(specifier, context);
  },
});

const projectPath = 'C:/project';
const row = (path, index, worktree, extra = {}) => ({
  path,
  index,
  worktree,
  untracked: false,
  conflicted: false,
  stagedAdditions: 0,
  stagedDeletions: 0,
  unstagedAdditions: 0,
  unstagedDeletions: 0,
  additions: 0,
  deletions: 0,
  ...extra,
});

async function mount(t, files, gitRevert) {
  const status = {
    repository: true,
    branch: 'main',
    detached: false,
    unborn: false,
    upstream: false,
    upstreamName: '',
    remote: false,
    ahead: 0,
    behind: 0,
    operation: '',
    files,
  };
  const { restore } = installTestDom(null, {
    html: '<!doctype html><body><main></main></body>',
    jsdom: { pretendToBeVisual: true },
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.attachEvent = () => {};
  window.HTMLElement.prototype.detachEvent = () => {};
  window.mixdogDesktop = { rendererDiagnostic() {}, gitStatus: async () => status, gitRevert };
  const { SourceControlDock } = await import('./SourceControlDock.tsx');
  const { overrideConfirmAction } = await import('./app-confirm.tsx');
  const prompts = [];
  overrideConfirmAction((message) => {
    prompts.push(message);
    return true;
  });
  const host = document.querySelector('main');
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    overrideConfirmAction(null);
    restore();
  });
  await act(async () =>
    root.render(
      React.createElement(SourceControlDock, {
        projectPath,
        status,
        statusReady: true,
        statusError: '',
        active: true,
        readinessKey: 'discard',
        onReadyChange() {},
        onRefreshStatus() {},
      })
    )
  );
  const click = (label, init = {}) =>
    act(async () => {
      const element = host.querySelector(`[aria-label="${label}"]`);
      assert.ok(element, `${label} is rendered`);
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    });
  return { prompts, click };
}

test('Discard All removes staged changes too, and a staged rename gets its source back', async (t) => {
  const calls = [];
  const view = await mount(
    t,
    [row('staged.txt', 'M', ' '), row('new.txt', 'R', ' ', { oldPath: 'old.txt' }), row('partly.txt', 'M', 'M')],
    async (...args) => {
      calls.push(args);
    }
  );
  await view.click('Discard All');
  assert.equal(view.prompts.length, 1);
  assert.deepEqual(calls, [
    [projectPath, 'staged.txt', false, 'all'],
    [projectPath, 'old.txt', false, 'all'],
    [projectPath, 'new.txt', false, 'all'],
    [projectPath, 'partly.txt', false, 'all'],
  ]);
});

test('discarding a selection that holds a conflicted row leaves that row out', async (t) => {
  const calls = [];
  const view = await mount(
    t,
    [row('a.txt', ' ', 'M'), row('b.txt', 'U', 'U', { conflicted: true }), row('c.txt', ' ', 'M')],
    async (_project, path) => {
      calls.push(path);
      if (path === 'b.txt') throw new Error(`error: path '${path}' is unmerged`);
    }
  );
  await view.click('Open changes a.txt');
  await view.click('Open changes b.txt', { ctrlKey: true });
  await view.click('Open changes c.txt', { ctrlKey: true });
  await view.click('Discard changes c.txt');
  assert.deepEqual(view.prompts, ['Discard 2 selected changes, staged and unstaged? This cannot be undone.']);
  assert.deepEqual(calls, ['a.txt', 'c.txt']);
});
