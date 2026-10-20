// The bot store (1.3.1): after the one-time split, bots are read and written
// under bots/<id>/ with their own model route, workflow agents under agents/,
// and a coding Lead's delegation catalog lists only workflow agents.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  FIXED_AGENT_SLOTS,
  clearAgentDefinitionCache,
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { normalizeAgentPermissionOrNone, readMarkdownDocument } from '../runtime/shared/markdown-frontmatter.mjs';
import { isContactAgentId } from '../runtime/shared/agent-route-config.mjs';
import { routineOwnerProblem } from './routine-owner.mjs';
import { scheduleOwnerAgentId } from './agent-home-delivery.mjs';
import { agentHomeSessionId } from '../runtime/agent/orchestrator/session/agent-home.mjs';

const MAIN = { provider: 'anthropic-oauth', model: 'claude-opus-5' };
const MASCOT = { kind: 'mascot', species: 'shepherd', accessory: 'collar', expression: 'calm', color: '#5b9bff' };
const STARTERS = ['worker', 'heavy-worker', 'reviewer', 'advisor', 'security', 'front-worker', 'writer', 'maintainer'];

function fixture(t, overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-bot-store-'));
  // The split backs up agents/ and bots/ first: never into the real profile's backups.
  const backups = mkdtempSync(join(tmpdir(), 'mixdog-bot-store-backups-'));
  const savedBackupRoot = process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
  process.env.MIXDOG_USER_DATA_BACKUP_ROOT = backups;
  t.after(() => {
    clearAgentDefinitionCache();
    if (savedBackupRoot === undefined) delete process.env.MIXDOG_USER_DATA_BACKUP_ROOT;
    else process.env.MIXDOG_USER_DATA_BACKUP_ROOT = savedBackupRoot;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(backups, { recursive: true, force: true });
  });
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'),
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone,
  });
  const { agentRouteFromConfig } = createWorkflowRouteHelpers({ findPreset: () => null });
  const state = {
    config: {
      workflow: { active: 'default' },
      default: 'workflow-lead',
      agents: { 'dialog-bot': { provider: 'openai', model: 'gpt-6' }, triage: { provider: 'openai', model: 'gpt-5' } },
    },
  };
  const api = createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : { ...MAIN }),
    agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    refreshEmptySessionToolPolicy: async () => ({ appliedToCurrentSession: true }),
    invalidateContextStatusCache() {},
    ...overrides,
  });
  return { dataDir, helpers, state, api };
}

function writeAgent(dataDir, id, { frontmatter = '', body = `You are ${id}.`, manifest = {} } = {}) {
  const dir = join(dataDir, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), `---\nname: ${id}\ndescription: ${id} job\n${frontmatter}---\n\n${body}\n`);
  writeFileSync(
    join(dir, 'agent.json'),
    `${JSON.stringify({ name: id, description: `${id} job`, ...manifest }, null, 2)}\n`
  );
}

function writeThread(dataDir, id, messages) {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', `sess_home_${id}.json`),
    JSON.stringify({ id: `sess_home_${id}`, ...MAIN, profile: { homeAgent: id }, messages })
  );
}

// A fresh 1.3.0 profile: a dialog bot (with a config route), a setup-tool bot
// that was greeted, an old agent the user chatted with, a Workflows agent.
function seed(dataDir) {
  writeAgent(dataDir, 'dialog-bot', { body: 'Plan my week.', manifest: { avatar: MASCOT } });
  writeThread(dataDir, 'dialog-bot', [
    { role: 'user', content: '[mixdog-runtime] The user just created you as a new agent named "dialog-bot".' },
    { role: 'assistant', content: '안녕하세요' },
  ]);
  writeAgent(dataDir, 'tool-bot');
  writeThread(dataDir, 'tool-bot', [
    { role: 'user', content: '[mixdog-runtime] The user just created you as a new agent named "tool-bot".' },
  ]);
  writeAgent(dataDir, 'old-helper');
  writeThread(dataDir, 'old-helper', [
    { role: 'user', content: '안녕' },
    { role: 'assistant', content: '안녕하세요' },
  ]);
  writeAgent(dataDir, 'triage', { frontmatter: 'kind: agent\n' });
}

const kinds = (api) =>
  Object.fromEntries(
    api
      .listAgents()
      .filter((row) => row.custom && !FIXED_AGENT_SLOTS.some((slot) => slot.id === row.id))
      .filter((row) => !STARTERS.includes(row.id))
      .map((row) => [row.id, isContactAgentId(row.id, row.kind) ? 'bot' : 'agent'])
  );

function tree(dir) {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .flatMap((name) => {
        try {
          return [[name, readFileSync(join(dir, name), 'utf8')]];
        } catch {
          return [];
        }
      })
  );
}

test('after the split, bots are read from bots/ with their own route; agents/ keeps every original', async (t) => {
  const { dataDir, state, api } = fixture(t);
  seed(dataDir);
  const agentsBefore = tree(join(dataDir, 'agents'));
  const sessionsBefore = tree(join(dataDir, 'sessions'));
  const configBefore = structuredClone(state.config);
  const result = api.migrateBotStore();
  assert.deepEqual(result.bots, ['dialog-bot', 'tool-bot']);
  assert.deepEqual(tree(join(dataDir, 'agents')), agentsBefore, 'originals stay for rollback');
  assert.deepEqual(tree(join(dataDir, 'sessions')), sessionsBefore, 'every transcript byte-for-byte');
  assert.deepEqual(state.config, configBefore, 'the config, Lead route included, is untouched');
  assert.deepEqual(kinds(api), { 'dialog-bot': 'bot', 'tool-bot': 'bot', 'old-helper': 'agent', triage: 'agent' });
  // The bot is read from its own folder from now on.
  writeFileSync(join(dataDir, 'bots', 'dialog-bot', 'PERSONA.md'), 'Warm.\n');
  clearAgentDefinitionCache('dialog-bot');
  assert.equal(api.getAgentDefinition('dialog-bot').persona, 'Warm.');
  // Its route came along and is its own.
  const rows = new Map(api.listAgents().map((row) => [row.id, row]));
  assert.deepEqual(rows.get('dialog-bot').route, { provider: 'openai', model: 'gpt-6' });
  assert.equal(rows.get('tool-bot').routeConfigured, false);
  // A second start does nothing.
  assert.equal(api.migrateBotStore().skipped, true);
});

test('a bot route is saved with the bot, a workflow agent route in the config; neither touches the Lead', async (t) => {
  const { dataDir, state, api } = fixture(t);
  seed(dataDir);
  api.migrateBotStore();
  await api.setAgentRoute('tool-bot', { provider: 'openai', model: 'gpt-6-mini' });
  assert.deepEqual(
    JSON.parse(readFileSync(join(dataDir, 'bots', 'tool-bot', 'agent.json'), 'utf8')).route.model,
    'gpt-6-mini'
  );
  assert.equal(state.config.agents['tool-bot'], undefined, 'never in the config');
  await api.setAgentRoute('triage', { provider: 'openai', model: 'gpt-6' });
  assert.equal(state.config.agents.triage.model, 'gpt-6');
  assert.equal(state.config.default, 'workflow-lead', 'the Lead preset stays');
  // Dropping the bot's own model: it follows Main again, still not in the config.
  await api.setAgentRoute('tool-bot', { provider: '' });
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'bots', 'tool-bot', 'agent.json'), 'utf8')).route, undefined);
});

test('new bots are made in bots/ (marked kind: bot), new agents in agents/; a purged migrated bot never comes back as an agent', async (t) => {
  const { dataDir, api } = fixture(t);
  seed(dataDir);
  api.migrateBotStore();
  const bot = await api.saveAgentDefinition({ name: 'Scout', body: 'Scout.', kind: 'bot', avatar: MASCOT });
  assert.ok(existsSync(join(dataDir, 'bots', bot.id, 'AGENT.md')));
  assert.equal(existsSync(join(dataDir, 'agents', bot.id)), false);
  const botFile = join(dataDir, 'bots', bot.id, 'AGENT.md');
  assert.equal(readMarkdownDocument(readFileSync(botFile, 'utf8')).frontmatter.kind, 'bot');
  // The marker survives a later edit.
  await api.saveAgentDefinition({ id: bot.id, name: 'Scout', body: 'Scout, edited.' });
  assert.equal(readMarkdownDocument(readFileSync(botFile, 'utf8')).frontmatter.kind, 'bot');
  const role = await api.saveAgentDefinition({ name: 'Sorter', body: 'Sort.', kind: 'agent' });
  assert.ok(existsSync(join(dataDir, 'agents', role.id, 'AGENT.md')));
  assert.equal(
    readMarkdownDocument(readFileSync(join(dataDir, 'agents', role.id, 'AGENT.md'), 'utf8')).frontmatter.kind,
    'agent'
  );
  assert.equal(kinds(api)[bot.id], 'bot');
  assert.equal(kinds(api)[role.id], 'agent');
  // Delete (archive) then purge a migrated bot: its agents/ original stays on
  // disk but is never read again.
  await api.deleteAgentDefinition('tool-bot');
  assert.ok(existsSync(join(dataDir, 'bots', 'tool-bot', '.deleted')));
  await api.purgeAgentDefinition('tool-bot');
  assert.equal(existsSync(join(dataDir, 'bots', 'tool-bot')), false);
  assert.ok(existsSync(join(dataDir, 'agents', 'tool-bot', 'AGENT.md')));
  assert.equal('tool-bot' in kinds(api), false);
  // Its id stays taken: a new agent of that name gets another one.
  const again = await api.saveAgentDefinition({ name: 'tool-bot', body: 'x', kind: 'agent' });
  assert.notEqual(again.id, 'tool-bot');
});

test('Mixy is its own bot: identity in bots/mixy, its own route; the Lead and Mixy never change each other', async (t) => {
  const { dataDir, state, api } = fixture(t);
  // A 1.3.0 automatic Mixy the user chatted with on gpt-6.
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  const thread = JSON.stringify({
    id: 'sess_home_lead',
    provider: 'openai-oauth',
    model: 'gpt-6',
    messages: [
      { role: 'user', content: '안녕' },
      { role: 'assistant', content: '안녕하세요' },
    ],
  });
  writeFileSync(join(dataDir, 'sessions', 'sess_home_lead.json'), thread);
  const leadConfig = structuredClone(state.config);
  assert.equal(api.migrateBotStore().mixy, true);
  assert.deepEqual(api.getLeadStatus(), {
    created: true,
    name: '',
    avatar: null,
    homeChatted: true,
    route: { provider: 'openai-oauth', model: 'gpt-6' },
  });
  // Mixy's model change lands in bots/mixy only.
  await api.setAgentRoute('lead', { provider: 'openai', model: 'gpt-6-mini' });
  assert.equal(api.getLeadStatus().route.model, 'gpt-6-mini');
  assert.deepEqual(state.config, leadConfig, "the Lead's route, presets and agent routes untouched");
  // The Lead's model change (its preset) leaves Mixy's own route alone.
  state.config = { ...state.config, default: 'workflow-other' };
  assert.equal(api.getLeadStatus().route.model, 'gpt-6-mini');
  // Its identity edits go to bots/mixy; agents/lead keeps its 1.3.0 flag only.
  api.saveLeadIdentity({ name: 'Momo' });
  api.saveLeadPersona('Cheerful.');
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), 'utf8')).name, 'Momo');
  assert.equal(readFileSync(join(dataDir, 'bots', 'mixy', 'PERSONA.md'), 'utf8'), 'Cheerful.\n');
  assert.equal(readFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), 'utf8'), '{\n  "created": true\n}\n');
  assert.equal(existsSync(join(dataDir, 'agents', 'lead', 'PERSONA.md')), false);
  // Mixy is never listed as a bot or an agent, and its thread is untouched.
  assert.equal(
    api.listAgents().some((row) => row.id === 'mixy' || row.id === 'lead'),
    false
  );
  assert.equal(readFileSync(join(dataDir, 'sessions', 'sess_home_lead.json'), 'utf8'), thread);
});

test('the 대표 에이전트 dialog over an unused automatic Mixy makes bots/mixy and leaves agents/lead as it was', async (t) => {
  const { dataDir, state, api } = fixture(t);
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  assert.equal(api.migrateBotStore().mixy, false, 'unused: not migrated');
  // Still decided (its routines keep running); unnamed and never talked to,
  // the host shows the dialog (main/mixy-first.ts resolveMixyCreated).
  assert.deepEqual(api.getLeadStatus(), { created: true, name: '', avatar: null, homeChatted: false, route: null });
  const leadConfig = structuredClone(state.config);
  // createMixy's steps (renderer/mixy-first.tsx).
  api.saveLeadIdentity({ name: 'Mixy' });
  await api.setAgentRoute('lead', { provider: 'openai', model: 'gpt-6' });
  const status = api.setLeadCreated(true, 'Primary assistant');
  assert.deepEqual(
    { ...status, route: { provider: status.route.provider, model: status.route.model } },
    {
      created: true,
      name: 'Mixy',
      avatar: null,
      homeChatted: false,
      route: { provider: 'openai', model: 'gpt-6' },
    }
  );
  assert.deepEqual(state.config, leadConfig, 'the Lead is untouched');
  assert.equal(readFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), 'utf8'), '{\n  "created": true\n}\n');
});

test('routines keep their owners across the split: migrated bots, Mixy and reclassified agents still run; a purged bot pauses', async (t) => {
  const { dataDir, api } = fixture(t);
  seed(dataDir);
  // A v1.3.0 automatic Mixy (ownerless 1.2.6 schedules belong to it).
  mkdirSync(join(dataDir, 'agents', 'lead'), { recursive: true });
  writeFileSync(join(dataDir, 'agents', 'lead', 'agent.json'), '{\n  "created": true\n}\n');
  api.migrateBotStore();
  const probe = {
    mixyExists: () => api.getLeadStatus().created !== false,
    presence: (agentId) => api.agentDefinitionPresence([agentId])[agentId],
  };
  for (const owner of ['dialog-bot', 'tool-bot', 'old-helper', '']) {
    assert.equal(await routineOwnerProblem(owner, probe), '', `${owner || 'Mixy'} still owns its routines`);
  }
  // Results still land in the same home threads (ids never change).
  assert.equal(agentHomeSessionId(scheduleOwnerAgentId({ ownerAgentId: 'dialog-bot' })), 'sess_home_dialog-bot');
  assert.equal(agentHomeSessionId(scheduleOwnerAgentId({})), 'sess_home_lead');
  await api.deleteAgentDefinition('tool-bot');
  await api.purgeAgentDefinition('tool-bot');
  assert.equal(await routineOwnerProblem('tool-bot', probe), 'owner-deleted');
});

test('2: an id lives in one store only: explicit, generated and restored ids never cross stores', async (t) => {
  const { dataDir, api } = fixture(t);
  seed(dataDir);
  api.migrateBotStore();
  // An explicit id already in the other store is refused, as is an archived one.
  await assert.rejects(
    api.saveAgentDefinition({ id: 'tool-bot', name: 'x', body: 'x', kind: 'agent' }),
    /kind is set when it is created/
  );
  await api.deleteAgentDefinition('old-helper');
  await assert.rejects(
    api.saveAgentDefinition({ id: 'old-helper', name: 'x', body: 'x', kind: 'bot' }),
    /already in use/
  );
  await api.deleteAgentDefinition('dialog-bot');
  await assert.rejects(
    api.saveAgentDefinition({ id: 'dialog-bot', name: 'x', body: 'x', kind: 'agent' }),
    /already in use/
  );
  // A generated id steps past folders of either store.
  const bot = await api.saveAgentDefinition({ name: 'old-helper', body: 'x', kind: 'bot' });
  assert.notEqual(bot.id, 'old-helper');
  // Restoring the archived bot brings it back in bots/, not agents/.
  await api.restoreAgentDefinition('dialog-bot');
  assert.ok(existsSync(join(dataDir, 'bots', 'dialog-bot', 'AGENT.md')));
  assert.equal(kinds(api)['dialog-bot'], 'bot');
});

test('7: a bot archived in bots/ stays archived across restarts; its agents/ original never shows', async (t) => {
  const { dataDir, api } = fixture(t);
  seed(dataDir);
  api.migrateBotStore();
  await api.deleteAgentDefinition('tool-bot');
  assert.equal(api.migrateBotStore().skipped, true);
  assert.equal('tool-bot' in kinds(api), false);
  assert.ok(existsSync(join(dataDir, 'agents', 'tool-bot', 'AGENT.md')), 'the original stays on disk');
  assert.equal(api.agentDefinitionPresence(['tool-bot'])['tool-bot'], 'deleted');
});

test('delegation catalogs list only workflow agents; only Mixy sees the bots', (t) => {
  const { dataDir, helpers, state, api } = fixture(t);
  seed(dataDir);
  api.migrateBotStore();
  const context = helpers.activeWorkflowContext(state.config, dataDir);
  const coding = context.leadPromptParts({ agentMode: false }).agentCatalogContext;
  assert.match(coding, /\(old-helper\)|old-helper/);
  assert.doesNotMatch(coding, /dialog-bot|tool-bot/);
  const lead = context.leadPromptParts({ agentMode: true, mixy: false });
  assert.doesNotMatch(lead.agentCatalogContext, /dialog-bot|tool-bot/);
  assert.equal(lead.contactCatalogContext, '');
  const mixy = context.leadPromptParts({ agentMode: true, mixy: true });
  assert.match(mixy.contactCatalogContext, /dialog-bot/);
  assert.match(mixy.contactCatalogContext, /tool-bot/);
  assert.doesNotMatch(mixy.agentCatalogContext, /dialog-bot|tool-bot/);
});

test('a bot route another process wrote while a conditional fill resolved is kept', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { dataDir, api } = fixture(t, {
    lookupModelMeta: async () => {
      await gate;
      return {};
    },
  });
  seed(dataDir);
  api.migrateBotStore();
  const file = join(dataDir, 'bots', 'tool-bot', 'agent.json');
  const fill = api.setAgentRoute('tool-bot', { provider: 'openai', model: 'gpt-fill', onlyIfEmpty: true });
  await Promise.resolve();
  // Written straight to the bot's folder by another process: no notification involved.
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, route: { provider: 'openai', model: 'gpt-elsewhere' } }));
  release();
  const answer = await fill;
  assert.equal(answer.skipped, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).route.model, 'gpt-elsewhere');
});
