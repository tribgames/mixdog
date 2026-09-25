import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useTranscriptHistory } from './use-transcript-history.ts';

test('tail windows page older history from transcriptHasOlder, one page per published window', async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: 'http://localhost/' });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  window.mixdogDesktop = {
    prefetchSession(sessionId, limit) {
      const result = Promise.withResolvers();
      requests.push({ sessionId, limit, ...result });
      return result.promise;
    },
  };
  const root = createRoot(document.getElementById('root'));
  const Reader = ({ count, hasOlder }) =>
    React.createElement('button', { type: 'button', onClick: useTranscriptHistory('a', count, hasOlder) }, 'Earlier');
  const render = (count, hasOlder) =>
    act(async () => {
      root.render(React.createElement(Reader, { count, hasOlder }));
    });
  const earlier = () => act(async () => document.querySelector('button').click());
  try {
    // A byte-budgeted first window (16 items) with older history.
    await render(16, true);
    await earlier();
    await earlier();
    assert.deepEqual(
      requests.map(({ limit }) => limit),
      [80],
      'one page past the current count, never while pending'
    );
    await act(async () => requests[0].resolve(true));
    await earlier();
    assert.equal(requests.length, 1, 'an ACK before the grown window arrives cannot skip ahead');
    // A live append can land while the page is in flight: count, not the
    // request, sizes the next page.
    await render(81, true);
    await earlier();
    assert.equal(requests[1].limit, 145);
    await act(async () => requests[1].resolve(true));
    await render(120, false);
    await earlier();
    assert.equal(requests.length, 2, 'the host said no older history exists');
    // A host that predates transcriptHasOlder keeps the count-based pages.
    await render(512, undefined);
    await earlier();
    assert.equal(requests[2].limit, 1024);
  } finally {
    await act(async () => {
      for (const request of requests) request.resolve(false);
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('cold history pages load on demand, survive delayed publications and stay session-scoped', async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: 'http://localhost/' });
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const requests = [];
  window.mixdogDesktop = {
    prefetchSession(sessionId, limit) {
      const result = Promise.withResolvers();
      requests.push({ sessionId, limit, ...result });
      return result.promise;
    },
  };
  const root = createRoot(document.getElementById('root'));
  const Reader = ({ sessionId, count }) =>
    React.createElement('button', { type: 'button', onClick: useTranscriptHistory(sessionId, count) }, 'Earlier');
  const render = (sessionId, count) =>
    act(async () => {
      root.render(React.createElement(Reader, { sessionId, count }));
    });
  const earlier = () => act(async () => document.querySelector('button').click());
  try {
    await render('a', 0);
    await earlier();
    assert.equal(requests.length, 0);
    await render('a', 512);
    await earlier();
    await earlier();
    assert.deepEqual(
      requests.map(({ sessionId, limit }) => [sessionId, limit]),
      [['a', 1024]]
    );
    await act(async () => requests[0].resolve(true));
    await earlier();
    assert.equal(requests.length, 1, 'an ACK before publication cannot skip to another page');
    await render('a', 1024);
    await earlier();
    assert.equal(requests[1].limit, 1536, 'delayed history does not mark the session exhausted');
    await render('b', 512);
    await earlier();
    assert.deepEqual([requests[2].sessionId, requests[2].limit], ['b', 1024]);
    await render('a', 512);
    await act(async () => requests[1].resolve(true));
    await earlier();
    assert.equal(requests[3].limit, 1024, "a previous visit's ACK does not change this visit");
    await act(async () => requests[3].reject(new Error('connection lost')));
    await earlier();
    assert.equal(requests[4].limit, 1024, 'failed reads remain retryable');
    await act(async () => requests[4].resolve(true));
    await render('a', 900);
    await earlier();
    assert.equal(requests.length, 5, 'a short returned page is complete');
    await render('a', 2048);
    await earlier();
    assert.equal(requests.length, 5, 'history retains its upper bound');
  } finally {
    await act(async () => {
      for (const request of requests) request.resolve(false);
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
