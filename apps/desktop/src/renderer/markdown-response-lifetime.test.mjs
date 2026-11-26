import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { parseMarkdownToHast } from './markdown-ast';
import {
  parseStreamingMarkdownAst,
  preloadSyncMarkdownParser,
  readCachedStreamingMarkdownAst,
  SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS,
  syncMarkdownParserLoad,
  terminateIdleMarkdownWorker,
} from './markdown-worker-client';
import { _runIdleReclaimForTest } from './idle-reclaim';
import { MarkdownResponse } from './MarkdownResponse';
import { MarkdownSessionContext } from './MarkdownLink';
import { TranscriptRow } from './transcript-row';

function installFakeMarkdownWorker(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const sent = [];
  let activeWorker = null;
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class FakeMarkdownWorker {
      handlers = new Map();
      constructor() {
        activeWorker = this;
      }
      addEventListener(type, listener) {
        this.handlers.set(type, listener);
      }
      postMessage(message) {
        sent.push(message);
      }
      terminate() {}
      reply(message) {
        const root = parseMarkdownToHast(message.text);
        this.handlers.get('message')?.({ data: { id: message.id, root } });
      }
    },
  });
  t.after(() => {
    terminateIdleMarkdownWorker();
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  });
  return {
    sent,
    flushNext: () =>
      act(async () => {
        const message = sent.find((item) => !item.replied);
        if (!message || !activeWorker) return;
        message.replied = true;
        activeWorker.reply(message);
        await Promise.resolve();
      }),
  };
}

async function mount(t) {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const worker = installFakeMarkdownWorker(t);
  await preloadSyncMarkdownParser();
  const render = (text, streaming) =>
    act(async () => root.render(text === null ? null : React.createElement(MarkdownResponse, { text, streaming })));
  return { document, render, worker };
}

test('cold parser: ending a streamed TranscriptRow with a longer final snapshot keeps displayed text monotonic', async (t) => {
  assert.equal(syncMarkdownParserLoad(), 'idle', 'parser starts cold before first preload');
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const worker = installFakeMarkdownWorker(t);
  const liveText = 'Prefix live text.';
  const finalText = `${liveText}\n\n${'alpha '.repeat(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS / 2)}`;
  const observedLengths = [];
  const recordLength = () => {
    const len = (document.querySelector('.markdown')?.textContent ?? '').length;
    observedLengths.push(len);
    return len;
  };
  const renderRow = (item) =>
    React.createElement(
      MarkdownSessionContext.Provider,
      { value: 'cold-session' },
      React.createElement(TranscriptRow, { item, revealKey: 'cold-session:c1', paced: false })
    );

  // Synchronous act commits while dynamic import('./markdown-ast') is still pending.
  act(() => {
    root.render(renderRow({ id: 'c1', kind: 'assistant', text: liveText, streaming: true }));
  });
  assert.notEqual(syncMarkdownParserLoad(), 'ready', 'parser is still cold during first commit');
  const duringStream = recordLength();

  act(() => {
    root.render(renderRow({ id: 'c1', kind: 'assistant', text: finalText, streaming: false }));
  });
  assert.notEqual(syncMarkdownParserLoad(), 'ready', 'parser is still cold when final snapshot arrives');
  const whileCold = recordLength();
  assert.equal(whileCold, duringStream, 'does not jump ahead to finalText while parser is cold');

  // Let the sync parser finish loading; final off-thread parse is still in flight.
  await act(async () => {
    await preloadSyncMarkdownParser();
  });
  assert.equal(syncMarkdownParserLoad(), 'ready');
  const afterParserReady = recordLength();
  assert.ok(
    afterParserReady >= whileCold,
    `displayed length did not move backward (${whileCold} -> ${afterParserReady})`
  );

  // Flush worker messages until the final parse lands.
  for (let i = 0; i < 6 && worker.sent.some((m) => !m.replied); i += 1) {
    await worker.flushNext();
  }
  const settled = recordLength();
  assert.ok(settled > liveText.length, 'final text renders once off-thread parse resolves');
  for (let i = 1; i < observedLengths.length; i += 1) {
    assert.ok(
      observedLengths[i] >= observedLengths[i - 1],
      `displayed text length must be monotonic: ${JSON.stringify(observedLengths)}`
    );
  }
});

test('a settled reply too long for the parse cache shows its parse once the worker answers', async (t) => {
  const { document, render, worker } = await mount(t);
  const text = `## Long reply\n\n${'word '.repeat(30_000)}`;
  assert.ok(text.length > 128 * 1024, 'past what the parse cache keeps of one text');
  await render(text, false);
  assert.ok(document.querySelector('[data-transcript-pending]'), 'pending while the worker parse is in flight');
  assert.equal(worker.sent.length, 1, 'one off-main-thread worker parse dispatched');
  await worker.flushNext();
  assert.equal(document.querySelector('[data-transcript-pending]'), null, 'nothing is left pending');
  assert.equal(document.querySelector('h2')?.textContent, 'Long reply');
});

test('a reply unmounted while it streams runs none of its live parses still waiting', async (t) => {
  const { render, worker } = await mount(t);
  // One open block past the main-thread bound: each of its parses runs off-main-thread, one at a time.
  const open = `Streaming ${'word '.repeat(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS / 4)}`;
  const before = worker.sent.length;
  await render(open, true);
  await render(`${open}more`, true);
  assert.equal(worker.sent.length, before + 1, 'the newer parse waits for the one out');
  await render(null);
  await worker.flushNext();
  assert.equal(worker.sent.length, before + 1, 'the waiting parse is never started');
});

test('a long streamed reply keeps its streamed render while resolving the final AST off-thread', async (t) => {
  const { document, render, worker } = await mount(t);
  const body = Array.from({ length: 120 }, (_, index) => `Paragraph ${index}: ${'alpha '.repeat(8)}`).join('\n\n');
  const streamed = `## Streamed Heading\n\n${body}`;
  const finalText = `${streamed}\n\nFinal **settled** line.`;
  assert.ok(finalText.length > SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS, 'exceeds sync parse bound');

  await render(streamed, true);
  assert.equal(document.querySelector('h2')?.textContent, 'Streamed Heading');
  const sentBeforeEnd = worker.sent.length;

  await render(finalText, false);
  assert.equal(document.querySelector('[data-transcript-pending]'), null, 'keeps showing streamed render');
  assert.equal(document.querySelector('h2')?.textContent, 'Streamed Heading', 'streamed heading remains visible');
  assert.equal(document.querySelector('strong'), null, 'final AST has not been synchronously parsed on main thread');
  assert.equal(worker.sent.length, sentBeforeEnd + 1, 'dispatches final full parse to worker host');
  assert.equal(worker.sent.at(-1).text, finalText);

  await worker.flushNext();
  assert.equal(document.querySelector('strong')?.textContent, 'settled', 'swaps in resolved worker AST');
});

test('a streamed TranscriptRow ending past the 128 KiB AST cache bound hands off its parsed AST without a second worker parse', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const worker = installFakeMarkdownWorker(t);
  await preloadSyncMarkdownParser();
  const finalText = `## Uncached Long Reply\n\n${'word '.repeat(30_000)}`;
  assert.ok(finalText.length > 128 * 1024, 'exceeds AST cache per-entry cap');
  const renderRow = (item) =>
    act(async () =>
      root.render(
        React.createElement(
          MarkdownSessionContext.Provider,
          { value: 'big-session' },
          React.createElement(TranscriptRow, { item, revealKey: 'big-session:b1', paced: false })
        )
      )
    );

  await renderRow({ id: 'b1', kind: 'assistant', text: '## Start\n\nHello', streaming: true });
  const sentBeforeEnd = worker.sent.length;

  await renderRow({ id: 'b1', kind: 'assistant', text: finalText, streaming: false });
  assert.equal(worker.sent.length, sentBeforeEnd + 1, 'dispatches one off-thread parse for the >128 KiB final text');
  assert.equal(worker.sent.at(-1).text, finalText);

  await worker.flushNext();
  assert.equal(
    worker.sent.filter((message) => message.text === finalText).length,
    1,
    'MarkdownResponse reuses the preparsed AST instead of triggering a second worker parse'
  );
  assert.equal(document.querySelector('h2')?.textContent, 'Uncached Long Reply');
  assert.equal(document.querySelector('.markdown')?.classList.contains('streaming'), false);
  assert.equal(document.querySelector('[data-transcript-pending]'), null);
});

test('a settled coding reply does not shrink back to lastStreamingText or lose its Completed footer after idle AST cache reclaim', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const worker = installFakeMarkdownWorker(t);
  await preloadSyncMarkdownParser();
  const shortLive = 'Hello';
  const finalText = `## Cached Long Reply\n\n${'word '.repeat(1_200)}`;
  assert.ok(finalText.length > SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS, 'exceeds sync parse cap');
  assert.ok(finalText.length < 128 * 1024, 'fits in AST cache');

  // Pre-populate AST cache so settlement hits the cache directly without setting resolvedFinal.
  const cachedPromise = parseStreamingMarkdownAst(finalText);
  await worker.flushNext();
  await cachedPromise;
  assert.ok(readCachedStreamingMarkdownAst(finalText), 'final AST is cached before settlement');

  const completion = { id: 'td-reclaim', kind: 'turndone', status: 'complete', elapsedMs: 1_500 };
  const renderRow = (item, extra = {}) =>
    act(async () =>
      root.render(
        React.createElement(
          MarkdownSessionContext.Provider,
          { value: 'reclaim-session' },
          React.createElement(TranscriptRow, {
            item,
            completion: item.streaming ? undefined : completion,
            revealKey: 'reclaim-session:r1',
            paced: false,
            ...extra,
          })
        )
      )
    );

  await renderRow({ id: 'r1', kind: 'assistant', text: shortLive, streaming: true });
  await renderRow({ id: 'r1', kind: 'assistant', text: finalText, streaming: false });
  assert.equal(document.querySelector('h2')?.textContent, 'Cached Long Reply');
  assert.equal(document.querySelector('.markdown')?.classList.contains('streaming'), false);
  assert.ok(document.querySelector('.response-footer'), 'Completed footer shown at settlement');
  const settledLength = (document.querySelector('.markdown')?.textContent ?? '').length;
  assert.ok(settledLength > 4_000, 'full settled text is rendered');

  // Reclaim clears the global AST cache; a subsequent rerender with unchanged text must stay settled.
  _runIdleReclaimForTest();
  assert.equal(readCachedStreamingMarkdownAst(finalText), null, 'AST cache reclaimed');
  const sentBeforeRerender = worker.sent.length;
  await renderRow({ id: 'r1', kind: 'assistant', text: finalText, streaming: false }, { animateComplete: true });

  assert.equal(
    (document.querySelector('.markdown')?.textContent ?? '').length,
    settledLength,
    'full reply stays intact without shrinking back to lastStreamingText'
  );
  assert.equal(document.querySelector('.markdown')?.classList.contains('streaming'), false);
  assert.ok(document.querySelector('.response-footer'), 'Completed footer remains visible after cache reclaim');
  assert.equal(worker.sent.length, sentBeforeRerender, 'no redundant worker parse dispatched on unchanged text');
});
