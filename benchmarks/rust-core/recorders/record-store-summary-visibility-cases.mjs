#!/usr/bin/env node
// Recording of session/store-summary-visibility.test.mjs (b6f10295a): agent descendants and parent links
// (store-summary-visibility.mjs), the checkpoint-marker policy of closed Lead and agent records (store-transcript-projection.mjs
// projectStoredTranscript + manager/turn-checkpoint.mjs recorder), the durable summary visibility (store-summary-index.mjs
// _sessionSummary/_normalizeSummaryIndex) and the catalogs over session files on disk (store-summary-reader.mjs, store/listing.mjs,
// the agent-workers.json links). A temp data dir holds the stored records; per case the files written and everything read back are recorded.
//
//   node benchmarks/rust-core/recorders/record-store-summary-visibility-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync as writeRaw } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXED_NOW, openSet } from './lib/case-set.mjs';
/** Every file the recorder writes gets the same mtime, one hour before the fixed clock: a recorded input (the store reads file times into its rows). */
const MTIME = new Date(FIXED_NOW - 3_600_000);
const writeFileSync = (path, text) => { writeRaw(path, text); utimesSync(path, MTIME, MTIME); };

const roots = [];
let root;
let sessionsDir;
/** A fresh data dir for the case (the test ran each case in its own): the module reads MIXDOG_DATA_DIR on use. */
function newDataDir() {
  root = mkdtempSync(join(tmpdir(), 'store-summary-visibility-'));
  roots.push(root);
  process.env.MIXDOG_DATA_DIR = root;
  sessionsDir = join(root, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
}
newDataDir();
const set = openSet('store-summary-visibility-cases', import.meta.url);
const S = 'src/runtime/agent/orchestrator/session/';
const { _normalizeSummaryIndex, _sessionSummary } = await set.load(`${S}store-summary-index.mjs`);
const { listStoredAgentWorkerLinks, listStoredAgentWorkers, listStoredSessionSummaries: listOrdinarySummaries, listStoredSessionSummariesAsync: listOrdinarySummariesAsync, readStoredSessionTranscript, storedSessionExists } = await set.load(`${S}store-summary-reader.mjs`);
const { listStoredSessions, listStoredSessionSummariesAsync: listInternalSummaries } = await set.load(`${S}store/listing.mjs`);
const { projectStoredTranscript } = await set.load(`${S}store-transcript-projection.mjs`);
const { createTurnCheckpointRecorder, settleTurnCheckpointWrites } = await set.load(`${S}manager/turn-checkpoint.mjs`);
const { agentDescendantIds, agentParentIds } = await set.load(`${S}store-summary-visibility.mjs`);
const session = (id, extra = {}) => ({ id, createdAt: 1_000, updatedAt: 2_000, lastUsedAt: 2_000, status: 'idle', owner: 'user', messages: [{ role: 'user', content: `prompt for ${id}` }], ...extra });

await set.run('agent descendants follow every owner/parent link to any depth, agent-only rows only', () => {
  const sub = (id, links) => ({ id, owner: 'agent', agent: 'worker', visibility: 'agent-only', ...links });
  const rows = [
    { id: 'sess_lead', owner: 'user', agent: 'lead' }, sub('sess_w1', { ownerSessionId: 'sess_lead' }), sub('sess_w1_child', { ownerSessionId: 'sess_lead' }), sub('sess_w1_grand', { parentSessionId: 'sess_w1_child' }),
    sub('sess_other', { ownerSessionId: 'sess_lead_other' }), { id: 'sess_task', owner: 'user', agent: 'lead', ownerSessionId: 'sess_lead', taskOrigin: {} }, { id: 'sess_lead_self', owner: 'user', agent: 'lead', ownerSessionId: 'sess_lead_self' },
  ];
  return { rows, descendants: [['sess_lead'], ['sess_w1_child'], ['sess_lead_self']].map(([id]) => ({ of: id, ids: agentDescendantIds(rows, id) })), ofNullRows: agentDescendantIds(null, 'sess_lead') };
});
await set.run('agent parent links are the owner and the parent, never the row itself', () => ({
  parents: [{ id: 'sess_x', ownerSessionId: 'sess_lead', parentSessionId: 'sess_p' }, { id: 'sess_x', ownerSessionId: 'sess_x', parentSessionId: 'sess_x' }, { id: 'sess_x', ownerSessionId: 'sess_lead', parentSessionId: 'sess_lead' }, null].map((row) => ({ row, ids: agentParentIds(row) })),
}));
await set.run('closed Lead and agent records apply the same checkpoint-marker policy', async () => {
  newDataDir();
  const results = [];
  for (const marked of [false, true]) {
    for (const owner of ['user', 'agent']) {
      const id = `projection_${owner}_${marked}`;
      const doc = session(id, { owner, parentSessionId: 'parent', closed: true, status: 'closed', generation: 1, ...(marked ? { activeTurnCheckpoint: { turnToken: id } } : {}) });
      writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify(doc));
      const recorder = createTurnCheckpointRecorder({ sessionId: id, generation: 1, turnToken: id, startedAt: Date.now() });
      recorder.record({ currentUserContent: 'checkpoint prompt', turnOutgoing: [{ role: 'user', content: 'checkpoint prompt' }] });
      await settleTurnCheckpointWrites(id);
      const projected = await projectStoredTranscript(id, doc, { includeMessages: true, itemLimit: 100 });
      results.push({ marked, owner, doc, projected });
      recorder.stop();
    }
  }
  return { results };
});
await set.run('summary visibility is durable and classifies legacy Agent-owned children', () => {
  const legacy = session('legacy-child', { owner: 'agent', parentSessionId: 'root-lead', agent: 'reviewer' });
  const summary = _sessionSummary(legacy);
  const [normalized] = _normalizeSummaryIndex({ version: 2, rows: [{ ...summary, visibility: undefined, ownerSessionId: 'root-lead' }] }).rows;
  const nestedInput = session('nested-child', { owner: 'agent', parentSessionId: 'parent-child', ownerSessionId: 'root-lead', agent: 'reviewer', visibility: 'agent-only', provider: 'test-provider', model: 'test-model', presetName: 'Test route', effort: 'high', fast: true, modelParameters: { temperature: 0.2 }, permissionMode: 'strict', schemaAllowedTools: ['read', 'grep'], taskType: 'review' });
  const nested = _sessionSummary(nestedInput);
  const [normalizedNested] = _normalizeSummaryIndex({ version: 2, rows: [nested] }).rows;
  const rootLeadInput = session('root-lead', { owner: 'agent', ownerSessionId: 'root-lead', agent: 'lead', visibility: 'agent-only' });
  return { legacyInput: legacy, legacySummary: summary, normalizedWithoutVisibility: normalized, nestedInput, nestedSummary: nested, normalizedNested, rootLeadInput, rootLeadSummary: _sessionSummary(rootLeadInput) };
});
await set.run('catalogs expose agent sessions while preserving their presentation classification', async () => {
  newDataDir();
  const records = [
    session('root-lead', { owner: 'agent', ownerSessionId: 'root-lead', agent: 'lead', sourceType: 'lead' }), session('ordinary-user'),
    session('declared-child', { ownerSessionId: 'root-lead', agent: 'reviewer', visibility: 'agent-only' }), session('legacy-child', { owner: 'agent', parentSessionId: 'root-lead', agent: 'reviewer', agentTag: 'review', closed: true, status: 'closed' }),
  ];
  for (const record of records) writeFileSync(join(sessionsDir, `${record.id}.json`), JSON.stringify(record));
  const indexRows = records.map((record) => _sessionSummary(record));
  delete indexRows.find((row) => row.id === 'legacy-child').visibility;
  const indexFile = { version: 2, updatedAt: Date.now(), rows: indexRows };
  writeFileSync(join(root, 'session-summaries.json'), JSON.stringify(indexFile));
  const workersFile = { workers: { review: { tag: 'review', sessionId: 'legacy-child', parentSessionId: 'root-lead', ownerSessionId: 'root-lead', agent: 'reviewer', status: 'idle', stage: 'idle', finishedAt: new Date(Date.now()).toISOString() } } };
  writeFileSync(join(root, 'agent-workers.json'), JSON.stringify(workersFile));
  const ids = (rows) => rows;
  const internal = await listInternalSummaries({ refreshFromStorage: true });
  const durableIndex = JSON.parse(readFileSync(join(root, 'session-summaries.json'), 'utf8'));
  const metadata = await readStoredSessionTranscript('legacy-child', { metadataOnly: true });
  const exact = await readStoredSessionTranscript('legacy-child');
  return {
    records, indexFileWritten: indexFile, workersFileWritten: workersFile,
    ordinarySummaries: ids(listOrdinarySummaries({ rebuildIfMissing: false })), ordinarySummariesAsync: ids(await listOrdinarySummariesAsync({ refreshFromStorage: true })),
    storedSessions: ids(listStoredSessions()), storedSessionsIncludingAgentOnly: ids(listStoredSessions({ includeAgentOnly: true })),
    internalSummaries: ids(internal), internalVisibility: { declaredChild: internal.find((r) => r.id === 'declared-child'), legacyChild: internal.find((r) => r.id === 'legacy-child') },
    durableLegacyChild: durableIndex.rows.find((r) => r.id === 'legacy-child'),
    storedWorkers: listStoredAgentWorkers(), workerLinks: listStoredAgentWorkerLinks(), storedSessionExists: storedSessionExists('legacy-child'),
    metadata,
    exact,
    normalised: 'finishedAt is the fixed clock as an ISO string',
  };
});

await set.finish({
  entry: { runs: 'store-summary-visibility.mjs, store-summary-index.mjs, store-summary-reader.mjs, store/listing.mjs, store-transcript-projection.mjs projectStoredTranscript, manager/turn-checkpoint.mjs recorder, all over session files in a temp data dir', notRun: 'no live runtime: only the stored records and indexes' },
  replay: { entry: 'mixdog-store summary.rs and sqlite/lead.rs (visibility, descendants, catalogs): write the recorded files (records, indexFileWritten, workersFileWritten) into a store and compare each listing, the durable index visibility, the worker links and the transcript reads; the checkpoint cases compare the projected messages', normalised: { dataDir: 'temp, not in the recording' } },
  replaceInText: roots.map((r) => [r, '<data>']),
  replaceRegex: [[/^\d+(:[0-9a-z]+:[A-Za-z0-9+\/=_-]+\/whole)$/, '<epoch>$1'], [/^\d+(:[0-9a-z]+:\d+)$/, '<pid>$1']],
  normaliseReason: 'the temp data dir is written <data>; a projection stamp starts with the transcript worker epoch (a per-run number), written <epoch>; a projection stamp without a fingerprint is <process id>:<clock>:<counter>, the process id written <pid>',
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
