import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'Event'],
});

const {
  FullToolOutputButton,
  heldToolOutputReads,
  useFullToolOutput,
  prefetchToolOutputs,
  resetFullToolOutputs,
  TOOL_OUTPUT_PREFETCH_RETRY_MS,
  toolOutputPrefetchesInFlight,
} = await import('./tool-full-output.tsx');
const {
  noteHistoryPageRequest,
  resetToolOutputPrefetch,
  TOOL_OUTPUT_PREFETCH_IDLE_MS,
  toolOutputPrefetchListening,
  useToolOutputPrefetch,
} = await import('./tool-output-prefetch.ts');
const { setRemoteConnectionState } = await import('./remote-connection-state.ts');

const cutRow = (id) => ({
  id,
  kind: 'tool',
  name: 'read',
  result: '1\tc\n2\tc',
  remoteOutputTruncated: 400,
  remoteOutputNotes: { result: { kind: 'omitted', at: 7, omitted: 393 } },
  completedAt: 1,
});

function Group({ items }) {
  const ref = useRef(null);
  useToolOutputPrefetch(ref, 'session-1', items);
  return React.createElement('article', { ref });
}

function deferredReads() {
  const calls = [];
  window.mixdogDesktop = {
    readTranscriptItem: (_session, id) =>
      new Promise((resolve) => {
        calls.push({ id, resolve: () => resolve({ id, result: `full ${id}` }) });
      }),
  };
  return calls;
}

const sleep = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

async function mount(items) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Group, { items })));
  return async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

test('idle after a scroll reads nearby cut rows, two at a time', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  const unmount = await mount(['a', 'b', 'c', 'd', 'e'].map(cutRow));
  document.dispatchEvent(new window.Event('scroll'));
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS / 2);
  document.dispatchEvent(new window.Event('scroll'));
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS / 2);
  assert.equal(calls.length, 0, 'still scrolling: nothing read');
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a', 'b'],
    'two reads in flight'
  );
  assert.equal(toolOutputPrefetchesInFlight(), 2);
  await act(async () => calls[0].resolve());
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a', 'b', 'c'],
    'a settled read frees its slot'
  );
  await unmount();
  await act(async () => calls[1].resolve());
  assert.equal(calls.length, 3, 'rows that left are not read');
});

test('no background read starts while a history page is pending', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  const settlePage = noteHistoryPageRequest();
  const unmount = await mount(['p', 'q'].map(cutRow));
  document.dispatchEvent(new window.Event('scroll'));
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
  assert.equal(calls.length, 0, 'the page goes first');
  await act(async () => settlePage());
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
  assert.deepEqual(
    calls.map((call) => call.id),
    ['p', 'q']
  );
  await unmount();
});

test('a scroll drops the reads queued for where the reader was', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  const unmount = await mount(['a', 'b', 'c', 'd'].map(cutRow));
  document.dispatchEvent(new window.Event('scroll'));
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
  assert.equal(calls.length, 2);
  document.dispatchEvent(new window.Event('scroll'));
  await act(async () => calls[0].resolve());
  assert.equal(calls.length, 2, 'a freed slot does not start a read queued before the scroll');
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a', 'b', 'c'],
    'idle again: rows still near are queued anew'
  );
  await unmount();
});

test('the last group leaving removes the scroll listener and the idle wait', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  deferredReads();
  const live = new Set();
  const add = document.addEventListener;
  const remove = document.removeEventListener;
  document.addEventListener = function (type, listener, options) {
    if (type === 'scroll') live.add(listener);
    return add.call(this, type, listener, options);
  };
  document.removeEventListener = function (type, listener, options) {
    if (type === 'scroll') live.delete(listener);
    return remove.call(this, type, listener, options);
  };
  try {
    const first = await mount(['a'].map(cutRow));
    const second = await mount(['b'].map(cutRow));
    assert.equal(live.size, 1);
    await first();
    assert.equal(live.size, 1, 'a group still mounted keeps it');
    await second();
    assert.equal(live.size, 0, 'no scroll listener stays behind');
    assert.equal(toolOutputPrefetchListening(), false, 'no idle wait stays behind');
  } finally {
    document.addEventListener = add;
    document.removeEventListener = remove;
  }
});

test('failed reads are bounded and prefetched again only after a while', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const asked = [];
  window.mixdogDesktop = {
    readTranscriptItem: async (_session, id) => {
      asked.push(id);
      throw new Error('offline');
    },
  };
  const owner = {};
  const rows = Array.from({ length: 80 }, (_, n) => cutRow(`f${n}`));
  await act(async () => {
    prefetchToolOutputs('session-1', rows, owner);
    for (let n = 0; n < 200 && asked.length < rows.length; n += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(asked.length, rows.length);
  assert.ok(heldToolOutputReads() <= 64, `failures are held to the limit (${heldToolOutputReads()})`);
  const realNow = Date.now;
  try {
    await act(async () => prefetchToolOutputs('session-1', [rows.at(-1)], owner));
    assert.equal(asked.length, rows.length, 'a fresh failure is not read again');
    await act(async () => prefetchToolOutputs('session-1', [rows[0]], owner));
    assert.equal(asked.length, rows.length, 'a fresh failure dropped from the held reads keeps its wait');
    Date.now = () => realNow() + TOOL_OUTPUT_PREFETCH_RETRY_MS;
    await act(async () => prefetchToolOutputs('session-1', [rows.at(-1)], owner));
    assert.equal(asked.length, rows.length + 1, 'an old failure is read again');
  } finally {
    Date.now = realNow;
  }
});

test('nothing is prefetched while the link to the host is down', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  setRemoteConnectionState('reconnecting');
  try {
    const unmount = await mount(['a'].map(cutRow));
    document.dispatchEvent(new window.Event('scroll'));
    await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
    assert.equal(calls.length, 0, 'reconnecting: no read');
    await act(async () => setRemoteConnectionState('connected'));
    await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
    assert.deepEqual(
      calls.map((call) => call.id),
      ['a'],
      'connected again: the nearby row is read'
    );
    await unmount();
  } finally {
    delete document.documentElement.dataset.mixdogRemoteConnection;
  }
});

test('a background read starts unseen and, settled, wakes only its own row', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  const seen = { a: [], b: [] };
  function Row({ item }) {
    const output = useFullToolOutput('session-1', item, false);
    seen[item.id].push({ loading: output.loading, result: output.item.result });
    return React.createElement(FullToolOutputButton, { output });
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(
        'div',
        null,
        React.createElement(Row, { item: cutRow('a') }),
        React.createElement(Row, { item: cutRow('b') })
      )
    )
  );
  const label = () => host.textContent;
  const before = label();
  await act(async () => prefetchToolOutputs('session-1', [cutRow('a')], {}));
  assert.equal(calls.length, 1, 'the read started');
  assert.equal(seen.a.length, 1, 'its start renders no row');
  assert.equal(seen.b.length, 1);
  assert.equal(label(), before, 'nothing on screen changes while it runs');
  await act(async () => calls[0].resolve());
  assert.equal(seen.a.length, 2, 'the settled row renders once');
  assert.equal(seen.a.at(-1).result, 'full a');
  assert.equal(seen.b.length, 1, 'the other row is not woken');
  await act(async () => root.unmount());
  host.remove();
});

test('a press during a background read shows that read loading', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  let output;
  function Row() {
    output = useFullToolOutput('session-1', cutRow('a'), false);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Row)));
  await act(async () => prefetchToolOutputs('session-1', [cutRow('a')], {}));
  assert.equal(output.loading, false);
  await act(async () => output.load());
  assert.equal(output.loading, true, 'the pressed row shows its read');
  assert.equal(calls.length, 1, 'no second read');
  await act(async () => calls[0].resolve());
  assert.equal(output.item.result, 'full a');
  await act(async () => root.unmount());
});

test('nothing is read while a finger is on the screen', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const calls = deferredReads();
  const unmount = await mount(['a'].map(cutRow));
  document.dispatchEvent(new window.Event('touchstart'));
  document.dispatchEvent(new window.Event('scroll'));
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS * 2);
  assert.equal(calls.length, 0, 'held while touching');
  document.dispatchEvent(new window.Event('touchend'));
  await sleep(TOOL_OUTPUT_PREFETCH_IDLE_MS + 50);
  assert.deepEqual(
    calls.map((call) => call.id),
    ['a'],
    'lifted and settled: read'
  );
  await unmount();
});

test('a read is held per session: the same row id in another session reads again', async () => {
  resetFullToolOutputs();
  resetToolOutputPrefetch();
  const asked = [];
  window.mixdogDesktop = {
    readTranscriptItem: async (session, id) => {
      asked.push(`${session}/${id}`);
      return { id, result: `full ${session}` };
    },
  };
  await act(async () => prefetchToolOutputs('session-1', [cutRow('a')], {}));
  await act(async () => prefetchToolOutputs('session-2', [cutRow('a')], {}));
  assert.deepEqual(asked, ['session-1/a', 'session-2/a']);
});
