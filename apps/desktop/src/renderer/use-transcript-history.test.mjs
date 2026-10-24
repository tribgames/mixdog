import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  TRANSCRIPT_HISTORY_TOP_PX,
  transcriptHistoryLead,
  useTranscriptHistory,
  useTranscriptHistoryFill,
} from './use-transcript-history.ts';
import { registerTranscriptScrollGeometry } from './use-transcript-follow.ts';
import { historyPagePending, resetFullToolOutputs } from './tool-full-output.tsx';

/** A DOM whose desktop bridge records each `prefetchSession` request so a test
 *  can settle it by hand. */
function installHistoryDom() {
  const { restore } = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
  const requests = [];
  window.mixdogDesktop = {
    prefetchSession(sessionId, limit) {
      const result = Promise.withResolvers();
      requests.push({ sessionId, limit, ...result });
      return result.promise;
    },
  };
  return { restore, requests };
}

async function restoreHistoryDom({ restore, requests }, root) {
  await act(async () => {
    for (const request of requests) request.resolve(false);
    root.unmount();
  });
  restore();
}

test('tail windows page older history from transcriptHasOlder, one page per published window', async () => {
  const env = installHistoryDom();
  const { requests } = env;
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
    // The host bounds a page by bytes: it can land with fewer than 64 rows,
    // and the next page still follows from what landed.
    await render(95, true);
    await earlier();
    assert.equal(requests[2].limit, 159, 'a byte-budgeted page does not stall paging');
    await act(async () => requests[2].resolve(true));
    await render(120, false);
    await earlier();
    assert.equal(requests.length, 3, 'the host said no older history exists');
    // A host that predates transcriptHasOlder keeps the count-based pages.
    await render(512, undefined);
    await earlier();
    assert.equal(requests[3].limit, 1024);
  } finally {
    await restoreHistoryDom(env, root);
  }
});

test('background output reads stay held after a page ACK until the page is applied, and not past a failure or a leave', async () => {
  const env = installHistoryDom();
  const { requests } = env;
  resetFullToolOutputs();
  const root = createRoot(document.getElementById('root'));
  const Reader = ({ sessionId, count, hasOlder }) =>
    React.createElement(
      'button',
      { type: 'button', onClick: useTranscriptHistory(sessionId, count, hasOlder) },
      'Earlier'
    );
  const render = (count, hasOlder = true, sessionId = 'a') =>
    act(async () => {
      root.render(React.createElement(Reader, { sessionId, count, hasOlder }));
    });
  const earlier = () => act(async () => document.querySelector('button').click());
  try {
    await render(8);
    await earlier();
    assert.equal(historyPagePending(), true, 'held while the page is asked for');
    await act(async () => requests[0].resolve(true));
    assert.equal(historyPagePending(), true, 'the ACK is not the page');
    await render(8);
    assert.equal(historyPagePending(), true, 'a frame without the page keeps the hold');
    await render(40);
    assert.equal(historyPagePending(), false, 'released once the page rows are applied');
    // A page that lands before its ACK releases as it lands.
    await earlier();
    await render(60);
    assert.equal(historyPagePending(), false);
    await act(async () => requests[1].resolve(true));
    assert.equal(historyPagePending(), false);
    // The host saying nothing older exists ends the wait too.
    await earlier();
    await act(async () => requests[2].resolve(true));
    await render(60, false);
    assert.equal(historyPagePending(), false);
    // A failed or refused read releases at once.
    await render(70, true);
    await earlier();
    await act(async () => requests[3].reject(new Error('connection lost')));
    assert.equal(historyPagePending(), false, 'a failure releases');
    await earlier();
    await act(async () => requests[4].resolve(false));
    assert.equal(historyPagePending(), false, 'a refusal releases');
    // Leaving the session cancels the wait.
    await earlier();
    await act(async () => requests[5].resolve(true));
    assert.equal(historyPagePending(), true);
    await render(8, true, 'b');
    assert.equal(historyPagePending(), false, 'a session switch releases');
    await earlier();
    assert.equal(historyPagePending(), true);
    await act(async () => root.unmount());
    assert.equal(historyPagePending(), false, 'unmounting releases');
  } finally {
    await act(async () => {
      for (const request of requests) request.resolve(false);
    });
    env.restore();
  }
});

test('a scroll asks for older history screens before the top, so a fling never runs out of rows first', () => {
  // #104: a phone fling crosses hundreds of px per frame; asked for only at
  // the old 320px band, it hit the top edge and died before the page landed.
  assert.equal(transcriptHistoryLead(711), 7_110);
  // An unmeasured or tiny pane still asks within the old band.
  assert.equal(transcriptHistoryLead(0), TRANSCRIPT_HISTORY_TOP_PX);
  assert.equal(transcriptHistoryLead(20), TRANSCRIPT_HISTORY_TOP_PX);
});

test('a first window that does not fill the pane loads older history without a scroll', async () => {
  const env = installHistoryDom();
  const { requests } = env;
  // The pane is 900 px tall; the transcript's height is whatever the test says.
  const geometry = { content: 400 };
  const root = createRoot(document.getElementById('root'));
  const Reader = ({ count, hasOlder, ready }) => {
    const viewport = React.useRef(null);
    const requestEarlier = useTranscriptHistory('a', count, hasOlder);
    useTranscriptHistoryFill(viewport, requestEarlier, count, ready);
    return React.createElement('div', {
      ref: (element) => {
        viewport.current = element;
        if (!element) return;
        // The mounted timeline answers for the pane's extent.
        registerTranscriptScrollGeometry(element, {
          viewportHeight: () => 900,
          contentHeight: () => geometry.content,
          scrollTop: () => 0,
        });
      },
    });
  };
  const render = (count, hasOlder, ready = true) =>
    act(async () => {
      root.render(React.createElement(Reader, { count, hasOlder, ready }));
    });
  try {
    // Not revealed yet: geometry is not settled, nothing is asked.
    await render(8, true, false);
    assert.equal(requests.length, 0);
    // Eight huge rows collapse to 400 px: nothing to scroll, so the pane
    // asks for the next page on its own.
    await render(8, true);
    assert.deepEqual(
      requests.map(({ limit }) => limit),
      [72]
    );
    await act(async () => requests[0].resolve(true));
    // The page landed and still does not fill the pane: one more.
    geometry.content = 800;
    await render(16, true);
    assert.equal(requests[1]?.limit, 80);
    await act(async () => requests[1].resolve(true));
    // It scrolls now, but holds less than the scroll lead (10 screens) above
    // the tail: a fling could cross it before the next page's round trip, so
    // the pane keeps asking before the reader can fling.
    geometry.content = 2_000;
    await render(24, true);
    assert.equal(requests[2]?.limit, 88);
    await act(async () => requests[2].resolve(true));
    // Past the lead: scrolling takes over.
    geometry.content = 900 + 9_001;
    await render(32, true);
    assert.equal(requests.length, 3);
    // A short session with nothing older never pages.
    geometry.content = 300;
    await render(40, false);
    assert.equal(requests.length, 3);
  } finally {
    await restoreHistoryDom(env, root);
  }
});

test('a scrollable first window extends toward the lead by at most four pages per entry', async () => {
  const env = installHistoryDom();
  const { requests } = env;
  const geometry = { content: 2_000 };
  const root = createRoot(document.getElementById('root'));
  const Reader = ({ count, ready }) => {
    const viewport = React.useRef(null);
    const requestEarlier = useTranscriptHistory('a', count, true);
    useTranscriptHistoryFill(viewport, requestEarlier, count, ready);
    return React.createElement('div', {
      ref: (element) => {
        viewport.current = element;
        if (!element) return;
        registerTranscriptScrollGeometry(element, {
          viewportHeight: () => 900,
          contentHeight: () => geometry.content,
          scrollTop: () => 0,
        });
      },
    });
  };
  const render = (count, ready = true) =>
    act(async () => {
      root.render(React.createElement(Reader, { count, ready }));
    });
  try {
    // Pages of tiny rows barely grow the transcript: the lead is never
    // reached, and an entry must not page the whole history in for it.
    for (const count of [8, 16, 24, 32]) {
      await render(count);
      await act(async () => requests.at(-1).resolve(true));
      geometry.content += 10;
    }
    assert.equal(requests.length, 4);
    await render(40);
    assert.equal(requests.length, 4, 'the fifth page waits for a scroll');
    // Re-entry (the transcript is revealed again) earns a fresh allowance.
    await render(40, false);
    await render(40);
    assert.equal(requests.length, 5);
  } finally {
    await restoreHistoryDom(env, root);
  }
});

test('cold history pages load on demand, survive delayed publications and stay session-scoped', async () => {
  const env = installHistoryDom();
  const { requests } = env;
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
    await restoreHistoryDom(env, root);
  }
});
