// What reaches memory of a session's sensitive value once it is marked (gaps-session sensitive P1): Node b6f10295a's
// own functions over one transcript holding the value in a tool call's arguments, a tool result, an attachment's name
// and a compaction summary:
//   stored  `redactSensitiveMessages` (sensitive-projection.mjs: the session's messages as stored and as the close
//           ingest and the search ingest receive them)
//   ingest  `projectSessionMessagesForIngest` (memory/lib/session-ingest.mjs: what the close ingest feeds memory)
//   search  `sessionSearchRows` (session-search/session-search-db.mjs: the rows the session search stores)
// The value is marked as a sensitive browser fill marks it (`rememberSensitiveValues`).
//
//   node benchmarks/rust-core/recorders/record-sensitive-feed.mjs --tree <exact export of b6f10295a>
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-sensitive-feed.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const load = (path) => import(pathToFileURL(join(tree, path)).href);

const values = await load('src/runtime/agent/orchestrator/session/sensitive-values.mjs');
const projection = await load('src/runtime/agent/orchestrator/session/sensitive-projection.mjs');
const ingest = await load('src/runtime/memory/lib/session-ingest.mjs');
const search = await load('src/runtime/session-search/session-search-db.mjs');

const session = 'sess_sensitive_feed';
const calls = [{ id: 'fill', name: 'browser', arguments: { action: 'fill', input: { sensitive: true, text: 'hunter2' } } }];
const messages = [
  { role: 'user', content: 'log me in', ts: 1_772_000_000_000 },
  { role: 'assistant', content: '', ts: 1_772_000_000_100, toolCalls: [{ id: 'fill', name: 'browser', arguments: calls[0].arguments }] },
  { role: 'tool', toolCallId: 'fill', content: 'filled hunter2 into the password field', ts: 1_772_000_000_200 },
  {
    role: 'user',
    ts: 1_772_000_000_300,
    content: [
      { type: 'text', text: 'here is the file' },
      { type: 'attachment', attachmentRef: 'att_1', name: 'hunter2-notes.pdf', mimeType: 'application/pdf' },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'read it' }], ts: 1_772_000_000_400, toolCalls: [{ id: 'read', name: 'read', arguments: { path: 'hunter2-notes.pdf' } }] },
  { role: 'tool', toolCallId: 'read', content: [{ type: 'text', text: 'notes: the code is hunter2' }], ts: 1_772_000_000_500 },
  { role: 'user', content: 'Conversation summary: the user logged in with hunter2.', meta: { source: 'compact-summary' }, ts: 1_772_000_000_600 },
  { role: 'assistant', content: 'done', ts: 1_772_000_000_700 },
];
values.rememberSensitiveValues(session, calls);
const stored = projection.redactSensitiveMessages(session, messages);

const finalDir = join(FIXTURES_ROOT, 'sensitive-feed');
const outDir = stageSet(finalDir, null);
writeJson(join(outDir, 'sensitive-feed.json'), {
  scenario: 'sensitive-feed',
  session,
  calls: exact(calls),
  messages: exact(messages),
  stored: exact(stored),
  ingest: exact(ingest.projectSessionMessagesForIngest(stored)),
  search: exact(search.sessionSearchRows(session, stored)),
});
writeSetManifest(outDir, {
  set: 'sensitive-feed',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of b6f10295a>`,
  extra: { values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)', ...recorderProvenance(import.meta.url) },
  identity,
});
commitStage(outDir, finalDir);
console.log('recorded sensitive-feed');
process.exit(0);
