import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { ContextBody } from './ContextBody.tsx';
import { toolResultLine } from './ContextInspector.tsx';
import { t } from './i18n.ts';
import { requiredDesktopCapabilityRequest } from '../main/ipc-validation.ts';

test('a turn traces which tools it called without growing with the call count', () => {
  // Sizes live on the tool rows; this line only names the tools, most-used
  // first, so the row cannot grow with how many times the turn called them.
  assert.equal(
    toolResultLine({
      toolResults: [
        { name: 'edit', tokens: 70 }, { name: 'read', tokens: 621 }, { name: 'edit', tokens: 71 },
        { name: 'task', tokens: 42 }, { name: 'edit', tokens: 73 }, { name: 'grep', tokens: 213 },
        { name: 'shell', tokens: 19 },
      ],
    }),
    'edit ×3 · grep · read · +2'
  );
  assert.equal(toolResultLine({ toolResults: [{ name: 'read', tokens: 12 }] }), 'read');
  assert.equal(toolResultLine({}), '');
});

test('inspection capability validates opt-in and preview revision without changing ordinary reads', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'contextStatus' }).args, []);
  assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability: 'contextStatus', args: [{ inspect: true }] }));
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'contextStatus', args: [{ inspect: true, entryId: 'message:0' }] }));
  assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'contextStatus', args: [{ inspect: true, persist: true }] }));
});

test('desktop reveals content only on selection and drops preview state on a new revision', async (context) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(() => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    dom.window.close();
  });
  const requests = [];
  const inspection = {
    revision: 'first', estimatedTokens: 20,
    categories: [{ key: 'system', label: 'System prompt', tokens: 20, count: 1 }],
    entries: [{ id: 'message:0', category: 'system', label: 'Rules', tokens: 20, kind: 'instruction' }],
  };
  const status = { sessionId: 'test', contextWindow: 100, rawContextWindow: 120,
    measurement: { source: 'last_api_request', tokens: 30 }, inspection };
  let deferred = false;
  let release;
  const request = async (capability, args) => {
    requests.push({ capability, args });
    if (deferred) return new Promise((resolve) => { release = resolve; });
    return { inspection: { preview: { id: 'message:0', text: 'PRIVATE_PREVIEW <script>not executable</script>' } } };
  };
  const render = () => act(() => root.render(React.createElement(ContextBody, { status, snapshot: {}, request })));
  await render();
  assert.equal(document.querySelectorAll('.context-block-map i').length, 128);
  assert.equal(requests.length, 0);
  assert.doesNotMatch(document.body.textContent, /PRIVATE_PREVIEW/);
  await act(async () => { document.querySelector('button[data-context-key="system"]').click(); });
  assert.equal(requests.length, 0);
  await act(async () => { document.querySelector('.context-entry-list button').click(); });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].args, [{ inspect: true, entryId: 'message:0', revision: 'first' }]);
  assert.match(document.querySelector('pre').textContent, /PRIVATE_PREVIEW/);
  assert.equal(document.querySelector('script'), null);
  // The preview replaces the list in the same pane; the back control returns to it.
  assert.equal(document.querySelector('.context-entry-list'), null);
  await act(async () => { document.querySelector('.context-entry-preview .context-detail-icon').click(); });
  assert.equal(document.querySelector('pre'), null);
  assert.ok(document.querySelector('.context-entry-list'));
  await act(async () => { document.querySelector('.context-entry-list button').click(); });
  assert.match(document.querySelector('pre').textContent, /PRIVATE_PREVIEW/);
  status.inspection = { ...inspection, revision: 'second' };
  await render();
  assert.equal(document.querySelector('pre'), null);
  assert.doesNotMatch(document.body.textContent, /PRIVATE_PREVIEW/);
  deferred = true;
  await act(async () => { document.querySelector('button[data-context-key="system"]').click(); });
  await act(async () => { document.querySelector('.context-entry-list button').click(); });
  status.inspection = { ...inspection, revision: 'third' };
  await render();
  await act(async () => { release({ inspection: { preview: { text: 'LATE_PRIVATE_PREVIEW' } } }); });
  assert.equal(document.querySelector('pre'), null);
  assert.doesNotMatch(document.body.textContent, /LATE_PRIVATE_PREVIEW/);
});

test('category rows rank by size, mark empty rows, and close the entry list', async (context) => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(() => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    dom.window.close();
  });
  const inspection = {
    revision: 'r', estimatedTokens: 60,
    categories: [
      { key: 'system', label: 'System prompt', tokens: 10, count: 1 },
      { key: 'tools', label: 'System tools', tokens: 0, count: 0 },
      { key: 'messages', label: 'Messages', tokens: 50, count: 4 },
    ],
    entries: [
      { id: 'message:0', category: 'messages', group: 'user', label: 'user · 1', tokens: 30, estimatedTokens: 40, kind: 'message', role: 'user', ordinal: 1 },
      { id: 'message:1', category: 'messages', group: 'assistant', label: 'assistant · 1', tokens: 20, estimatedTokens: 26, kind: 'message', role: 'assistant', ordinal: 1,
        toolResults: [{ name: 'read', tokens: 12 }] },
    ],
    calibration: { source: 'provider', measuredTokens: 60, ratio: 0.75, coveredMessages: 2, estimatedTokens: 80 },
  };
  const status = { sessionId: 'test', contextWindow: 100, rawContextWindow: 120,
    measurement: { source: 'last_api_request', tokens: 60 }, inspection };
  await act(() => root.render(React.createElement(ContextBody, { status, snapshot: {}, request: async () => ({}) })));
  const keys = [...document.querySelectorAll('.context-inspector button.context-mix-row')].map((row) => row.dataset.contextKey);
  assert.deepEqual(keys, ['messages', 'system', 'tools']);
  assert.equal(document.querySelector('button[data-context-key="tools"]').dataset.empty, 'true');
  assert.equal(document.querySelector('button[data-context-key="messages"]').dataset.empty, undefined);
  assert.equal(document.querySelector('button[data-context-key="messages"] em').textContent, '50%');
  assert.ok(document.querySelector('.context-mix-remainder [data-context-key="free"]'));
  assert.equal(document.querySelector('.context-entry-section'), null);
  // The detail pane starts as a placeholder, then shows the chosen category
  // with rows in the UI language, and its × returns to the placeholder.
  assert.ok(document.querySelector('.context-inspector-detail .context-detail-empty'));
  await act(async () => { document.querySelector('button[data-context-key="messages"]').click(); });
  assert.ok(document.querySelector('.context-inspector-detail .context-entry-section'));
  assert.equal(document.querySelector('.context-detail-empty'), null);
  assert.equal(document.querySelector('button[data-context-key="messages"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('.context-detail-bar h3').textContent, t('Messages'));
  // Two role groups, both open under the threshold; the assistant turn names
  // the tool result it carries.
  const heads = [...document.querySelectorAll('.context-entry-group-head > span')].map((node) => node.textContent);
  assert.deepEqual(heads, [t('User'), t('Assistant')]);
  const labels = [...document.querySelectorAll('.context-entry-list button:not(.context-entry-group-head) > span')].map((node) => node.textContent);
  assert.deepEqual(labels, [`${t('User')} 1`, `${t('Assistant')} 1read`]);
  assert.equal(document.querySelector('.context-entry-tools').textContent, 'read');
  assert.equal(
    document.querySelector('.context-entry-list button:not(.context-entry-group-head)').title,
    t('Raw estimate: ≈{{tokens}}', { tokens: '40' })
  );
  await act(async () => { document.querySelector('.context-entry-group-head').click(); });
  assert.equal(document.querySelectorAll('.context-entry-list button:not(.context-entry-group-head)').length, 1);
  assert.equal(document.querySelector('.context-inspector-toggle'), null);
  await act(async () => { document.querySelector('.context-detail-bar [aria-label]').click(); });
  assert.equal(document.querySelector('.context-entry-section'), null);
  assert.ok(document.querySelector('.context-detail-empty'));
});
