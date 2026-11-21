import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Node', 'HTMLElement', 'HTMLInputElement'],
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { useWorkspaceSearch } = await import('./use-workspace-search.ts');

async function mount(t, projectPath, desktop) {
  window.mixdogDesktop = desktop;
  const seen = { current: null };
  function Harness() {
    seen.current = useWorkspaceSearch(projectPath, true);
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  });
  await act(async () => root.render(React.createElement(Harness)));
  return seen;
}

const settleSearch = () => act(async () => new Promise((resolve) => setTimeout(resolve, 200)));

test('a Names query settles with the file-name matches of each project', async (t) => {
  const seen = await mount(t, '/p', { searchProjectFiles: async (project, query) => [`${project}/${query}.ts`] });
  await act(async () => seen.current.setQuery('  foo '));
  await settleSearch();
  assert.deepEqual(seen.current.settled, {
    projects: '/p',
    query: 'foo',
    mode: 'names',
    names: [{ project: '/p', paths: ['/p/foo.ts'] }],
    contents: [],
    error: '',
  });
  assert.equal(seen.current.pending, false);
});

test('a Contents query settles with the full-text results', async (t) => {
  const seen = await mount(t, '/p', {
    searchWorkspaceText: async (project, options) => ({
      files: [],
      matchCount: 3,
      limitHit: false,
      echo: options.query,
    }),
  });
  await act(async () => {
    seen.current.setSearchMode('contents');
    seen.current.setQuery('bar');
  });
  await settleSearch();
  const { settled } = seen.current;
  assert.equal(settled.mode, 'contents');
  assert.equal(settled.error, '');
  assert.deepEqual(settled.names, []);
  assert.equal(settled.contents[0].matchCount, 3);
  assert.equal(settled.contents[0].echo, 'bar');
});

test('a Contents query where every project fails settles with the error message', async (t) => {
  const seen = await mount(t, '/p', {
    searchWorkspaceText: async () => {
      throw new Error('index offline');
    },
  });
  await act(async () => {
    seen.current.setSearchMode('contents');
    seen.current.setQuery('bar');
  });
  await settleSearch();
  assert.equal(seen.current.settled.error, 'index offline');
  assert.deepEqual(seen.current.settled.contents, []);
});

test('a query with no project settles at once with nothing found', async (t) => {
  const seen = await mount(t, '', {});
  await act(async () => seen.current.setQuery('foo'));
  assert.deepEqual(seen.current.settled, {
    projects: '',
    query: 'foo',
    mode: 'names',
    names: [],
    contents: [],
    error: '',
  });
});

test('a search superseded by a newer query never settles', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const seen = await mount(t, '/p', {
    searchProjectFiles: async (_project, query) => {
      if (query === 'old') await gate;
      return [query];
    },
  });
  await act(async () => seen.current.setQuery('old'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
  await act(async () => seen.current.setQuery('new'));
  await settleSearch();
  await act(async () => release());
  await settleSearch();
  assert.equal(seen.current.settled.query, 'new');
  assert.deepEqual(seen.current.settled.names, [{ project: '/p', paths: ['new'] }]);
});
