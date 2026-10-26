import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'navigator'],
});

const { ChildSurfacePeekLines, childSurfacePeeksAt, recordChildSurfacePeek, useChildSurfacePeeks } = await import(
  './child-surface-peeks.tsx'
);
const { onBrowserPageRevealRequested } = await import('./browser-page-request.ts');

const peek = (overrides = {}) => ({
  childSessionId: 'sub-1',
  childName: '시장 조사',
  surface: 'browser',
  title: '공시 검색',
  tabId: 'p2',
  failed: '',
  at: 150,
  ...overrides,
});

test('a child line follows the row recorded last before its reveal', () => {
  const rows = [
    { _tag: 'UserMessage', key: 'u', turnKey: 't1', item: { kind: 'user', at: 100 } },
    { _tag: 'ToolActivity', key: 'a', turnKey: 't1', items: [{ startedAt: 120 }] },
    { _tag: 'TurnGap', key: 'g', turnKey: 't2' },
    { _tag: 'UserMessage', key: 'u2', turnKey: 't2', item: { kind: 'user', at: 200 } },
  ];
  const peeks = [peek(), peek({ childSessionId: 'sub-2', at: 300 })];
  assert.deepEqual(
    rows.map((_, index) => childSurfacePeeksAt(rows, index, peeks).map((entry) => entry.childSessionId)),
    [[], ['sub-1'], [], ['sub-2']]
  );
});

test('the owner conversation shows the child page under its name, and a failed open without 보기', async () => {
  const reveals = [];
  const stop = onBrowserPageRevealRequested((request) => reveals.push(request));
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let shown = [];
  function Lines() {
    shown = useChildSurfacePeeks('lead');
    return React.createElement(ChildSurfacePeekLines, { sessionId: 'lead', peeks: shown });
  }
  try {
    await act(async () => root.render(React.createElement(Lines)));
    await act(async () => recordChildSurfacePeek('lead', peek()));
    await act(async () =>
      recordChildSurfacePeek(
        'lead',
        peek({ childSessionId: 'sub-2', childName: '검토', tabId: '', failed: '정책에 막힌 주소', at: 160 })
      )
    );
    await act(async () =>
      recordChildSurfacePeek('lead', peek({ childSessionId: 'sub-3', surface: 'terminal', tabId: '', title: '' }))
    );
    assert.equal(shown.length, 3);
    const [browser, failed, terminal] = host.querySelector('.transcript-child-surface-peeks').children;
    assert.match(browser.textContent, /시장 조사/);
    assert.match(browser.textContent, /공시 검색/);
    assert.equal(browser.querySelector('.transcript-browser-peek-owner')?.textContent, '시장 조사');
    assert.equal(failed.tagName, 'DIV');
    assert.match(failed.textContent, /정책에 막힌 주소/);
    assert.equal(failed.querySelector('b'), null, 'no 보기 on a failed open');
    assert.equal(terminal.tagName, 'BUTTON');
    assert.match(terminal.textContent, /시장 조사/);
    // A repeat reveal of the same child surface keeps its place.
    await act(async () => recordChildSurfacePeek('lead', peek({ at: 999 })));
    assert.equal(shown.find((entry) => entry.childSessionId === 'sub-1').at, 150);
    // No line for a session in its own conversation.
    recordChildSurfacePeek('sub-1', peek());
    assert.equal(reveals.length, 0);
  } finally {
    stop();
    await act(async () => root.unmount());
    host.remove();
  }
});
