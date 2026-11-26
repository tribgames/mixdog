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

test('a non-fenced streaming tail crossing the 64 KiB cap stays visible instead of collapsing to empty', async (t) => {
  const { document, render, worker } = await mount(t);
  const { MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS } = await import('./streaming-markdown');
  // Start just above sync parse bound (so worker parse is pending, no tail AST landed yet)
  // and grow past the 64 KiB live parse cutoff without closing the paragraph.
  const beforeCap = `Paragraph start ${'word '.repeat(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS / 2)}`;
  assert.ok(beforeCap.length > SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS);
  assert.ok(beforeCap.length < MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS);
  await render(beforeCap, true);
  assert.ok(document.querySelector('p.markdown-plain'), 'waiting prose renders before the 64 KiB cap');
  const sentBeforeCap = worker.sent.length;

  const pastCap = `${beforeCap}${'more '.repeat(Math.ceil((MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS - beforeCap.length + 512) / 5))}`;
  assert.ok(pastCap.length > MAX_STREAMING_UNSTABLE_MARKDOWN_CHARS);
  await render(pastCap, true);
  const plain = document.querySelector('p.markdown-plain');
  assert.ok(plain, 'non-fenced tail stays visible past the 64 KiB parse cap');
  assert.ok(plain.textContent.length >= pastCap.trimEnd().length, 'full waiting text remains rendered');
  assert.equal(document.querySelector('[data-transcript-pending]'), null, 'capped tail stops awaiting live parse');
  assert.equal(worker.sent.length, sentBeforeCap, 'no new live parse work dispatched past 64 KiB');
});

test('an initially empty blockquote tail crossing 64 KiB falls back to visible waiting prose instead of dropping to empty', async (t) => {
  const { document, render } = await mount(t);
  await render('Intro\n\n> ', true);
  assert.equal(document.querySelector('p')?.textContent, 'Intro');

  const hugeTail = `Intro\n\n> ${'word '.repeat(14_000)}`;
  assert.ok(hugeTail.length > 70_000);
  await render(hugeTail, true);
  const plain = document.querySelector('p.markdown-plain');
  assert.ok(plain, 'non-fenced tail stays visible after an initially empty blockquote parse crosses 64 KiB');
  assert.ok(plain.textContent.length >= 70_000, 'full 70k tail text remains rendered');
});

test('MarkdownDocumentView normalizes leading-whitespace slotKeys and preserves the outer DOM box across waiting-to-parsed swaps', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const { MarkdownDocumentView } = await import('./MarkdownDocumentView');
  const { LiveMarkdownDocument, markdownPagesOf, unitsOf } = await import('./markdown-document');
  const { SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS } = await import('./markdown-worker-client');
  installFakeMarkdownWorker(t);

  // Leading whitespace: waiting unit and parsed AST unit share the same normalized slotKey.
  const paddedSource = `  plain **prose** ${'w'.repeat(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS)}`;
  const liveDoc = new LiveMarkdownDocument(() => {});
  const waitingPages = liveDoc.update(paddedSource);
  let waitingLeaf = waitingPages;
  while (waitingLeaf && 'items' in waitingLeaf) waitingLeaf = waitingLeaf.items[0];
  const parsedAst = parseMarkdownToHast(paddedSource);
  const parsedUnits = unitsOf(parsedAst, 0, 0, paddedSource.length);
  assert.equal(waitingLeaf.slotKey, '@2', 'waiting unit normalizes slotKey past leading spaces');
  assert.equal(parsedUnits[0].slotKey, '@2', 'parsed unit starts at the same content offset');

  await act(async () =>
    root.render(
      React.createElement(MarkdownDocumentView, {
        root: markdownPagesOf([waitingLeaf]),
        copyControl: () => null,
      })
    )
  );
  const outerBefore = document.querySelector('.markdown-unit');
  assert.ok(outerBefore, 'renders stable outer unit box while waiting');
  assert.ok(outerBefore.querySelector('p.markdown-plain'), 'shows waiting prose inside outer unit');

  await act(async () =>
    root.render(
      React.createElement(MarkdownDocumentView, {
        root: markdownPagesOf(parsedUnits),
        copyControl: () => null,
      })
    )
  );
  const outerAfter = document.querySelector('.markdown-unit');
  assert.equal(outerAfter, outerBefore, 'outer DOM box stays connected and identical across UnitWaiting -> UnitBody');
  assert.equal(outerAfter.isConnected, true);
  assert.equal(outerAfter.querySelector('strong')?.textContent, 'prose');

  const initialAst = parseMarkdownToHast('First **version**');
  const initialUnits = unitsOf(initialAst, 0, 0, 'First **version**'.length);
  assert.equal(initialUnits[0].slotKey, '@0');

  await act(async () =>
    root.render(
      React.createElement(MarkdownDocumentView, {
        root: markdownPagesOf(initialUnits),
        copyControl: () => null,
      })
    )
  );
  const outerForRoleSwap = document.querySelector('.markdown-unit');
  const strong = document.querySelector('strong');
  assert.equal(strong?.textContent, 'version');

  // Waiting unit at the same source position must keep the prior parsed block visible.
  await act(async () =>
    root.render(
      React.createElement(MarkdownDocumentView, {
        root: markdownPagesOf([
          {
            key: 'wait@0',
            slotKey: '@0',
            node: null,
            from: 0,
            held: false,
            text: '## Heading replacement',
            pending: true,
          },
        ]),
        copyControl: () => null,
      })
    )
  );
  assert.equal(
    document.querySelector('.markdown-unit'),
    outerForRoleSwap,
    'outer box stays mounted while awaiting replacement'
  );
  assert.equal(document.querySelector('strong'), strong, 'prior parsed block stays mounted while replacement parses');
  assert.equal(document.querySelector('p.markdown-plain'), null, 'does not downgrade to raw plain text');
  assert.ok(document.querySelector('[data-transcript-pending]'), 'marks replacement parse pending');

  // Replacement AST with a different role at the same offset swaps in cleanly.
  const nextAst = parseMarkdownToHast('## Heading replacement');
  const nextUnits = unitsOf(nextAst, 0, 0, '## Heading replacement'.length);
  assert.equal(nextUnits[0].slotKey, '@0');
  await act(async () =>
    root.render(
      React.createElement(MarkdownDocumentView, {
        root: markdownPagesOf(nextUnits),
        copyControl: () => null,
      })
    )
  );
  assert.equal(document.querySelector('.markdown-unit'), outerForRoleSwap, 'outer box stays identical on role swap');
  assert.equal(document.querySelector('h2')?.textContent, 'Heading replacement');
  assert.equal(document.querySelector('[data-transcript-pending]'), null);
});

test('a nonempty prior tail AST growing past the 64 KiB cap shows current tail text instead of freezing on the stale partial AST', async (t) => {
  const { document, render } = await mount(t);
  await render('Start', true);
  assert.equal(document.querySelector('p')?.textContent, 'Start', 'initial tail AST renders Start');

  const extended = `Start ${'x'.repeat(70_003)}`;
  assert.equal(extended.length, 70_009);
  await render(extended, true);
  const plain = document.querySelector('p.markdown-plain');
  assert.ok(plain, 'capped tail replaces stale partial AST with current tail text');
  assert.equal(plain.textContent.length, extended.length, 'full 70,009-char tail is visible');
  assert.equal(
    document.querySelector('[data-transcript-pending]'),
    null,
    'no pending marker once live parse is capped'
  );

  const outerAtCap = document.querySelector('.markdown-unit');
  const extendedMore = `${extended} tail`;
  await render(extendedMore, true);
  assert.equal(document.querySelector('.markdown-unit'), outerAtCap, 'subsequent capped chunks update in place');
  assert.equal(document.querySelector('p.markdown-plain')?.textContent.length, extendedMore.length);
});

test('indented code blocks with 4 spaces or a tab keep identical slotKey and outer DOM box from waiting to parsed', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const { MarkdownDocumentView } = await import('./MarkdownDocumentView');
  const { LiveMarkdownDocument, markdownPagesOf, unitsOf } = await import('./markdown-document');
  const { SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS } = await import('./markdown-worker-client');
  installFakeMarkdownWorker(t);

  for (const [label, prefix] of [
    ['4-space indented code block', '    '],
    ['tab-indented code block', '\t'],
  ]) {
    const source = `${prefix}const value = "${'a'.repeat(SYNC_MARKDOWN_PARSE_MAX_UTF16_UNITS)}";`;
    const liveDoc = new LiveMarkdownDocument(() => {});
    const waitingPages = liveDoc.update(source);
    let waitingLeaf = waitingPages;
    while (waitingLeaf && 'items' in waitingLeaf) waitingLeaf = waitingLeaf.items[0];
    const parsedAst = parseMarkdownToHast(source);
    const parsedUnits = unitsOf(parsedAst, 0, 0, source.length);
    assert.equal(waitingLeaf.slotKey, '@0', `${label}: waiting slotKey starts at indentation offset @0`);
    assert.equal(parsedUnits[0].slotKey, '@0', `${label}: parsed slotKey starts at indentation offset @0`);

    await act(async () =>
      root.render(
        React.createElement(MarkdownDocumentView, {
          root: markdownPagesOf([waitingLeaf]),
          copyControl: () => null,
        })
      )
    );
    const outerBefore = document.querySelector('.markdown-unit');
    assert.ok(outerBefore, `${label}: renders outer unit while waiting`);

    await act(async () =>
      root.render(
        React.createElement(MarkdownDocumentView, {
          root: markdownPagesOf(parsedUnits),
          copyControl: () => null,
        })
      )
    );
    const outerAfter = document.querySelector('.markdown-unit');
    assert.equal(outerAfter, outerBefore, `${label}: outer DOM box stays identical on parse completion`);
    assert.ok(outerAfter.querySelector('pre code'), `${label}: renders parsed indented code block`);
    await act(async () => root.render(null));
  }
});

test('a top-level raw-HTML block keeps its unit key from a tail parse to the whole parse', async () => {
  const { unitsOf } = await import('./markdown-document');
  const source = 'Intro.\n\n<div>raw</div>\n';
  const start = source.indexOf('<div>');
  const htmlKey = (units) => units.find((unit) => unit.node?.type === 'text' && unit.node.value.includes('<div>'))?.key;
  const whole = htmlKey(unitsOf(parseMarkdownToHast(source), 0, 0, source.length));
  const tail = htmlKey(unitsOf(parseMarkdownToHast(source.slice(start)), start, start, source.length));
  assert.equal(whole, `text@${start}`);
  assert.equal(tail, whole, 'the settled parse finds the live unit by its key');
});
