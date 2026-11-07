#!/usr/bin/env node
// Genuine 1.4.5 stored session metadata: `readStoredSessionTranscript(id, { metadataOnly: true })`
// (store-summary-reader.mjs `readStoredSessionMetadata`) over crafted log records, as the usage
// service's `describeRequestSessions` reads it (usage-stats-api.mjs `readSessionMetadata`). Only
// the keys the usage service consumes are kept (its own and those `isLeadVisibleRow` reads), with
// `isLeadVisibleRow({ ...metadata, preview: 'x' })` (the `openable` test of `describeRequestSessions`).
// Records that read as `null`: a session whose files `deleteSession` unlinked
// (session-delete.mjs `_unlinkIfThere(plan.logPath)`), an unreadable log and a log of another
// session. The Rust `SessionMetadata` impl of `SessionDirectory` must answer the same from the index.
//
//   node benchmarks/rust-core/recorders/record-session-metadata.mjs --tree <tree> --data <empty temp dir>
// Output: native/core/fixtures/session-metadata/golden.json
// Run with MIXDOG_DATA_DIR, MIXDOG_HOME, HOME, USERPROFILE, APPDATA and LOCALAPPDATA pointing at temp dirs.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolve(args.get('tree'));
const data = resolve(args.get('data'));
if (process.env.MIXDOG_DATA_DIR !== data) throw new Error('MIXDOG_DATA_DIR must be the --data dir');
mkdirSync(join(data, 'sessions'), { recursive: true });
const format = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/session-log-format.mjs');
const { readStoredSessionTranscript } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const { isLeadVisibleRow } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store-summary-catalog.mjs');
const { isConversationUsageSource } = await importFrom(tree, 'src/runtime/shared/llm/usage-rollup.mjs');
// `internalKindOf` of describeRequestSessions (usage-stats-api.mjs:187), over the same Node functions.
const internalKindOf = (sourceType) => {
  const id = String(sourceType || '').trim().toLowerCase();
  if (id === 'session-title') return id;
  const hidden = id && !isLeadVisibleRow({ sourceType: id, preview: id });
  return hidden && (id === 'exec' || !isConversationUsageSource(id)) ? id : '';
};
const KEYS =['id', 'sessionId', 'owner', 'agent', 'parentSessionId', 'ownerSessionId', 'visibility', 'title', 'sourceType', 'sourceName'];

const h = (id, extra) => ({ id, owner: 'user', closed: false, generation: 1, updatedAt: 1, ...extra });
const headers = [
  h('s_lead', { title: 'Fix the build', agent: 'lead', sourceType: 'lead' }),
  h('s_plain', {}),
  h('s_empty', { title: '', agent: '', ownerSessionId: '', sourceType: '' }),
  h('s_raw_title', { title: '  Fix\nthe   build  ' }),
  h('s_blank_title', { title: '   ' }),
  h('s_agent', { title: 'worker run', owner: 'agent', agent: 'worker', ownerSessionId: 's_lead', sourceType: 'agent' }),
  h('s_parent_only', { agent: 'worker', parentSessionId: 's_lead' }),
  h('s_both', { agent: 'worker', ownerSessionId: 's_owner', parentSessionId: 's_parent' }),
  h('s_empty_owner', { agent: 'worker', ownerSessionId: '', parentSessionId: 's_parent' }),
  h('s_memory', { sourceType: 'memory-cycle', agent: 'worker', ownerSessionId: 's_lead' }),
  h('s_title_call', { sourceType: 'session-title' }),
  h('s_exec', { sourceType: 'exec', title: 'exec run' }),
  h('s_falsy', { agent: 0, ownerSessionId: false, sourceType: null }),
  h('s_number_owner', { agent: 'worker', ownerSessionId: 7 }),
  // isLeadVisibleRow: owner, visibility, sourceName, sourceType and agent.
  h('s_foreign_owner', { owner: 'importer', title: 'foreign' }),
  h('s_owner_cased', { owner: ' User ', title: 'cased' }),
  h('s_owner_agent', { owner: 'agent', agent: 'worker', parentSessionId: 's_lead' }),
  h('s_owner_agent_self', { owner: 'agent', agent: 'worker', parentSessionId: 's_owner_agent_self' }),
  h('s_agent_only', { visibility: 'agent-only', title: 'declared' }),
  h('s_session_visibility', { sessionVisibility: 'agent-only' }),
  h('s_root_lead_agent_only', { agent: 'lead', visibility: 'agent-only', ownerSessionId: 's_root_lead_agent_only' }),
  h('s_lead_cased', { agent: ' Lead ', sourceType: 'bot' }),
  h('s_source_name_only', { sourceName: 'newsbot' }),
  h('s_bot', { sourceType: 'bot', sourceName: 'newsbot', title: 'by a bot' }),
  h('s_cli', { sourceType: 'cli' }),
  h('s_schedule', { sourceType: 'schedule' }),
  h('s_webhook', { sourceType: 'webhook' }),
  h('s_cache_warm', { sourceType: 'cache-warm' }),
  h('s_agent_foreign', { owner: 'importer', agent: 'worker', ownerSessionId: 's_lead' }),
  h('s_agent_no_owner', { owner: 'importer', agent: 'worker' }),
  h('s_native_search',{ sourceType: 'native-web-search', agent: 'worker', ownerSessionId: 's_lead' }),
];
const cases = [];
const record = (id, header, logId = `L-${id}`, recordId = id) => {
  const messages = [JSON.stringify({ role: 'user', content: 'hello there' })];
  writeFileSync(join(data, 'sessions', `${id}.log.jsonl`), format.encodeSessionRecord({ logId, id: recordId, header }) + format.encodeCompacted(1, messages));
};
for (const header of headers) {
  const id = header.id;
  record(id, header);
  const meta = await readStoredSessionTranscript(id, { metadataOnly: true });
  const expected = Object.fromEntries(KEYS.map((key) => [key, meta[key]]));
  // `openable` of describeRequestSessions (usage-stats-api.mjs:221), for a request with no owner link and with one.
  const openable = (requestOwner) =>
    Boolean(meta) && !internalKindOf(meta.sourceType) && Boolean((meta.agent && (meta.ownerSessionId || requestOwner)) || isLeadVisibleRow({ ...meta, preview: 'x' }));
  cases.push({ id, header, expected, leadVisible: isLeadVisibleRow({ ...meta, preview: 'x' }), openable: { unowned: openable(''), owned: openable('r_owner') } });
}
// Records that read as null.
const nulls = [];
record('s_unlinked', h('s_unlinked', { title: 'deleted' }));
if ((await readStoredSessionTranscript('s_unlinked', { metadataOnly: true })).title !== 'deleted') throw new Error('the record is readable before the delete');
unlinkSync(join(data, 'sessions', 's_unlinked.log.jsonl'));
nulls.push({ id: 's_unlinked', how: 'files unlinked, as deleteSession leaves a deleted session' });
writeFileSync(join(data, 'sessions', 's_garbage.log.jsonl'), 'not a session record\n');
nulls.push({ id: 's_garbage', how: 'log that does not parse' });
record('s_foreign', h('s_other', { title: 'other' }), 'L-other', 's_other');
nulls.push({ id: 's_foreign', how: 'log of another session' });
nulls.push({ id: 's_absent', how: 'no file' });
for (const { id } of nulls) {
  if ((await readStoredSessionTranscript(id, { metadataOnly: true })) !== null) throw new Error(`${id} must read as null`);
}

const out = join(FIXTURES_ROOT, 'session-metadata');
mkdirSync(out, { recursive: true });
writeJson(join(out, 'golden.json'), {
  note: 'readStoredSessionTranscript(id, { metadataOnly: true }) over crafted log records, the keys usage consumes, and isLeadVisibleRow({ ...metadata, preview: "x" }); unreadable, foreign, unlinked and absent records are null',
  cases,
  nulls,
  internalKinds: ['', ' ', 'lead', 'cli', 'schedule', 'webhook', 'exec', ' EXEC ', 'bot', 'agent', 'memory-cycle', 'session-title', 'Session-Title', 'cache-warm', 'native-web-search', 'judge', 'compaction', 'user'].map((source) => ({
    source,
    kind: internalKindOf(source),
  })),
});
console.log(`cases=${cases.length}`);
