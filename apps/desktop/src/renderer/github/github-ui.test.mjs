import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
    return next(specifier, context);
  },
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
const { GithubPanel } = await import('./GithubPanel.tsx');
const { GithubActionForm } = await import('./GithubActionForm.tsx');
const { GithubReviewForm } = await import('./GithubReviewForm.tsx');
const { SurfaceActiveContext } = await import('../surface-activity.ts');
const { settingsCategoriesForSurface } = await import('../settings/settings-items.ts');
const { extensionSectionForSettings } = await import('../extension-sections.ts');
const { SourceControlDock } = await import('../SourceControlDock.tsx');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function mount(element) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, root, cleanup: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const click = async (host, text) => {
  const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent === text);
  assert.ok(button, `button ${text}`);
  await act(async () => button.click());
};
const props = { projectPath: 'C:\\Project\\demo', repositoryUrl: 'https://github.com/owner/demo', section: 'issues' };

test('Git settings leave the settings sidebar and legacy extension routes remain usable', () => {
  for (const remote of [false, true]) assert.equal(settingsCategoriesForSurface(remote).some((item) => item.value === 'git'), false);
  assert.equal(extensionSectionForSettings('git'), 'plugins');
});

test('the GitHub dock offers repository creation before local Git status is ready or initialized', () => {
  window.mixdogDesktop = {};
  for (const status of [null, { repository: false, files: [] }]) {
    const markup = renderToStaticMarkup(React.createElement(SourceControlDock, {
      projectPath: props.projectPath, status, statusReady: Boolean(status), statusError: '',
      loading: false, active: true, readinessKey: 'github', surface: 'prs', onRefreshStatus() {},
    }));
    assert.match(markup, /GitHub view/);
    assert.match(markup, /Create repository/);
    assert.match(markup, /Clone repository/);
    assert.doesNotMatch(markup, /selected project is not a Git repository/);
  }
});

test('each GitHub section displays data and provides bounded next-page navigation', async () => {
  for (const [section, action, item] of [
    ['repositories', 'repo.list', { id: 1, full_name: 'owner/demo' }],
    ['issues', 'issue.list', { id: 1, number: 1, title: 'An issue' }],
    ['actions', 'run.list', { id: 1, display_title: 'Build' }],
    ['workflows', 'workflow.list', { id: 1, name: 'Build workflow' }],
    ['releases', 'release.list', { id: 1, name: 'Version 1' }],
    ['notifications', 'notification.list', { id: '1', subject: { title: 'Review needed' } }],
  ]) {
    const calls = [];
    window.mixdogDesktop = { githubRequest: async (_cwd, input) => {
      calls.push(input);
      return { action, repo: 'owner/demo', data: [item], hasMore: input.page === 1 };
    } };
    const rendered = await mount(React.createElement(GithubPanel, { ...props, section }));
    try {
      assert.equal(rendered.host.querySelectorAll('.github-item').length, 1);
      assert.equal(calls[0].action, action);
      await click(rendered.host, 'Next');
      assert.equal(calls.at(-1).page, 2);
      assert.equal(calls.at(-1).limit, 30);
    } finally { await rendered.cleanup(); }
  }
});

test('inactive surfaces do not fetch and late results cannot repaint an inactive surface', async () => {
  const pending = deferred();
  let calls = 0;
  window.mixdogDesktop = { githubRequest: () => { calls++; return pending.promise; } };
  const element = (active) => React.createElement(SurfaceActiveContext.Provider, { value: active },
    React.createElement(GithubPanel, props));
  const rendered = await mount(element(false));
  try {
    assert.equal(calls, 0);
    await act(async () => rendered.root.render(element(true)));
    assert.equal(calls, 1);
    await act(async () => rendered.root.render(element(false)));
    await act(async () => pending.resolve({ data: [{ id: 1, title: 'Stale issue' }] }));
    assert.equal(rendered.host.textContent.includes('Stale issue'), false);
  } finally { await rendered.cleanup(); }
});

test('write forms require confirmation and block a second submit while the first is pending', async () => {
  const pending = deferred();
  const writes = [];
  let closed = 0;
  window.confirm = () => false;
  const rendered = await mount(React.createElement(GithubActionForm, {
    request: { action: 'issue.create', repo: 'owner/demo', title: '한글 제목', body: '내용' },
    onSubmit: (input) => { writes.push(input); return pending.promise; }, onClose: () => { closed++; },
  }));
  try {
    const submit = () => rendered.host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await act(async () => submit());
    assert.equal(writes.length, 0);
    window.confirm = () => true;
    await act(async () => { submit(); submit(); });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].title, '한글 제목');
    assert.equal(writes[0].repo, 'owner/demo');
    await act(async () => pending.resolve());
    assert.equal(closed, 1);
  } finally { await rendered.cleanup(); }
});

test('PR approval submits the displayed repository and commit, then refreshes once', async () => {
  const requests = [];
  let refreshed = 0;
  const sha = 'b'.repeat(40);
  window.confirm = () => true;
  window.mixdogDesktop = { githubRequest: async (_cwd, input) => {
    requests.push(input);
    return { repo: 'owner/demo', data: { head: { sha } } };
  } };
  const rendered = await mount(React.createElement(GithubReviewForm, {
    projectPath: props.projectPath, number: 12, active: true, onSubmitted: () => { refreshed++; },
  }));
  try {
    const select = rendered.host.querySelector('select');
    await act(async () => {
      select.value = 'APPROVE';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => rendered.host.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(requests.at(-1).action, 'pr.review');
    assert.equal(requests.at(-1).event, 'APPROVE');
    assert.equal(requests.at(-1).sha, sha);
    assert.equal(requests.at(-1).repo, 'owner/demo');
    assert.equal(refreshed, 1);
  } finally { await rendered.cleanup(); }
});
