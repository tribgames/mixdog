#!/usr/bin/env node
// Golden of the session-search backfill's source (`native/core/fixtures/session-search-backfill/
// golden.json`): real Node code stores sessions (`saveSessionDurably`, plus one legacy `<id>.json`),
// and the store dir's files are recorded with what Node's backfill reads of them
// (`session-search-ingest.mjs` `backfillSessionSearch` / `loadStoreDeps`): the ids of the dir
// listing (`sessionIdsOfNames(readdirSync(dir))`), whether each has a record stamp
// (`sessionRecordStampOfSync`), the session `readSession` gives (`storedSessionSync(dir, id,
// false)`, null for an unreadable record), `isAgentOnlySession(session)`, and the search rows
// `appendSessionSearchMessages` would store (`sessionSearchRows(session.id, session.messages)`).
// Also recorded: whether a save changes the record stamp. Rust migrates the same files and reads
// them through `StoredSearchSessions`.
//
//   node benchmarks/rust-core/recorders/record-session-search-backfill.mjs --tree <tree>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const repo = resolveTree(parseArgs());
const home = mkdtempSync(join(tmpdir(), 'mixdog-search-backfill-'));
const data = join(home, 'data');
mkdirSync(join(data, 'sessions'), { recursive: true });
// Every user dir Node reads is a fresh temp dir before any Mixdog module loads.
for (const [name, dir] of [['HOME', 'home'], ['USERPROFILE', 'home'], ['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata']]) {
  mkdirSync(join(home, dir), { recursive: true });
  process.env[name] = join(home, dir);
}
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
const at = (p) => import(pathToFileURL(join(repo, p)).href);

const store = await at('src/runtime/agent/orchestrator/session/store.mjs');
const { getStoreDir } = await at('src/runtime/agent/orchestrator/session/store/session-paths.mjs');
const { sessionIdsOfNames, sessionRecordStampOfSync } = await at('src/runtime/agent/orchestrator/session/store/session-record.mjs');
const { storedSessionSync } = await at('src/runtime/agent/orchestrator/session/store/stored-session.mjs');
const { STORED_SESSION_UNREADABLE } = await at('src/runtime/agent/orchestrator/session/store/serialize.mjs');
const { isAgentOnlySession } = await at('src/runtime/agent/orchestrator/session/store-summary-visibility.mjs');
const { sessionSearchRows } = await at('src/runtime/session-search/session-search-db.mjs');

const T = 1_700_000_000_000;
const conversation = [
  { role: 'user', content: 'Where is the heron survey stored?', ts: T + 1_000 },
  {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"survey.md"}' } }],
    ts: T + 2_000,
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'heron survey: 14 nests', ts: T + 3_000 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'The heron survey lists 14 nests.' }],
    timestamp: new Date(T + 4_000).toISOString(),
  },
  { role: 'user', content: 'Thanks <system-reminder>hidden note</system-reminder> noted.', ts: T + 5_000 },
];
const base = (id, extra) => ({
  id,
  owner: 'user',
  agent: 'lead',
  sourceType: 'lead',
  closed: false,
  generation: 0,
  createdAt: T,
  updatedAt: T + 10_000,
  cwd: 'C:\\mixdog-golden\\project',
  ...extra,
});

// An ordinary Lead session, saved twice: the second save is a new turn.
const plain = base('sess_plain', { messages: conversation.slice(0, 3) });
await store.saveSessionDurably(structuredClone(plain));
const dir = getStoreDir();
const stampBefore = sessionRecordStampOfSync(dir, 'sess_plain');
plain.messages = conversation;
await store.saveSessionDurably(structuredClone(plain));
const stampAfter = sessionRecordStampOfSync(dir, 'sess_plain');

// Compacted: the stored messages are the replacement, not the turns it replaced.
const compacted = base('sess_compacted', { messages: conversation });
await store.saveSessionDurably(structuredClone(compacted));
compacted.messages = [
  { role: 'user', content: 'Summary: the heron survey lists 14 nests.', ts: T + 6_000 },
  { role: 'assistant', content: 'Continuing from the summary.', ts: T + 7_000 },
];
await store.saveSessionDurably(structuredClone(compacted));

// A sub-agent: owned by an agent and linked to another session.
await store.saveSessionDurably(
  base('sess_child', { owner: 'agent', agent: 'worker', sourceType: 'agent', parentSessionId: 'sess_plain', messages: conversation.slice(0, 1) })
);
// Declared agent-only.
await store.saveSessionDurably(base('sess_declared', { agent: 'reviewer', visibility: 'agent-only', messages: conversation.slice(0, 1) }));
// A root Lead linked to itself is ordinary whatever it declares.
await store.saveSessionDurably(
  base('sess_rootlead', { ownerSessionId: 'sess_rootlead', visibility: 'agent-only', messages: conversation.slice(3) })
);
// A legacy record: only `<id>.json`.
writeFileSync(join(dir, 'sess_legacy.json'), JSON.stringify(base('sess_legacy', { messages: conversation.slice(0, 2) })));

(await at('src/runtime/agent/orchestrator/session/store/session-writer-claim.mjs')).releaseHeldSessionWriters();

// `loadStoreDeps().readSession` of session-search-ingest.mjs.
const readSession = (id) => {
  const session = storedSessionSync(dir, id, false);
  return session && session !== STORED_SESSION_UNREADABLE ? session : null;
};
const names = readdirSync(dir);
const sessions = sessionIdsOfNames(names).map((id) => {
  const session = readSession(id);
  return {
    id,
    stamped: typeof sessionRecordStampOfSync(dir, id) === 'string',
    read: session?.id ?? null,
    agentOnly: session ? isAgentOnlySession(session) : null,
    rows: session ? sessionSearchRows(session.id, session.messages) : null,
  };
});
const files = Object.fromEntries(
  names.filter((name) => statSync(join(dir, name)).isFile()).map((name) => [name, readFileSync(join(dir, name), 'utf8')])
);
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

const set = join(FIXTURES_ROOT, 'session-search-backfill');
writeJson(join(set, 'golden.json'), { stampChangesOnSave: stampBefore !== stampAfter, sessions, files });
writeSetManifest(set, {
  set: 'session-search-backfill',
  recorder: 'benchmarks/rust-core/recorders/record-session-search-backfill.mjs',
  command: 'node <repo>/benchmarks/rust-core/recorders/record-session-search-backfill.mjs --tree <tree>',
  identityTree: repo,
});
console.log(`recorded ${sessions.length} sessions, ${Object.keys(files).length} files`);
process.exit(0);
