#!/usr/bin/env node
// Replay of native/core/fixtures/session-host-transcript-page-cases (record-session-host-transcript-page-cases.mjs, b6f10295a) on a built
// `mixdogd`, through the desktop's own client code: the protocol client (`connect`, `sessionReducer`, `sessionStateOf`), the host adapter that
// serves the renderer (`createChatApi` + `createChatHostApi`: `readTranscriptHistory`, `prefetchSession`) and the renderer's own hook
// (`useTranscriptWindow`: the pager `TranscriptHistoryPager` and the window growth `useTranscriptHistory`), mounted in a DOM.
//
// The core is run over a data directory laid by `seed_transcript_page_session` (a connection cannot store rows; the core's own writer does,
// as it does for a stored session): the 300 rows `c0`..`c299` of the recording, and `n0`, `n1` more for the changed session.
//
// What the user sees at the end, per case, is compared whole with the recorded `snapshot.items` (96 rows, text trimmed as a stored message
// restores, ids left out: manifest `replay.normalised`):
// - an older page crosses ...: the reader follows the tail (a short first window filling the pane): the hook grows the window by a page, the
//   host reads the 32 rows held + 64 again from the core.
// - a session that changed between reads: the reader has scrolled up, so the pager reads the page before its oldest held row; while that read
//   is held in flight the tail changes (the two appended rows reach the held rows), the pager drops the page and the hook reads the window the
//   request was made for (32 held + 64 = 96 rows), not one grown from the 34 held now.
// - held rows that move while the page is in flight: as above, the held copy loses its first row while the read is held; the window read
//   again is 32 + 64 = 96 rows, not 31 + 64.
// Every wait has a deadline and a message naming what it waits for.
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/replay-session-host-transcript-page.mjs --mixdogd <exe> --seeds <dir with c300 and c302>
// The exit code is 1 on any difference.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, startCore, waitStore, within } from '../../../scripts/rust-core/lib/core-session.mjs';
import { fromExact as decodeExact } from './lib/exact.mjs';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const bin = arg('--mixdogd');
const seeds = arg('--seeds');
if (!bin || !seeds) throw new Error('--mixdogd <exe> and --seeds <dir with c300 and c302> are required');
const golden = JSON.parse(readFileSync(join(REPO_ROOT, 'native/core/fixtures/session-host-transcript-page-cases/golden.json'), 'utf8'));
const recorded = (prefix) => golden.cases.find((entry) => entry.case.startsWith(prefix));
const observed = (prefix) => decodeExact(recorded(prefix).observed);
const LIMIT = 60_000;
const ID = 'sess_page_host';
/** The recorder handed its scripted rows to the host untrimmed; a stored assistant message restores as its trimmed text. */
const rowsOf = (rows) => rows.map(({ id: _id, ...row }) => ({ ...row, ...(typeof row.text === 'string' ? { text: row.text.trim() } : {}) }));
const deferred = () => {
  let resolveIt;
  const promise = new Promise((done) => (resolveIt = done));
  return { promise, resolve: resolveIt };
};

const src = (path) => import(pathToFileURL(join(REPO_ROOT, path)).href);
const { installTestDom } = await src('apps/desktop/src/renderer/test-support/test-dom.mjs');
// react-dom decides at load whether a DOM exists: the window is installed first.
const dom = installTestDom(null, { jsdom: { url: 'http://localhost/' } });
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useTranscriptWindow } = await src('apps/desktop/src/renderer/use-transcript-history.ts');
const { createChatApi } = await src('apps/desktop/src/renderer/remote-protocol-chat.ts');
const { createChatHostApi } = await src('apps/desktop/src/renderer/remote-protocol-chat-host.ts');
const { routeService } = await src('apps/desktop/src/main/protocol/service-route.ts');
const { coreErrorForWindow } = await src('apps/desktop/src/main/protocol/core-error.ts');
const { mergeToolRows, rowOf } = await src('packages/protocol-client/src/rows.ts');

/** One case: a core over `seed`, the client holding the newest `opened` rows, the reader's request and what happens to it. */
async function replay({ prefix, seed, opened, following, move }) {
  const held = 32;
  const recording = observed(prefix);
  const name = recorded(prefix).case;
  const root = mkdtempSync(join(tmpdir(), 'session-host-page-'));
  const start = (prepare) => startCore({ bin: resolve(bin), root, clientName: 'session-host-page', prepare });
  // A first start lets the core migrate an empty data directory (its ledger and index); the seeded store then replaces the index and
  // lays the session, and the core is started over it.
  await (await start()).stop();
  const core = await start((paths) => {
    rmSync(join(paths.dataDir, 'index'), { recursive: true });
    for (const part of ['index', 'sessions']) cpSync(join(seed, part), join(paths.dataDir, part), { recursive: true });
  });
  const pane = createRoot(document.getElementById('root'));
  try {
    const { client } = core;
    const lib = await src('packages/protocol-client/src/index.ts');
    const shared = {
      routeService,
      coreErrorForWindow,
      normalizedProviderModels: (rows) => rows,
      sessionStateOf: (threadId) => lib.sessionStateOf(client, threadId),
      remoteToolOutput: () => null,
      foldRows: (items) => mergeToolRows(items.map((item) => rowOf(item)).filter(Boolean)),
    };
    const api = createChatHostApi(client, shared, createChatApi(client, shared, {}), { remoteSession: () => undefined });
    const state = () => lib.sessionStateOf(client, ID);
    // The window the renderer asks the core for (`prefetchSession`), as the renderer's own host sends it.
    const [resume] = routeService('prefetchSession', [ID, opened]).requests;
    await within(client.resumeThread(ID, resume.params.window), LIMIT, `${name}: opening the session`);
    // The window folds into the client's state from the feed after the reply.
    await within(waitStore(client, () => (state()?.items.length === opened ? true : undefined)), LIMIT, `${name}: the opened window being folded`).catch((error) => {
      throw new Error(`${error.message}; the client holds ${state()?.items.length} rows`);
    });
    assert.equal(state().transcriptHasOlder, true, `${name}: older rows exist`);

    // The read the pager sends can be held in flight (before it leaves the host adapter); the window growth is observed as the host adapter gets it.
    const reads = [];
    const grows = [];
    const entered = deferred();
    const grew = deferred();
    const hold = deferred();
    let holdFirstRead = move !== null;
    window.mixdogDesktop = {
      readTranscriptHistory: async (threadId, request) => {
        reads.push(request);
        if (holdFirstRead) {
          holdFirstRead = false;
          entered.resolve();
          await within(hold.promise, LIMIT, `${name}: the page read being released`);
        }
        return api.readTranscriptHistory(threadId, request);
      },
      prefetchSession: (threadId, items) => {
        grows.push([threadId, items]);
        const done = api.prefetchSession(threadId, items);
        grew.resolve(done);
        return done;
      },
    };

    // The renderer's own hook, over the rows the client holds (the reader sees `live`).
    let live = state().items.slice(0, held);
    let latest = null;
    const Reader = ({ items }) => {
      latest = useTranscriptWindow(ID, items, state().transcriptHasOlder === true, following);
      return null;
    };
    const show = () => act(async () => pane.render(React.createElement(Reader, { items: live })));
    await show();
    assert.deepEqual(rowsOf(latest.items), rowsOf(observed('an older page').heldBeforePage), `${name}: the rows held before the page`);
    const heldFirst = latest.items[0].id;

    await act(async () => latest.requestEarlier());
    if (move) {
      await within(entered.promise, LIMIT, `${name}: the page read reaching the host adapter`);
      live = move(live, state().items);
      await show();
      await act(async () => hold.resolve());
    }
    await within(grew.promise, LIMIT, `${name}: the window being read again`).then((done) => within(done, LIMIT, `${name}: the window read`));
    // The grown window folds into the client's state from the feed after the reply.
    await within(waitStore(client, () => (state().items.length === 96 ? true : undefined)), LIMIT, `${name}: the grown window being folded`).catch((error) => {
      throw new Error(`${error.message}; the client holds ${state().items.length} rows`);
    });
    live = state().items;
    await show();

    assert.equal(latest.historyActive, false, `${name}: the reader is on the live tail again`);
    assert.deepEqual(grows, [[ID, 96]], `${name}: the window read is the 32 rows held when the request was made plus a page`);
    if (move) assert.equal(reads[0].before, heldFirst, `${name}: the page was asked before the oldest held row`);
    else assert.deepEqual(reads, [], `${name}: a reader on the tail grows the window; no page is read`);
    assert.deepEqual(rowsOf(latest.items), rowsOf(recording.snapshot.items), `${name}: the rows displayed at the end`);
    console.log(`${name}: replayed`);
  } finally {
    await act(async () => pane.unmount());
    await core.stop();
  }
}

try {
  await replay({ prefix: 'an older page', seed: join(seeds, 'c300'), opened: 32, following: true, move: null });
  // The client's feed carries the appended rows to the held rows while the page is in flight.
  await replay({ prefix: 'a session that changed', seed: join(seeds, 'c302'), opened: 34, following: false, move: (_held, all) => all });
  // The recorder's movement: the held copy loses its first row.
  await replay({ prefix: 'held rows that move', seed: join(seeds, 'c300'), opened: 32, following: false, move: (items) => items.slice(1) });
} finally {
  dom.restore();
}
