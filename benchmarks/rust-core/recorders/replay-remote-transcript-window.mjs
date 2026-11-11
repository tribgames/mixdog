// The replay of record-remote-transcript-window-cases.mjs on K1: what a phone ends up showing of a thread, through the phone's own
// transcript window (apps/desktop/src/main/remote-phone-transcript.ts) over the thread's rows as the phone folds them
// (packages/protocol-client). Run by mixdog-core-session client_chain_replay_tests.rs, which answers the core's half (lib/core-bridge.mjs):
// each case's rows are stored in a thread of the core, the phone resumes it (`thread/resume`, the window phone-view.ts asks for),
// folds its snapshot and feed, and pages older rows with `thread/items/list`. Compared whole with what Node's phone held: the
// rows (`items`) and `transcriptHasOlder` of each delivered state (Node's delta-wire text is Node's transport, not K1's).
//
// Three cases cannot hold their rows in a core, so their rows are the recording's own inputs given to the same window as the
// phone's fold (the `fold` input), and only the core's reads are stood in for:
//  - 1 and 5 are tool rows: the phone folds a run of finished tool rows into one aggregate card (rows.ts mergeToolRows), so 16
//    separate finished shell rows, or a hand-made aggregate, are no transcript a thread's feed folds to;
//  - 6 is Node's runtime spill buffer with an archived compaction (`archived` rows): the core keeps its whole log.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { fromExact } from './lib/exact.mjs';
import { coreBridge } from './lib/core-bridge.mjs';
import { desktopSessionState, sessionReducer } from '../../../packages/protocol-client/src/session-state.ts';
import { mergeToolRows, rowOf } from '../../../packages/protocol-client/src/rows.ts';
import { createPhoneTranscript } from '../../../apps/desktop/src/main/remote-phone-transcript.ts';
import { viewIsStale } from '../../../apps/desktop/src/main/remote-view-staleness.ts';
import { VIEW_WINDOW } from '../../../apps/mobile/src/phone-view.ts';

const golden = fromExact(JSON.parse(readFileSync(new URL('../../../native/core/fixtures/remote-transcript-window-cases/golden.json', import.meta.url), 'utf8')));
const recorded = (name) => golden.cases.find((c) => c.case === name)?.observed ?? (() => { throw new Error(`no case ${name}`); })();
const core = coreBridge();
const failures = [];
const same = (name, what, actual, expected) => {
  if (!isDeepStrictEqual(actual, expected)) failures.push({ case: name, what, actual, expected });
};
/** What the phone held of a delivered state: Node's recorder delivered `{items, transcriptHasOlder}` snapshots. */
const held = (state) => ({ items: state.items, transcriptHasOlder: state.transcriptHasOlder });
const itemBytes = (items) => items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
const foldRows = (items) => mergeToolRows(items.map((item) => rowOf(item)).filter(Boolean));

// The recorder's row makers (its inputs).
const user = (id, chars) => ({ id, kind: 'user', text: `${id} ${'w'.repeat(chars)}` });
const shell = (id, chars) => ({ id, kind: 'tool', name: 'shell', args: { command: 'npm test' }, result: `${id}\n${'o'.repeat(chars)}`, completedAt: 1 });

/** A thread of the core holding `rows` (user rows: a Node transcript message each, its row id the submission id). */
async function threadOf(rows) {
  const { threadId } = await core.call('thread');
  await append(threadId, rows);
  return threadId;
}
const message = (row) => ({ role: 'user', content: row.text, meta: { transcript: { clientSubmissionId: row.id, ...(row.device ? { device: row.device } : {}) } } });
// All rows in one post, as the recording stored them.
const append = (threadId, rows) => core.call('append', { threadId, messages: rows.map(message) });

let connections = 0;
/** A phone following `threadId` on its own connection: it shows the fold's state through its transcript window. */
async function phoneOn(threadId) {
  const conn = ++connections;
  let fold = sessionReducer.initial(await core.call('resume', { conn, threadId, window: VIEW_WINDOW }));
  const transcript = createPhoneTranscript({
    older: async (thread, beforeId, limit) => {
      const page = await core.call('request', {
        conn,
        method: 'thread/items/list',
        params: { threadId: thread, cursor: { type: 'item', itemId: beforeId }, sortDirection: 'desc', limit },
      });
      return { rows: foldRows(page.data), hasOlder: page.hasOlder === true };
    },
    changed() {},
  });
  const state = async () => {
    for (const frame of await core.call('frames', { conn })) fold = sessionReducer.apply(fold, frame);
    return desktopSessionState(fold, []);
  };
  return {
    show: async () => transcript.view(threadId, await state()),
    page: async (limit) => transcript.page(threadId, await state(), limit),
    latest: async () => {
      const page = await core.call('request', { conn, method: 'thread/items/list', params: { threadId, limit: 512 } });
      return foldRows(page.data);
    },
  };
}

/** A phone whose fold is `fold()` (the recording's rows, see the header), its older rows read from `all`. */
function phoneOver(fold, all) {
  const transcript = createPhoneTranscript({
    older: async (_thread, beforeId, limit) => {
      const end = all.findIndex((row) => row.id === beforeId);
      return { rows: all.slice(Math.max(0, end - limit), end), hasOlder: end - limit > 0 };
    },
    changed() {},
  });
  return {
    show: () => transcript.view('t', fold()),
    page: (limit) => transcript.page('t', fold(), limit),
    output: (id) => transcript.output('t', fold(), id),
  };
}

async function run(name, replay) {
  try {
    await replay(name, recorded(name));
  } catch (error) {
    failures.push({ case: name, error: String(error?.stack ?? error) });
  }
}

await run('a page revealed above a short first page arrives as history, the rows the phone opened on stay its tail', async (name, node) => {
  const tail = Array.from({ length: 8 }, (_, n) => shell(`t${n}`, 1_500));
  const paged = Array.from({ length: 8 }, (_, n) => shell(`h${n}`, 1_500));
  const phone = phoneOver(() => ({ items: tail, transcriptHasOlder: true }), [...paged, ...tail]);
  same(name, 'opened', held(phone.show()), held(node.opened));
  await phone.page(node.pageLimitRequested);
  same(name, 'snapshot', held(phone.show()), held(node.snapshot));
});

await run("a phone's first page stays within its byte budget however wide the shared window is", async (name, node) => {
  const wide = await phoneOn(await threadOf(Array.from({ length: 32 }, (_, n) => user(`u${n}`, 20_000))));
  const shown = await wide.show();
  same(name, 'wide', { snapshot: held(shown), bytes: itemBytes(shown.items) }, { snapshot: held(node.wide.snapshot), bytes: node.wide.bytes });
  const floor = await phoneOn(await threadOf(Array.from({ length: 32 }, (_, n) => user(`u${n}`, 20_000)).slice(-8)));
  const floorShown = await floor.show();
  same(name, 'floor', { snapshot: held(floorShown), bytes: itemBytes(floorShown.items) }, { snapshot: held(node.floor.snapshot), bytes: node.floor.bytes });
  const short = await phoneOn(await threadOf(Array.from({ length: 32 }, (_, n) => user(`s${n}`, 10))));
  same(name, 'short', held(await short.show()), held(node.short.snapshot));
});

await run('live rows append past the first page; older rows reveal only on the phone request, within the page', async (name, node) => {
  // r0 is the desktop's prompt from the start: the rows above the phone's view are never shown, so where the recording marks it
  // `device: 'desktop'` only for the staleness read changes nothing the phone was shown.
  const rows = Array.from({ length: 40 }, (_, n) => user(`r${n}`, 10));
  const threadId = await threadOf([{ ...rows[0], device: 'desktop' }, ...rows.slice(1)]);
  const phone = await phoneOn(threadId);
  await phone.show();
  await append(threadId, [user('live', 10)]);
  same(name, 'afterLiveRow', held(await phone.show()), held(node.afterLiveRow));
  await phone.page(node.pageLimitRequested);
  const paged = await phone.show();
  same(name, 'paged', held(paged), held(node.paged));
  same(name, 'staleWhenDesktopPromptAbove', viewIsStale(paged.items, await phone.latest(), 'phone'), node.staleWhenDesktopPromptAbove);
  // Node's row has no text; the core shows no empty prompt row (a K1 desktop cannot send one), and staleness reads only the row's
  // id, kind and device, so the row carries text.
  await append(threadId, [{ id: 'new', kind: 'user', text: 'new', device: 'desktop' }]);
  same(name, 'staleWhenNewDesktopRow', viewIsStale(paged.items, await phone.latest(), 'phone'), node.staleWhenNewDesktopRow);
});

await run('a phone page reveals at most 512 rows a request, whatever limit it names, and pages on to the first row', async (name, node) => {
  const phone = await phoneOn(await threadOf(Array.from({ length: 2_000 }, (_, n) => user(`d${n}`, 10))));
  let shown = await phone.show();
  const counts = [shown.items.length];
  const revealed = [];
  while (shown.items.length < 2_000 && counts.length <= 10) {
    await phone.page(10_000_000);
    const next = await phone.show();
    revealed.push(next.items.length - shown.items.length);
    shown = next;
    counts.push(shown.items.length);
  }
  same(name, 'pages', { counts, revealed }, { counts: node.counts, revealed: node.revealed });
  same(name, 'finalHeld', held(shown), held(node.finalHeld));
});

await run('an oversized newest tool row goes with its outputs cut to fit, readable whole through Show full output', async (name, node) => {
  const members = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}`, name: 'read', result: 'r'.repeat(8_000) }));
  const aggregate = { id: 'agg', kind: 'tool', aggregate: true, result: '', toolMembers: members, completedAt: 1 };
  const phone = phoneOver(() => ({ items: [user('old', 10), aggregate], transcriptHasOlder: false }), []);
  const shown = phone.show();
  same(name, 'snapshot', { snapshot: held(shown), sentBytes: itemBytes([shown.items[0]]) }, { snapshot: held(node.snapshot), sentBytes: node.sentBytes });
  same(name, 'readBack', shown.items[0].toolMembers.map((record) => phone.output(record.id)), node.readBack);
});

await run('a compacted live session whose runtime spilled rows pages back on the phone to its first row', async (name, node) => {
  // The fold is the newest rows the phone's resume window reaches; every older one is read as a page asks for it.
  const fold = node.all.slice(-VIEW_WINDOW.lastItems);
  const phone = phoneOver(() => ({ items: fold, transcriptHasOlder: true }), node.all);
  let shown = phone.show();
  const steps = [{ heldRows: shown.items.length, hasOlder: shown.transcriptHasOlder }];
  while (shown.transcriptHasOlder && steps.length <= 100) {
    await phone.page(shown.items.length + 64);
    shown = phone.show();
    steps.push({ heldRows: shown.items.length, hasOlder: shown.transcriptHasOlder });
  }
  // Node's host window read its live rows and its spilled ones separately (loadLiveTranscriptHead): the page that crossed from
  // the live rows (from `firstLiveRowAfterCap`) into the spill stopped at that seam short of its limit. K1 has no spill (the core
  // pages its whole log), so its pages are compared with the recorded ones up to that seam, and after it each one must reveal the
  // 64 rows asked for or reach the first row; the final state is compared whole.
  const seam = node.steps.findIndex((step) => step.limit !== undefined && step.hostRows < Math.min(step.limit, node.all.length));
  const wanted = (step) => ({ heldRows: step.heldRows, hasOlder: step.hasOlder });
  same(name, 'steps before the spill seam', steps.slice(0, seam), node.steps.slice(0, seam).map(wanted));
  const after = steps.slice(seam).map((step, at) => {
    const before = steps[seam + at - 1].heldRows;
    return step.heldRows === Math.min(before + 64, node.all.length) && step.hasOlder === step.heldRows < node.all.length;
  });
  same(name, 'steps after the spill seam reveal 64 rows each', after, after.map(() => true));
  same(name, 'held', held(shown), held(node.held));
});

await run('an oversized message row is sent whole, so a first page with it is over the budget (as HEAD)', async (name, node) => {
  const phone = await phoneOn(await threadOf([user('old', 10), node.message]));
  const shown = await phone.show();
  same(name, 'snapshot', { snapshot: held(shown), bytes: itemBytes(shown.items) }, { snapshot: held(node.snapshot), bytes: node.bytes });
});

core.done(failures);
