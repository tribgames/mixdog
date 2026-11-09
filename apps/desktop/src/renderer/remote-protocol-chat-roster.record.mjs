// Records what Node's phone holds as its thread list through a desktop restart: Node's own attach baseline
// (remote-view-sync.ts registerAndSynchronizeRelayViews, view-synchronizer.ts) run unchanged from the exact export of b6f10295a,
// with the phone's own roster decoder and cache (shared/list-delta.ts, shared/remote-roster-cache.ts) and its catalog
// (shared/remote-catalog.ts). The desktop host is scripted; its rosters are Node's `desktopSessionSummaries` over raw rows.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-roster.record.mjs <export dir> <out file>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [exportDir, outFile] = process.argv.slice(2);
const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const NODE_CHECKOUT = 'C:/Project/mixdog';

// The export is exact only if every file of the commit's tree is in it: byte for byte (git blob ids), or, for a text file the archive\n// wrote with CRLF (* text=auto), the same bytes once CRLF is read as the LF the repository stores.
const listing = execFileSync('git', ['-C', NODE_CHECKOUT, 'ls-tree', '-r', COMMIT], { maxBuffer: 1 << 28 }).toString().trim().split('\n');
let checked = 0;
let eolOnly = 0;
const blobId = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const mismatched = [];
for (const line of listing) {
  const [meta, path] = line.split('\t');
  const [mode, , sha] = meta.split(' ');
  if (mode === '160000' || mode === '120000') continue;
  let body;
  try { body = readFileSync(join(exportDir, path)); } catch { mismatched.push(`${path} (missing)`); continue; }
  checked += 1;
  if (blobId(body) === sha) continue;
  if (blobId(Buffer.from(body.toString('latin1').replaceAll('\r\n', '\n'), 'latin1')) === sha) eolOnly += 1;
  else mismatched.push(path);
}
if (mismatched.length) throw new Error(`the export is not b6f10295a: ${mismatched.length} files differ, e.g. ${mismatched.slice(0, 3).join(', ')}`);

const load = (path) => import(pathToFileURL(join(exportDir, 'apps/desktop/src', path)).href);
const { registerAndSynchronizeRelayViews } = await load('main/remote-view-sync.ts');
const { createRelayClientRegistry } = await load('main/remote-relay-clients.ts');
const { createRelayCatalogs } = await load('main/remote-relay-catalog.ts');
const { createKeyedListDeltaDecoder } = await load('shared/list-delta.ts');
const { createRemoteRosterCache, readRosterStamp } = await load('shared/remote-roster-cache.ts');
const { createRemoteCatalog } = await load('shared/remote-catalog.ts');
const { desktopSessionSummaries } = await load('main/desktop-state.ts');
const { DesktopSessionMetadata } = await load('main/desktop-session-metadata.ts');
const { byActivityThenId } = await import(pathToFileURL(join(exportDir, 'src/runtime/agent/orchestrator/session/catalog-db/schema.mjs')).href);

const plain = (value) => JSON.parse(JSON.stringify(value));
const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// Raw rows as the store lists them (newest activity first); the core's row is the same row with the stored
// desktopSession flattened (`classification`, `projectPath`).
const raw = (n, extra = {}) => ({
  id: `sess_${n}`,
  preview: `preview ${n}`,
  title: `Title ${n}`,
  updatedAt: 1000 - n,
  messageCount: 4,
  cwd: n % 2 ? 'C:\\proj\\a' : 'C:\\proj\\b',
  desktopSession: { classification: 'project', projectPath: n % 2 ? 'C:\\proj\\a' : 'C:\\proj\\b' },
  ...(n === 0 ? { working: true } : {}),
  ...(n === 1 ? { agentWorking: true, lastUsedAt: 1500 } : {}),
  ...(n === 2 ? { inheritedFromSessionId: 'sess_0' } : {}),
  ...extra,
});
// The store lists newest activity first, then by id (the catalog's order; the core lists the same way).
const ordered = (rows) => [...rows].sort((a, b) => (Number(b.lastUsedAt) || b.updatedAt) - (Number(a.lastUsedAt) || a.updatedAt) || (a.id < b.id ? -1 : 1));
// What the host laid over the projection (session-host.ts sessionCatalog): Node's own DesktopSessionMetadata overlays, run unchanged
// over the state a user left (archived, favorite, a deleted bot's home, a read cursor).
const meta = new DesktopSessionMetadata(() => process.env.MIXDOG_DATA_DIR ?? '.');
Object.assign(meta, {
  titleMap: {}, nameMap: {}, archivedMap: { sess_3: 1 }, favoriteMap: { sess_2: 1 }, retiredMap: { sess_4: 1 },
  readMap: { sess_1: { messageCount: 3, revision: 2 } },
});
const roster = (rows) =>
  meta.withReadCursors(meta.withFavoriteFlags(meta.withRetiredFlags(meta.withArchiveFlags(desktopSessionSummaries(ordered(rows), meta.titles, meta.names, '')))));
// The same rows as the core carries them (its `ThreadSummary`): the stored row flattened, the overlays as fields of the row.
const coreOf = ({ desktopSession, inheritedFromSessionId, working, agentWorking, ...row }) => ({
  ...row,
  classification: desktopSession.classification,
  projectPath: desktopSession.projectPath,
  ...(inheritedFromSessionId ? { forkedFromId: inheritedFromSessionId } : {}),
  activityAt: Number(row.lastUsedAt) || row.updatedAt,
  ...(working || agentWorking ? { working: true } : {}),
  ...(working ? { leadWorking: true } : {}),
  ...(agentWorking ? { agentWorking: true } : {}),
  ...(meta.archivedMap[row.id] ? { archived: true } : {}),
  ...(meta.favoriteMap[row.id] ? { favorite: true } : {}),
  ...(meta.retiredMap[row.id] ? { agentDeleted: true } : {}),
  ...(meta.readMap[row.id] ? { readMessageCount: meta.readMap[row.id].messageCount, readRevision: meta.readMap[row.id].revision } : {}),
});

function desktop(rows) {
  const listeners = new Set();
  let gate = null;
  const host = {
    rows,
    listSessions: async () => {
      if (gate) await gate;
      return roster(host.rows);
    },
    getSnapshot: () => ({ sessionId: null, status: 'idle', items: [], streamingTail: null }),
    listAgentPool: async () => [],
    subscribeSessions: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    subscribeAgentPool: () => () => {},
    setVisibleSessionsForSource: async () => true,
    replaySessionStates: async (_ids, deliver) => deliver([]),
  };
  const registry = createRelayClientRegistry({ host, sendEnvelope: () => {}, frameBudgetBytes: 1 << 20, onClientCountChanged: () => {}, onEmpty: () => {}, now: () => 0 });
  const clients = new Map();
  let deliver = null;
  const catalogs = createRelayCatalogs({ host, clients, live: () => true, sendEncryptedFrame: async (_id, frame) => deliver?.(frame) });
  let legs = 0;
  return {
    host,
    /** A catalog change: the host's own listeners hear it, then the relay's live frame. */
    publish(next) {
      host.rows = next;
      for (const listener of [...listeners]) listener(roster(next));
      catalogs.publishSessions(roster(next));
    },
    hold() { let release; gate = new Promise((r) => (release = r)); return () => { gate = null; release(); }; },
    connect(phone) {
      const clientId = `client-${++legs}`;
      const state = registry.open(clientId, {});
      clearTimeout(state.handshakeTimer);
      Object.assign(state, { channel: {}, viewSync: true, compactWire: true, listDelta: true, stateLane: null });
      clients.clear();
      clients.set(clientId, state);
      deliver = (frame) => phone.apply(plain(frame));
      return async (rosterParam) => {
        const frames = [];
        await registerAndSynchronizeRelayViews(host, clientId, state, [[], null, undefined, rosterParam], () => true, async (frame) => {
          frames.push(plain(frame));
          deliver(frame);
        });
        return frames;
      };
    },
  };
}

const storage = (() => {
  let record;
  return { load: async () => (record === undefined ? undefined : structuredClone(record)), save: async (v) => { record = structuredClone(v); }, clear: async () => { record = undefined; }, get record() { return record; } };
})();

/** The phone as remote-shim-dispatch.ts runs it: a `sessions` frame decodes and publishes to the catalog. */
function phone() {
  const decoder = createKeyedListDeltaDecoder();
  const cache = createRemoteRosterCache({ storage, scope: () => 'relay\ndevice\nkey\nsecret', decoder, saveDelayMs: 0, onMismatch: () => {} });
  const catalog = createRemoteCatalog();
  const published = [];
  catalog.subscribe((rows) => published.push(plain(rows)));
  return {
    published,
    claim: () => cache.claim(),
    get rows() { return catalog.get(); },
    apply(frame) {
      if (frame.event !== 'sessions') return;
      const decoded = decoder.decode(frame.payload);
      if (!decoded.ok) throw new Error('a sessions frame did not apply');
      catalog.publish(decoded.items);
      cache.observe(frame.payload);
    },
    stamped: () => readRosterStamp,
  };
}
const kind = (frames) => frames.filter((f) => f.event === 'sessions').map((f) => (f.payload.__listCatch ? 'catch-up' : f.payload.rows ? 'baseline' : 'delta'));

const steps = [];
const note = (name, core, p, frames) => steps.push({ name, coreRows: plain(ordered(core).map(coreOf)), frames: frames ? kind(frames) : undefined, published: p.published.splice(0), roster: plain(p.rows) });
const settle = async () => { await wait(60); };

const R1 = [0, 1, 2, 3, 4].map((n) => raw(n));
let d = desktop(R1);
let p = phone();
note('attach-baseline', R1, p, await d.connect(p)(await p.claim()));
await settle();

// A live roster push (a row is worked on and moves to the top).
const R1b = [raw(2, { updatedAt: 2000, messageCount: 6 }), ...R1.filter((r) => r.id !== 'sess_2')];
d.publish(R1b);
note('live-push', R1b, p);
await settle();

// The desktop restarts: another process (a fresh roster log epoch) with the same rows. The phone reconnects holding its persisted roster.
d = desktop(R1b);
p = phone();
note('restart-same-roster', R1b, p, await d.connect(p)(await p.claim()));
await settle();

// The desktop restarts again after rows changed while it was away: one removed, one added, one renamed, one reordered.
const R2 = [raw(7), raw(0, { title: 'Renamed 0', updatedAt: 3000 }), ...R1b.filter((r) => !['sess_0', 'sess_3'].includes(r.id))];
d = desktop(R2);
p = phone();
note('restart-roster-changed', R2, p, await d.connect(p)(await p.claim()));
await settle();

// A change between the baseline's subscribe and its list: the host publishes while the read is held; the push outranks the listing.
const R3 = [raw(8), ...R2];
const R3b = R3.filter((r) => r.id !== 'sess_1');
d = desktop(R2);
p = phone();
const release = d.hold();
const syncing = d.connect(p)(await p.claim());
await wait(20);
d.publish(R3b); // a new row appears and sess_1 is deleted while the listing is still being read
release();
note('change-between-subscribe-and-list', R3b, p, await syncing);
await settle();

// Live pushes keep applying after the baseline.
const R4 = R3b.map((r) => (r.id === 'sess_4' ? { ...r, messageCount: 9 } : r));
d.publish(R4);
note('live-push-after-restart', R4, p);
await settle();

// Node's catalog order over ties, lastUsedAt over updatedAt, and rows with no activity at all (schema.mjs byActivityThenId).
const tieRows = [
  raw(10, { updatedAt: 500 }), raw(11, { updatedAt: 500 }), raw(12, { updatedAt: 500, id: 'sess_09' }), raw(13, { updatedAt: 100, lastUsedAt: 900 }),
  raw(14, { updatedAt: 900 }), raw(15, { updatedAt: 0 }), raw(16, { updatedAt: 0, id: 'sess_A' }), raw(17, { updatedAt: 0, lastUsedAt: 0, id: 'sess_a' }),
];
steps.push({ name: 'order-ties', coreRows: plain(tieRows.map(coreOf)), order: [...tieRows].sort(byActivityThenId).map((r) => r.id) });

const manifest = { exact: true, commit: COMMIT, tree: execFileSync('git', ['-C', NODE_CHECKOUT, 'rev-parse', `${COMMIT}^{tree}`]).toString().trim(), filesCompared: checked, crlfOnlyDifferences: eolOnly, source: 'git archive of the whole tree, every file compared with its git blob id; remote-view-sync.ts, remote-relay-catalog.ts, view-synchronizer.ts, list-delta.ts, remote-roster-cache.ts run unchanged' };
writeFileSync(outFile, `${JSON.stringify({ manifest, steps }, null, 2)}\n`);
console.log(`recorded ${steps.length} steps over ${checked} verified files`);
