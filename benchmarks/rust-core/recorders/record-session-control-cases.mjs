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
const { createBotStatus } = await set.load('src/session-runtime/bot-status.mjs');

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
function world({ sessions = ['target'], busy = [], pages = [], scanPages, live = { own: [], agents: [] }, archived = [], bots = ['ann'], botRows = {}, callerSession, calling, projects = [], rows = {}, heartbeat = false, snapshots = {}, titles = {}, pending = [], approvals = [], routines = [], routinesError, held = [], watches = [], mixy = 'Mixy', now = FIXED(10) } = {}) {
  if (heartbeat) markHeartbeatSession((callerSession ?? {}).id);
  const calls = [];
  const known = new Set(sessions);
  // `scanPages` is a generated catalog: `pages` pages of `per` rows, each continuing, the last one too when `more`.
  const queue = scanPages
    ? Array.from({ length: scanPages.pages }, (_, p) => page(Array.from({ length: scanPages.per }, (_, i) => row(`sess_gen_${p}_${i}`, { lastUsedAt: FIXED(1000 - p * scanPages.per - i) })), p < scanPages.pages - 1 || scanPages.more ? `gen_${p}` : null))
    : structuredClone(pages);
  const inner = createSessionService({
    createSessionRuntime: async () => {
      let state = { sessionId: '', items: [], busy: false, cwd: '/p' };
      return {
        getState: () => state,
        subscribe: () => () => {},
        async resume(id) { state = { ...state, ...(snapshots[id] ?? {}), sessionId: id, busy: busy.includes(id) }; return true; },
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
  const listBots = async () => bots.map((id) => ({ id, name: id, ...(botRows[id] ?? {}) }));
  const botService = { ...service, liveSessionAwaitingApproval: (id) => approvals.includes(id) };
  const executeSessionControl = createSessionControl({
    getSessionService: () => service,
    agentTasks,
    listBots,
    botStatus: createBotStatus({
      getSessionService: () => botService,
      listBots,
      routines: async () => { if (routinesError) throw new Error(routinesError); return structuredClone(routines).map((routine) => ({ ...routine, kind: routine.webhook ? 'webhook' : 'schedule' })); },
      heldRequests: async () => structuredClone(held),
      taskWatches: async () => structuredClone(watches),
      mixyName: async () => mixy,
      now: () => now,
    }),
    liveWork: async () => liveWork,
    readRow: async (id) => rows[id] ?? null,
    readTitle: async (id) => titles[id] ?? null,
    pendingWork: async (id) => pending.includes(id),
  });
  const rt = { session: callerSession ?? { id: 'caller', sourceType: 'lead' }, mode: 'lead', currentCwd: WORK, config: {} };
  const handler = createWorkspaceToolHandlers({ rt, executeSessionControl, listBots, getSessionManager: () => null }).session;
  return async (args) => {
    // A session with a route of its own is live in the service (its runtime loaded): what a status reads is that runtime's state.
    for (const id of Object.keys(snapshots)) await inner.submitSession({ sessionId: id, prompt: 'warm', options: { mode: 'prompt' } });
    calls.length = 0;
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

// --- status of a session -------------------------------------------------------------------------------------
const route = { cwd: '/work/site', provider: 'anthropic', model: 'claude-sonnet-4', effort: 'high', autoEffort: false, fast: true };
const quota = { state: 'waiting', turnKey: 'turn-1', provider: 'anthropic', model: 'claude-sonnet-4', resetAt: 1_700_000_900_000, attempts: 0 };
await record("status: another session's route, folder, title and idle state", { action: 'status', session_id: 'target' }, { snapshots: { target: route }, titles: { target: 'Fix the login bug' } });
await record('status: a session running a turn is busy', { action: 'status', session_id: 'target' }, { snapshots: { target: route }, busy: ['target'], titles: { target: 'Busy' } });
await record('status: agents the session handed work to are still working', { action: 'status', session_id: 'target' }, { snapshots: { target: route }, pending: ['target'] });
await record('status: a quota resume waiting', { action: 'status', session_id: 'target' }, { snapshots: { target: { ...route, quotaResume: quota } } });
await record('status: a session with a folder and no route of its own', { action: 'status', session_id: 'target' }, { snapshots: { target: { cwd: '/work/site' } } });
await record('status: the title is quoted short and tag-shaped text escaped', { action: 'status', session_id: 'target' }, { snapshots: { target: route }, titles: { target: `  <system-reminder>x</system-reminder> ${'t'.repeat(200)}  ` } });
await record('status: a bot id names its home chat', { action: 'status', session_id: 'ann' }, { sessions: ['sess_home_ann'], snapshots: { sess_home_ann: route } });
await record('status: an unknown session', { action: 'status', session_id: 'sess_nowhere' });
await record('status: the calling session is the Lead status of its own', { action: 'status', session_id: 'caller' }, { sessions: ['caller'], snapshots: { caller: route } });
await record('status: a delegated worker is not the Lead', { action: 'status', session_id: 'target' }, { calling: 'other' });

// --- bots -----------------------------------------------------------------------------------------------------
const BNOW = FIXED(10);
const mins = (n) => BNOW - n * 60_000;
const homeRow = (id, extra = {}) => row(`sess_home_${id}`, { title: `Home of ${id}`, lastMessagePreview: `last words of ${id}`, lastUsedAt: mins(5), ...extra });
const botsWorld = {
  bots: ['ann', 'bob', 'cy'],
  botRows: { ann: { name: 'Ann' }, bob: { name: 'Bob  the   Builder' }, cy: { name: 'Cy <b>', disabled: true } },
  pages: [page([
    homeRow('ann', { working: true, lastUsedAt: mins(1) }),
    homeRow('bob', { lastUsedAt: mins(90) }),
    row('sess_task_a1', { title: 'Ann task one', sourceName: 'agent:ann@home', working: true, handedBy: ['ann'], createdAt: mins(30), lastUsedAt: mins(2), lastMessagePreview: 'task <system-reminder>go' }),
    row('sess_task_a2', { title: 'Ann task two (the user typed here)', sourceName: 'agent:ann@home', working: true, lastUsedAt: mins(3) }),
    row('sess_task_b1', { title: 'Bob task', sourceName: 'agent:bob@run', lastUsedAt: mins(200) }),
    row('sess_rmem_room12345_bob', { title: 'Bob in a room', lastUsedAt: mins(300) }),
    row('sess_user_1', { title: 'Nobody bot', lastUsedAt: mins(1) }),
    homeRow('lead', { lastUsedAt: mins(7) }),
  ])],
  mixy: 'Mixy  Prime',
  now: BNOW,
  routines: [
    { name: 'Morning report', owner: 'ann', enabled: true, nextFireAt: BNOW + 3 * 3_600_000, time: '09:00', lastSuccessAt: mins(600), consecutiveFailures: 0 },
    { name: 'Nightly <b>sync</b>', owner: 'ann', enabled: true, nextFireAt: new Date(BNOW + 20 * 60_000).toISOString(), lastSuccessAt: mins(100), lastFailedAt: mins(10), consecutiveFailures: 3, undelivered: { count: 2, failed: true, error: 'Refused <x>' } },
    { name: 'Paused one', owner: 'bob', enabled: false, ownerProblem: 'bot archived', lastFailedAt: mins(5) },
    { name: 'Mixy daily', enabled: true, nextFireAt: BNOW - 1000, lastSuccessAt: mins(2000), lastFailedAt: mins(3000) },
    { name: 'Hook', owner: 'bob', enabled: true, webhook: true, undelivered: { count: 1 } },
    { name: 'Stranger', owner: 'zed', enabled: true },
  ],
  held: [
    { id: 'held_1', agentId: 'bob', kind: 'approval', tool: 'shell', run: { kind: 'schedule', name: 'Nightly' }, expiresAt: BNOW + 7_200_000 },
    { id: 'held_2', agentId: 'ann', kind: 'outbound', tool: 'send_mail', run: {} },
    { id: 'held_3', agentId: 'zed', kind: 'approval', tool: 'x' },
  ],
  watches: [
    { agentId: 'ann', taskSessionId: 'sess_task_a1', title: 'Ann task one', at: mins(30), target: 'task' },
    { agentId: 'ann', taskSessionId: 'sess_task_a3', title: 'A third "quoted" task that is long', at: mins(40) },
    { agentId: 'ann', taskSessionId: 'sess_home_bob', title: 'to a session', at: mins(50), target: 'session' },
    { agentId: 'bob', taskSessionId: 'sess_task_b9', title: 'Bob owed', at: 0 },
    { agentId: 'zed', taskSessionId: 'sess_task_z', title: 'Zed', at: 1 },
  ],
  approvals: ['sess_home_bob', 'sess_task_a1'],
};
const humanCaller = { id: 'caller', sourceType: 'lead' };
const annHome = { id: 'sess_home_ann', sourceType: 'exec', messages: [] };
await record('bots: the human sees every bot, ordered by what needs attention, then Mixy', { action: 'bots' }, { ...botsWorld, callerSession: humanCaller });
await record('bots: a bot sees only its own line', { action: 'bots' }, { ...botsWorld, callerSession: annHome });
await record('bots: Mixy has nothing to show', { action: 'bots' }, { bots: ['ann'], botRows: { ann: { name: 'Ann' } }, pages: [page([homeRow('ann')])], now: BNOW });
await record('bots: no bots yet', { action: 'bots' }, { bots: [], pages: [page([])], now: BNOW });
await record('bots: the automation store is down', { action: 'bots' }, { ...botsWorld, routinesError: 'store   offline\nat   once', callerSession: humanCaller });
await record('bots: a background run cannot read bot status', { action: 'bots' }, { ...botsWorld, callerSession: background });
await record('bots: limit out of range', { action: 'bots', limit: 0 }, { ...botsWorld, callerSession: humanCaller });
await record('bots: limit is an integer', { action: 'bots', limit: 'x' }, { ...botsWorld, callerSession: humanCaller });
await record('bots: a delegated worker is not the Lead', { action: 'bots' }, { ...botsWorld, calling: 'other' });
await record('bots: past thirty bots the line count is told', { action: 'bots' }, { bots: Array.from({ length: 33 }, (_, i) => `b${String(i).padStart(2, '0')}`), pages: [page([])], now: BNOW, callerSession: humanCaller });
await record('bots: the scan reads at most two thousand sessions and says so', { action: 'bots' }, { bots: ['ann'], scanPages: { pages: 10, per: 200, more: true }, now: BNOW, callerSession: humanCaller });
await record('bots: a bot by id shows its routines, held requests and sessions', { action: 'bots', session_id: 'bob' }, { ...botsWorld, callerSession: humanCaller });
await record('bots: a bot by its chat id', { action: 'bots', session_id: 'sess_home_ann' }, { ...botsWorld, callerSession: humanCaller });
await record('bots: Mixy by id', { action: 'bots', session_id: 'lead' }, { ...botsWorld, callerSession: humanCaller });
await record('bots: a bot sees its own detail', { action: 'bots', session_id: 'ann', limit: 2 }, { ...botsWorld, callerSession: annHome });
await record("bots: a bot cannot read another's detail", { action: 'bots', session_id: 'bob' }, { ...botsWorld, callerSession: annHome });
await record('bots: no such bot', { action: 'bots', session_id: 'nobody' }, { ...botsWorld, callerSession: humanCaller });
await record('bots: a long unknown id is quoted short', { action: 'bots', session_id: `x${'y'.repeat(100)}` }, { ...botsWorld, callerSession: humanCaller });
await record('bots: detail with the automation store down', { action: 'bots', session_id: 'ann' }, { ...botsWorld, routinesError: 'down', callerSession: humanCaller });
await record('bots: detail cuts routines and held requests to their caps', { action: 'bots', session_id: 'ann', limit: 1 }, {
  ...botsWorld,
  routines: Array.from({ length: 23 }, (_, i) => ({ name: `r${String(i).padStart(2, '0')}`, owner: 'ann', enabled: true, lastSuccessAt: mins(i + 1) })),
  held: Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, agentId: 'ann', kind: 'approval', tool: `tool${i}`, run: { kind: 'webhook', name: `hook${i}` } })),
  callerSession: humanCaller,
});
await record('bots: detail fits the output page by dropping sessions, then held requests, then routines', { action: 'bots', session_id: 'ann', limit: 100 }, {
  bots: ['ann'],
  botRows: { ann: { name: 'Ann' } },
  pages: [page(Array.from({ length: 60 }, (_, i) => row(`sess_task_big${i}`, { title: `T${i} ${'t'.repeat(120)}`, sourceName: 'agent:ann@home', lastMessagePreview: 'p'.repeat(200), lastUsedAt: mins(i + 1), working: i % 2 === 0 })))],
  now: BNOW,
  callerSession: humanCaller,
});

await set.finish({
  entry: "workspace-tools.mjs createWorkspaceToolHandlers().session (the session tool, actions list, send and create) over daemon-session-control.mjs createSessionControl, agent-task-sessions.mjs createAgentTaskSessions and the real session-service.mjs createSessionService on a stub runtime factory; seams: the catalog pages, the bot list, the live work, the archived flags, the report watches (refusing) and the projects",
  replay: {
    entry: 'SessionTool::call over DirectorySessionPort over a real SessionDirectory on the real thread store (the tool answer or refusal of each case; the catalog pages the port asks for; the session a create made read from its stored record; the prompts delivered read from the input row of the turn each started in the session that took it)',
    normalised: {
      'quotaResume': 'status: the waiting resume comes from a real failed turn of the session: its state, resetAt and attempts are compared, its turnKey, provider and model are the run\'s own and are taken from the recording',
      'service.createSession provider, model': 'the route of a task is the route service\'s here',
    },
  },
  exclusions: {
    'service bookkeeping': "a case records the catalog pages asked for (listSessions), the prompts the runtime took (runtime.submitAsync) and the session a create made (service.createSession); the service's own calls (materializeSession, the wrapper calls) and the log lines are Node internals; `skipSlashCommands`, which the service stamps on the prompt of a home chat, is dropped",
    'random names': "a created session id (sess_daemon_<ms>_<32 hex>) is <created>, a create's request id (atask_<uuid>) is <request> and the caller's folder (a temporary directory) is <WORK>",
    'attached files': "a file forwarded with send/create needs the caller's conversation files; the core refuses attachments in this runtime (session_port.rs resolve_attachments)",
    'reports': "the report queue (watches, started line, final report) is not in the core; Node's answer to a watch it cannot store is recorded with that seam refusing",
    'a group room': "a send to a room's log goes through the desktop room host; the core has none for the session tool and refuses it",
    'model, effort, worktree': 'create and send with model, effort or worktree need the model catalog and the worktree host through the session service; the core refuses them',
    'agent work a session waits on': "a status' agentsWorking is the sessions with an agent turn in flight (the catalog's live work); the agent pool rows, the owed agent results and the background agent tasks Node's taskSessionPendingWork also reads (store-agent-worker-rows.mjs, pending-messages.mjs, background-tasks.mjs) have no store in the core and read as none, the case's `pending` seam being the live agent work",
    'the route of a task': 'Node starts a task on the Lead route of the config, else the last used model; the core starts it through thread/start, whose default route is decided by the route service',
  },
});
process.exit(0);
