import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { CommandSurface } from './CommandSurface.tsx';
import { t } from './i18n.ts';
import { UsageLedger, makeUsageRecord } from '../../../../src/runtime/shared/llm/usage-ledger.mjs';
import { createUsageStatsApi } from '../../../../src/session-runtime/usage-stats-api.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function harness(context) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['HTMLElement', 'Node', 'history'],
    actEnvironment: false,
  });
  // The list's end: the test scrolls it into view by hand.
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.target = null;
    }
  };
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    delete globalThis.IntersectionObserver;
    dom.window.close();
  });
  return {
    render: async (props) => act(async () => root.render(React.createElement(CommandSurface, props))),
    scrollToEnd: async () =>
      act(async () => {
        for (const observer of observers) {
          if (observer.target?.isConnected) observer.callback([{ isIntersecting: true }]);
        }
      }),
  };
}

function requestApi(context, count) {
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  const now = Date.now();
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(
      makeUsageRecord({
        ts: now - (index + 1) * 60_000,
        provider: index === 1 ? 'openai-oauth' : 'openai',
        model: index === 1 ? 'gpt-5.6-luna' : 'gpt-5.6',
        sessionId: index === 0 ? 'agent' : 'lead',
        sourceType: 'lead',
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.04,
        durationMs: 6000,
        ttftMs: 1000,
        status: index === 2 ? 'failed' : index === 3 ? 'substituted' : 'completed',
      })
    );
  }
  ledger.record(rows);
  const usage = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    sessionMetadata: async (id) =>
      ({ lead: { title: 'Dev session' }, agent: { agent: 'reviewer', ownerSessionId: 'lead' } })[id] ?? null,
  });
  const asked = [];
  const control = { failFirstPage: false };
  return {
    asked,
    control,
    api: {
      invokeCapability: async ({ capability, args = [] }) => {
        if (capability !== 'getUsageRequests') return { value: { totals: {}, providers: [], period: {} } };
        asked.push(args[0]);
        if (control.failFirstPage && !args[0].cursor) throw new Error('first page failed');
        return { value: await usage.getUsageRequests(args[0]) };
      },
    },
  };
}

const tab = (label) => [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === t(label));
const bodyRows = () => [...document.querySelectorAll('.request-log-table tbody tr:not(.request-log-more)')];
const option = (label) => [...document.querySelectorAll('.mx-menu [role="option"]')].find((node) => node.textContent === label);
const openFilter = (index) =>
  act(async () => {
    const trigger = document.querySelectorAll('.request-log-filter .mx-select-trigger')[index];
    trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  });

test('the request log tab lists requests with every column, filters them and loads more on scroll', async (context) => {
  const { render, scrollToEnd } = harness(context);
  window.localStorage.clear();
  const { api, asked } = requestApi(context, 60);
  await render({ surface: 'stats', open: true, onClose() {}, api });
  await act(async () => tab('Request log').click());
  assert.equal(tab('Request log').getAttribute('aria-selected'), 'true');
  assert.deepEqual(asked[0], { view: 'hour', limit: 50 });
  assert.deepEqual(
    [...document.querySelectorAll('.request-log-table thead th')].map((node) => node.textContent),
    ['Time', 'Session', 'Model', 'Tokens', 'Cost', 'Time taken', 'Status'].map((label) => t(label))
  );
  assert.equal(
    document.querySelector('.stats-ranges [aria-pressed="true"]').textContent,
    t('Last 24 hours'),
    'the shared period chips, on the same default'
  );
  assert.equal(bodyRows().length, 50);
  const cells = (row) => [...bodyRows()[row].children];
  assert.equal(cells(0)[1].textContent, 'Dev session · Reviewer', 'an agent names the session it ran for and its role');
  assert.equal(cells(1)[1].textContent, 'Dev session');
  assert.equal(cells(0)[3].textContent, '1.5K');
  assert.equal(cells(0)[4].textContent, '$0.04');
  assert.equal(cells(1)[4].textContent, t('Subscription'), 'an OAuth route has no per-request bill');
  assert.equal(cells(2)[6].dataset.status, 'failed');
  assert.equal(cells(2)[6].textContent, t('Failed'));
  assert.equal(cells(3)[6].textContent, t('Substituted'));

  await scrollToEnd();
  assert.equal(asked.length, 2);
  assert.ok(asked[1].cursor, 'the next page continues after the last row');
  assert.equal(bodyRows().length, 60);
  assert.equal(document.querySelector('.request-log-more'), null, 'nothing more to load');

  await openFilter(0);
  await act(async () => option(t('Failed')).click());
  assert.equal(asked.at(-1).status, 'failed');
  assert.equal(bodyRows().length, 1);

  await openFilter(1);
  assert.deepEqual(
    [...document.querySelectorAll('.mx-menu [role="option"]')].map((node) => node.textContent),
    [t('All'), 'gpt-5.6', 'gpt-5.6-luna']
  );
  await act(async () => option('gpt-5.6-luna').click());
  assert.equal(asked.at(-1).model, 'gpt-5.6-luna');
  assert.equal(bodyRows()[0].textContent, t('No requests recorded in this period.'));
});

test('a failed first page of a new filter clears the old rows and pages nothing on scroll', async (context) => {
  const { render, scrollToEnd } = harness(context);
  window.localStorage.clear();
  const { api, asked, control } = requestApi(context, 120);
  await render({ surface: 'stats', open: true, onClose() {}, api });
  await act(async () => tab('Request log').click());
  assert.equal(bodyRows().length, 50);
  await scrollToEnd();
  assert.ok(asked.at(-1).asOf > 0, 'later pages carry the first page\'s time');
  assert.equal(bodyRows().length, 100);

  control.failFirstPage = true;
  await openFilter(0);
  await act(async () => option(t('Failed')).click());
  const count = asked.length;
  assert.equal(bodyRows().filter((row) => !row.querySelector('.usage-empty')).length, 0, 'the old rows are gone');
  await scrollToEnd();
  assert.equal(asked.length, count, 'no page is read with the old cursor');
});

test('a host that does not advertise the request log shows no tab, and a stored choice opens token usage', async (context) => {
  const { render } = harness(context);
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'requests');
  const { api, asked } = requestApi(context, 3);
  await render({ surface: 'stats', open: true, onClose() {}, api: { ...api, remoteUsageRequests: false } });
  assert.equal(tab('Request log'), undefined);
  assert.equal(tab('Token usage').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('.request-log-table'), null);
  assert.equal(asked.length, 0, 'the older host is never asked');
});

test('an empty period shows one line', async (context) => {
  const { render } = harness(context);
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'requests');
  const { api } = requestApi(context, 0);
  await render({ surface: 'stats', open: true, onClose() {}, api });
  assert.equal(bodyRows().length, 1);
  assert.equal(bodyRows()[0].querySelector('.usage-empty').textContent, t('No requests recorded in this period.'));
});
