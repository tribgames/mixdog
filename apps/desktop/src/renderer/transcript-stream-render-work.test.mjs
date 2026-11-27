import { renderCount, resetRenderCount } from './test-support/react-render-count.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

import { preloadSyncMarkdownParser, SYNC_MARKDOWN_PARSE_BUDGET_MS } from './markdown-worker-client';
import { preloadMarkdownBody } from './markdown-body-loader';
import { PAGE_FANOUT, PAGE_LEVELS } from './markdown-document';
import { MarkdownResponse } from './MarkdownResponse';
import { markdownWorkCounts, resetMarkdownWorkCounts } from './markdown-work-counts';

// jsdom lays nothing out: the observer never reports, but parking keeps its
// books for every block as in the app.
class QuietIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const ROW =
  '<!doctype html><html><body><div style="overflow-y: auto; height: 600px">' +
  '<div class="transcript-virtual-row" id="root"></div></div></body></html>';

/** What one update of a live reply from `before` to `after` costs: what React
 *  rendered and visited, the block boundaries the splitter looked at, and the
 *  block entries parking looked at. */
async function workOfOneUpdate(before, after, { beforeParseStepMs = 0 } = {}) {
  const { dom, restore } = installTestDom(null, {
    html: ROW,
    jsdom: { url: 'http://localhost/' },
    expose: ['MutationObserver', 'getComputedStyle', 'Element', 'Node', 'HTMLElement'],
    globals: { IntersectionObserver: QuietIntersectionObserver },
  });
  const root = createRoot(dom.window.document.getElementById('root'));
  const realNow = performance.now.bind(performance);
  let clockMs = 0;
  let stepMs = beforeParseStepMs;
  performance.now = () => {
    clockMs += stepMs;
    return clockMs;
  };
  try {
    await preloadMarkdownBody();
    await preloadSyncMarkdownParser();
    const render = (text) =>
      act(async () => root.render(React.createElement(MarkdownResponse, { text, streaming: true })));
    resetMarkdownWorkCounts();
    await render(before);
    // Drain any microtask work queued by the initial attach (parking sync, async parse).
    await act(async () => {});
    assert.equal(dom.window.document.querySelector('[data-transcript-pending]'), null, 'initial reply settled');
    const joined = { ...markdownWorkCounts };
    stepMs = 0;
    resetRenderCount();
    resetMarkdownWorkCounts();
    await render(after);
    await act(async () => {});
    assert.equal(dom.window.document.querySelector('[data-transcript-pending]'), null, 'updated reply settled');
    const blocks = dom.window.document.querySelectorAll('[data-md-unit]').length;
    const textContent = dom.window.document.getElementById('root').textContent ?? '';
    return { ...renderCount(), ...markdownWorkCounts, joined, blocks, textContent };
  } finally {
    performance.now = realNow;
    await act(async () => root.unmount());
    restore();
  }
}

const paragraphs = (count) => Array.from({ length: count }, (_, index) => `Paragraph ${index}.`).join('\n\n');

/** The same update behind a short and a long complete prefix costs the same. */
function sameWork(short, long, label) {
  assert.ok(short.commits > 0 && short.rendered > 0, `${label}: the update was committed (${JSON.stringify(short)})`);
  assert.ok(long.blocks > short.blocks, `${label}: the long reply has more blocks (${long.blocks} / ${short.blocks})`);
  assert.deepEqual(long.names, short.names, `${label}: the same components rendered, pages included`);
  assert.equal(long.rendered, short.rendered, `${label}: rendered`);
  // Each page on the last path holds at most PAGE_FANOUT items.
  assert.ok(
    long.reconciled - short.reconciled <= PAGE_FANOUT * PAGE_LEVELS,
    `${label}: visited ${long.reconciled} fibers against ${short.reconciled}`
  );
  assert.equal(long.splitterBoundaries, short.splitterBoundaries, `${label}: splitter boundaries`);
  assert.equal(long.parkingEntries, short.parkingEntries, `${label}: parking entries`);
}

// Behind 40 and behind 3,112 complete paragraphs (three more full pages of
// pages).
const SHORT = 40;
const LONG = 40 + 3 * PAGE_FANOUT * PAGE_FANOUT;

test('a word added to a live reply costs the same however much of it is complete', async () => {
  const update = (count) => workOfOneUpdate(`${paragraphs(count)}\n\nTail`, `${paragraphs(count)}\n\nTail grows`);
  const short = await update(SHORT);
  const long = await update(LONG);
  sameWork(short, long, 'a word');
  assert.ok(
    long.joined.parkingEntries >= LONG,
    `parking took in every block as it attached (${long.joined.parkingEntries})`
  );
  assert.ok(long.parkingEntries > 0, 'parking was told of the changed block');
});

test('a block completed in a live reply costs the same however much of it is complete', async () => {
  const update = (count) =>
    workOfOneUpdate(`${paragraphs(count)}\n\nTail`, `${paragraphs(count)}\n\nTail done.\n\nNext`);
  sameWork(await update(SHORT), await update(LONG), 'a completed block');
});

test('text added inside an open fence looks at no boundary of the blocks before it', async () => {
  // Joined while the fence is open, behind 3 and behind 90 paragraphs.
  const update = (count) => {
    const open = `${paragraphs(count)}\n\n\`\`\`js\nconst a = 1;\n`;
    return workOfOneUpdate(open, `${open}const b = 2;\n`);
  };
  const short = await update(3);
  const long = await update(90);
  assert.ok(long.joined.splitterBoundaries >= 90, 'joining found the blocks');
  assert.equal(long.splitterBoundaries, 0);
  assert.equal(short.splitterBoundaries, 0);
  assert.deepEqual(long.names, short.names, 'the same components rendered');
  assert.equal(long.parkingEntries, short.parkingEntries, 'parking entries');
});

test('an open block handed off to async parsing renders the page tree only once when the parse lands', async () => {
  const update = (count) => {
    const open = `${paragraphs(count)}\n\n\`\`\`js\nconst a = 1;\n`;
    return workOfOneUpdate(open, `${open}const b = 2;\n`, {
      beforeParseStepMs: SYNC_MARKDOWN_PARSE_BUDGET_MS + 1,
    });
  };
  const short = await update(3);
  const long = await update(90);
  assert.match(short.textContent, /const b = 2;/, 'short async parse landed');
  assert.match(long.textContent, /const b = 2;/, 'long async parse landed');
  assert.equal(long.names.MarkdownResponse, 2, 'prop update plus async parse landing');
  assert.equal(long.names.MarkdownDocumentView, 1, 'document view skipped until parsed pages change');
  assert.equal(long.names.PageItems, PAGE_LEVELS, 'page spine rendered once, not twice');
  assert.deepEqual(long.names, short.names, 'short and long async handoff render the same components');
});
