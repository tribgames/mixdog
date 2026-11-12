#!/usr/bin/env node
// Recording of the `session` tool's list, send and create actions (daemon-session-control.mjs createSessionControl,
// agent-task-sessions.mjs createAgentTaskSessions, workspace-tools.mjs session handler) through Node's session tool
// handler. The session service is Node's own (`createSessionService` over a stub runtime factory, so a missing session and an
// accepted prompt, queued or not, are the service's answers); what sits below the code under test is a seam of its own: the
// catalog pages (`listSessions`), the bots (`listBots`), the live work, the archived flags, the report watches (they refuse,
// as the core has no report queue: Node's own answer to a watch it cannot store) and the projects.
//
// Each case records its `input` (the arguments and the world it ran in) beside what the tool answered and what the code below
// it was asked for: the replay builds the same world from it.
//
//   node benchmarks/rust-core/recorders/record-session-control-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'session-control-')));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
const WORK = join(sandbox, 'work');
mkdirSync(join(WORK, 'site'), { recursive: true });
const { openSet, FIXED_NOW } = await import('./lib/case-set.mjs');

const set = openSet('session-control-cases', import.meta.url);
const { createWorkspaceToolHandlers } = await set.load('src/session-runtime/internal-tool-executor/workspace-tools.mjs');
const { createSessionControl } = await set.load('src/standalone/daemon-session-control.mjs');
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { createAgentTaskSessions } = await set.load('src/session-runtime/agent-task-sessions.mjs');
const { registerSessionSidebarHost } = await set.load('src/runtime/shared/session-sidebar-host.mjs');
const { markHeartbeatSession } = await set.load('src/runtime/shared/routine-trigger.mjs');

const REPORT_QUEUE = 'the report queue is not available in this runtime';
const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4' };
const CREATED = /sess_daemon_\d+_[0-9a-f]{32}/g;
const REQUEST = /atask_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const WORK_TEXT = JSON.stringify(WORK).slice(1, -1);
// A folder inside an answer that is itself JSON text is escaped twice.
const WORK_QUOTED = JSON.stringify(WORK_TEXT).slice(1, -1);
const names = (value) => JSON.parse(JSON.stringify(value).replaceAll(WORK_QUOTED, '<WORK>').replaceAll(WORK_TEXT, '<WORK>').replace(CREATED, '<created>').replace(REQUEST, '<request>'));
// What a case records of the calls below the code under test: the catalog pages asked for, the prompts the runtime took and
// the session a create made. The service's own bookkeeping (materializeSession, the wrapper calls) and the log lines are not.
const EFFECTS = new Set(['listSessions', 'runtime.submitAsync', 'service.createSession']);

// The desktop's archived flags: a host seam of the sidebar state.
const sidebar = new Map();
registerSessionSidebarHost(
  async (sessionId, change) => { if (change.archived === true) sidebar.set(sessionId, FIXED(1)); else if (change.archived === false) sidebar.delete(sessionId); },
  { state: async () => ({ archived: Object.fromEntries(sidebar) }) },
);

function FIXED(n) { return 1_700_000_000_000 + n * 1000; }
const row = (id, extra = {}) => ({ id, title: `Title of ${id}`, status: 'idle', cwd: '/project', lastUsedAt: FIXED(1), updatedAt: FIXED(1), ...extra });

/**
 * One world per case: the real session service over a stub runtime factory, Node's session control over it, and the session
 * tool's handler. `options` is plain data (it is recorded): `sessions` the stored ones, `busy` those running a turn, `pages`
 * the catalog pages in the order they are asked for, `live` `{ own: [ids], agents: [ids] }`, `archived` the ids the sidebar
 * holds archived, `bots` the contact bots, `projects`, `rows` the stored records by id, `callerSession` the calling session's
 * record, `calling` the id the call names as its caller when it is not that session.
 */
function world({ sessions = ['target'], busy = [], pages = [], live = { own: [], agents: [] }, archived = [], bots = ['ann'], callerSession, calling, projects = [], rows = {}, heartbeat = false } = {}) {
  if (heartbeat) markHeartbeatSession((callerSession ?? {}).id);
  const calls = [];
  const known = new Set(sessions);
  const queue = structuredClone(pages);
  const inner = createSessionService({
    createSessionRuntime: async () => {
      let state = { sessionId: '', items: [], busy: false, cwd: '/p' };
      return {
        getState: () => state,
        subscribe: () => () => {},
        async resume(id) { state = { ...state, sessionId: id, busy: busy.includes(id) }; return true; },
        bindSessionAddress() {},
        reserveSession(id) { state = { ...state, sessionId: String(id) }; known.add(String(id)); return true; },
        // `skipSlashCommands` is the service's own stamp of a home chat's prompt, not a thing the tool asks for.
        async submitAsync(text, options) { const { skipSlashCommands: _stamp, ...asked } = options ?? {}; calls.push(['runtime.submitAsync', state.sessionId, text, asked]); return true; },
        async dispose() {},
      };
    },
    sessionExists: async (id) => known.has(id),
    readStoredSession: async () => null,
    listSessions: async (options) => { calls.push(['listSessions', options]); return queue.shift() ?? { sessions: [], nextCursor: null }; },
    publishIntervalMs: 5,
  });
  // The session a create asks the service for is an effect of the case.
  const service = { ...inner, createSession: async (input) => { calls.push(['service.createSession', structuredClone(input)]); return inner.createSession(input); } };
  const delivered = [];
  const agentTasks = createAgentTaskSessions({
    getSessionService: () => service,
    deliver: async (agentId, report) => { delivered.push([agentId, report]); },
    watches: { add: async () => { throw new Error(REPORT_QUEUE); }, remove: async () => {}, list: async () => [], owned: async () => [], own: async () => {}, disown: async () => {} },
    loadSession: async (id) => rows[id] ?? null,
    listProjects: async () => projects,
    newTaskDefault: async () => undefined,
    leadRoute: async () => MODEL,
    lastUsedRoute: async () => null,
    agentName: async (id) => `Agent ${id}`,
    turnArtifacts: async () => ({ files: [] }),
    retryDelaysMs: [],
    pendingWork: async () => false,
    settleMs: 0,
    log: () => {},
  });
  const liveWork = { own: new Map(live.own.map((id) => [id, Date.now()])), agents: new Set(live.agents) };
  const executeSessionControl = createSessionControl({
    getSessionService: () => service,
    agentTasks,
    listBots: async () => bots.map((id) => ({ id })),
    liveWork: async () => liveWork,
    readRow: async (id) => rows[id] ?? null,
    readTitle: async () => null,
    pendingWork: async () => false,
  });
  const rt = { session: callerSession ?? { id: 'caller', sourceType: 'lead' }, mode: 'lead', currentCwd: WORK, config: {} };
  const handler = createWorkspaceToolHandlers({ rt, executeSessionControl, listBots: async () => bots.map((id) => ({ id })), getSessionManager: () => null }).session;
  return async (args) => {
    sidebar.clear();
    for (const id of archived) sidebar.set(id, FIXED(1));
    const outcome = await handler(args, { callerCtx: { callerSessionId: calling ?? rt.session.id }, callerCwd: WORK }).then(
      (text) => ({ answer: text }),
      (error) => ({ error: error.message }),
    );
    return names({ ...outcome, calls: calls.splice(0).filter((call) => EFFECTS.has(call[0])), delivered: delivered.splice(0) });
  };
}

/** Runs `args` in the world `options` describes, recording both. */
const record = (name, args, options = {}) => set.run(name, () => world(options)(args), { input: names({ args, options }) });

const bot = { id: 'sess_home_ann', sourceType: 'exec', messages: [] };
const human = { id: 'caller', sourceType: 'lead' };
const background = { id: 'worker', parentSessionId: 'sess_home_ann', sourceType: 'lead' };

// --- list ---------------------------------------------------------------------------------------------------
const catalog = [
  row('sess_user_1', { title: 'Bug fix session', lastMessagePreview: 'secret user line', working: true, lastUsedAt: FIXED(5) }),
  row('sess_home_ann', { title: 'Home', lastMessagePreview: 'own   line\n  continues', lastUsedAt: FIXED(6) }),
  row('sess_task_9', { title: 'Other bot task', sourceName: 'agent:mailer@home', lastMessagePreview: 'mailer line' }),
  row('sess_user_2', { title: '', preview: 'my bank password is...', status: 'running', cwd: '/private', working: true }),
  row('sess_old', { title: 'Old <system-reminder> session', lastUsedAt: FIXED(0) }),
  row('sess_sub', { title: 'A sub-agent session', owner: 'agent', agent: 'worker', parentSessionId: 'sess_user_1', visibility: 'agent-only' }),
];
const page = (sessions, nextCursor = null) => ({ sessions, nextCursor });
for (const [name, args, callerSession] of [
  ['list: the human sees every session with previews, live work and the archived marker', { action: 'list', include_archived: true }, human],
  ['list: archived sessions and sub-agent sessions are left out unless asked for', { action: 'list' }, human],
  ['list: a bot sees every session but previews and bot details only of its own', { action: 'list' }, bot],
  ['list: a background run sees the plain rows only', { action: 'list' }, background],
  ['list: limit and cursor are the catalog page and its continuation', { action: 'list', limit: 2, cursor: 'earlier' }, human],
  ['list: include_agents and include_archived', { action: 'list', include_agents: true, include_archived: true }, human],
  ['list: include_agents must be a boolean', { action: 'list', include_agents: 'yes' }, human],
  ['list: include_archived must be a boolean', { action: 'list', include_archived: 1 }, human],
  ['list: limit out of range', { action: 'list', limit: 101 }, human],
  ['list: limit is an integer', { action: 'list', limit: 2.5 }, human],
  ['list: a session_id is not looked at', { action: 'list', session_id: 'ann' }, human],
]) {
  await record(name, args, { callerSession, archived: ['sess_old'], pages: [page(catalog)] });
}
await record('list: live sessions lead the first page, newest sign of work first, and a later page keeps catalog order', { action: 'list', limit: 3 }, {
  live: { own: ['sess_live_a', 'sess_live_b'], agents: ['sess_agent_lead'] },
  rows: { sess_live_a: row('sess_live_a', { lastUsedAt: FIXED(2) }), sess_live_b: row('sess_live_b', { lastUsedAt: FIXED(3) }), sess_agent_lead: row('sess_agent_lead') },
  pages: [page([row('sess_live_a'), row('sess_other')], 'more')],
});
await record('list: a later page keeps the catalog order and shows the live ones where they sit', { action: 'list', limit: 3, cursor: 'more' }, {
  live: { own: ['sess_live_a'], agents: [] },
  rows: { sess_live_a: row('sess_live_a') },
  pages: [page([row('sess_live_a'), row('sess_other')])],
});
await record('list: a page the output budget shortens continues after the last row shown', { action: 'list', limit: 12 }, {
  pages: [page(Array.from({ length: 12 }, (_, i) => row(`sess_big_${i}`, { title: 'x'.repeat(300), cwd: `/${'d'.repeat(900)}`, lastUsedAt: FIXED(100 - i) })), 'beyond')],
});
await record('list: the scan stops at the rows it needs and names where to go on', { action: 'list', limit: 2 }, {
  pages: [page(Array.from({ length: 5 }, (_, i) => row(`sess_s_${i}`, { lastUsedAt: FIXED(50 - i) })), 'beyond')],
});
await record('list: the scan reads on past rows it leaves out', { action: 'list', limit: 2 }, {
  pages: [page([row('sess_a1'), row('sess_sub', { visibility: 'agent-only' })], 'p2'), page([row('sess_b1'), row('sess_b2'), row('sess_b3')], null)],
  archived: ['sess_a1'],
});

// --- send ---------------------------------------------------------------------------------------------------
const home = (id) => ({ sessions: [`sess_home_${id}`] });
await record('send: a prompt to an idle session is accepted and runs there', { action: 'send', session_id: 'target', prompt: 'continue' });
await record('send: a prompt to a session running a turn is accepted and queued behind it', { action: 'send', session_id: 'target', prompt: 'continue' }, { busy: ['target'] });
await record('send: the prompt is not trimmed', { action: 'send', session_id: 'target', prompt: '  indented\n  text  ' });
await record('send: the session id is trimmed', { action: 'send', session_id: '  target  ', prompt: 'hi' });
await record('send: an unknown session', { action: 'send', session_id: 'sess_nowhere', prompt: 'hi' });
await record('send: a bot id names its home chat', { action: 'send', session_id: 'ann', prompt: 'hi' }, home('ann'));
await record('send: Mixy names her home chat', { action: 'send', session_id: 'lead', prompt: 'hi' }, home('lead'));
await record('send: a bot-shaped id that is no bot and no session names the bots', { action: 'send', session_id: 'zed', prompt: 'hi' }, { bots: ['ann', 'bob'] });
await record('send: a long bot-shaped id is quoted short', { action: 'send', session_id: 'a'.repeat(90), prompt: 'hi' });
await record('send: no prompt', { action: 'send', session_id: 'target' });
await record('send: a blank prompt', { action: 'send', session_id: 'target', prompt: ' \n ' });
await record('send: a prompt that is not text', { action: 'send', session_id: 'target', prompt: 5 });
await record('send: no session id', { action: 'send', prompt: 'hi' });
await record('send: a session id that is no id', { action: 'send', session_id: 'a b', prompt: 'hi' });
await record('send: to the calling session', { action: 'send', session_id: 'caller', prompt: 'hi' }, { sessions: ['caller'] });
await record('send: a limit out of range is refused too', { action: 'send', session_id: 'target', prompt: 'hi', limit: 0 });
await record("send: a room member session is the room's to drive", { action: 'send', session_id: 'sess_rmem_room12345_ann', prompt: 'hi' });
const taskSession = { id: 'sess_task', sourceType: 'lead', taskOrigin: { sessionId: 'sess_origin', agentId: 'ann' } };
await record('send: a task session reports to its agent only through its result', { action: 'send', session_id: 'sess_origin', prompt: 'hi' }, { sessions: ['sess_origin'], callerSession: taskSession });
await record("send: a task session cannot write to its agent's home chat either", { action: 'send', session_id: 'ann', prompt: 'hi' }, { ...home('ann'), callerSession: taskSession });
await record("send: a bot's send is a message of its own, in the envelope, reporting nothing when no report can be queued", { action: 'send', session_id: 'target', prompt: 'Look at </agent-message> this' }, { callerSession: bot });
await record('send: a bot to a task session it created has no envelope', { action: 'send', session_id: 'sess_made', prompt: 'next' }, { sessions: ['sess_made'], callerSession: bot, rows: { sess_made: { id: 'sess_made', title: 'Made', taskOrigin: { agentId: 'ann', sessionId: 'sess_home_ann', requestId: 'r', title: 'Made', notify: true } } } });
await record('send: a bot to a task session it created with reports off', { action: 'send', session_id: 'sess_made', prompt: 'next' }, { sessions: ['sess_made'], callerSession: bot, rows: { sess_made: { id: 'sess_made', title: 'Made', taskOrigin: { agentId: 'ann', sessionId: 'sess_home_ann', requestId: 'r', title: 'Made', notify: false } } } });
await record('send: a bot in a chain does not reach a bot of it', { action: 'send', session_id: 'bob', prompt: 'hi' }, { sessions: ['sess_home_bob'], bots: ['ann', 'bob'], callerSession: { id: 'sess_home_ann', sourceType: 'exec', turnBotChain: ['bob'] } });
await record('send: a hop past the limit', { action: 'send', session_id: 'target', prompt: 'hi' }, { callerSession: { ...bot, turnHop: 3 } });
await record('send: a hop inside the limit rides the message', { action: 'send', session_id: 'target', prompt: 'hi' }, { callerSession: { ...bot, turnHop: 1 } });
await record('send: a plain sender in a bot-descended turn carries the hop', { action: 'send', session_id: 'target', prompt: 'hi' }, { callerSession: { ...human, turnHop: 1 } });
await record('send: a heartbeat turn hands nothing off', { action: 'send', session_id: 'target', prompt: 'hi' }, { callerSession: { id: 'sess_hb', sourceType: 'exec' }, heartbeat: true });
await record('send: a delegated worker is not the Lead', { action: 'send', session_id: 'target', prompt: 'hi' }, { calling: 'other' });
await record('send: attachments apply to send and create only', { action: 'list', attachments: ['a.png'] });

// --- read and status of a session there is none of ---------------------------------------------------------
await record('read: an unknown session', { action: 'read', session_id: 'sess_nowhere' });
await record('read: a bot-shaped id that is no bot and no session names the bots', { action: 'read', session_id: 'zed' }, { bots: ['ann', 'bob'] });
await record('status: a bot-shaped id that is no bot and no session names the bots', { action: 'status', session_id: 'zed' });
await record('cancel: a bot id is no session id', { action: 'cancel', session_id: 'zed' });
await record('cancel: an unknown session', { action: 'cancel', session_id: 'sess_nowhere' });
await record('delete: an unknown session', { action: 'delete', session_id: 'sess_nowhere' });
await record('cancel: the calling session', { action: 'cancel', session_id: 'caller' });

// --- create -------------------------------------------------------------------------------------------------
const botWorld = { callerSession: bot };
await record("create: a brief starts a task session in the caller's folder", { action: 'create', brief: 'Fix the login bug\nsecond line' }, botWorld);
await record('create: a title of its own', { action: 'create', brief: 'Fix it', title: '  Login   ' }, botWorld);
await record('create: a title is cut to sixty characters', { action: 'create', brief: 'x'.repeat(100) }, botWorld);
await record('create: a registered project by name', { action: 'create', brief: 'Fix it', project: 'Site' }, { ...botWorld, projects: [{ name: 'Site', path: '/work/site' }] });
await record('create: a folder that is no registered project', { action: 'create', brief: 'Fix it', project: 'site' }, botWorld);
await record('create: an ambiguous project', { action: 'create', brief: 'Fix it', project: 'site' }, { ...botWorld, projects: [{ name: 'Site', path: '/a' }, { name: 'SITE', path: '/b' }] });
await record('create: a project that is no project and no folder', { action: 'create', brief: 'Fix it', project: 'nowhere-at-all' }, botWorld);
await record('create: notify false', { action: 'create', brief: 'Fix it', notify: false }, botWorld);
await record('create: no brief', { action: 'create' }, botWorld);
await record('create: a blank brief', { action: 'create', brief: '  ' }, botWorld);
await record('create: only a bot conversation creates', { action: 'create', brief: 'Fix it' });
await record('create: a delegated worker is not the Lead', { action: 'create', brief: 'Fix it' }, { ...botWorld, calling: 'other' });
await record('create: a bot in a chain hands the task on with its hop and chain', { action: 'create', brief: 'Fix it' }, { callerSession: { ...bot, turnHop: 2, turnBotChain: ['bob'] } });

await set.finish({
  entry: "workspace-tools.mjs createWorkspaceToolHandlers().session (the session tool, actions list, send and create) over daemon-session-control.mjs createSessionControl, agent-task-sessions.mjs createAgentTaskSessions and the real session-service.mjs createSessionService on a stub runtime factory; seams: the catalog pages, the bot list, the live work, the archived flags, the report watches (refusing) and the projects",
  replay: { entry: 'SessionTool::call over DirectorySessionPort (the tool answer or refusal of each case, and the requests the port makes of the session catalog and the thread requests)', normalised: {} },
  exclusions: {
    'service bookkeeping': "a case records the catalog pages asked for (listSessions), the prompts the runtime took (runtime.submitAsync) and the session a create made (service.createSession); the service's own calls (materializeSession, the wrapper calls) and the log lines are Node internals; `skipSlashCommands`, which the service stamps on the prompt of a home chat, is dropped",
    'random names': "a created session id (sess_daemon_<ms>_<32 hex>) is <created>, a create's request id (atask_<uuid>) is <request> and the caller's folder (a temporary directory) is <WORK>",
    'attached files': "a file forwarded with send/create needs the caller's conversation files; the core refuses attachments in this runtime (session_port.rs resolve_attachments)",
    'reports': "the report queue (watches, started line, final report) is not in the core; Node's answer to a watch it cannot store is recorded with that seam refusing",
    'a group room': "a send to a room's log goes through the desktop room host; the core has none for the session tool and refuses it",
    'model, effort, worktree': 'create and send with model, effort or worktree need the model catalog and the worktree host through the session service; the core refuses them',
    'the route of a task': 'Node starts a task on the Lead route of the config, else the last used model; the core starts it through thread/start, whose default route is decided by the route service',
  },
});
process.exit(0);
