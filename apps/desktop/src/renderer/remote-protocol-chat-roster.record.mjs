// Records what Node's phone holds as its thread list, action by action, and through a desktop restart: Node's own attach baseline
// (remote-view-sync.ts registerAndSynchronizeRelayViews, view-synchronizer.ts) run unchanged from the exact export of b6f10295a,
// with the phone's own roster decoder and cache (shared/list-delta.ts, shared/remote-roster-cache.ts) and its catalog
// (shared/remote-catalog.ts). The desktop host is scripted; its rosters are Node's `desktopSessionSummaries` over raw rows.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-roster.record.mjs <export dir> <out file>
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const { _sessionSummary } = await import(pathToFileURL(join(exportDir, 'src/runtime/agent/orchestrator/session/store-summary-index.mjs')).href);
const { desktopSessionSummaries } = await load('main/desktop-state.ts');
const { DesktopSessionMetadata } = await load('main/desktop-session-metadata.ts');
const { byActivityThenId } = await import(pathToFileURL(join(exportDir, 'src/runtime/agent/orchestrator/session/catalog-db/schema.mjs')).href);

const plain = (value) => JSON.parse(JSON.stringify(value));

// ── The scenario: the same actions remote-protocol-chat-live.record.mjs makes against a running mixdogd ─────────────────────────────
// Node's store rows are Node's own `_sessionSummary` (store-summary-index.mjs) of session records the way Node writes them, and the
// sidebar overlays are Node's own DesktopSessionMetadata (rename, favorite, read cursor, archive, forget) over a scratch directory.
// The clock is virtual: every store write takes the next tick, so the timestamps are Node's order of writes, nothing from the wall clock.
//   session-record.mjs:199 / session-crud.mjs:237  a created session has lastUsedAt = updatedAt = its creation tick
//   ask-turn-settle.mjs:134                         a settled turn sets lastUsedAt (and updatedAt) to its completion tick
//   desktop-session-metadata.ts setName/setArchived/setFavorite/markRead: sidebar metadata, no write to the session record
let clockTick = 1_000_000;
const tick = () => (clockTick += 1000);
const PROJECT = { a: 'C:\\proj\\a', b: 'C:\\proj\\b' };
const sessions = new Map();
const metaDir = mkdtempSync(join(tmpdir(), 'ph2-chat-node-meta-'));
const meta = new DesktopSessionMetadata(() => metaDir);
const create = (name, project, extra = {}) => {
  const at = tick();
  sessions.set(name, { id: name, cwd: PROJECT[project], desktopSession: { classification: 'project', projectPath: PROJECT[project] }, createdAt: at, updatedAt: at, lastUsedAt: at, messages: [], ...extra });
};
const ordered = (rows) => [...rows].sort(byActivityThenId);
const roster = () =>
  meta.withReadCursors(meta.withFavoriteFlags(meta.withRetiredFlags(meta.withArchiveFlags(desktopSessionSummaries(ordered([...sessions.values()].map(_sessionSummary)), meta.titles, meta.names, '')))));

const ACTIONS = [
  ['created', async () => {
    for (const [name, project] of [['sess_0', 'b'], ['sess_1', 'a'], ['sess_3', 'a'], ['sess_4', 'b']]) {
      create(name, project);
      await meta.setName(name, `Title ${name.slice(-1)}`);
    }
    create('sess_2', 'b', { inheritedFromSessionId: 'sess_0' });
    await meta.setName('sess_2', 'Title 2');
    await meta.setFavorite('sess_2', true);
    await meta.markRead('sess_1', 0, true, { messageCount: 0, compactCount: 0 });
  }],
  ['turns', async () => {
    for (const name of ['sess_1', 'sess_0']) {
      const s = sessions.get(name);
      s.messages.push({ role: 'user', content: `hello ${name}` }, { role: 'assistant', content: 'ok' });
      s.updatedAt = s.lastUsedAt = tick();
    }
  }],
  ['archive', async () => { await meta.setArchived('sess_3', true); }],
  ['unarchive', async () => { await meta.setArchived('sess_3', false); }],
  ['archive-again', async () => { await meta.setArchived('sess_3', true); }],
  ['delete', async () => {
    create('sess_5', 'a');
    await meta.setName('sess_5', 'Title 5');
    sessions.delete('sess_5');
    await meta.forget('sess_5');
  }],
];

function desktop(rows) {
  const listeners = new Set();
  let gate = null;
  let reached = null;
  const host = {
    rows,
    listSessions: async () => {
      if (gate) {
        reached?.();
        await gate;
      }
      return host.rows;
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
      for (const listener of [...listeners]) listener(next);
      catalogs.publishSessions(next);
    },
    /** Holds the host's roster read; rrived resolves when a read has reached the hold. */
    hold() {
      let release;
      gate = new Promise((r) => (release = r));
      const arrived = new Promise((r) => (reached = r));
      return { arrived, release: () => { gate = null; release(); } };
    },
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
  const saved = [];
  return {
    load: async () => (record === undefined ? undefined : structuredClone(record)),
    save: async (v) => {
      record = structuredClone(v);
      saved.splice(0).forEach((resolve) => resolve());
    },
    clear: async () => { record = undefined; },
    /** Resolves when the phone's roster cache has persisted its next roster (the completion of its debounced save). */
    nextSave: () => new Promise((resolve) => saved.push(resolve)),
  };
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
const note = (name, p, frames, extra = {}) => steps.push({ name, ...extra, frames: frames ? kind(frames) : undefined, published: p.published.splice(0), roster: plain(p.rows) });

// The desktop and phone that stay connected through every action: each action ends with the host publishing its roster, as Node's catalog did.
let live = desktop([]);
let livePhone = phone();
await live.connect(livePhone)(await livePhone.claim());
livePhone.published.splice(0);
const rosters = [{ name: 'start', roster: [] }];
for (const [name, act] of ACTIONS) {
  await act();
  const next = plain(roster());
  rosters.push({ name, roster: next });
  live.publish(next);
  note(`action:${name}`, livePhone, undefined);
}

// Per state: a fresh phone's baseline, a phone that restarts into it holding the previous state's persisted roster, and a change that
// arrives while the baseline's read is still held.
const withRows = (name) => rosters.find((r) => r.name === name).roster;
for (let i = 1; i < rosters.length; i += 1) {
  const { name } = rosters[i];
  const prev = rosters[i - 1];
  await storage.clear();
  let d = desktop(withRows(name));
  let p = phone();
  note(`attach:${name}`, p, await d.connect(p)(await p.claim()));
  if (i === 1) continue;
  // The desktop restarts into this state; the phone holds the roster it persisted from the previous one.
  await storage.clear();
  d = desktop(withRows(prev.name));
  p = phone();
  const persisted = storage.nextSave();
  await d.connect(p)(await p.claim());
  await persisted;
  d = desktop(withRows(name));
  p = phone();
  note(`restart:${prev.name}>${name}`, p, await d.connect(p)(await p.claim()));
  // A change between the baseline's subscribe and its list: the host publishes the next state while the read is held.
  await storage.clear();
  d = desktop(withRows(prev.name));
  p = phone();
  const { arrived, release } = d.hold();
  const syncing = d.connect(p)(await p.claim());
  await arrived;
  d.publish(withRows(name));
  release();
  note(`between:${prev.name}>${name}`, p, await syncing);
}

// Publishing a roster the phone already has: Node's catalog skips an unchanged roster, so nothing reaches the phone.
live.publish(rosters.at(-1).roster);
note('unchanged:delete', livePhone, undefined);

// Node's catalog order over ties, lastUsedAt over updatedAt, and rows with no activity at all (schema.mjs byActivityThenId): the rows are
// Node store rows (inputs); `order` is what Node's own comparator gives.
const tieRows = [
  { id: 'sess_10', updatedAt: 500 }, { id: 'sess_11', updatedAt: 500 }, { id: 'sess_09', updatedAt: 500 }, { id: 'sess_13', updatedAt: 100, lastUsedAt: 900 },
  { id: 'sess_14', updatedAt: 900 }, { id: 'sess_15', updatedAt: 0 }, { id: 'sess_A', updatedAt: 0 }, { id: 'sess_a', updatedAt: 0, lastUsedAt: 0 },
].map((row) => ({ preview: '', title: row.id, messageCount: 0, cwd: PROJECT.a, classification: 'project', projectPath: PROJECT.a, ...row, activityAt: Number(row.lastUsedAt) || row.updatedAt }));
steps.push({ name: 'order-ties', coreRows: plain(tieRows), order: [...tieRows].sort(byActivityThenId).map((r) => r.id) });

await meta.flush();
const manifest = { exact: true, commit: COMMIT, tree: execFileSync('git', ['-C', NODE_CHECKOUT, 'rev-parse', `${COMMIT}^{tree}`]).toString().trim(), filesCompared: checked, crlfOnlyDifferences: eolOnly, source: 'git archive of the whole tree, every file compared with its git blob id; remote-view-sync.ts, remote-relay-catalog.ts, view-synchronizer.ts, list-delta.ts, remote-roster-cache.ts, desktop-session-metadata.ts, store-summary-index.mjs run unchanged', actions: ACTIONS.map(([name]) => name) };
writeFileSync(outFile, `${JSON.stringify({ manifest, states: rosters, steps }, null, 2)}\n`);
console.log(`recorded ${steps.length} steps over ${checked} verified files`);
process.exit(0);