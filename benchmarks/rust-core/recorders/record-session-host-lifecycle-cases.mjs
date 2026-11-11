#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-host-lifecycle.test.mjs (b6f10295a): SessionHost disposal, archive/restore of session
// trees (sidebar flags, the worktree cleanup hand-off), sub-agent retention through the real host, the read cursor's numbering and a
// failed metadata flush. Real SessionHost (apps/desktop/src/main/session-host.ts), session-sidebar-actions.ts, the runtime's
// session-sidebar-host.mjs and applySubAgentRetention; the daemon client is scripted (a session list and a close counter).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-host-lifecycle-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { within } from './lib/recorder-error.mjs';
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-host-lifecycle-cases', import.meta.url);
const { SessionHost } = await set.load('apps/desktop/src/main/session-host.ts');
const { sessionSidebarChangeHandler } = await set.load('apps/desktop/src/main/session-sidebar-actions.ts');
const { applySessionSidebarChange, readSessionSidebarState, registerSessionSidebarHost } = await set.load('src/runtime/shared/session-sidebar-host.mjs');
const { applySubAgentRetention } = await set.load('src/runtime/agent/orchestrator/session/store/sweep/sub-agent-retention.mjs');
const roots = [];

async function fixture(close, sessions = []) {
  const root = await mkdtemp(join(tmpdir(), 'session-host-lifecycle-'));
  roots.push(root);
  const host = await SessionHost.create(
    { userDataPath: root, resourcesPath: root, appPath: root, packaged: false },
    { attachSessionClient: async () => ({ list: async () => ({ sessions }), close }), loadProjects: async () => ({}), loadSessionStore: async () => ({}), loadStatuslineSegments: async () => ({}), executeCodeGraphTool: async () => ({}) },
  );
  return { host, root, cleanup: async () => { await within('the host disposal at cleanup', host.dispose().catch(() => {}), 10_000); await rm(root, { recursive: true, force: true }); } };
}
const sub = (id, ownerSessionId) => ({ id, owner: 'agent', agent: 'worker', visibility: 'agent-only', ownerSessionId, messageCount: 2, preview: 'work' });

await set.run('every overlapping host disposal waits for the same attachment cleanup', async () => {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const events = [];
  let closes = 0;
  const { host, cleanup } = await fixture(async () => { closes++; events.push('cleanup entered'); entered.resolve(); await release.promise; events.push('cleanup returned'); });
  try {
    const first = host.dispose().then(() => { events.push('first dispose finished'); });
    await within('the host to start the attachment cleanup', entered.promise, 5000);
    const second = host.dispose().then(() => { events.push('second dispose finished'); });
    events.push('cleanup released');
    release.resolve();
    await within('both overlapping disposals to finish', Promise.all([first, second]), 5000);
    return { events, closes };
  } finally { await cleanup(); }
});
await set.run('archiving a session archives its sub-agent sessions; restoring it brings back the ones it took', async () => {
  const rows = [{ id: 'sess_lead', owner: 'user', agent: 'lead', sourceType: 'lead', messageCount: 2, preview: 'lead' }, sub('sess_w1', 'sess_lead'), sub('sess_w2', 'sess_lead'), sub('sess_w_other', 'sess_lead_other')];
  const { host, cleanup } = await fixture(async () => {}, rows);
  try {
    const log = [];
    await host.setSessionArchived('sess_w2', true);
    await host.setSessionArchived('sess_lead', true);
    let state = await host.sessionSidebarState();
    log.push({ step: 'w2 archived, then the lead', archived: structuredClone(state.archived) });
    await host.setSessionArchived('sess_lead', false);
    state = await host.sessionSidebarState();
    log.push({ step: 'lead restored', archived: structuredClone(state.archived) });
    await host.forgetSessionMetadata('sess_w2');
    log.push({ step: 'w2 forgotten (store deleted it)', archived: (await host.sessionSidebarState()).archived });
    return { rows, log };
  } finally { await cleanup(); }
});
await set.run("archiving or restoring a session hands its tree's ids to the worktree cleanup, and a failure there never fails the archive", async () => {
  const rows = [{ id: 'sess_lead', owner: 'user', agent: 'lead', sourceType: 'lead', messageCount: 2, preview: 'lead' }, { id: 'sess_w1', owner: 'agent', agent: 'worker', ownerSessionId: 'sess_lead', messageCount: 2, preview: 'w' }];
  const { host, cleanup } = await fixture(async () => {}, rows);
  try {
    const forwarded = [];
    host.transport.invokeControl = async (method, args) => { forwarded.push([method, args]); throw new Error('daemon unavailable'); };
    await host.setSessionArchived('sess_lead', true);
    await host.setSessionArchived('sess_lead', false);
    return { rows, forwarded, archivedAfter: (await host.sessionSidebarState()).archived };
  } finally { await cleanup(); }
});
await set.run("sub-agent retention archives exactly its tree's members through the real host, no cascade past them", async () => {
  const subRow = (id, links, extra = {}) => ({ id, owner: 'agent', agent: 'worker', visibility: 'agent-only', messageCount: 2, preview: 'work', ...links, ...extra });
  const rows = [
    { id: 'sess_lead', owner: 'user', agent: 'lead', sourceType: 'lead', messageCount: 2, preview: 'lead' },
    subRow('sess_t', { ownerSessionId: 'sess_lead', parentSessionId: 'sess_lead' }),
    subRow('sess_t_child', { ownerSessionId: 'sess_lead', parentSessionId: 'sess_t' }),
    subRow('sess_t_outside', { ownerSessionId: 'sess_t' }, { taskOrigin: { agentId: 'mailer' } }),
  ];
  const { host, cleanup } = await fixture(async () => {}, rows);
  const dir = join(process.env.MIXDOG_DATA_DIR, 'sessions');
  const written = [];
  let unregister = () => {};
  try {
    await mkdir(dir, { recursive: true });
    const at = Date.now() - 5 * 24 * 60 * 60 * 1000;
    for (const row of rows.slice(1, 3)) { await writeFile(join(dir, `${row.id}.json`), JSON.stringify({ ...row, createdAt: at, updatedAt: at, lastUsedAt: at })); written.push(join(dir, `${row.id}.json`)); }
    unregister = registerSessionSidebarHost(sessionSidebarChangeHandler(host), { state: () => host.sessionSidebarState() });
    const flags = await readSessionSidebarState();
    const members = [{ id: 'sess_t', parentId: 'sess_lead', lastActive: at }, { id: 'sess_t_child', parentId: 'sess_t', lastActive: at }];
    const applied = await applySubAgentRetention(members, { isArchived: (id) => Object.hasOwn(flags.archived, id), setSidebar: applySessionSidebarChange });
    const archivedAfterRetention = structuredClone((await host.sessionSidebarState()).archived);
    await host.setSessionArchived('sess_t', false);
    await host.setSessionArchived('sess_t', true);
    return { rows, storedRecordAgeDays: 5, members, applied, archivedAfterRetention, archivedAfterExplicitArchive: (await host.sessionSidebarState()).archived };
  } finally { unregister(); for (const p of written) await rm(p, { force: true }); await cleanup(); }
});
await set.run('a read lands in the session’s own numbering: a surface counting in a retired one cannot read past it', async () => {
  const chat = { id: 'sess_chat', owner: 'user', agent: 'lead', sourceType: 'lead', preview: 'chat' };
  const { host, cleanup } = await fixture(async () => {}, [{ ...chat, messageCount: 62, compactCount: 17 }]);
  try {
    await host.listSessions();
    await host.markSessionRead('sess_chat', 417, false);
    const [listed] = await host.listSessions();
    return { listedMessageCount: 62, listedCompactCount: 17, surfaceReadCount: 417, listed };
  } finally { await cleanup(); }
});
await set.run('failed metadata flushing cannot prevent host attachment cleanup', async () => {
  let closes = 0;
  const { host, root, cleanup } = await fixture(async () => { closes++; });
  const realError = console.error;
  console.error = () => {};
  try {
    await host.listSessions();
    await mkdir(join(root, 'desktop-session-metadata.json'));
    await host.markSessionRead('session-a', 2, false);
    let outcome;
    try { await host.dispose(); outcome = { resolved: true }; } catch (e) { outcome = { rejected: e }; }
    return { metadataPathIsADirectory: 'desktop-session-metadata.json', disposeOutcome: outcome, closes };
  } finally { console.error = realError; await cleanup(); }
});

await set.finish({
  entry: { runs: 'SessionHost (setSessionArchived, sessionSidebarState, forgetSessionMetadata, markSessionRead, listSessions, dispose, transport.invokeControl hand-off), sessionSidebarChangeHandler, registerSessionSidebarHost / readSessionSidebarState / applySessionSidebarChange and applySubAgentRetention over the host', notRun: 'no daemon: the session client is a scripted list/close pair; the real data dir (MIXDOG_DATA_DIR of the test env) holds the retention members\' stored records' },
  replay: { entry: 'mixdog-app-server-daemon compose_flip.rs sub-agent retention and the session sidebar: replay each case\'s calls and compare the archived-id sets after each step, the worktree cleanup hand-off, the retention result, the read cursor and the dispose outcome', normalised: { userData: 'the temp user-data path is written <userData> wherever it occurs (paths listed in normalised.paths)' } },
  replaceInText: roots.map((r) => [r, '<userData>']),
});
process.exit(0);
