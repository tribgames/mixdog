#!/usr/bin/env node
// Recording of apps/desktop/src/main/remote-transcript-window.test.mjs (b6f10295a): the phone's transcript window over the relay.
// Real remote-transcript-window.ts (encodePhoneSessionState, requestPhoneTranscriptPage), the snapshot delta encoder/decoder
// (prepend wire), remote-transcript.ts (remoteToolOutput, REMOTE_HISTORY_OUTPUT_CHARS), remote-view-staleness.ts, the host's live
// window (standalone/session-service/projection/transcript-window.mjs) over a transcript spill buffer (tui/session/transcript-spill.mjs)
// with a live compaction (compaction-view.mjs archiveItemsForCompaction). Rows, snapshots and wires are recorded whole.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-remote-transcript-window-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('remote-transcript-window-cases', import.meta.url);
const { DESKTOP_TRANSCRIPT_PAGE_BYTES, REMOTE_TRANSCRIPT_TAIL_BYTES, REMOTE_TRANSCRIPT_TAIL_ITEMS } = await set.load('apps/desktop/src/main/desktop-support.ts');
const { archiveItemsForCompaction } = await set.load('src/tui/session/compaction-view.mjs');
const { createTranscriptSpillBuffer } = await set.load('src/tui/session/transcript-spill.mjs');
const { loadLiveTranscriptHead, requestLiveTranscriptWindow, windowTranscriptSnapshot } = await set.load('src/standalone/session-service/projection/transcript-window.mjs');
const { REMOTE_HISTORY_OUTPUT_CHARS, remoteToolOutput } = await set.load('apps/desktop/src/main/remote-transcript.ts');
const { encodePhoneSessionState, requestPhoneTranscriptPage } = await set.load('apps/desktop/src/main/remote-transcript-window.ts');
const { viewIsStale } = await set.load('apps/desktop/src/main/remote-view-staleness.ts');
const { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } = await set.load('apps/desktop/src/main/state-delta.ts');

function phone() {
  const encoder = createSnapshotDeltaEncoder({ prepend: true });
  const decoder = createSnapshotDeltaDecoder();
  let held = null;
  const wires = [];
  return {
    encoder, wires,
    deliver(snapshot) {
      const wire = encodePhoneSessionState(encoder, snapshot, true);
      const text = JSON.stringify(wire);
      const decoded = decoder.decode(JSON.parse(text));
      const heldSnapshot = structuredClone(decoded.snapshot);
      if (!decoded.ok) throw new Error('the phone decoder refused a frame');
      held = heldSnapshot;
      wires.push({ bytes: Buffer.byteLength(text), wireText: text });
      return { snapshot: held, bytes: Buffer.byteLength(text) };
    },
    get held() { return held; },
  };
}
const itemBytes = (items) => items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
const user = (id, chars) => ({ id, kind: 'user', text: `${id} ${'w'.repeat(chars)}` });
const shell = (id, chars) => ({ id, kind: 'tool', name: 'shell', args: { command: 'npm test' }, result: `${id}\n${'o'.repeat(chars)}`, completedAt: 1 });

await set.run('a page revealed above a short first page arrives as history, the rows the phone opened on stay its tail', () => {
  const held = Array.from({ length: 8 }, (_, n) => shell(`t${n}`, 1_500));
  const paged = Array.from({ length: 8 }, (_, n) => shell(`h${n}`, 1_500));
  const reader = phone();
  const opened = reader.deliver({ items: held, transcriptHasOlder: true }).snapshot;
  requestPhoneTranscriptPage(reader.encoder, 8 + 64);
  const { snapshot } = reader.deliver({ items: [...paged, ...held], transcriptHasOlder: false });
  return {
    heldRows: 8, pagedRows: 8, rowChars: 1_500, historyOutputChars: REMOTE_HISTORY_OUTPUT_CHARS,
    opened, pageLimitRequested: 8 + 64, snapshot, wires: reader.wires,
  };
});
await set.run("a phone's first page stays within its byte budget however wide the shared window is", () => {
  const shared = Array.from({ length: 32 }, (_, n) => user(`u${n}`, 20_000));
  const reader = phone();
  const { snapshot } = reader.deliver({ items: shared, transcriptHasOlder: true });
  const floorReader = phone();
  const floor = floorReader.deliver({ items: shared.slice(-8), transcriptHasOlder: true }).snapshot;
  const short = Array.from({ length: 32 }, (_, n) => user(`s${n}`, 10));
  const shortReader = phone();
  const shortSnapshot = shortReader.deliver({ items: short }).snapshot;
  return {
    tailBytes: REMOTE_TRANSCRIPT_TAIL_BYTES, tailItems: REMOTE_TRANSCRIPT_TAIL_ITEMS,
    wide: { sharedRows: 32, rowChars: 20_000, snapshot, bytes: itemBytes(snapshot.items), wires: reader.wires },
    floor: { snapshot: floor, bytes: itemBytes(floor.items) },
    short: { snapshot: shortSnapshot },
  };
});
await set.run('live rows append past the first page; older rows reveal only on the phone request, within the page', () => {
  const rows = Array.from({ length: 40 }, (_, n) => user(`r${n}`, 10));
  const reader = phone();
  reader.deliver({ items: rows, transcriptHasOlder: false });
  const live = [...rows, user('live', 10)];
  const { snapshot } = reader.deliver({ items: live, transcriptHasOlder: false });
  requestPhoneTranscriptPage(reader.encoder, REMOTE_TRANSCRIPT_TAIL_ITEMS + 1 + 5);
  const paged = reader.deliver({ items: live, transcriptHasOlder: false }).snapshot;
  const latest = [{ ...rows[0], device: 'desktop' }, ...live.slice(1)];
  return {
    afterLiveRow: snapshot, pageLimitRequested: REMOTE_TRANSCRIPT_TAIL_ITEMS + 1 + 5,
    paged,
    staleWhenDesktopPromptAbove: viewIsStale(paged.items, latest, 'phone'),
    staleWhenNewDesktopRow: viewIsStale(paged.items, [...latest, { id: 'new', kind: 'user', device: 'desktop' }], 'phone'),
    wires: reader.wires,
  };
});
await set.run('a phone page reveals at most 512 rows a request, whatever limit it names, and pages on to the first row', () => {
  const rows = Array.from({ length: 2_000 }, (_, n) => user(`d${n}`, 10));
  const reader = phone();
  let held = reader.deliver({ items: rows, transcriptHasOlder: false }).snapshot.items.length;
  const counts = [held];
  const revealed = [];
  while (held < rows.length) {
    requestPhoneTranscriptPage(reader.encoder, 10_000_000);
    const { snapshot } = reader.deliver({ items: rows, transcriptHasOlder: false });
    revealed.push(snapshot.items.length - held);
    held = snapshot.items.length;
    counts.push(held);
  }
  return { rows: 2_000, counts, revealed, finalHeld: reader.held, wires: reader.wires };
});
await set.run('an oversized newest tool row goes with its outputs cut to fit, readable whole through Show full output', () => {
  const members = Array.from({ length: 40 }, (_, n) => ({ id: `m${n}`, name: 'read', result: 'r'.repeat(8_000) }));
  const aggregate = { id: 'agg', kind: 'tool', aggregate: true, result: '', toolMembers: members, completedAt: 1 };
  const reader = phone();
  const { snapshot } = reader.deliver({ items: [user('old', 10), aggregate], transcriptHasOlder: false });
  const [sent] = snapshot.items;
  return {
    tailBytes: REMOTE_TRANSCRIPT_TAIL_BYTES, snapshot, sentBytes: itemBytes([sent]),
    readBack: sent.toolMembers.map((record) => remoteToolOutput({ items: [aggregate] }, record.id)),
    wires: reader.wires,
  };
});
await set.run('a compacted live session whose runtime spilled rows pages back on the phone to its first row', async () => {
  const spill = createTranscriptSpillBuffer({ workerFactory: () => ({ on() {}, postMessage() {}, terminate() {}, unref() {} }) });
  try {
    const row = (n) => user(`it_${n}`, 200);
    let all = []; let items = [];
    const push = (item) => { all = [...all, item]; items = spill.capLive([...items, item]); };
    for (let n = 0; n < 400; n += 1) push(row(n));
    const divider = { id: 'it_div', at: 1 };
    all = archiveItemsForCompaction(all, divider).items;
    items = spill.capLive(archiveItemsForCompaction(items, divider).items);
    for (let n = 400; n < 700; n += 1) push(row(n));
    const state = { sessionId: 's', items, transcriptArchive: null, transcriptSpilled: spill.spilled };
    const firstLive = items[0].id;
    const entry = { runtime: { getState: () => state, readSpilledTranscript: (range) => spill.readSpilled(range) }, transcriptView: null, publishedSnapshot: null };
    requestLiveTranscriptWindow(entry, { limit: REMOTE_TRANSCRIPT_TAIL_ITEMS, byteBudget: REMOTE_TRANSCRIPT_TAIL_BYTES, pageBase: 0 });
    let host = windowTranscriptSnapshot(entry, state);
    const reader = phone();
    let held = reader.deliver(host).snapshot;
    const steps = [{ step: 0, hostRows: host.items.length, heldRows: held.items.length, hasOlder: held.transcriptHasOlder }];
    for (let step = 1; held.transcriptHasOlder && step <= 100; step += 1) {
      const limit = held.items.length + 64;
      requestPhoneTranscriptPage(reader.encoder, limit);
      let grew = false;
      if (limit > host.items.length) {
        grew = true;
        requestLiveTranscriptWindow(entry, { limit, byteBudget: DESKTOP_TRANSCRIPT_PAGE_BYTES, pageBase: host.items.length });
        await loadLiveTranscriptHead(entry, 's', async () => null);
        host = windowTranscriptSnapshot(entry, state);
      }
      held = reader.deliver(host).snapshot;
      steps.push({ step, limit, hostWindowGrew: grew, hostRows: host.items.length, heldRows: held.items.length, hasOlder: held.transcriptHasOlder });
    }
    return {
      rows: 700, compactionAfterRow: 400, firstLiveRowAfterCap: firstLive, steps, tailBytes: REMOTE_TRANSCRIPT_TAIL_BYTES, tailItems: REMOTE_TRANSCRIPT_TAIL_ITEMS, pageBytes: DESKTOP_TRANSCRIPT_PAGE_BYTES,
      held, all,
    };
  } finally { spill.dispose(); }
});
await set.run('an oversized message row is sent whole, so a first page with it is over the budget (as HEAD)', () => {
  const message = user('big', 400_000);
  const reader = phone();
  const { snapshot } = reader.deliver({ items: [user('old', 10), message], transcriptHasOlder: false });
  return { rowChars: 400_000, message, snapshot, bytes: itemBytes(snapshot.items), tailBytes: REMOTE_TRANSCRIPT_TAIL_BYTES, wires: reader.wires };
});

await set.finish({
  entry: { hops: "The relay hop is JSON: each frame is recorded as the text that crossed (`wireText`), the decoder reads JSON.parse of it, as in the Node test.", runs: 'encodePhoneSessionState / requestPhoneTranscriptPage over the snapshot delta encoder (prepend) and decoder; remoteToolOutput; viewIsStale; the host live window (requestLiveTranscriptWindow, windowTranscriptSnapshot, loadLiveTranscriptHead) over a transcript spill buffer with a stubbed worker, archiveItemsForCompaction', notRun: 'the relay transport; the spill worker thread is a stub, the spill buffer is the runtime\'s' },
  replay: { entry: 'mixdog-app-server thread/items/list paging and the phone transcript window: feed each case\'s rows and page requests; compare ids, byte counts, truncation fields, notes and wires (whole)', normalised: {} },
});
process.exit(0);
