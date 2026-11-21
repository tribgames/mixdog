// The phone's chat thread as the phone renders it (PaneConversation on the phone surface), fed by the phone's own chat adapter over a
// protocol client whose core is scripted here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { installPhonePaneDom } from './test-support/phone-pane-dom.mjs';

const protocolOptions = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const ISLAND_READ = async () => ({
  value: { supported: true, authoritative: true, snapshotKind: 'worktree', patch: '', files: [], agents: [] },
});
const threadRow = (id) => ({
  id,
  preview: '',
  title: '',
  updatedAt: 1,
  messageCount: 0,
  cwd: '/w',
  classification: {},
  projectPath: null,
});

const at = (n) => ({ at: n * 1000 });
const question = (n) => ({ id: `u${n}`, type: 'userMessage', content: [{ type: 'text', text: `question ${n}` }], meta: at(n) });
const toolCalls = (n, count) =>
  Array.from({ length: count }, (_, k) => ({
    id: `c${n}_${k}`,
    type: 'toolCall',
    name: 'read',
    input: { path: `f${k}` },
    output: 'ok',
    meta: { status: 'completed', ...at(n) },
  }));
const reply = (n) => [
  { id: `a${n}`, type: 'agentMessage', text: `answer ${n}`, meta: at(n) },
  { id: `e${n}`, type: 'turnEnd', status: 'completed', elapsedMs: 10, meta: at(n) },
];

/** One turn as the core stores it: a prompt, its reasoning, `calls` tool calls (one card), the reply and its end. */
const turn = (n, calls = 8) => [question(n), { id: `r${n}`, type: 'reasoning', meta: at(n) }, ...toolCalls(n, calls), ...reply(n)];

/** A core holding `items` behind a view of its newest 200 (store.rs WINDOW_ROWS): a resume sends the newest `lastItems` of the
 *  view, one from the window already folded replays nothing, and `thread/items/list` reads the history by position. `live`
 *  adds items to the thread while it is followed; while `withholdSnapshots` is set a resume is answered and its snapshot is not
 *  sent. */
function core(items) {
  let seq = 0;
  let link;
  const epoch = 'e1';
  const resumes = [];
  /** The id a client shows for an item, which is how the core names it to clients (a prompt by its submission). */
  const shownId = (item) => item.clientSubmissionId || item.id;
  const c = {
    resumes,
    /** Each `thread/resume` received: its window and whether it continued a fold (`resumeFrom`) or opened the thread. */
    opens: [],
    /** The cursors of the `thread/items/list` reads received. */
    reads: [],
    /** The most items one history page carries (the core cuts a page by bytes). */
    pageItems: Number.POSITIVE_INFINITY,
    withholdSnapshots: false,
    /** A rewind to `kept` items: the rest are discarded, and the feed says so by the last item kept. `hasOlder` is the core's,
     *  about its own window of the newest 200 (mutation.rs `history_reset`), whatever the client holds of it. */
    rewind(threadId, kept) {
      const hasOlder = items.length > 200;
      items.length = kept;
      link.serverSend({
        method: 'thread/historyReset',
        params: { threadId, reason: 'rewind', fromItemId: shownId(items[kept - 1]), hasOlder },
        feed: { id: threadId, epoch, seq: ++seq },
      });
      link.serverSend({
        method: 'thread/frame',
        params: { threadId, structureChanged: true },
        feed: { id: threadId, epoch, seq: ++seq },
      });
    },
    live(threadId, added) {
      for (const item of added) {
        items.push(item);
        link.serverSend({ method: 'item/completed', params: { threadId, item }, feed: { id: threadId, epoch, seq: ++seq } });
      }
      link.serverSend({
        method: 'thread/frame',
        params: { threadId, structureChanged: true },
        feed: { id: threadId, epoch, seq: ++seq },
      });
    },
    serve(request, conn) {
      link = conn;
      const { method, params } = request;
      if (method === 'thread/resume') {
        resumes.push(params.window.lastItems);
        const thread = threadRow(params.threadId);
        const from = params.resumeFrom;
        c.opens.push({ items: params.window.lastItems, continued: Boolean(from) });
        if (from && from.window?.lastItems === params.window.lastItems) {
          const subscription = { id: 's', mode: 'replay', epoch, startSeq: from.seq + 1, liveSeq: seq + 1 };
          conn.serverSend({ id: request.id, result: { thread, subscription } });
          return;
        }
        const shown = items.slice(-200).slice(-params.window.lastItems);
        const at = ++seq;
        const subscription = { id: 's', mode: 'snapshot', epoch, startSeq: at, liveSeq: at + 1 };
        conn.serverSend({ id: request.id, result: { thread, subscription } });
        if (c.withholdSnapshots) return;
        conn.serverSend({
          method: 'thread/snapshot',
          params: {
            thread,
            items: shown,
            state: { route: { provider: 'p', model: 'm' } },
            hasOlder: shown.length < items.length,
          },
          feed: { id: params.threadId, epoch, seq: at },
        });
        return;
      }
      if (method === 'thread/items/list') {
        // reads.rs `items_window_in`: an item anchor or an opaque cursor names an item, and the answer names where the history
        // goes on in the direction read (`nextCursor`) and back (`backwardsCursor`).
        c.reads.push(params.cursor);
        const anchor = typeof params.cursor === 'string' ? params.cursor : params.cursor?.itemId;
        const end = items.findIndex((item) => item.id === anchor || shownId(item) === anchor);
        assert.ok(end >= 0, `a page is read before an item the core holds: ${JSON.stringify(params.cursor)}`);
        const start = Math.max(0, end - Math.min(params.limit, c.pageItems));
        const data = items.slice(start, end);
        conn.serverSend({
          id: request.id,
          result: {
            data,
            hasOlder: start > 0,
            hasNewer: true,
            ...(start > 0 && data.length ? { nextCursor: data[0].id } : {}),
            ...(data.length ? { backwardsCursor: data.at(-1).id } : {}),
          },
        });
        return;
      }
      conn.serverSend({ id: request.id, result: {} });
    },
  };
  return c;
}

/** The questions the rendered thread shows. */
const questionsShown = (log) => [...log.textContent.matchAll(/question (\d+)/g)].map((match) => Number(match[1]));

/** The phone pane, its rows 40px tall, showing thread `t1` as the phone's chat adapter hands it the core's states.
 *
 *  `pages` are the pane's page requests (`prefetchSession`). While `pages.hold` is 'request' a page waits before the host is
 *  asked; while it is 'ack' the host is asked at once and the pane waits for its answer. `pages.release()` lets those waiting go
 *  on, in order. */
async function phoneThread(t, items, { hold = null, pageItems } = {}) {
  const pane = await installPhonePaneDom(t);
  const { dom } = pane;
  const heightOf = (element) => {
    if (element.classList.contains('transcript')) return 800;
    return element.classList.contains('transcript-virtual-row') ? 40 : 0;
  };
  class RowObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(target) {
      const blockSize = heightOf(target);
      const size = { inlineSize: 412, blockSize };
      this.callback([{ target, contentRect: { width: 412, height: blockSize }, borderBoxSize: [size] }], this);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = RowObserver;
  dom.window.ResizeObserver = RowObserver;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const height = heightOf(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 412, bottom: height, width: 412, height, toJSON() {} };
  };
  const { connect, sessionReducer } = await import('../../../../packages/protocol-client/src/index.ts');
  const { MockNetwork } = await import('../../../../packages/protocol-client/src/mock.ts');
  const { phoneChatAdapter } = await import('./remote-protocol-chat.ts');
  const { createRemoteSessionInbox } = await import('./remote-session-inbox.ts');
  const c = core(items);
  if (pageItems) c.pageItems = pageItems;
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: protocolOptions.clientInfo,
    capabilities: protocolOptions.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  void (async () => {
    for (;;) c.serve(JSON.parse(await conn.nextSent()), conn);
  })();
  const client = await connecting;
  const ctx = {
    sessionsCatalog: { publish() {} },
    sessionInbox: createRemoteSessionInbox({ onGap() {} }),
    viewSettledListeners: new Set(),
    phone: { start: () => new Promise(() => undefined) },
  };
  const host = { ctx, client: () => client, declareLane() {}, onClient: (listener) => (listener(client), () => {}) };
  ctx.sessionInbox.subscribe((update) => pane.defaultSessionLaneStore.apply(update));
  const adapter = phoneChatAdapter();
  const stop = adapter.install(host);
  t.after(async () => {
    stop();
    await client.close();
  });
  const pages = { hold, waiting: [], release: async () => {} };
  dom.window.mixdogDesktop = {
    prefetchSession: (sessionId, limit) => {
      const ask = () => adapter.calls.prefetchSession([sessionId, limit], host);
      if (!pages.hold) return ask();
      const answer = pages.hold === 'ack' ? ask() : null;
      answer?.catch(() => {});
      return new Promise((resolve, reject) => pages.waiting.push(() => (answer ?? ask()).then(resolve, reject)));
    },
    readTranscriptHistory: (sessionId, request) => adapter.calls.readTranscriptHistory([sessionId, request], host),
    invokeCapability: ISLAND_READ,
  };
  const settle = async (rounds) => {
    for (let round = 0; round < rounds; round += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      await act(async () => {
        for (const [id, callback] of [...pane.frames]) {
          pane.frames.delete(id);
          callback(performance.now());
        }
      });
    }
  };
  /** The phone's view opens the pane's thread (phone-view.ts VIEW_WINDOW), and the pane shows it. */
  const open = async () => {
    await client.resumeThread('t1', { lastItems: 50 }, { join: true, follow: true });
    await settle(1);
    await act(async () => pane.root.render(pane.element('t1')));
    await settle(40);
  };
  pages.release = async (count = pages.waiting.length) => {
    for (const next of pages.waiting.splice(0, count)) next();
    await settle(6);
  };
  await open();
  const log = () => pane.dom.window.document.querySelector('.transcript');
  /** The reader scrolls to the top of what the pane holds, again after each page lands, up to `rounds` times. */
  const scrollToTop = async (rounds) => {
    for (let round = 0; round < rounds && !questionsShown(log()).includes(0); round += 1) {
      const element = log();
      await act(async () => {
        element.dispatchEvent(new pane.dom.window.WheelEvent('wheel', { deltaY: -element.scrollHeight, bubbles: true }));
        element.scrollTop = 0;
        element.dispatchEvent(new pane.dom.window.Event('scroll'));
      });
      await settle(4);
    }
  };
  /** The pane closes and the view lets the thread go; `open` shows it again. */
  const close = async () => {
    await act(async () => pane.root.render(null));
    await client.unsubscribeThread('t1');
    await settle(1);
  };
  /** The pane's Retry as the phone's adapter forwards it (remote-shim-api.ts `prefetchSession`). */
  const retry = () => adapter.calls.prefetchSession(['t1', undefined, undefined, { retry: true }], host);
  /** A read of the thread's state: no rows named (session-read-request.ts). */
  const readState = () => adapter.calls.prefetchSession(['t1', undefined, 'trace-1'], host);
  return { pane, settle, log, scrollToTop, open, close, c, pages, retry, readState };
}

const lane = (items, fields = {}) => ({
  sessionId: 's',
  frameSource: 'live',
  snapshot: { sessionId: 's', provider: 'p', model: 'm', transcriptHasOlder: true, items, ...fields },
});
const exchange = (prefix, count) =>
  Array.from({ length: count }, (_, i) => ({
    kind: i % 2 ? 'assistant' : 'user',
    id: `${prefix}${i}`,
    text: `${prefix} ${i % 2 ? 'answer' : 'question'} ${i}`,
  }));

/** The phone pane over `recent` (and the lane `fields`: `busy` for a thread whose turn runs), with "hello phone" typed and sent;
 *  the PC has not answered. `bubble()` is where the sent message is drawn in the viewport (its top less the scroll offset), null
 *  when it is not drawn; `settle(sample)` runs the timers and the frames, sampling after each frame. */
async function sentFromPhone(t, recent, fields) {
  const pane = await installPhonePaneDom(t);
  const doc = pane.dom.window.document;
  pane.defaultSessionLaneStore.apply(lane(recent, fields));
  pane.dom.window.mixdogDesktop = { prefetchSession: () => new Promise(() => {}), invokeCapability: ISLAND_READ };
  const sent = [];
  const props = { ...pane.props('s'), submit: (_content, options) => new Promise(() => sent.push(options.id)) };
  const settle = async (sample = () => {}) => {
    for (let round = 0; round < 6; round += 1) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      sample();
      await act(async () => {
        for (const [id, callback] of [...pane.frames]) {
          pane.frames.delete(id);
          callback(performance.now());
        }
      });
      sample();
    }
  };
  await act(async () => pane.root.render(React.createElement(pane.PaneConversation, props)));
  await settle();
  const textarea = doc.querySelector('textarea');
  const setValue = Object.getOwnPropertyDescriptor(pane.dom.window.HTMLTextAreaElement.prototype, 'value').set;
  await act(async () => {
    setValue.call(textarea, 'hello phone');
    textarea.dispatchEvent(new pane.dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => {
    doc.querySelector('form').dispatchEvent(new pane.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const bubble = () => {
    const rows = [...doc.querySelectorAll('.transcript-virtual-row')].filter((row) =>
      row.querySelector('.message.user')?.textContent.includes('hello phone')
    );
    assert.ok(rows.length <= 1, 'the message is drawn once');
    return rows[0] ? Number.parseFloat(rows[0].style.top) - doc.querySelector('.transcript').scrollTop : null;
  };
  const apply = (items, fields) => act(async () => pane.defaultSessionLaneStore.apply(lane(items, fields)));
  return { bubble, apply, settle, sent, own: () => ({ kind: 'user', id: sent[0], text: 'hello phone' }) };
}

test('a sent message stays put on screen while an older page lands before its own row, and when its row replaces it', async (t) => {
  const recent = exchange('recent', 6);
  const { bubble, apply, settle, own } = await sentFromPhone(t, recent);
  const landed = bubble();
  assert.notEqual(landed, null, 'the message shows as it is sent');
  const seen = [];
  const sample = () => seen.push(bubble());
  // History the phone asked for before the send lands first: older questions above the window.
  await apply([...exchange('older', 6), ...recent]);
  sample();
  await settle(sample);
  // Its own row arrives with the turn it started.
  await apply([...exchange('older', 6), ...recent, own()], { busy: true });
  sample();
  await settle(sample);
  assert.deepEqual(
    [...new Set(seen)],
    [landed],
    'the message is drawn, in one place on screen, through every frame of the page and of its own row'
  );
});

test("another device's message landing first leaves this phone's sent message drawn until its own row", async (t) => {
  const recent = exchange('recent', 6);
  const { bubble, apply, settle, own } = await sentFromPhone(t, recent);
  assert.notEqual(bubble(), null);
  const other = { kind: 'user', id: 'from-the-pc', text: 'sent on the PC' };
  await apply([...recent, other], { busy: true });
  await settle();
  assert.notEqual(bubble(), null, "the PC's row does not take the phone's message away");
  await apply([...recent, other, { kind: 'assistant', id: 'pc-answer', text: 'ok' }, own()], { busy: true });
  await settle();
  assert.notEqual(bubble(), null, 'its own row shows the message');
});

test("a message queued behind a running turn stays drawn when it leaves the queue and the PC's row lands, until its own row", async (t) => {
  const recent = exchange('recent', 6);
  const { bubble, apply, settle, sent, own } = await sentFromPhone(t, recent, { busy: true });
  assert.notEqual(bubble(), null, 'the message shows as it is sent');
  // The core holds it in the thread's queue, under the submission id.
  await apply(recent, { busy: true, queued: [{ id: sent[0], displayText: 'hello phone', submittedAt: 5 }] });
  await settle();
  assert.notEqual(bubble(), null, 'the queued message is drawn');
  // The queue empties and a user row lands: the PC's, sent into the same thread.
  const other = { kind: 'user', id: 'from-the-pc', text: 'sent on the PC', steered: true };
  await apply([...recent, other], { busy: true, queued: [] });
  await settle();
  assert.notEqual(bubble(), null, "the PC's row does not take the phone's waiting message away");
  // That turn ends without the phone's row.
  const ended = [...recent, other, { kind: 'assistant', id: 'pc-answer', text: 'ok' }, { kind: 'turndone', id: 'pc-end' }];
  await apply(ended, { queued: [] });
  await settle();
  assert.notEqual(bubble(), null, 'nor does the end of that turn');
  await apply([...ended, own()], { busy: true, queued: [] });
  await settle();
  assert.notEqual(bubble(), null, 'its own row shows the message');
});

const liveReasoning = (count) =>
  Array.from({ length: count }, (_, k) => ({ id: `live-r${k}`, type: 'reasoning', meta: at(99) }));
const liveNotes = (count) =>
  Array.from({ length: count }, (_, k) => ({ id: `live-a${k}`, type: 'agentMessage', text: `note ${k}`, meta: at(99) }));

test('a page asked after reasoning arrived live reaches past every item the phone holds', async (t) => {
  // The first window is question 1 and its 49 calls; the page it asks waits while the turn reasons.
  const thread = [question(0), ...toolCalls(0, 60), question(1), ...toolCalls(1, 49)];
  const { log, c, pages, settle } = await phoneThread(t, thread, { hold: 'request' });
  assert.deepEqual(questionsShown(log()), [1]);
  assert.equal(pages.waiting.length, 1, 'the pane, not filled, asked for a page');
  c.live('t1', liveReasoning(70));
  await settle(4);
  pages.hold = null;
  await pages.release();
  assert.ok(c.resumes.at(-1) > 120, `the page asks past the 120 items held: ${c.resumes}`);
  assert.deepEqual(questionsShown(log()), [0, 1], 'older history joined above the question already shown');
});

test('a page whose rows arrived live before the host took it leaves no page waiting, and the next one is asked', async (t) => {
  // One card in the pane: the page asks for 65 rows, and 70 rows land live before the host handles it.
  const { log, c, pages, settle, scrollToTop } = await phoneThread(t, [question(0), ...toolCalls(0, 100)], {
    hold: 'request',
  });
  assert.deepEqual(questionsShown(log()), []);
  assert.equal(pages.waiting.length, 1);
  c.live('t1', liveNotes(70));
  await settle(6);
  pages.hold = null;
  await pages.release();
  await settle(20);
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false, 'no page is left waiting');
  assert.ok(c.resumes.at(-1) > 120, `a page was asked of the core after the one that asked for nothing: ${c.resumes}`);
  // The pane follows the live rows at its end; the history that page brought is above them.
  await scrollToTop(1);
  assert.deepEqual(questionsShown(log()), [0], 'and it brought the history above the card');
});

test('a pane that cannot scroll keeps filling when each page is published before it is acknowledged', async (t) => {
  // One card until the question is reached, two pages away; no acknowledgement arrives.
  const { log, pages } = await phoneThread(t, [question(0), ...toolCalls(0, 150)], { hold: 'ack' });
  assert.ok(pages.waiting.length > 1, `each published page was followed by the next request: ${pages.waiting.length}`);
  assert.deepEqual(questionsShown(log()), [0], 'the pane filled back to the question');
  pages.hold = null;
  await pages.release();
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false);
  assert.deepEqual(questionsShown(log()), [0]);
});

test('a thread closed while a page was on its way pages again when it is opened again', async (t) => {
  const { log, open, close, c, pages, settle } = await phoneThread(t, [question(0), ...toolCalls(0, 60), ...reply(0)], {
    hold: 'request',
  });
  assert.equal(pages.waiting.length, 1);
  // The page's resume is answered; the thread is let go before its snapshot.
  c.withholdSnapshots = true;
  await pages.release();
  assert.ok(c.resumes.at(-1) > 50, 'the page went to the core');
  await close();
  c.withholdSnapshots = false;
  pages.hold = null;
  const asked = c.resumes.length;
  await open();
  await settle(10);
  assert.ok(
    c.resumes.slice(asked).some((items) => items > 50),
    `the reopened thread's page was sent: ${c.resumes.slice(asked)}`
  );
  assert.deepEqual(questionsShown(log()), [0]);
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false);
});

test('a complete thread that grew live past 512 rows asks for no page and holds no read back', async (t) => {
  // The thread's start is in the window; the host says so, and nothing older exists to ask for.
  const { log, c, settle, scrollToTop } = await phoneThread(t, [question(0), ...reply(0)]);
  c.live('t1', liveNotes(520));
  await settle(10);
  await scrollToTop(1);
  await settle(4);
  assert.deepEqual(questionsShown(log()), [0]);
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false, 'no page is waited for: tool outputs load');
  assert.deepEqual(c.resumes, [50], 'and none was asked of the core');
});

test('history pages that hold only reasoning are passed by their continuation, up to the first question', async (t) => {
  // Beyond the core's view the pane reads by position, twenty items a page: one page is reasoning alone and brings no row.
  const reasoning = Array.from({ length: 30 }, (_, k) => ({ id: `r0_${k}`, type: 'reasoning', meta: at(0) }));
  const { log, c } = await phoneThread(t, [question(0), ...reasoning, ...toolCalls(0, 210)], { pageItems: 20 });
  assert.deepEqual(questionsShown(log()), [0], 'the pane read past the page without rows');
  // The page before the first call is twenty reasoning items; the next one starts where the core said that page began.
  assert.deepEqual(c.reads.slice(-2), ['c0_0', 'r0_10'], `the reads: ${JSON.stringify(c.reads)}`);
  assert.equal(new Set(c.reads.map((cursor) => JSON.stringify(cursor))).size, c.reads.length, 'no page was read twice');
});

test("a rewind that keeps the window's first item is another window: its page is asked of the core again", async (t) => {
  // The view ends above the window, so the pane reads the question by position; then the tail is rewound.
  const { log, c, settle } = await phoneThread(t, [question(0), ...toolCalls(0, 300), ...reply(0)]);
  assert.deepEqual(questionsShown(log()), [0]);
  const asked = c.resumes.length;
  const read = c.reads.length;
  // 152 items stay: the fold keeps its first fifty, from the same item on, and the core's view now reaches the question.
  c.rewind('t1', 152);
  await settle(20);
  assert.ok(c.resumes.length > asked, `the window is grown again after the rewind: ${c.resumes.slice(asked)}`);
  assert.equal(c.reads.length, read, 'not read by position on the strength of the old window');
  assert.deepEqual(questionsShown(log()), [0]);
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false);
});

test('a rewind above everything the phone holds leaves a window that pages in what the rewind kept', async (t) => {
  // The core holds all 100 items; the phone holds the newest fifty (its page waits and is never served).
  const thread = [question(0), ...toolCalls(0, 39), question(1), ...toolCalls(1, 59)];
  const { log, c, pages, settle } = await phoneThread(t, thread, { hold: 'request' });
  assert.deepEqual(c.resumes, [50]);
  pages.waiting.length = 0;
  pages.hold = null;
  // Items 1 to 40 stay: the boundary is above the phone's window, and the core, holding the whole thread, says nothing is older.
  c.rewind('t1', 40);
  await settle(20);
  assert.ok(c.resumes.length > 1, `the emptied window asked for a page: ${c.resumes}`);
  assert.deepEqual(questionsShown(log()), [0], 'what the rewind kept is shown');
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false);
});

test('a read of the state of a thread the phone holds puts nothing on the wire', async (t) => {
  // Older history exists and the pane's own page waits unserved: the state read is not a page either.
  const { log, c, settle, readState } = await phoneThread(t, [question(0), ...toolCalls(0, 100), question(1)], {
    hold: 'request',
  });
  const opens = c.opens.length;
  assert.equal(await readState(), true, 'the state is held: the read is answered');
  assert.equal(await readState(), true);
  await settle(4);
  assert.deepEqual(c.opens.slice(opens), [], 'no resume was sent');
  assert.deepEqual(questionsShown(log()), [1]);
});

test("the phone's Retry opens the thread anew instead of joining what is out", async (t) => {
  const { log, c, settle, retry } = await phoneThread(t, [question(0), ...reply(0)]);
  const opens = c.opens.length;
  assert.equal(await retry(), true);
  await settle(4);
  assert.deepEqual(c.opens.slice(opens), [{ items: 50, continued: false }], 'one resume, with no fold to continue');
  assert.deepEqual(questionsShown(log()), [0], 'the reopened thread is shown');
});

test("what a fold holds of the core's items is read from the fold: rowless items, a dropped head, a cut tail, a window that moved", async () => {
  const { sessionReducer, desktopSessionState, FOLD_MAX_ITEMS } = await import(
    '../../../../packages/protocol-client/src/session-state.ts'
  );
  const { pageWindow, pageLanded } = await import('./remote-protocol-chat.ts');
  const snapshot = (items, hasOlder = true) => sessionReducer.initial({ thread: { id: 't' }, state: {}, items, hasOlder });
  const completed = (fold, item) => sessionReducer.apply(fold, { method: 'item/completed', params: { item } });
  const rowsOf = (fold) => desktopSessionState(fold, []).items.length;
  // A prompt and 49 calls: two rows. Reasoning that arrives live has no row and is held all the same.
  const opened = snapshot([question(1), ...toolCalls(1, 49)]);
  const reasoned = liveReasoning(70).reduce(completed, opened);
  assert.equal(rowsOf(reasoned), 2);
  assert.equal(pageWindow(reasoned, rowsOf(reasoned), 66), 184, '120 items held, 64 rows more');
  assert.equal(desktopSessionState(reasoned, []).transcriptWindowStart, 'u1');
  // The same items again are not held twice.
  assert.equal(pageWindow(liveReasoning(70).reduce(completed, reasoned), 2, 66), 184);
  // A window that lost its oldest items moved toward newer history: no page. One that holds the old start below older items is.
  const newer = snapshot([...toolCalls(1, 49).slice(6), ...liveReasoning(70)]);
  assert.equal(pageLanded(reasoned, newer), false);
  assert.equal(pageLanded(reasoned, snapshot([question(1), ...toolCalls(1, 49)])), false, 'the same window again');
  assert.equal(pageLanded(reasoned, snapshot([...toolCalls(0, 5), question(1), ...toolCalls(1, 49)])), true);
  assert.equal(pageLanded(reasoned, snapshot([question(1)], false)), true, "the thread's start is held");
  // Rows cut back by a reset take their items along.
  const reset = (fold, fromItemId) =>
    sessionReducer.apply(fold, { method: 'thread/historyReset', params: { fromItemId, hasOlder: true } });
  const cut = reset(reasoned, 'c1_9');
  assert.equal(pageWindow(cut, rowsOf(cut), 66), 11 + 66 - rowsOf(cut));
  assert.deepEqual(
    [desktopSessionState(reasoned, []).transcriptGeneration, desktopSessionState(cut, []).transcriptGeneration],
    [0, 1],
    'a reset is another generation of the window, which still begins at the same item'
  );
  assert.equal(desktopSessionState(cut, []).transcriptWindowStart, 'u1');
  // The core names the boundary by the id a client shows: a prompt's submission id, where the item's own id is another.
  const sent = (n) => ({ ...question(n), clientSubmissionId: `sub-${n}` });
  const held = (fold) => [fold.items.map((row) => row.id), fold.coreItems];
  const turns = snapshot([sent(1), { id: 'r1', type: 'reasoning', meta: at(1) }, ...reply(1), sent(2), ...reply(2)]);
  assert.deepEqual(
    held(reset(turns, 'sub-1')),
    [['sub-1'], ['u1']],
    'a rewind to a prompt keeps that prompt and nothing after it, rows and items alike'
  );
  // A boundary with no row (reasoning): the rows of the items after it go, the ones before it stay.
  assert.deepEqual(held(reset(turns, 'r1')), [['sub-1'], ['u1', 'r1']]);
  assert.deepEqual(held(reset(turns, 'e1')), [
    ['sub-1', 'a1', 'e1'],
    ['u1', 'r1', 'a1', 'e1'],
  ]);
  // The reset's `hasOlder` is the core's, about its own window. A boundary above this window takes all it holds and leaves
  // what the rewind kept above it; one inside it leaves above it what was there; a clear leaves nothing.
  const said = (fold, params) =>
    desktopSessionState(sessionReducer.apply(fold, { method: 'thread/historyReset', params }), []).transcriptHistory;
  const emptied = sessionReducer.apply(turns, { method: 'thread/historyReset', params: { fromItemId: 'u0', hasOlder: false } });
  assert.deepEqual([...held(emptied), desktopSessionState(emptied, []).transcriptHistory], [[], [], 'older']);
  assert.equal(pageLanded(emptied, snapshot([question(0)], true)), true, 'any item is older history to an empty window');
  assert.equal(said(turns, { fromItemId: 'e1', hasOlder: false }), 'older');
  assert.equal(said(snapshot([sent(1), ...reply(1)], false), { fromItemId: 'sub-1', hasOlder: false }), 'held');
  assert.equal(said(turns, { hasOlder: false }), 'held');
  // Whether the start is held is stated either way, never left to an absent field.
  assert.equal(desktopSessionState(snapshot([question(0)], false), []).transcriptHistory, 'held');
  assert.equal(desktopSessionState(turns, []).transcriptHistory, 'older');
  assert.equal(desktopSessionState(reset(turns, 'e1'), []).transcriptHistory, 'older');
  // A fold past its bound drops its oldest rows, and its window begins at the first row kept.
  let long = snapshot([question(0)], false);
  for (let k = 0; k < FOLD_MAX_ITEMS + 2; k += 1)
    long = completed(long, { id: `n${k}`, type: 'agentMessage', text: `${k}`, meta: at(1) });
  assert.equal(desktopSessionState(long, []).transcriptWindowStart, 'n2');
  assert.equal(pageWindow(long, FOLD_MAX_ITEMS, FOLD_MAX_ITEMS + 64), FOLD_MAX_ITEMS + 64);
});

test('a phone opening one question followed by a long run of tool calls shows the question', async (t) => {
  const { log } = await phoneThread(t, [question(0), ...toolCalls(0, 110), ...reply(0)]);
  assert.deepEqual(questionsShown(log()), [0], 'the run folds to one card: the window grew past it to the question');
});

test("a phone opening a run of tool calls longer than the core's view reads the question above it by position", async (t) => {
  const { log } = await phoneThread(t, [question(0), ...toolCalls(0, 300), ...reply(0)]);
  assert.deepEqual(questionsShown(log()), [0]);
});

test('a phone scrolls a long thread of tool runs back to its first question', async (t) => {
  const { log, scrollToTop } = await phoneThread(
    t,
    Array.from({ length: 30 }, (_, n) => turn(n)).flat()
  );
  await scrollToTop(30);
  assert.ok(questionsShown(log()).includes(0), `the oldest question on screen: ${Math.min(...questionsShown(log()))}`);
});

test('a thread opened again pages its history in again', async (t) => {
  // One page past the view's first window holds the whole thread.
  const { log, open, close, c } = await phoneThread(t, [question(0), ...toolCalls(0, 60), ...reply(0)]);
  assert.deepEqual(questionsShown(log()), [0]);
  await close();
  const asked = c.resumes.length;
  await open();
  assert.deepEqual(questionsShown(log()), [0]);
  assert.ok(
    c.resumes.slice(asked).some((items) => items > 50),
    `the reopened thread's window grew again: ${c.resumes.slice(asked)}`
  );
  const { historyPagePending } = await import('./tool-full-output.tsx');
  assert.equal(historyPagePending(), false, 'no page is left waiting, so tool outputs load');
});

