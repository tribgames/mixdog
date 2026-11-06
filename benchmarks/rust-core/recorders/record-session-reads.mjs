#!/usr/bin/env node
// Genuine 1.4.5 session reads: Node's own `sessionFinalAnswer` (desktop session-final-answer.ts),
// `attachmentHistoryRows` (stored-attachment-history.mjs) and the stored historical-position read
// `storedHistorySlice({cursor})` (store-transcript-projection.mjs: historyCursorSlice with
// budgetedEdge) over crafted display histories. The Rust `session::reads` must answer the same.
//
//   node benchmarks/rust-core/recorders/record-session-reads.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/session-reads/golden.json
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { sessionFinalAnswer } = await importFrom(tree, 'apps/desktop/src/main/session-final-answer.ts');
const { attachmentHistoryRows } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/stored-attachment-history.mjs');
const { storedHistorySlice } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-transcript-projection.mjs');

// ---- final answers
const user = (id) => ({ kind: 'user', id, text: 'q' });
const assistant = (id, text, extra = {}) => ({ kind: 'assistant', id, text, ...extra });
const done = (id, at, status, extra = {}) => ({ kind: 'turndone', id, at, status, ...extra });
const finals = [];
const addFinal = (name, snapshot, startedAt) => finals.push({ name, snapshot, startedAt, expected: sessionFinalAnswer(snapshot, startedAt) });
const base = [user('u1'), assistant('a1', 'the answer'), done('d1', 100, 'done', { finalAssistantId: 'a1' })];
addFinal('done with its answer', { items: base }, 50);
addFinal('answer before startedAt', { items: base }, 101);
addFinal('answer exactly at startedAt', { items: base }, 100);
addFinal('busy', { busy: true, items: base }, 50);
addFinal('streaming tail', { streamingTail: { id: 't' }, items: base }, 50);
addFinal('no turndone', { items: [user('u1'), assistant('a1', 'x')] }, 0);
addFinal('empty items', { items: [] }, 0);
addFinal('done without id', { items: [assistant('a1', 'x'), { kind: 'turndone', at: 100, status: 'done', finalAssistantId: 'a1' }] }, 0);
addFinal('done at not a number', { items: [assistant('a1', 'x'), done('d1', '100', 'done', { finalAssistantId: 'a1' })] }, 0);
addFinal('newer prompt after the end', { items: [...base, user('u2')] }, 50);
addFinal('newer assistant after the end', { items: [...base, assistant('a2', 'more')] }, 50);
addFinal('failed', { items: [user('u1'), done('d1', 100, 'failed')] }, 50);
addFinal('cancelled', { items: [user('u1'), done('d1', 100, 'cancelled')] }, 50);
addFinal('reaction alone', { items: [user('u1'), done('d1', 100, 'done', { reacted: true })] }, 50);
addFinal('done with no final id, not reacted', { items: [user('u1'), done('d1', 100, 'done')] }, 50);
addFinal('final id names no assistant row', { items: [user('u1'), assistant('a9', 'x'), done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('final id names a tool row', { items: [user('u1'), { kind: 'tool', id: 'a1' }, done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('an earlier turn end between', { items: [assistant('a1', 'x'), done('d0', 90, 'done'), user('u2'), done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('answer still streaming', { items: [assistant('a1', 'part', { streaming: true }), done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('answer blank', { items: [assistant('a1', '  \n\t ', {}), done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('answer without text', { items: [{ kind: 'assistant', id: 'a1' }, done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('answer text is padded', { items: [assistant('a1', '  hi  '), done('d1', 100, 'done', { finalAssistantId: 'a1' })] }, 50);
addFinal('numeric ids', { items: [assistant(7, 'n'), done(8, 100, 'done', { finalAssistantId: 7 })] }, 50);
addFinal('the newest end wins', { items: [assistant('a1', 'old'), done('d1', 100, 'done', { finalAssistantId: 'a1' }), user('u2'), assistant('a2', 'new'), done('d2', 200, 'done', { finalAssistantId: 'a2' })] }, 150);
addFinal('unknown status', { items: [assistant('a1', 'x'), done('d1', 100, 'weird', { finalAssistantId: 'a1' })] }, 50);

// ---- attachment rows
const attachmentCases = [
  [],
  [{ kind: 'user', text: 'no attachments' }],
  [{ kind: 'user', id: 'u', attachments: [{ id: 'att_1', name: 'a.txt', mimeType: 'text/plain', kind: 'file', size: 12, extra: 'dropped', path: '/secret' }] }],
  [{ kind: 'user', attachments: [{ id: 'att_2', name: null, mimeType: undefined, size: 0 }] }],
  [{ kind: 'user', images: [{ attachmentRef: 'ref_1', name: 'i.png', mimeType: 'image/png', bytes: 5, data: 'x' }] }],
  [{ kind: 'user', imageRefs: [{ ref: 'r1', other: 1 }, { ref: 'r2' }] }],
  [{ kind: 'notice', routine: { kind: 'schedule', name: 'n' }, attachments: [{ id: 'att_3' }] }],
  [{ kind: 'notice', routine: { kind: '' }, attachments: [{ id: 'att_3' }] }],
  [{ kind: 'notice', room: { kind: 'agent', who: 'x' }, images: [{ name: 'i' }] }],
  [{ kind: 'notice', room: {}, routine: null, attachments: [{ id: 'a' }], images: [{ bytes: 1 }], imageRefs: [{ ref: 'z' }] }],
  [{ kind: 'user', attachments: [], images: [], imageRefs: [] }],
  [{ kind: 'user', attachments: [{ ignored: 1 }] }],
  [{ kind: 'user', attachments: 'not a list', images: {}, imageRefs: null }],
  [{ kind: 'user', attachments: [{ id: 'one' }] }, { kind: 'assistant', text: 'between' }, { kind: 'user', attachments: [{ id: 'two' }] }],
].map((items) => ({ items, expected: attachmentHistoryRows(items) }));

// ---- historical-position pages (the stored reader's cursor slice)
const history = Array.from({ length: 24 }, (_, i) => ({ id: `r${i}`, kind: 'assistant', text: 'x'.repeat(((i * 37) % 11) * 40 + 5) }));
const sizes = history.map((item) => Buffer.byteLength(JSON.stringify(item)));
const total = sizes.reduce((a, b) => a + b, 0);
const pages = [];
const requests = [];
for (const at of [0, 1, 5, 12, 20, 23]) {
  for (const maxRows of [1, 3, 8, 30]) {
    for (const byteBudget of [null, 1, 300, 900, total]) {
      requests.push({ before: `r${at}`, maxRows, byteBudget });
      requests.push({ after: `r${at}`, maxRows, byteBudget });
    }
  }
}
requests.push({ before: 'nope', maxRows: 8, byteBudget: null }, { after: 'nope', maxRows: 8, byteBudget: null });
requests.push({ before: 'r5', maxRows: 9999, byteBudget: null }, { after: 'r5', maxRows: 0, byteBudget: null });
for (const request of requests) {
  const answer = storedHistorySlice({ items: history, transcriptHasOlder: false }, { cursor: request });
  if (answer.cursorMissing) {
    pages.push({ request, expected: { cursorMissing: true } });
    continue;
  }
  const anchor = history.findIndex((item) => item.id === (request.before ?? request.after));
  const ids = answer.items.map((item) => item.id);
  const start = ids.length ? history.findIndex((item) => item.id === ids[0]) : request.before != null ? anchor : anchor + 1;
  pages.push({
    request,
    expected: { start, end: start + ids.length, hasOlder: answer.transcriptHasOlder, hasNewer: answer.transcriptHasNewer },
  });
}

const finalOut = join(FIXTURES_ROOT, 'session-reads');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'sessionFinalAnswer, attachmentHistoryRows and storedHistorySlice({cursor}) over crafted display rows; `sizes` are the rows\' JSON byte lengths',
  finalAnswers: finals,
  attachmentRows: attachmentCases,
  pages: { sizes, requests: pages },
});
writeSetManifest(out, {
  set: 'session-reads',
  recorder: 'benchmarks/rust-core/recorders/record-session-reads.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-reads.mjs --tree <tree>',
  extra: { finalAnswers: finals.length, attachmentCases: attachmentCases.length, pages: pages.length },
});
commitStage(out, finalOut);
console.log(`finalAnswers=${finals.length} attachmentCases=${attachmentCases.length} pages=${pages.length}`);
