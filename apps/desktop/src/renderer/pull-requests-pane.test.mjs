// Behavior of PullRequestsPane: retained-surface list reads, epoch-guarded
// list responses, project reset, row actions and the push-before-create flow.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

const { window, restore } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  expose: ['Node', 'HTMLElement'],
});
after(restore);

const { createRoot } = await import('react-dom/client');
const { PullRequestsPane } = await import('./PullRequestsPane.tsx');
const { SurfaceActiveContext } = await import('./surface-activity.ts');

const pr = (number, extra = {}) => ({
  number,
  title: `Title ${number}`,
  author: 'octo',
  headRefName: `branch-${number}`,
  baseRefName: 'main',
  isDraft: false,
  state: 'OPEN',
  url: `https://github.test/pull/${number}`,
  updatedAt: '2020-01-01T00:00:00Z',
  reviewDecision: '',
  checks: { total: 0, passing: 0, failing: 0, pending: 0 },
  ...extra,
});
const all = (...prs) => [{ key: 'all', label: 'All', prs }];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function mount(t, apiOverrides = {}) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const api = {
    ghPrList: async () => all(),
    gitBranches: async () => [],
    ghPrDefaultBranch: async () => 'main',
    ghPrCheckout: async () => undefined,
    ghPrCreate: async () => pr(99),
    gitPush: async () => undefined,
    openExternal: () => undefined,
    ...apiOverrides,
  };
  window.mixdogDesktop = api;
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  });
  const baseProps = {
    projectPath: '/a',
    prUrl: 'https://github.test/compare/x',
    repositoryUrl: '',
    currentBranch: 'feature/x',
    createHint: '',
  };
  const render = (props = {}, active = true) =>
    act(async () =>
      root.render(
        React.createElement(
          SurfaceActiveContext.Provider,
          { value: active },
          React.createElement(PullRequestsPane, { ...baseProps, ...props })
        )
      )
    );
  return { host, api, render };
}

const click = (element) =>
  act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
const titles = (host) => [...host.querySelectorAll('.dock-pr-row-label b')].map((node) => node.textContent);
const byLabel = (host, label) => host.querySelector(`[aria-label="${label}"]`);
const typeInto = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('an inactive surface issues no list reads and loads on activation', async (t) => {
  let lists = 0;
  let branches = 0;
  const view = mount(t, {
    ghPrList: async () => {
      lists += 1;
      return all(pr(1));
    },
    gitBranches: async () => {
      branches += 1;
      return [];
    },
  });
  await view.render({}, false);
  assert.equal(lists, 0);
  assert.equal(branches, 0);
  await view.render({}, true);
  assert.equal(lists, 1);
  assert.deepEqual(titles(view.host), ['Title 1']);
  await view.render({}, false);
  assert.deepEqual(titles(view.host), ['Title 1'], 'loaded rows stay while retained');
  assert.equal(lists, 1);
});

test('stale list responses are rejected by the list epoch', async (t) => {
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const view = mount(t, { ghPrList: () => pending.shift().promise });
  await view.render({ projectPath: '/a' });
  await view.render({ projectPath: '/b' });
  await act(async () => second.resolve(all(pr(2))));
  assert.deepEqual(titles(view.host), ['Title 2']);
  await act(async () => first.resolve(all(pr(1))));
  assert.deepEqual(titles(view.host), ['Title 2'], 'late answer for the old load is ignored');
});

test('deactivating orphans an in-flight list', async (t) => {
  const first = deferred();
  const view = mount(t, { ghPrList: () => first.promise });
  await view.render({}, true);
  await view.render({}, false);
  await act(async () => first.resolve(all(pr(1))));
  assert.deepEqual(titles(view.host), []);
});

test('a project change resets list, filter and errors', async (t) => {
  const second = deferred();
  const results = [Promise.resolve(all(pr(1), pr(2))), second.promise];
  const view = mount(t, { ghPrList: () => results.shift() });
  await view.render({ projectPath: '/a' });
  assert.deepEqual(titles(view.host), ['Title 1', 'Title 2']);
  await typeInto(byLabel(view.host, 'Filter pull requests'), 'Title 2');
  assert.deepEqual(titles(view.host), ['Title 2']);
  await view.render({ projectPath: '/b' });
  assert.deepEqual(titles(view.host), []);
  assert.match(view.host.textContent, /Loading pull requests/);
  assert.equal(byLabel(view.host, 'Filter pull requests').value, '');
  await act(async () => second.resolve(all(pr(3))));
  assert.deepEqual(titles(view.host), ['Title 3']);
});

test('checkout runs the host checkout then reloads; checked-out rows hide it', async (t) => {
  const calls = [];
  let lists = 0;
  const view = mount(t, {
    ghPrList: async () => {
      lists += 1;
      return all(pr(1), pr(2, { headRefName: 'feature/x' }));
    },
    ghPrCheckout: async (project, number) => {
      calls.push([project, number]);
    },
  });
  await view.render();
  assert.equal(byLabel(view.host, 'Checkout pull request 2'), null);
  assert.equal(view.host.querySelectorAll('.dock-pr-row-active').length, 1);
  await click(byLabel(view.host, 'Checkout pull request 1'));
  assert.deepEqual(calls, [['/a', 1]]);
  assert.equal(lists, 2);
});

test('opening a row uses the open handler, or the external URL without one', async (t) => {
  const opened = [];
  const external = [];
  const view = mount(t, {
    ghPrList: async () => all(pr(1)),
    openExternal: (url) => external.push(url),
  });
  await view.render({ onOpenPullRequest: (...args) => opened.push(args) });
  await click(view.host.querySelector('.dock-pr-row-main'));
  await click(byLabel(view.host, 'Open changes for pull request 1'));
  assert.deepEqual(
    opened.map(([project, entry, mode, side]) => [project, entry.number, mode, side]),
    [
      ['/a', 1, 'overview', false],
      ['/a', 1, 'changes', false],
    ]
  );
  await view.render({ onOpenPullRequest: undefined });
  await click(view.host.querySelector('.dock-pr-row-main'));
  assert.deepEqual(external, ['https://github.test/pull/1']);
});

async function openCreateForm(view) {
  await click(byLabel(view.host, 'Create pull request'));
  const form = view.host.querySelector('form.dock-pr-create');
  assert.ok(form, 'create form opens');
  return form;
}
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });

test('create pushes an unpublished branch first, then creates and opens the pull request', async (t) => {
  const order = [];
  const opened = [];
  const view = mount(t, {
    gitPush: async (project) => order.push(['push', project]),
    ghPrCreate: async (project, input) => {
      order.push(['create', project, input]);
      return pr(99);
    },
  });
  await view.render({ prUrl: '', onOpenPullRequest: (...args) => opened.push(args) });
  const form = await openCreateForm(view);
  await submit(form);
  assert.deepEqual(order, [
    ['push', '/a'],
    ['create', '/a', { base: 'main', head: 'feature/x', title: 'X', body: '', draft: false }],
  ]);
  assert.equal(view.host.querySelector('form.dock-pr-create'), null);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][1].number, 99);
});

test('create stops with an error when the push fails', async (t) => {
  let created = 0;
  const opened = [];
  const view = mount(t, {
    gitPush: async () => {
      throw new Error('push rejected');
    },
    ghPrCreate: async () => {
      created += 1;
      return pr(99);
    },
  });
  await view.render({ prUrl: '', onOpenPullRequest: (...args) => opened.push(args) });
  const form = await openCreateForm(view);
  await submit(form);
  assert.equal(created, 0);
  assert.equal(opened.length, 0);
  assert.ok(view.host.querySelector('form.dock-pr-create'), 'form stays open');
  assert.match(view.host.querySelector('.dock-pr-create-error').textContent, /push rejected/);
});
