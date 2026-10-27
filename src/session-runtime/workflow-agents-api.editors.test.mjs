// Characterization of the agent / workflow editor surfaces of the
// workflow-agents API against a real data directory: catalog listing, custom
// agent create/update/delete (including starter tombstones and fixed-role
// overrides), and workflow pack create/save/delete with active fallback.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  AGENT_DELETED_MARKER,
  FIXED_AGENT_SLOTS,
  clearAgentDefinitionCache,
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
  workflowIdFromName,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';
import { isContactAgentId } from '../runtime/shared/agent-route-config.mjs';

const MAIN = { provider: 'openai', model: 'main-model' };

function fixture(t, extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-workflow-agents-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'),
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone,
  });
  const routeHelpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const state = { config: { workflow: { active: 'default' } }, refreshes: 0 };
  const api = createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : { ...MAIN }),
    agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    refreshEmptySessionToolPolicy: async () => {
      state.refreshes += 1;
      return { appliedToCurrentSession: true };
    },
    invalidateContextStatusCache() {},
    ...extra,
  });
  return { dataDir, helpers, state, api };
}

test('listAgents reports the fixed roles first with the effective Main route, then every custom agent', (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const agents = api.listAgents();
  const fixed = agents.slice(0, FIXED_AGENT_SLOTS.length);
  assert.deepEqual(
    fixed.map((agent) => [agent.id, agent.locked, agent.userOverride, agent.disabled]),
    FIXED_AGENT_SLOTS.map((agent) => [agent.id, true, false, false])
  );
  assert.deepEqual(fixed[0].route, { ...MAIN });
  // Main is only the fallback: no agent claims it as a route of its own.
  assert.ok(agents.every((agent) => agent.routeConfigured === false));
  const customIds = helpers.listCustomAgentIds(dataDir);
  assert.ok(customIds.length > 0, 'starter agents ship as custom agents');
  assert.deepEqual(
    agents.slice(FIXED_AGENT_SLOTS.length).map((agent) => agent.id),
    customIds
  );
  for (const agent of agents.slice(FIXED_AGENT_SLOTS.length)) {
    assert.equal(agent.custom, true);
    assert.equal(agent.userOverride, false);
    assert.equal(agent.label, agent.definition?.name || agent.id);
  }
});

test('kind: bot marks a bot at creation; unmarked agents (every pre-bot agent) stay workflow agents; a kind never changes', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const isContact = (row) => isContactAgentId(row.id, row.kind);
  const role = await api.saveAgentDefinition({ name: 'Triage', body: 'Sort issues.', kind: 'agent' });
  assert.equal(role.kind, 'agent');
  const file = join(dataDir, 'agents', role.id, 'AGENT.md');
  assert.match(readFileSync(file, 'utf8'), /^---\nname: Triage\nkind: agent\n---\n/);
  const bot = await api.saveAgentDefinition({ name: 'Concierge', body: 'Plan my day.', kind: 'bot' });
  assert.equal(bot.kind, 'bot');
  const botFile = join(dataDir, 'agents', bot.id, 'AGENT.md');
  assert.match(readFileSync(botFile, 'utf8'), /^---\nname: Concierge\nkind: bot\n---\n/);
  const plain = await api.saveAgentDefinition({ name: 'Helper', body: 'Help.' });
  assert.equal(plain.kind, null);
  // An agent made before bots existed: no marker, on disk as v1.2.6 wrote it,
  // one switched off — both stay workflow agents and their files are untouched.
  const legacyDir = join(dataDir, 'agents', 'watcher');
  mkdirSync(legacyDir, { recursive: true });
  const legacy = '---\nname: Watcher\n---\nWatch GitHub.\n';
  writeFileSync(join(legacyDir, 'AGENT.md'), legacy);
  state.config = { ...state.config, disabledAgents: ['watcher'] };
  const rows = new Map(api.listAgents().map((row) => [row.id, row]));
  assert.equal(isContact(rows.get(role.id)), false, 'a kind: agent workflow agent is no contact');
  assert.equal(isContact(rows.get(bot.id)), true, 'a kind: bot agent is a contact');
  assert.equal(isContact(rows.get(plain.id)), false, 'an unmarked agent is a workflow agent');
  assert.equal(isContact(rows.get('watcher')), false, 'a pre-bot unmarked agent stays a workflow agent');
  assert.equal(readFileSync(join(legacyDir, 'AGENT.md'), 'utf8'), legacy, 'listing never stamps a marker');
  assert.equal(isContact(rows.get('worker')), false, 'shipped roles stay agents');
  // Edits keep the marker; a kind is never changed or given to an existing agent.
  const edited = await api.saveAgentDefinition({ id: role.id, name: 'Triage 2', body: 'Sort and label issues.' });
  assert.equal(edited.kind, 'agent');
  assert.match(readFileSync(file, 'utf8'), /kind: agent/);
  const editedBot = await api.saveAgentDefinition({ id: bot.id, name: 'Concierge', body: 'Plan my week.' });
  assert.equal(editedBot.kind, 'bot');
  await assert.rejects(
    api.saveAgentDefinition({ id: bot.id, body: 'x', kind: 'agent' }),
    /kind is set when it is created/
  );
  await assert.rejects(
    api.saveAgentDefinition({ id: plain.id, body: 'x', kind: 'bot' }),
    /kind is set when it is created/
  );
  await assert.rejects(api.saveAgentDefinition({ name: 'Odd', body: 'x', kind: 'robot' }), /agent kind must be "bot"/);
});

// --- Upgrade populations: bot or workflow agent, decided read-only ---
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const MASCOT = { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' };

// A v1.2.6 custom agent exactly as v1.2.6 wrote it (no kind marker).
function writeV126Agent(dataDir, id) {
  const dir = join(dataDir, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), `---\nname: ${id}\ndescription: ${id} role\n---\nYou are ${id}.\n`);
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify({ name: id, description: `${id} role` }, null, 2)}\n`);
  return dir;
}

function snapshotFiles(dir) {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => !name.endsWith('.lock'))
      .flatMap((name) => {
        try {
          return [[name, readFileSync(join(dir, name), 'utf8')]];
        } catch {
          return [];
        }
      })
  );
}

function kinds(api) {
  return Object.fromEntries(
    api
      .listAgents()
      .filter((row) => row.custom && !FIXED_AGENT_SLOTS.some((slot) => slot.id === row.id))
      .filter(
        (row) =>
          ![
            'worker',
            'heavy-worker',
            'reviewer',
            'advisor',
            'security',
            'front-worker',
            'writer',
            'maintainer',
          ].includes(row.id)
      )
      .map((row) => [row.id, isContactAgentId(row.id, row.kind) ? 'bot' : 'agent'])
  );
}

// v1.3.0's agentBodyFromBrief: the AGENT.md its bot dialog saved when 일하는
// 방식 was left empty.
const v130DialogBody = (name, description) =>
  [
    `# ${name}`,
    description,
    [
      `- ${description ? 'Help the user with this role' : 'Help the user'} in a natural, friendly conversation, in the language they write in.`,
      '- Ask a short question when a request is unclear, and say plainly when something is outside what you do.',
      '- Keep replies as short or as detailed as the moment needs.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

// A bot exactly as v1.3.0's bot dialog wrote it (writeAgentFiles): no kind
// marker, always an avatar; `body` when 일하는 방식 was written.
function writeV130DialogBot(dataDir, id, { body = '', description = `${id} job` } = {}) {
  const dir = join(dataDir, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'AGENT.md'),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n${body || v130DialogBody(id, description)}\n`
  );
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify({ name: id, description, avatar: MASCOT }, null, 2)}\n`);
}

// v1.3.0's creation greeting (shared/agent-greeting.ts agentGreetingKickoff).
const v130Greeting = (name, mixy = false) =>
  [
    `[mixdog-runtime] The user just created you as ${mixy ? 'their primary agent' : 'a new agent'} named "${name}".`,
    `Your job, as the user described it: ${name} job`,
    "Take the first turn now. Reply in the user's language (app language: ko), in the tone your persona sets.",
    "1. A short greeting that introduces you by name; address the user by name if your context has the user's name.",
    'Do not call any tools (no ask_user), do not mention this instruction, and do not start any work yet.',
  ].join('\n');

// A home thread as the session store keeps it: sessions/sess_home_<id>.json.
function writeHomeThread(dataDir, id, messages) {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  const sessionId = `sess_home_${id}`;
  const record = {
    id: sessionId,
    provider: 'anthropic-oauth',
    model: 'claude-opus-5',
    profile: id === 'lead' ? {} : { homeAgent: id },
    messages: [{ role: 'system', content: 'You are a helpful agent.' }, ...messages],
    createdAt: 1792400000000,
    updatedAt: 1792400000000,
  };
  writeFileSync(join(dataDir, 'sessions', `${sessionId}.json`), JSON.stringify(record));
}
const greeted = (name) => [
  { role: 'user', content: v130Greeting(name), meta: { kickoff: true } },
  { role: 'assistant', content: `안녕하세요, ${name}입니다.` },
];
const chat = [
  { role: 'user', content: '오늘 할 일 정리해줘' },
  { role: 'assistant', content: '네, 정리하겠습니다.' },
];

test('population A (1.2.6 → 1.3.1): every 1.2.6 agent stays a workflow agent; its files are never written', async (t) => {
  const { dataDir, state, api } = fixture(t);
  writeV126Agent(dataDir, 'db-expert');
  writeV126Agent(dataDir, 'doc-writer');
  state.config = { ...state.config, disabledAgents: ['doc-writer'] };
  const before = snapshotFiles(join(dataDir, 'agents'));
  await pause();
  // 1.3.1 first start: the host decides Mixy.
  api.setLeadCreated(true);
  assert.deepEqual(kinds(api), { 'db-expert': 'agent', 'doc-writer': 'agent' });
  const after = snapshotFiles(join(dataDir, 'agents'));
  for (const [name, text] of Object.entries(before)) assert.equal(after[name], text, `${name} untouched`);
  // A bot made on 1.3.1 carries the explicit marker.
  const bot = await api.saveAgentDefinition({ name: 'Concierge', body: 'Plan.', kind: 'bot', avatar: MASCOT });
  assert.equal(kinds(api)[bot.id], 'bot');
});

test('population B (1.2.6 → 1.3.0 → 1.3.1): old agents opened, chatted with or given a face on 1.3.0 stay workflow agents; nothing is written', async (t) => {
  const { dataDir, api } = fixture(t);
  writeV126Agent(dataDir, 'db-expert');
  writeV126Agent(dataDir, 'helper');
  writeV126Agent(dataDir, 'opened');
  writeV126Agent(dataDir, 'untouched');
  // 1.3.0 auto-created Mixy ({"created": true}) and showed the old agents as
  // bots: the user gave one a face and a persona, chatted with another and
  // only opened a third (an empty home thread). None was ever greeted.
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  writeFileSync(
    join(dataDir, 'agents', 'db-expert', 'agent.json'),
    `${JSON.stringify({ name: 'db-expert', description: 'db-expert role', avatar: MASCOT }, null, 2)}\n`
  );
  writeFileSync(join(dataDir, 'agents', 'db-expert', 'PERSONA.md'), 'Be kind.\n');
  writeHomeThread(dataDir, 'db-expert', chat);
  writeHomeThread(dataDir, 'helper', chat);
  writeHomeThread(dataDir, 'opened', []);
  const before = { ...snapshotFiles(join(dataDir, 'agents')), ...snapshotFiles(join(dataDir, 'sessions')) };
  assert.deepEqual(kinds(api), { 'db-expert': 'agent', helper: 'agent', opened: 'agent', untouched: 'agent' });
  // The untouched automatic Mixy: no name, no home thread — the host shows the dialog.
  assert.deepEqual(api.getLeadStatus(), { created: true, name: '', avatar: null, homeChatted: false, route: null });
  assert.deepEqual(
    { ...snapshotFiles(join(dataDir, 'agents')), ...snapshotFiles(join(dataDir, 'sessions')) },
    before,
    'reading wrote nothing'
  );
});

test('population C (fresh 1.3.0 → 1.3.1): unmarked 1.3.0 bots stay bots on creation evidence; one with none is a workflow agent', async (t) => {
  const { dataDir, api } = fixture(t);
  // Bot dialog, greeting posted (a written 일하는 방식, so only T1 holds).
  writeV130DialogBot(dataDir, 'dialog-greeted', { body: 'Plan my week, every Monday.' });
  writeHomeThread(dataDir, 'dialog-greeted', [...greeted('dialog-greeted'), ...chat]);
  // Bot dialog, the greeting failed (no home thread): its avatar and default body (T2).
  writeV130DialogBot(dataDir, 'dialog-silent');
  // Mixy's setup tool, greeted by the host: files exactly as v1.2.6 wrote (T1).
  writeV126Agent(dataDir, 'tool-greeted');
  writeHomeThread(dataDir, 'tool-greeted', greeted('tool-greeted'));
  // Mixy's setup tool, never greeted: indistinguishable from a v1.2.6 agent.
  writeV126Agent(dataDir, 'tool-silent');
  writeHomeThread(dataDir, 'tool-silent', chat);
  // A Workflows-page agent of 1.3.0 (kind: agent), and an avatar on a body
  // that is not the dialog's default (no T2).
  const role = await api.saveAgentDefinition({ name: 'Triage', body: 'Sort.', kind: 'agent', avatar: MASCOT });
  writeV130DialogBot(dataDir, 'faced', { body: 'My own instructions.' });
  // Mixy made in the dialog: named, greeted.
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(
    join(dataDir, 'agents', 'lead', 'agent.json'),
    `${JSON.stringify({ created: true, name: 'Mixy', description: 'Primary assistant' }, null, 2)}\n`
  );
  writeHomeThread(dataDir, 'lead', [
    { role: 'user', content: v130Greeting('Mixy', true), meta: { kickoff: true } },
    { role: 'assistant', content: 'Mixdog에 오신 걸 환영합니다.' },
  ]);
  const before = snapshotFiles(join(dataDir, 'agents'));
  assert.deepEqual(kinds(api), {
    'dialog-greeted': 'bot',
    'dialog-silent': 'bot',
    'tool-greeted': 'bot',
    'tool-silent': 'agent',
    [role.id]: 'agent',
    faced: 'agent',
  });
  assert.equal(api.getAgentDefinition('dialog-silent').kind, 'bot', 'the editor reports the same kind');
  // Named, so created; its greeting and Mixy's reply are no word of the user's.
  assert.deepEqual(api.getLeadStatus(), { created: true, name: 'Mixy', avatar: null, homeChatted: false, route: null });
  assert.deepEqual(snapshotFiles(join(dataDir, 'agents')), before, 'nothing is stamped');
});

test('a starter override or an explicit kind is never inferred: evidence decides only unmarked user agents', async (t) => {
  const { dataDir, api } = fixture(t);
  // A user copy of the shipped Worker with an avatar and a greeted thread.
  writeV130DialogBot(dataDir, 'worker');
  writeHomeThread(dataDir, 'worker', greeted('worker'));
  // An explicit kind: agent with the same evidence.
  writeV130DialogBot(dataDir, 'marked');
  writeFileSync(
    join(dataDir, 'agents', 'marked', 'AGENT.md'),
    `---\nname: marked\nkind: agent\n---\n\n${v130DialogBody('marked', 'marked job')}\n`
  );
  writeHomeThread(dataDir, 'marked', greeted('marked'));
  const rows = new Map(api.listAgents().map((row) => [row.id, row]));
  assert.equal(rows.get('worker').kind, null);
  assert.equal(rows.get('marked').kind, 'agent');
});

test("an automatic Mixy's home thread: missing or never talked in reads unused; a user's message counts", async (t) => {
  const { dataDir, api } = fixture(t);
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  assert.equal(api.getLeadStatus().homeChatted, false, 'no thread');
  writeHomeThread(dataDir, 'lead', []);
  assert.equal(api.getLeadStatus().homeChatted, false, 'an empty thread');
  writeHomeThread(dataDir, 'lead', [{ role: 'user', content: '[mixdog-runtime] Routine output from schedule "x"' }]);
  assert.equal(api.getLeadStatus().homeChatted, false, 'a runtime turn alone is no conversation');
  // Issue #243: the heartbeat's reports, posted as Mixy's own messages.
  writeHomeThread(dataDir, 'lead', [
    { role: 'assistant', content: '현재 xx 프로젝트는 빌드 작업 중입니다.' },
    { role: 'assistant', content: 'xx 프로젝트의 테스트가 끝났습니다.' },
  ]);
  assert.equal(api.getLeadStatus().homeChatted, false, "Mixy's own posts are no conversation");
  writeHomeThread(dataDir, 'lead', [{ role: 'user', content: '안녕' }]);
  assert.equal(api.getLeadStatus().homeChatted, true, 'one user message');
  // Completing the 대표 에이전트 dialog over the automatic manifest names it
  // and keeps every key; the thread itself is never touched.
  const thread = readFileSync(join(dataDir, 'sessions', 'sess_home_lead.json'), 'utf8');
  api.saveLeadIdentity({ name: 'Mixy' });
  const status = api.setLeadCreated(true, 'Primary assistant');
  assert.deepEqual(status, { created: true, name: 'Mixy', avatar: null, homeChatted: true, route: null });
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), 'utf8')), {
    created: true,
    name: 'Mixy',
    description: 'Primary assistant',
  });
  assert.equal(readFileSync(join(dataDir, 'sessions', 'sess_home_lead.json'), 'utf8'), thread);
});

test('setLeadCreated leaves a malformed agents/lead/agent.json alone and fails soft', async (t) => {
  const { dataDir, api } = fixture(t);
  const file = join(dataDir, 'agents', 'lead', 'agent.json');
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  for (const broken of ['{"name": "Momo", ', '["not", "an", "object"]\n']) {
    writeFileSync(file, broken);
    const stderr = t.mock.method(process.stderr, 'write', () => true);
    assert.deepEqual(api.setLeadCreated(true), {
      created: null,
      name: '',
      avatar: null,
      homeChatted: false,
      route: null,
    });
    stderr.mock.restore();
    assert.equal(readFileSync(file, 'utf8'), broken, 'the unreadable manifest is never overwritten');
  }
  // A readable manifest keeps every other key; a missing one is created.
  writeFileSync(file, '{"name": "Momo", "connectors": {"off": ["github"]}}\n');
  assert.deepEqual(api.setLeadCreated(true), {
    created: true,
    name: 'Momo',
    avatar: null,
    homeChatted: false,
    route: null,
  });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    name: 'Momo',
    connectors: { off: ['github'] },
    created: true,
  });
  rmSync(file);
  assert.equal(api.setLeadCreated(false).created, false);
});

test('saveAgentDefinition creates a custom agent (id from name, AGENT.md + manifest, optional route) and delete removes it everywhere', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Release  Captain',
    description: 'Ships\nreleases',
    body: 'Cut releases carefully.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  assert.equal(created.custom, true);
  assert.equal(created.userOverride, true);
  assert.equal(created.name, 'Release Captain');
  assert.equal(created.description, 'Ships releases');
  assert.equal(created.body, 'Cut releases carefully.');
  assert.equal(created.disabled, false);
  const savedRoute = { provider: 'anthropic', model: 'claude', fast: false, modelParameters: {} };
  assert.deepEqual(created.route, savedRoute);
  assert.equal(created.routeConfigured, true);
  const dir = join(dataDir, 'agents', created.id);
  assert.match(
    readFileSync(join(dir, 'AGENT.md'), 'utf8'),
    /^---\nname: Release Captain\ndescription: Ships releases\n---\n/
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')), {
    name: 'Release Captain',
    description: 'Ships releases',
  });
  assert.deepEqual(state.config.agents[created.id], savedRoute);
  assert.ok(api.listAgents().some((agent) => agent.id === created.id && agent.custom));

  const renamed = await api.saveAgentDefinition({ id: created.id, name: 'Captain', body: 'Updated.' });
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, 'Captain');
  assert.equal(renamed.body, 'Updated.');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')), 'description'), false);

  assert.deepEqual(await api.deleteAgentDefinition(created.id), {
    id: created.id,
    deleted: true,
    revertedToBuiltIn: false,
  });
  // Archived: gone from every surface, its name and face kept for its chat,
  // its AGENT.md moved aside and its model kept, so a restore is exact.
  assert.equal(existsSync(join(dir, 'AGENT.md')), false);
  assert.equal(existsSync(join(dir, 'AGENT.md.archived')), true);
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), true);
  assert.deepEqual(state.config.agents[created.id], savedRoute);
  assert.throws(() => api.getAgentDefinition(created.id), /not found/);
  assert.equal(
    api.listAgents().some((agent) => agent.id === created.id),
    false
  );
  assert.deepEqual(api.agentDefinitionPresence([created.id]), { [created.id]: 'deleted' });
  assert.deepEqual(api.archivedAgentIdentities([created.id, 'worker']), {
    [created.id]: { name: 'Captain', avatar: null },
    worker: null,
  });
  await assert.rejects(api.deleteAgentDefinition(created.id), /not found/);
  // A new bot of the same name never takes over the archived one's id (or chat).
  const again = await api.saveAgentDefinition({ name: 'Release Captain', body: 'New.' });
  assert.equal(again.id, `${created.id}-2`);
  // Deleted again from 보관됨: everything it left goes for good.
  assert.deepEqual(await api.purgeAgentDefinition(created.id), { id: created.id, purged: true });
  assert.equal(existsSync(dir), false);
  assert.equal(Object.hasOwn(state.config.agents || {}, created.id), false, 'its model goes with it');
  assert.deepEqual(api.archivedAgentIdentities([created.id]), { [created.id]: null });
  // A live agent is never purged.
  assert.deepEqual(await api.purgeAgentDefinition(again.id), { id: again.id, purged: false });
  assert.ok(api.getAgentDefinition(again.id));
});

test('getAgentDefinition returns the user copy path only; a direct AGENT.md edit shows on the next read', async (t) => {
  const { dataDir, api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Path Agent', description: 'd', body: 'First body.' });
  const file = join(dataDir, 'agents', created.id, 'AGENT.md');
  assert.equal(api.getAgentDefinition(created.id).path, file);
  writeFileSync(file, 'Second body, edited on disk.');
  assert.equal(api.getAgentDefinition(created.id).body, 'Second body, edited on disk.');
  const shipped = api.listAgents().find((agent) => !agent.userOverride && agent.custom);
  if (shipped) assert.equal('path' in api.getAgentDefinition(shipped.id), false);
  assert.equal('path' in api.getAgentDefinition('worker'), false);
});

test('a user agent whose agent.json entry names another file reads and revalidates through that file', (t) => {
  const { dataDir, api } = fixture(t);
  const dir = join(dataDir, 'agents', 'entry-agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: 'Entry Agent', entry: 'prompt.md' }));
  writeFileSync(join(dir, 'AGENT.md'), 'Default body.');
  const file = join(dir, 'prompt.md');
  writeFileSync(file, 'First prompt.');
  const first = api.getAgentDefinition('entry-agent');
  assert.equal(first.userOverride, true);
  assert.equal(first.path, file);
  assert.equal(first.body, 'First prompt.');
  writeFileSync(file, 'Second prompt, edited on disk.');
  const second = api.getAgentDefinition('entry-agent');
  assert.equal(second.body, 'Second prompt, edited on disk.');
  assert.notEqual(second.revision, first.revision);
});

// A user agent whose agent.json names `entry`, with prompt.md written when `files` says so.
function entryAgent(dataDir, id, entry, files = {}) {
  const dir = join(dataDir, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ name: id, entry }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('an agent.json entry that climbs out or resolves outside its folder loads as at HEAD but is handed out with no editable path', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const outside = join(dataDir, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'prompt.md'), 'Outside body.');
  entryAgent(dataDir, 'climb-agent', '../../outside/prompt.md', { 'AGENT.md': 'Own body.' });
  const linked = entryAgent(dataDir, 'link-agent', 'linked/prompt.md', { 'AGENT.md': 'Own body.' });
  symlinkSync(outside, join(linked, 'linked'), 'junction');
  const ids = ['climb-agent', 'link-agent'];
  for (const id of ids) {
    assert.equal(helpers.loadAgentDefinition(dataDir, id).body, 'Outside body.', `${id} loads`);
    assert.ok(helpers.listCustomAgentIds(dataDir).includes(id), `${id} is discovered`);
    const read = api.getAgentDefinition(id);
    assert.equal(read.body, 'Outside body.');
    assert.equal(read.userOverride, true);
    assert.equal('path' in read, false, `${id} hands out no path`);
  }
  assert.deepEqual(api.agentDefinitionPresence(ids), { 'climb-agent': 'present', 'link-agent': 'present' });
  // Delete acts as HEAD did (it archives only the folder's own AGENT.md and
  // writes the tombstone) and never moves the outside file.
  const outsideStays = () => {
    assert.equal(readFileSync(join(outside, 'prompt.md'), 'utf8'), 'Outside body.');
    assert.deepEqual(readdirSync(outside), ['prompt.md']);
  };
  const climbDir = join(dataDir, 'agents', 'climb-agent');
  assert.deepEqual(await api.deleteAgentDefinition('climb-agent'), {
    id: 'climb-agent',
    deleted: true,
    revertedToBuiltIn: false,
  });
  assert.equal(existsSync(join(climbDir, AGENT_DELETED_MARKER)), true);
  assert.equal(readFileSync(join(climbDir, 'AGENT.md.archived'), 'utf8'), 'Own body.');
  outsideStays();
  const linkDir = join(dataDir, 'agents', 'link-agent');
  await api.deleteAgentDefinition('link-agent');
  assert.equal(readFileSync(join(linkDir, 'AGENT.md.archived'), 'utf8'), 'Own body.');
  assert.equal(existsSync(join(linkDir, 'AGENT.md')), false);
  assert.equal(existsSync(join(linkDir, AGENT_DELETED_MARKER)), true);
  outsideStays();
  // Restore puts HEAD's AGENT.md.archived back as AGENT.md, again leaving the outside file be.
  await api.restoreAgentDefinition('link-agent');
  assert.equal(readFileSync(join(linkDir, 'AGENT.md'), 'utf8'), 'Own body.');
  assert.equal(existsSync(join(linkDir, 'AGENT.md.archived')), false);
  outsideStays();
  // The same entry kept inside the folder gets its path.
  entryAgent(dataDir, 'link-agent', 'inside/prompt.md', { 'inside/prompt.md': 'Inside body.' });
  const fixed = api.getAgentDefinition('link-agent');
  assert.equal(fixed.body, 'Inside body.');
  assert.equal(fixed.path, join(dataDir, 'agents', 'link-agent', 'inside', 'prompt.md'));
});

test('restore finds the legacy AGENT.md.archived for the default entry and when the selected entry has no archive', async (t) => {
  const { dataDir, api } = fixture(t);
  const tombstone = (dir) => writeFileSync(join(dir, AGENT_DELETED_MARKER), 'deleted\n');
  const legacy = join(dataDir, 'agents', 'legacy-agent');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'agent.json'), JSON.stringify({ name: 'Legacy' }));
  writeFileSync(join(legacy, 'AGENT.md.archived'), 'Legacy body.');
  tombstone(legacy);
  const first = await api.restoreAgentDefinition('legacy-agent');
  assert.equal(first.body, 'Legacy body.');
  assert.equal(first.path, join(legacy, 'AGENT.md'));
  assert.equal(existsSync(join(legacy, 'AGENT.md.archived')), false);

  const custom = entryAgent(dataDir, 'legacy-entry', 'prompt.md', { 'AGENT.md.archived': 'Older body.' });
  tombstone(custom);
  // As at HEAD the file goes back to AGENT.md; the loader still reads the selected entry, so the read-back is not found.
  await assert.rejects(api.restoreAgentDefinition('legacy-entry'), /not found/);
  assert.equal(readFileSync(join(custom, 'AGENT.md'), 'utf8'), 'Older body.');
  assert.equal(existsSync(join(custom, 'prompt.md')), false);
  assert.equal(existsSync(join(custom, 'AGENT.md.archived')), false);
});

test('HEAD compatibility: an AGENT.md beside a missing entry is discovered and present; delete leaves a blocked entry under the tombstone; legacy restore goes to AGENT.md', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  // 1. AGENT.md exists, the manifest-selected entry does not: still discovered and present.
  entryAgent(dataDir, 'md-only', 'prompt.md', { 'AGENT.md': 'Default body.' });
  assert.ok(helpers.listCustomAgentIds(dataDir).includes('md-only'));
  assert.deepEqual(api.agentDefinitionPresence(['md-only']), { 'md-only': 'present' });
  // 2. prompt.md and prompt.md.archived, no AGENT.md: delete writes the tombstone, overwrites nothing.
  const dir = entryAgent(dataDir, 'blocked-entry', 'prompt.md', { 'prompt.md': 'Live.', 'prompt.md.archived': 'Stray.' });
  assert.equal((await api.deleteAgentDefinition('blocked-entry')).deleted, true);
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), true);
  assert.equal(readFileSync(join(dir, 'prompt.md'), 'utf8'), 'Live.');
  assert.equal(readFileSync(join(dir, 'prompt.md.archived'), 'utf8'), 'Stray.');
  // A default AGENT.md over an existing AGENT.md.archived is the one move refused.
  const plain = join(dataDir, 'agents', 'plain-clash');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'AGENT.md'), 'Live.');
  writeFileSync(join(plain, 'AGENT.md.archived'), 'Stray.');
  await assert.rejects(api.deleteAgentDefinition('plain-clash'), /cannot be deleted.*already exists/);
  assert.equal(readFileSync(join(plain, 'AGENT.md.archived'), 'utf8'), 'Stray.');
  assert.equal(existsSync(join(plain, AGENT_DELETED_MARKER)), false);
  // 3. A legacy AGENT.md.archived restores to AGENT.md even when agent.json selects prompt.md;
  //    the selected entry's own archive restores to that entry.
  const legacy = entryAgent(dataDir, 'legacy-target', 'prompt.md', { 'AGENT.md.archived': 'Old body.' });
  writeFileSync(join(legacy, AGENT_DELETED_MARKER), 'deleted\n');
  await assert.rejects(api.restoreAgentDefinition('legacy-target'), /not found/);
  assert.equal(readFileSync(join(legacy, 'AGENT.md'), 'utf8'), 'Old body.');
  assert.equal(existsSync(join(legacy, 'prompt.md')), false);
  const selected = entryAgent(dataDir, 'selected-archive', 'prompt.md', { 'prompt.md.archived': 'New body.' });
  writeFileSync(join(selected, AGENT_DELETED_MARKER), 'deleted\n');
  await api.restoreAgentDefinition('selected-archive');
  assert.equal(readFileSync(join(selected, 'prompt.md'), 'utf8'), 'New body.');
});

test('delete and restore refuse a conflicting destination and touch neither file', async (t) => {
  const { dataDir, api } = fixture(t);
  const dir = entryAgent(dataDir, 'clash-agent', 'prompt.md', { 'prompt.md': 'Live body.' });
  const tombstone = join(dir, AGENT_DELETED_MARKER);
  await api.deleteAgentDefinition('clash-agent');
  await assert.rejects(api.deleteAgentDefinition('clash-agent'), /not found/);
  // Restore over a recreated entry is refused.
  writeFileSync(join(dir, 'prompt.md'), 'Recreated.');
  await assert.rejects(api.restoreAgentDefinition('clash-agent'), /cannot be restored.*already exists/);
  assert.equal(readFileSync(join(dir, 'prompt.md'), 'utf8'), 'Recreated.');
  assert.equal(readFileSync(join(dir, 'prompt.md.archived'), 'utf8'), 'Live body.');
  assert.equal(existsSync(tombstone), true);
  rmSync(join(dir, 'prompt.md'));
  const restored = await api.restoreAgentDefinition('clash-agent');
  assert.equal(restored.body, 'Live body.');
  await assert.rejects(api.restoreAgentDefinition('clash-agent'), /is not deleted/);
});

test('delete archives AGENT.md beside a missing selected entry, and restore brings it back past an unrelated entry archive', async (t) => {
  const { dataDir, api } = fixture(t);
  const dir = entryAgent(dataDir, 'mixed-agent', 'prompt.md', { 'AGENT.md': 'Default body.' });
  await api.deleteAgentDefinition('mixed-agent');
  assert.equal(existsSync(join(dir, 'AGENT.md')), false);
  assert.equal(readFileSync(join(dir, 'AGENT.md.archived'), 'utf8'), 'Default body.');
  assert.deepEqual(api.agentDefinitionPresence(['mixed-agent']), { 'mixed-agent': 'deleted' });
  // A live prompt.md and a stray prompt.md.archived do not block the legacy move.
  writeFileSync(join(dir, 'prompt.md'), 'Live prompt.');
  writeFileSync(join(dir, 'prompt.md.archived'), 'Stray archive.');
  await api.restoreAgentDefinition('mixed-agent');
  assert.equal(readFileSync(join(dir, 'AGENT.md'), 'utf8'), 'Default body.');
  assert.equal(readFileSync(join(dir, 'prompt.md'), 'utf8'), 'Live prompt.');
  assert.equal(readFileSync(join(dir, 'prompt.md.archived'), 'utf8'), 'Stray archive.');
});

test('a BOM-prefixed agent.json is read the same by discovery, the loader and the editor', (t) => {
  const { dataDir, helpers, api } = fixture(t);
  // The BOM must not hide the selected entry: the loader reads it, not AGENT.md.
  const only = entryAgent(dataDir, 'bom-only', 'prompt.md', { 'prompt.md': 'Entry only.', 'AGENT.md': 'Default body.' });
  writeFileSync(join(only, 'agent.json'), `\ufeff${JSON.stringify({ name: 'Bom Only', entry: 'prompt.md' })}`);
  assert.ok(helpers.listCustomAgentIds(dataDir).includes('bom-only'));
  assert.equal(helpers.loadAgentDefinition(dataDir, 'bom-only').body, 'Entry only.');
  assert.equal(api.getAgentDefinition('bom-only').path, join(only, 'prompt.md'));

  const both = entryAgent(dataDir, 'bom-both', 'prompt.md', { 'prompt.md': 'Entry body.', 'AGENT.md': 'Default body.' });
  writeFileSync(join(both, 'agent.json'), `\ufeff${JSON.stringify({ name: 'Bom Both', entry: 'prompt.md' })}`);
  const read = api.getAgentDefinition('bom-both');
  assert.equal(read.body, 'Entry body.');
  assert.equal(read.path, join(both, 'prompt.md'));
});

test('a folder with only a manifest-selected entry and no AGENT.md is neither discovered nor present, as at HEAD', (t) => {
  const { dataDir, helpers, api } = fixture(t);
  entryAgent(dataDir, 'entry-only', 'prompt.md', { 'prompt.md': 'Entry body.' });
  assert.equal(helpers.listCustomAgentIds(dataDir).includes('entry-only'), false);
  assert.equal(api.listAgents().some((agent) => agent.id === 'entry-only'), false);
  assert.deepEqual(api.agentDefinitionPresence(['entry-only']), { 'entry-only': 'deleted' });
});

test('an agent with an AGENT.md and another selected entry is discovered and present, and delete + restore keep both files', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const dir = entryAgent(dataDir, 'entry-agent', 'prompt.md', { 'prompt.md': 'Entry body.', 'AGENT.md': 'Default body.' });
  assert.ok(helpers.listCustomAgentIds(dataDir).includes('entry-agent'));
  assert.ok(api.listAgents().some((agent) => agent.id === 'entry-agent' && agent.userOverride));
  assert.deepEqual(api.agentDefinitionPresence(['entry-agent']), { 'entry-agent': 'present' });

  assert.deepEqual(await api.deleteAgentDefinition('entry-agent'), {
    id: 'entry-agent',
    deleted: true,
    revertedToBuiltIn: false,
  });
  // AGENT.md always moves aside; the selected entry too, its archive being free.
  assert.equal(existsSync(join(dir, 'AGENT.md')), false);
  assert.equal(existsSync(join(dir, 'AGENT.md.archived')), true);
  assert.equal(existsSync(join(dir, 'prompt.md')), false);
  assert.equal(existsSync(join(dir, 'prompt.md.archived')), true);
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), true);
  assert.equal(helpers.loadAgentDefinition(dataDir, 'entry-agent'), null);
  assert.equal(helpers.listCustomAgentIds(dataDir).includes('entry-agent'), false);
  assert.deepEqual(api.agentDefinitionPresence(['entry-agent']), { 'entry-agent': 'deleted' });

  const restored = await api.restoreAgentDefinition('entry-agent');
  assert.equal(restored.path, join(dir, 'prompt.md'));
  assert.equal(restored.body, 'Entry body.');
  assert.equal(readFileSync(join(dir, 'AGENT.md'), 'utf8'), 'Default body.');
  assert.equal(readFileSync(join(dir, 'prompt.md'), 'utf8'), 'Entry body.');
  assert.equal(existsSync(join(dir, 'prompt.md.archived')), false);
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), false);
  assert.ok(helpers.listCustomAgentIds(dataDir).includes('entry-agent'));
  assert.deepEqual(api.agentDefinitionPresence(['entry-agent']), { 'entry-agent': 'present' });
});

test('a deleted bot restores exactly under its own id, even after a new bot took its name', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const bot = await api.saveAgentDefinition({
    name: 'Watcher',
    description: 'Watches PRs',
    body: 'Watch pull requests.',
    persona: 'Brief and calm.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  await api.setAgentRoute(bot.id, { disabled: true });
  const dir = join(dataDir, 'agents', bot.id);
  const before = readFileSync(join(dir, 'AGENT.md'), 'utf8');
  await api.deleteAgentDefinition(bot.id);
  const newcomer = await api.saveAgentDefinition({ name: 'Watcher', body: 'Someone else.' });
  assert.equal(newcomer.id, `${bot.id}-2`);

  const restored = await api.restoreAgentDefinition(bot.id);
  assert.equal(restored.id, bot.id, 'its own id, not the newcomer');
  assert.equal(readFileSync(join(dir, 'AGENT.md'), 'utf8'), before);
  assert.deepEqual(
    [restored.name, restored.description, restored.body, restored.persona, restored.disabled],
    ['Watcher', 'Watches PRs', 'Watch pull requests.', 'Brief and calm.', true]
  );
  assert.equal(restored.routeConfigured, true);
  assert.equal(state.config.agents[bot.id].model, 'claude');
  assert.equal(existsSync(join(dir, AGENT_DELETED_MARKER)), false);
  assert.equal(existsSync(join(dir, 'AGENT.md.archived')), false);
  assert.deepEqual(api.agentDefinitionPresence([bot.id]), { [bot.id]: 'present' });
  assert.deepEqual(api.archivedAgentIdentities([bot.id]), { [bot.id]: null });
  assert.equal(api.getAgentDefinition(newcomer.id).body, 'Someone else.', 'the newcomer is untouched');
  // Only an archived agent restores; a live one, a fixed role or an unknown id never does.
  await assert.rejects(api.restoreAgentDefinition(bot.id), /is not deleted/);
  await assert.rejects(api.restoreAgentDefinition('maintainer'), /unknown agent/);
  await assert.rejects(api.restoreAgentDefinition('never-existed'), /is not deleted/);
  // One archived before its AGENT.md was kept has nothing to restore from.
  const legacy = join(dataDir, 'agents', 'legacy-bot');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'agent.json'), '{"name":"Legacy"}\n');
  writeFileSync(join(legacy, AGENT_DELETED_MARKER), 'deleted\n');
  await assert.rejects(api.restoreAgentDefinition('legacy-bot'), /cannot be restored/);
  assert.equal(existsSync(join(legacy, AGENT_DELETED_MARKER)), true);
});

test('a new agent made under an archived id (never restored) drops the kept model', async (t) => {
  const { state, api } = fixture(t);
  const bot = await api.saveAgentDefinition({
    name: 'Scout',
    body: 'Scout.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  await api.deleteAgentDefinition(bot.id);
  const again = await api.saveAgentDefinition({ id: bot.id, name: 'Scout', body: 'New scout.' });
  assert.equal(again.routeConfigured, false);
  assert.equal(Object.hasOwn(state.config.agents || {}, bot.id), false);
});

test('agentDefinitionPresence proves a deletion per id from the files, never from a failed read', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Watcher', body: 'Watch.' });
  const starter = helpers.listCustomAgentIds(dataDir).find((id) => id !== created.id);
  assert.deepEqual(api.agentDefinitionPresence([created.id, starter, 'never-existed']), {
    [created.id]: 'present',
    [starter]: 'present',
    'never-existed': 'deleted',
  });
  await api.deleteAgentDefinition(created.id);
  await api.deleteAgentDefinition(starter);
  // A removed user agent and a tombstoned starter are both proven gone.
  assert.deepEqual(api.agentDefinitionPresence([created.id, starter]), {
    [created.id]: 'deleted',
    [starter]: 'deleted',
  });
  // Malformed ids are never judged.
  assert.deepEqual(api.agentDefinitionPresence(['Not An Id']), { 'Not An Id': 'unknown' });

  // A directory-read fault (EIO/EACCES) answers 'unknown', even for a gone agent.
  const failing = fixture(t, {
    statSync: () => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    },
  });
  assert.deepEqual(failing.api.agentDefinitionPresence(['never-existed']), { 'never-existed': 'unknown' });
});

test('saving an off agent with a picked model stores the model and keeps the agent off', async (t) => {
  const { state, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Quiet Reviewer',
    body: 'Review quietly.',
    route: { disabled: true },
  });
  assert.equal(created.disabled, true);
  const saved = await api.saveAgentDefinition({
    id: created.id,
    name: 'Quiet Reviewer',
    body: 'Review quietly.',
    route: { provider: 'anthropic', model: 'claude', disabled: true },
  });
  assert.equal(saved.disabled, true);
  const savedRoute = { provider: 'anthropic', model: 'claude', fast: false, modelParameters: {} };
  assert.deepEqual(saved.route, savedRoute);
  assert.deepEqual(state.config.agents[created.id], savedRoute);
});

test('an archived agent keeps its disabled-roster entry until purged, and a recreated agent of that id starts enabled', async (t) => {
  const { dataDir, helpers, state, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  state.config = { ...state.config, disabledAgents: [starter, 'other-agent'] };
  await api.deleteAgentDefinition(starter);
  // Kept for an exact restore; deleting it for good clears it.
  assert.deepEqual(state.config.disabledAgents, [starter, 'other-agent']);
  await api.purgeAgentDefinition(starter);
  assert.deepEqual(state.config.disabledAgents, ['other-agent']);

  state.config = { ...state.config, disabledAgents: [starter, 'other-agent'] };
  await api.saveAgentDefinition({ id: starter, name: 'Recreated', body: 'Recreated prompt.' });
  assert.equal(api.listAgents().find((agent) => agent.id === starter).disabled, false);
  assert.deepEqual(state.config.disabledAgents, ['other-agent']);

  await api.saveAgentDefinition({ id: starter, name: 'Recreated', body: 'Edited prompt.' });
  state.config = { ...state.config, disabledAgents: [starter] };
  await api.saveAgentDefinition({ id: starter, name: 'Recreated', body: 'Edited again.' });
  assert.equal(api.listAgents().find((agent) => agent.id === starter).disabled, true);
});

test('agent editor validation: empty body, bad id, missing name, hidden roles', async (t) => {
  const { api } = fixture(t);
  await assert.rejects(api.saveAgentDefinition({ name: 'x' }), /AGENT.md body must not be empty/);
  await assert.rejects(api.saveAgentDefinition({ id: '///', body: 'b' }), /agent id must contain letters\/numbers/);
  await assert.rejects(api.saveAgentDefinition({ body: 'b' }), /agent name must not be empty/);
  assert.throws(() => api.getAgentDefinition('   '), /unknown agent/);
  await assert.rejects(api.deleteAgentDefinition('does-not-exist'), /not found/);
});

test('deleting a shipped starter agent leaves a tombstone; a fixed role needs an override to reset and then reverts', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  const result = await api.deleteAgentDefinition(starter);
  assert.deepEqual(result, { id: starter, deleted: true, revertedToBuiltIn: false });
  assert.equal(existsSync(join(dataDir, 'agents', starter, AGENT_DELETED_MARKER)), true);
  assert.equal(helpers.loadAgentDefinition(dataDir, starter), null);
  assert.equal(helpers.listCustomAgentIds(dataDir).includes(starter), false);

  const fixed = FIXED_AGENT_SLOTS[0].id;
  await assert.rejects(api.deleteAgentDefinition(fixed), /has no user override to reset/);
  const override = await api.saveAgentDefinition({ id: fixed, body: 'Custom maintainer prompt.' });
  assert.equal(override.custom, false);
  assert.equal(override.userOverride, true);
  assert.equal(api.listAgents().find((agent) => agent.id === fixed).userOverride, true);
  assert.deepEqual(await api.deleteAgentDefinition(fixed), { id: fixed, deleted: true, revertedToBuiltIn: true });
  assert.equal(api.getAgentDefinition(fixed).userOverride, false);
});

test('an editor save keeps frontmatter the editor does not show: shipped first, then the user copy', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const shipped = helpers.loadAgentDefinition(dataDir, 'maintainer');
  assert.equal(shipped.permission, 'read-write');
  await api.saveAgentDefinition({ id: 'maintainer', name: shipped.name, body: 'Edited maintainer prompt.' });
  assert.equal(helpers.loadAgentDefinition(dataDir, 'maintainer').permission, 'read-write');

  // A value the user set by hand in their copy survives the next editor save.
  const file = join(dataDir, 'agents', 'maintainer', 'AGENT.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('permission: read-write', 'permission: read'));
  clearAgentDefinitionCache('maintainer');
  await api.saveAgentDefinition({ id: 'maintainer', name: shipped.name, body: 'Edited again.' });
  const saved = helpers.loadAgentDefinition(dataDir, 'maintainer');
  assert.equal(saved.permission, 'read');
  assert.equal(saved.body, 'Edited again.');
});

test('an avatar round-trips through agent.json, keeping manifest keys and frontmatter the editor does not show', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const avatar = { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' };
  const created = await api.saveAgentDefinition({ name: 'GitHub Watcher', body: 'Watch.', avatar });
  const dir = join(dataDir, 'agents', created.id);
  const manifestFile = join(dir, 'agent.json');
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), { name: 'GitHub Watcher', avatar });
  assert.deepEqual(created.avatar, avatar);
  assert.deepEqual(api.listAgents().find((agent) => agent.id === created.id).avatar, avatar);

  // Keys set by hand elsewhere survive every editor save.
  writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(readFileSync(manifestFile, 'utf8')), team: 'infra' }));
  const doc = join(dir, 'AGENT.md');
  writeFileSync(
    doc,
    readFileSync(doc, 'utf8').replace('name: GitHub Watcher', 'name: GitHub Watcher\npermission: read')
  );
  clearAgentDefinitionCache(created.id);
  // An older `variant` pick is saved as its mapped look.
  const next = { kind: 'mascot', variant: 'folded-happy-plain', color: '#F2C94C' };
  await api.saveAgentDefinition({ id: created.id, name: 'GitHub Watcher', body: 'Watch more.', avatar: next });
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), {
    name: 'GitHub Watcher',
    team: 'infra',
    avatar: { kind: 'mascot', species: 'terrier', accessory: 'none', expression: 'happy', color: '#f2c94c' },
  });
  assert.equal(helpers.loadAgentDefinition(dataDir, created.id).permission, 'read');

  // A save without `avatar` keeps it; null clears it; a bad one is refused.
  await api.saveAgentDefinition({ id: created.id, name: 'GitHub Watcher', body: 'Watch.' });
  assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).avatar.species, 'terrier');
  // A manifest still holding an old `variant` reads as its mapped look.
  writeFileSync(
    manifestFile,
    JSON.stringify({ name: 'GitHub Watcher', team: 'infra', avatar: { ...next, variant: 'perky-calm-collar' } })
  );
  clearAgentDefinitionCache(created.id);
  assert.deepEqual(api.getAgentDefinition(created.id).avatar, { ...avatar, color: '#f2c94c' });
  await assert.rejects(
    api.saveAgentDefinition({ id: created.id, name: 'x', body: 'b', avatar: { kind: 'mascot', variant: 'nope' } }),
    /agent avatar/
  );
  const cleared = await api.saveAgentDefinition({
    id: created.id,
    name: 'GitHub Watcher',
    body: 'Watch.',
    avatar: null,
  });
  assert.equal(cleared.avatar, null);
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, 'utf8')), { name: 'GitHub Watcher', team: 'infra' });
});

/** A real PNG `side`² (an APNG when animated: it carries an acTL chunk). */
function png(side, animated = false, height = side) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...(animated ? [chunk('acTL', Buffer.from([0, 0, 0, 2, 0, 0, 0, 0]))] : []),
    chunk('IDAT', deflateSync(Buffer.alloc((side * 4 + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const pngUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;

test('custom avatar images are stored per state under avatar/, checked, read back on demand and pruned', async (t) => {
  const { dataDir, api } = fixture(t);
  const moving = png(64, true);
  const poster = png(64);
  const still = png(128);
  const created = await api.saveAgentDefinition({
    name: 'Painter',
    body: 'Paint.',
    avatar: { kind: 'custom', states: { idle: { data: pngUrl(moving), poster: pngUrl(poster) } } },
  });
  const dir = join(dataDir, 'agents', created.id);
  const { avatar } = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'));
  assert.deepEqual(Object.keys(avatar.states), ['idle']);
  assert.match(avatar.states.idle, /^idle-[0-9a-f]{12}\.png$/);
  assert.deepEqual(readFileSync(join(dir, 'avatar', avatar.states.idle)), moving);
  assert.deepEqual(readFileSync(join(dir, 'avatar', avatar.states.idle.replace('.png', '.poster.png'))), poster);
  // The catalog carries only file names; the bytes come from their own read.
  assert.deepEqual(api.listAgents().find((agent) => agent.id === created.id).avatar, avatar);
  assert.deepEqual(api.getAgentAvatarImage(created.id), {
    states: { idle: { file: avatar.states.idle, url: pngUrl(moving), poster: pngUrl(poster) } },
  });

  // Add a still typing image, keeping idle by name.
  const save = (states) =>
    api.saveAgentDefinition({ id: created.id, name: 'Painter', body: 'Paint.', avatar: { kind: 'custom', states } });
  const typed = await save({ idle: avatar.states.idle, typing: { data: pngUrl(still) } });
  assert.equal(typed.avatar.states.idle, avatar.states.idle);
  assert.match(typed.avatar.states.typing, /^typing-[0-9a-f]{12}\.png$/);
  assert.deepEqual(api.getAgentAvatarImage(created.id).states.typing, {
    file: typed.avatar.states.typing,
    url: pngUrl(still),
    poster: '',
  });

  // Refused: markup, a lying data URL, odd sizes, an animation without its
  // first frame, no idle, a kept name that does not exist.
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}`;
  const fake = `data:image/png;base64,${Buffer.from('<svg onload="x()"/>'.padEnd(64)).toString('base64')}`;
  const gifAsPng = `data:image/gif;base64,${still.toString('base64')}`;
  for (const [states, problem] of [
    [{ idle: { data: svg } }, /PNG, GIF or WebP/],
    [{ idle: { data: fake } }, /PNG, GIF or WebP/],
    [{ idle: { data: gifAsPng } }, /PNG, GIF or WebP/],
    [{ idle: { data: pngUrl(png(300, false, 200)) } }, /square/],
    [{ idle: { data: pngUrl(png(600)) } }, /512px/],
    [{ idle: { data: pngUrl(Buffer.concat([still, Buffer.alloc(1024 * 1024)])) } }, /1 MB/],
    [{ idle: { data: pngUrl(moving) } }, /first frame/],
    [{ idle: { data: pngUrl(moving), poster: pngUrl(moving) } }, /still PNG/],
    [{ typing: { data: pngUrl(still) } }, /idle/],
    [{ idle: 'idle-000000000000.png' }, /not found/],
  ]) {
    await assert.rejects(save(states), problem, JSON.stringify(Object.keys(states)));
  }
  assert.deepEqual(api.getAgentDefinition(created.id).avatar, typed.avatar, 'a refused save writes nothing');

  // Leaving a state out resets it (back to idle) and drops its file.
  await save({ idle: avatar.states.idle });
  assert.equal(existsSync(join(dir, 'avatar', typed.avatar.states.typing)), false);
  // Switching back to a mascot drops every image.
  await api.saveAgentDefinition({
    id: created.id,
    name: 'Painter',
    body: 'Paint.',
    avatar: { kind: 'mascot', species: 'labrador', color: '#e6e6e6' },
  });
  assert.deepEqual(readdirSync(join(dir, 'avatar')), []);
  assert.equal(api.getAgentAvatarImage(created.id), null);
});

test('the older single image avatar reads as the idle image and is replaced cleanly', async (t) => {
  const { dataDir, api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Old Face', body: 'Work.' });
  const dir = join(dataDir, 'agents', created.id);
  const old = png(256);
  writeFileSync(join(dir, 'avatar-0123456789ab.png'), old);
  const manifest = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'));
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({ ...manifest, avatar: { kind: 'image', file: 'avatar-0123456789ab.png' } })
  );
  clearAgentDefinitionCache(created.id);
  const migrated = { kind: 'custom', states: { idle: 'avatar-0123456789ab.png' } };
  assert.deepEqual(api.getAgentDefinition(created.id).avatar, migrated);
  assert.deepEqual(api.getAgentAvatarImage(created.id), {
    states: { idle: { file: 'avatar-0123456789ab.png', url: pngUrl(old), poster: '' } },
  });
  // Kept by name while a typing image is added beside it.
  const kept = await api.saveAgentDefinition({
    id: created.id,
    name: 'Old Face',
    body: 'Work.',
    avatar: { kind: 'custom', states: { idle: 'avatar-0123456789ab.png', typing: { data: pngUrl(png(64)) } } },
  });
  assert.equal(kept.avatar.states.idle, 'avatar-0123456789ab.png');
  assert.equal(existsSync(join(dir, 'avatar-0123456789ab.png')), true);
  // The older upload shape still saves: as a new idle image, the old file gone.
  const replaced = await api.saveAgentDefinition({
    id: created.id,
    name: 'Old Face',
    body: 'Work.',
    avatar: { kind: 'image', data: pngUrl(png(32)) },
  });
  assert.match(replaced.avatar.states.idle, /^idle-[0-9a-f]{12}\.png$/);
  assert.equal(existsSync(join(dir, 'avatar-0123456789ab.png')), false);
});

test('PERSONA.md is written beside AGENT.md, read back, kept when absent and removed when cleared', async (t) => {
  const { dataDir, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Buddy',
    body: 'Help.',
    persona: '  반말로, 재영님이라고 부릅니다.  ',
  });
  const file = join(dataDir, 'agents', created.id, 'PERSONA.md');
  assert.equal(readFileSync(file, 'utf8'), '반말로, 재영님이라고 부릅니다.\n');
  assert.equal(created.persona, '반말로, 재영님이라고 부릅니다.');
  assert.equal(api.getAgentDefinition(created.id).persona, '반말로, 재영님이라고 부릅니다.');
  // A save without `persona` (e.g. Mixy's setup tool) leaves it alone.
  await api.saveAgentDefinition({ id: created.id, name: 'Buddy', body: 'Help more.' });
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(join(dataDir, 'agents', created.id, 'AGENT.md'), 'utf8').includes('Help more.'), true);
  const cleared = await api.saveAgentDefinition({ id: created.id, name: 'Buddy', body: 'Help more.', persona: '' });
  assert.equal(existsSync(file), false);
  assert.equal(cleared.persona, '');
  assert.equal(existsSync(join(dataDir, 'agents', created.id, 'agent.json')), true);
});

test('a save carrying a stale revision is refused as a conflict; a fresh one or none saves', async (t) => {
  const { api } = fixture(t);
  const created = await api.saveAgentDefinition({ name: 'Watcher', description: 'one', body: 'Work.' });
  const loaded = api.getAgentDefinition(created.id);
  assert.match(loaded.revision, /^[0-9a-f]{24}$/);
  // Another surface (the Workflows editor, the setup tool) saves meanwhile, with no revision.
  const other = await api.saveAgentDefinition({ id: created.id, name: 'Watcher', description: 'two', body: 'Work.' });
  assert.equal(other.description, 'two', 'a save without a revision still wins');
  assert.notEqual(other.revision, loaded.revision);
  await assert.rejects(
    api.saveAgentDefinition({
      id: created.id,
      expectedRevision: loaded.revision,
      name: 'Watcher',
      description: 'stale',
      body: 'Work.',
    }),
    (error) => error.code === 'AGENT_DEFINITION_CONFLICT' && /AGENT_DEFINITION_CONFLICT/.test(error.message)
  );
  assert.equal(api.getAgentDefinition(created.id).description, 'two', 'the stale save wrote nothing');
  const fresh = await api.saveAgentDefinition({
    id: created.id,
    expectedRevision: other.revision,
    name: 'Watcher',
    description: 'three',
    persona: '짧게',
    body: 'Work.',
  });
  assert.equal(fresh.description, 'three');
  assert.notEqual(fresh.revision, other.revision, 'PERSONA.md is part of the revision');
});

test("Mixy's persona is agents/lead/PERSONA.md: saved, read back and removed when cleared", async (t) => {
  const { dataDir, api } = fixture(t);
  assert.equal(api.getLeadPersona(), '');
  assert.equal(api.saveLeadPersona('  존댓말로 짧게 답합니다.  '), '존댓말로 짧게 답합니다.');
  const file = join(dataDir, 'agents', 'lead', 'PERSONA.md');
  assert.equal(readFileSync(file, 'utf8'), '존댓말로 짧게 답합니다.\n');
  assert.equal(api.getLeadPersona(), '존댓말로 짧게 답합니다.');
  assert.ok(!api.listAgents().some((agent) => agent.id === 'lead'), 'the persona never makes Mixy a custom agent');
  assert.equal(api.saveLeadPersona(''), '');
  assert.equal(existsSync(file), false);
  assert.throws(() => api.saveLeadPersona('x'.repeat(256 * 1024 + 1)), /256 KB/);
});

test("Mixy's 일하는 방식 is agents/lead/AGENT.md: saved, read back and removed when cleared", async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  assert.equal(api.getLeadAgentBody(), '');
  assert.equal(api.saveLeadAgentBody('  일정부터 챙깁니다.  '), '일정부터 챙깁니다.');
  const file = join(dataDir, 'agents', 'lead', 'AGENT.md');
  assert.equal(readFileSync(file, 'utf8'), '일정부터 챙깁니다.\n');
  assert.equal(api.getLeadAgentBody(), '일정부터 챙깁니다.');
  assert.ok(!api.listAgents().some((agent) => agent.id === 'lead'), 'its AGENT.md never makes Mixy a custom agent');
  assert.ok(!helpers.listCustomAgentIds(dataDir).includes('lead'));
  assert.equal(api.saveLeadAgentBody(''), '');
  assert.equal(existsSync(file), false);
  assert.throws(() => api.saveLeadAgentBody('x'.repeat(256 * 1024 + 1)), /256 KB/);
});

test("Mixy's created flag lives in agents/lead/agent.json: undecided, then set, keeping the other keys", async (t) => {
  const { dataDir, api } = fixture(t);
  assert.deepEqual(api.getLeadStatus(), { created: null, name: '', avatar: null, homeChatted: false, route: null });
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{ "keep": 1 }\n');
  assert.deepEqual(api.setLeadCreated(false), {
    created: false,
    name: '',
    avatar: null,
    homeChatted: false,
    route: null,
  });
  assert.deepEqual(api.setLeadCreated(true, '  기본 비서 '), {
    created: true,
    name: '',
    avatar: null,
    homeChatted: false,
    route: null,
  });
  const manifest = JSON.parse(readFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), 'utf8'));
  assert.equal(manifest.created, true);
  assert.equal(manifest.description, '기본 비서');
  assert.equal(manifest.keep, 1, 'the other keys are kept');
  assert.ok(!api.listAgents().some((agent) => agent.id === 'lead'), 'the flag never makes Mixy a custom agent');
  assert.throws(() => api.setLeadCreated('yes'), /boolean/);
});

test("Mixy's name and face are `name` and `avatar` in agents/lead/agent.json; empty goes back to the defaults", async (t) => {
  const { dataDir, api } = fixture(t);
  const face = {
    kind: 'custom',
    states: { idle: { data: `data:image/png;base64,${png(64).toString('base64')}` } },
  };
  const status = api.saveLeadIdentity({ name: '  Navi  ', avatar: face });
  assert.equal(status.name, 'Navi');
  assert.match(status.avatar.states.idle, /^idle-[0-9a-f]{12}\.png$/);
  const file = join(dataDir, 'agents', 'lead', 'agent.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(manifest.name, 'Navi', 'the key the runtime identity line reads');
  assert.deepEqual(manifest.avatar, status.avatar);
  assert.equal(api.getAgentAvatarImage('lead').states.idle.file, status.avatar.states.idle);
  // Only the keys given change; null drops the images too.
  api.setLeadCreated(true);
  assert.equal(api.saveLeadIdentity({ avatar: null }).name, 'Navi');
  assert.deepEqual(readdirSync(join(dataDir, 'agents', 'lead', 'avatar')), []);
  assert.deepEqual(api.saveLeadIdentity({ name: '' }), {
    created: true,
    name: '',
    avatar: null,
    homeChatted: false,
    route: null,
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).created, true);
  assert.throws(() => api.saveLeadIdentity({ avatar: { kind: 'mascot', variant: 'nope' } }), /mascot/);
});

test('a starter saved unchanged but with an avatar keeps a user copy instead of folding back to shipped', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  const shipped = api.getAgentDefinition(starter);
  const avatar = { kind: 'mascot', species: 'labrador', accessory: 'none', expression: 'calm', color: '#9a9a9a' };
  await api.saveAgentDefinition({
    id: starter,
    name: shipped.name,
    description: shipped.description,
    body: shipped.body,
    avatar,
  });
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'agents', starter, 'agent.json'), 'utf8')).avatar, avatar);
  assert.deepEqual(api.getAgentDefinition(starter).avatar, avatar);
});

test('workflow packs: create derives a free id, save/list/set round-trip, delete falls the active workflow back to Default', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const first = await api.createWorkflow({ name: 'Review  Flow', description: 'Two\nlines', body: 'Review first.' });
  assert.equal(first.id, workflowIdFromName('Review Flow'));
  assert.deepEqual(first, {
    id: first.id,
    name: 'Review Flow',
    description: 'Two lines',
    source: 'user',
    body: 'Review first.',
    userOverride: true,
    path: join(dataDir, 'workflows', first.id, 'WORKFLOW.md'),
  });
  const second = await api.createWorkflow({ name: 'Review Flow', body: 'Again.' });
  assert.notEqual(second.id, first.id, 'a taken id yields the next available one');
  await assert.rejects(api.createWorkflow({ id: first.id, name: 'Dup', body: 'x' }), /already exists/);
  await assert.rejects(api.createWorkflow({ name: '   ', body: 'x' }), /workflow name must not be empty/);
  await assert.rejects(api.saveWorkflowPack({ id: first.id, body: '  ' }), /WORKFLOW.md body must not be empty/);

  assert.deepEqual(
    api.listWorkflows().map((workflow) => [workflow.id, workflow.active]),
    [
      ['default', true],
      [first.id, false],
      [second.id, false],
    ]
  );
  const applied = await api.setWorkflow(first.id);
  assert.equal(applied.appliedToCurrentSession, true);
  assert.equal(state.config.workflow.active, first.id);
  assert.equal(state.refreshes, 1);
  await assert.rejects(api.setWorkflow('nope'), /workflow "nope" not found/);

  assert.deepEqual(await api.deleteWorkflow(first.id), { id: first.id, deleted: true, revertedToBuiltIn: false });
  assert.equal(state.config.workflow.active, 'default', 'a removed active pack falls back to Default');
  assert.equal(existsSync(join(dataDir, 'workflows', first.id)), false);
  assert.throws(() => api.getWorkflowPack(first.id), /not found/);
  await assert.rejects(api.deleteWorkflow(first.id), /not found/);
  assert.throws(() => api.getWorkflowPack(''), /unknown workflow/);
});

test('a built-in workflow cannot be deleted until a user override exists; deleting the override reverts it', async (t) => {
  const { dataDir, api } = fixture(t);
  await assert.rejects(api.deleteWorkflow('default'), /built-in and cannot be deleted/);
  const builtIn = api.getWorkflowPack('default');
  assert.equal(builtIn.userOverride, false);
  assert.equal(builtIn.path, undefined, 'a shipped-only pack exposes no file to edit');
  const saved = await api.saveWorkflowPack({ id: 'default', body: 'Overridden default.' });
  assert.equal(saved.userOverride, true);
  // An in-place edit of the user copy is what the next read returns.
  writeFileSync(saved.path, readFileSync(saved.path, 'utf8').replace('Overridden default.', 'Edited in place.'));
  assert.equal(api.getWorkflowPack('default').body, 'Edited in place.');
  assert.equal(saved.name, 'default', 'a missing name falls back to the id');
  assert.match(
    readFileSync(join(dataDir, 'workflows', 'default', 'WORKFLOW.md'), 'utf8'),
    /^---\nid: default\nname: default\n---\n/
  );
  assert.deepEqual(await api.deleteWorkflow('default'), { id: 'default', deleted: true, revertedToBuiltIn: true });
  assert.equal(api.getWorkflowPack('default').body, builtIn.body);
});

test('definition saves are atomic and keep the replaced copy as <file>.bak', async (t) => {
  const { dataDir, api } = fixture(t);
  const agent = await api.saveAgentDefinition({ name: 'Keeper', body: 'First body.' });
  const dir = join(dataDir, 'agents', agent.id);
  await api.saveAgentDefinition({ id: agent.id, name: 'Keeper', body: 'Second body.' });
  assert.match(readFileSync(join(dir, 'AGENT.md'), 'utf8'), /Second body\./);
  assert.match(readFileSync(join(dir, 'AGENT.md.bak'), 'utf8'), /First body\./);
  assert.equal(JSON.parse(readFileSync(join(dir, 'agent.json.bak'), 'utf8')).name, 'Keeper');
  assert.ok(
    !readdirSync(dir).some((name) => name.endsWith('.tmp') || name.includes('.mixdog-tmp-')),
    'no temp file is left behind'
  );
  const pack = await api.saveWorkflowPack({ id: 'keep-me', body: 'One.' });
  await api.saveWorkflowPack({ id: pack.id, body: 'Two.' });
  const packDir = join(dataDir, 'workflows', 'keep-me');
  assert.match(readFileSync(join(packDir, 'WORKFLOW.md.bak'), 'utf8'), /One\./);
});

test('persona and Mixy files holding no data (a crash left them NUL-filled) read as missing and are rewritten', async (t) => {
  const { dataDir, api } = fixture(t);
  const lead = join(dataDir, 'agents', 'lead');
  mkdirSync(lead, { recursive: true });
  for (const file of ['PERSONA.md', 'AGENT.md', 'agent.json']) writeFileSync(join(lead, file), '\0'.repeat(64));
  assert.equal(api.getLeadPersona(), '');
  assert.equal(api.getLeadAgentBody(), '');
  assert.equal(api.getLeadStatus().created, null);
  assert.equal(api.saveLeadPersona('Warm.'), 'Warm.');
  assert.equal(readFileSync(join(lead, 'PERSONA.md'), 'utf8'), 'Warm.\n');
  // A custom agent's NUL persona is no persona.
  const agent = await api.saveAgentDefinition({ name: 'Nul Persona', body: 'Work.' });
  writeFileSync(join(dataDir, 'agents', agent.id, 'PERSONA.md'), '\0'.repeat(32));
  assert.equal(api.getAgentDefinition(agent.id).persona, '');
});

// A manifest a crash left damaged must never be rewritten from nothing: its
// keys (connectors above all — a manifest without them means "every connector
// on") come back from agent.json.bak, or the write is refused.
const GUARDED = { name: 'Momo', connectors: { off: ['github'] } };
const DAMAGES = [
  ['NUL-filled', '\0'.repeat(64)],
  ['empty', ''],
  ['truncated', '{"name": "Momo", "connectors": {"off": ["gith'],
];

for (const [damage, bytes] of DAMAGES) {
  test(`setLeadCreated restores a ${damage} Mixy manifest from its backup and keeps its connectors`, async (t) => {
    const { dataDir, api } = fixture(t);
    const lead = join(dataDir, 'agents', 'lead');
    mkdirSync(lead, { recursive: true });
    writeFileSync(join(lead, 'agent.json'), bytes);
    writeFileSync(join(lead, 'agent.json.bak'), JSON.stringify(GUARDED));
    const status = api.setLeadCreated(true, 'Primary');
    assert.equal(status.created, true);
    assert.equal(status.name, 'Momo');
    assert.deepEqual(JSON.parse(readFileSync(join(lead, 'agent.json'), 'utf8')), {
      ...GUARDED,
      created: true,
      description: 'Primary',
    });
    assert.deepEqual(api.getAgentConnectorPolicy('lead').off, ['github']);
    const aside = readdirSync(lead).filter((name) => name.startsWith('agent.json.corrupt-'));
    assert.equal(aside.length, 1, 'the damaged bytes are kept');
    assert.equal(readFileSync(join(lead, aside[0]), 'utf8'), bytes);
  });
}

test('without a good copy a damaged Mixy manifest is left as is: no write turns it into a permissive one', async (t) => {
  const { dataDir, api } = fixture(t);
  const lead = join(dataDir, 'agents', 'lead');
  const file = join(lead, 'agent.json');
  mkdirSync(lead, { recursive: true });
  for (const [, bytes] of DAMAGES) {
    writeFileSync(file, bytes);
    t.mock.method(process.stderr, 'write', () => true);
    assert.equal(api.setLeadCreated(true).created, null, 'soft: the flag is not saved');
    assert.throws(() => api.saveLeadIdentity({ name: 'Mixy' }), /damaged and has no good copy/);
    await assert.rejects(api.setAgentConnectorPolicy('lead', null), /damaged and has no good copy/);
    t.mock.restoreAll();
    assert.equal(readFileSync(file, 'utf8'), bytes, 'the damaged manifest is never overwritten');
    assert.deepEqual(
      readdirSync(lead).filter((name) => name !== 'agent.json'),
      [],
      'nothing was moved aside or created'
    );
  }
});

test('saving a custom agent restores a damaged manifest from its backup; without one it refuses', async (t) => {
  const { dataDir, api } = fixture(t);
  const agent = await api.saveAgentDefinition({ name: 'Guarded', body: 'Work.' });
  const dir = join(dataDir, 'agents', agent.id);
  const file = join(dir, 'agent.json');
  writeFileSync(file.concat('.bak'), JSON.stringify({ name: 'Guarded', ...GUARDED }));
  writeFileSync(file, '\0'.repeat(64));
  await api.saveAgentDefinition({ id: agent.id, name: 'Guarded', body: 'Work again.' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).connectors, { off: ['github'] });
  assert.match(readFileSync(join(dir, 'AGENT.md'), 'utf8'), /Work again\./);

  rmSync(file.concat('.bak'));
  writeFileSync(file, '\0'.repeat(64));
  await assert.rejects(
    api.saveAgentDefinition({ id: agent.id, name: 'Guarded', body: 'Third.' }),
    /damaged and has no good copy/
  );
  assert.equal(readFileSync(file, 'utf8'), '\0'.repeat(64));
  assert.match(readFileSync(join(dir, 'AGENT.md'), 'utf8'), /Work again\./, 'the definition is not rewritten either');
});
