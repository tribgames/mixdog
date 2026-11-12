// What Node b6f10295a answers for an agent child whose record a terminal reaper unlinked (gaps-session item 9): a 1.4.5
// data directory (legacy `<id>.json` parents carrying the child's completion notification, `agent-workers.json`
// links, `session-summaries.json` + `.log` catalog rows) and, through Node's own entries, for each child id:
//   transcript  `readStoredSessionTranscript` (the desktop's transcript read; `readVanishedSessionTranscript` →
//               `readArchivedAgentResult`)
//   resume      the session manager's `resumeSession`
//   fork        `createInheritance(...).inheritToNewSession` (the session tool's fork) over the real manager
//   delete      the runtime's `deleteSession` (session-switch/session-delete.mjs, the desktop's delete)
// and the model's `session` tool (`sessionTool`): list (with and without agents), and read, status and send of the
// linked child, the orphan (its one parent gone) and an id never stored.
// The data directory's files are recorded as written, so the replay migrates the same bytes.
//
//   node benchmarks/rust-core/recorders/record-archived-agent.mjs --tree <exact export of b6f10295a>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-archived-agent.mjs';
const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const load = (path) => import(pathToFileURL(join(tree, path)).href);
const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-archived-agent-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.on('exit', () => rmSync(dataDir, { recursive: true, force: true }));

// The completion notification the agent tool writes into the parent (`Async agent task … finished.` + Result block).
const notification = (child, { status = 'completed', body, headers = {}, at }) => ({
  role: 'user',
  content: [
    `Async agent task task_${child} (${status}) finished.`,
    '',
    'Result:',
    '> background task',
    `> sessionId: ${child}`,
    '> surface: agent',
    `> status: ${status}`,
    ...Object.entries(headers).map(([k, v]) => `> ${k}: ${v}`),
    '> ',
    ...body.split('\n').map((line) => `> ${line}`),
  ].join('\n'),
  ...(at ? { meta: { transcript: { at } } } : {}),
});
const full = { tag: 'w1', agent: 'worker', provider: 'openai', model: 'gpt-5', effort: 'high', fast: 'true', finished: '2026-03-01T10:00:00.000Z' };
const parent = (id, updatedAt, messages, extra = {}) => ({
  id,
  owner: 'user',
  agent: 'lead',
  closed: false,
  generation: 1,
  createdAt: 1_700_000_000_000,
  updatedAt,
  cwd: 'C:/work/project',
  title: `parent ${id}`,
  messages: [{ role: 'user', content: 'start the agents' }, ...messages],
  ...extra,
});

const files = {
  'sessions/sess_parent_a.json': parent('sess_parent_a', 1_772_000_000_000, [
    notification('sess_child_link', { status: 'failed', body: 'older failed body', headers: full }),
    { role: 'assistant', content: 'waiting' },
    notification('sess_child_link', { body: 'linked body\nsecond line', headers: full }),
    notification('sess_child_two', { body: 'two parents: a', headers: { agent: 'worker' }, at: 1_772_000_000_500 }),
    notification('sess_child_tie', { body: 'tie: a', headers: { agent: 'worker', finished: '2026-03-02T00:00:00.000Z' } }),
    notification('sess_child_logrow', { body: 'catalog log row body', headers: { model: 'm-log' } }),
    { role: 'user', content: 'Async agent task task_x (completed) finished.\n\nResult:\n> sessionId: sess_child_bad\n> surface: agent\n> status: running\n> \n> not terminal' },
    { role: 'user', content: 'Async agent task task_y (completed) finished.\n\nResult:\n> sessionId: sess_child_empty\n> surface: agent\n> status: completed\n> \n> ' },
  ]),
  'sessions/sess_parent_b.json': parent('sess_parent_b', 1_772_100_000_000, [
    notification('sess_child_row', { body: 'catalog row body', headers: { agent: 'reviewer', model: 'claude', provider: 'anthropic' } }),
    notification('sess_child_two', { body: 'two parents: b', headers: { agent: 'worker' }, at: 1_772_000_000_900 }),
    notification('sess_child_tie', { body: 'tie: b', headers: { agent: 'worker', finished: '2026-03-02T00:00:00.000Z' } }),
  ], { desktopSession: { projectPath: 'C:/work/project' } }),
  'sessions/sess_alive_child.json': {
    id: 'sess_alive_child', owner: 'agent', agent: 'worker', closed: true, generation: 1, updatedAt: 1_772_000_000_000,
    parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a', messages: [{ role: 'user', content: 'alive' }, { role: 'assistant', content: 'still here' }],
  },
  // The shape 1.4.5's worker index writes: version 2, rows keyed by session id.
  'agent-workers.json': {
    version: 2,
    tombstones: {},
    workers: Object.fromEntries([
      { sessionId: 'sess_child_link', parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a', tag: 'w1' },
      { sessionId: 'sess_child_two', parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a' },
      { sessionId: 'sess_child_tie', parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a' },
      { sessionId: 'sess_child_orphan', parentSessionId: 'sess_parent_gone', ownerSessionId: 'sess_parent_gone' },
      { sessionId: 'sess_child_bad', parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a' },
      { sessionId: 'sess_child_empty', parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a' },
      { sessionId: 'sess_child_silent', parentSessionId: 'sess_parent_b', ownerSessionId: 'sess_parent_b' },
      { sessionId: 'sess_alive_child', parentSessionId: 'sess_parent_a', ownerSessionId: 'sess_parent_a' },
    ].map((row) => [row.sessionId, row])),
  },
  'session-summaries.json': {
    version: 2,
    updatedAt: 1,
    rows: [
      { id: 'sess_child_row', owner: 'agent', agent: 'reviewer', ownerSessionId: 'sess_parent_b', updatedAt: 1 },
      { id: 'sess_child_two', owner: 'agent', agent: 'worker', ownerSessionId: 'sess_parent_b', updatedAt: 1 },
      { id: 'sess_child_tie', owner: 'agent', agent: 'worker', parentSessionId: 'sess_parent_b', updatedAt: 1 },
      { id: 'sess_child_removed', owner: 'agent', agent: 'worker', ownerSessionId: 'sess_parent_b', updatedAt: 1 },
      { id: 'sess_deleted_lead', owner: 'user', agent: 'lead', updatedAt: 1, preview: 'gone' },
    ],
  },
};
const texts = Object.fromEntries(Object.entries(files).map(([rel, value]) => [rel, JSON.stringify(value)]));
texts['sessions/sess_parent_b.json'] += '\n';
// The delta log the catalog replays over the base: an upsert naming a parent and the removal of a row.
texts['session-summaries.log'] = [
  '',
  JSON.stringify({ u: { id: 'sess_child_logrow', owner: 'agent', agent: 'worker', ownerSessionId: 'sess_parent_a', updatedAt: 2 } }),
  JSON.stringify({ r: ['sess_child_removed'] }),
  '',
].join('\n');
mkdirSync(join(dataDir, 'sessions'), { recursive: true });
for (const [rel, text] of Object.entries(texts)) writeFileSync(join(dataDir, rel), text);

const CHILDREN = [
  'sess_child_link',
  'sess_child_row',
  'sess_child_two',
  'sess_child_tie',
  'sess_child_logrow',
  'sess_child_removed',
  'sess_child_orphan',
  'sess_child_bad',
  'sess_child_empty',
  'sess_child_silent',
  'sess_deleted_lead',
  'sess_never_existed',
];

const settle = async (fn) => {
  try {
    return { value: exact(await fn()) };
  } catch (error) {
    return { threw: exact(error) };
  }
};

const reader = await load('src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const manager = await load('src/runtime/agent/orchestrator/session/manager.mjs');
const { createInheritance } = await load('src/session-runtime/lifecycle/inheritance.mjs');
const inheritance = createInheritance(
  {
    getSession: () => null,
    getRoute: () => null,
    mgr: manager,
    createCurrentSession: null,
    invalidateContextStatusCache: () => {},
    getReservedSessionId: () => null,
  },
  { compactConversation: null, saveSession: () => {} }
);
// The runtime's delete (the desktop's `deleteSession`), over the real manager; no session is current.
const { createSessionDelete } = await load('src/session-runtime/lifecycle/session-switch/session-delete.mjs');
const deletion = createSessionDelete(
  { getSession: () => null, setSession: () => {}, mgr: manager, statusRoutes: null, agentTool: null, createCurrentSession: null, invalidateContextStatusCache: () => {}, invalidatePreSessionToolSurface: () => {} },
  { cancelBackgroundTasks: () => {} }
);

const answers = {};
for (const id of CHILDREN) answers[id] = { transcript: await settle(() => reader.readStoredSessionTranscript(id)) };

// The model's `session` tool (daemon-session-control.mjs) over the daemon's real session service and stored-session
// views (daemon.mjs wiring: createDesktopRuntime -> createStoredSessionViews -> createSessionService); no runtime is
// ever created (a cold session is read from disk). The caller is the parent of the linked child.
const { createDesktopRuntime } = await load('src/standalone/daemon-desktop-runtime.mjs');
const { createStoredSessionViews } = await load('src/standalone/daemon-stored-session-views.mjs');
const { createSessionService } = await load('src/standalone/session-service.mjs');
const { createSessionControl } = await load('src/standalone/daemon-session-control.mjs');
const desktopRuntime = createDesktopRuntime({ getLocalSessionBridge: () => null });
const service = createSessionService({
  createSessionRuntime: async ({ sessionId }) => {
    throw new Error(`recorder: a runtime was asked for ${sessionId}`);
  },
  ...createStoredSessionViews({ desktopRuntime, dataDir }),
  desktopRuntime,
  idleEvictMs: null,
  softRssMb: null,
});
const control = createSessionControl({ getSessionService: () => service, listBots: async () => [] });
const caller = { callerSessionId: 'sess_parent_a' };
const sessionTool = {
  list: await settle(() => control({ action: 'list' }, caller)),
  listAgents: await settle(() => control({ action: 'list', include_agents: true }, caller)),
};
for (const id of ['sess_child_link', 'sess_child_orphan', 'sess_never_existed']) {
  sessionTool[id] = {
    read: await settle(() => control({ action: 'read', session_id: id }, caller)),
    status: await settle(() => control({ action: 'status', session_id: id }, caller)),
    send: await settle(() => control({ action: 'send', session_id: id, prompt: 'are you there?' }, caller)),
  };
}
// The other entries, each over the same child: one reaped with a link (archived view above) and one never stored.
for (const id of ['sess_child_link', 'sess_never_existed']) {
  answers[id].resume = await settle(() => manager.resumeSession(id));
  answers[id].fork = await settle(() => inheritance.inheritToNewSession(id));
  answers[id].delete = await settle(() => deletion.deleteSession(id));
  answers[id].transcriptAfterDelete = await settle(() => reader.readStoredSessionTranscript(id));
}
const left = readdirSync(join(dataDir, 'sessions')).sort();

const finalDir = join(FIXTURES_ROOT, 'archived-agent');
const outDir = stageSet(finalDir, null);
writeJson(join(outDir, 'archived-agent.json'), { scenario: 'archived-agent', files: texts, children: CHILDREN, answers, sessionTool, sessionsLeft: left });
writeSetManifest(outDir, {
  set: 'archived-agent',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of b6f10295a>`,
  extra: { values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)', ...recorderProvenance(import.meta.url) },
  identity,
});
commitStage(outDir, finalDir);
console.log('recorded archived-agent');
process.exit(0);
