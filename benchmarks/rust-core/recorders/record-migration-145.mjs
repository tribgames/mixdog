#!/usr/bin/env node
// Records a real v1.4.5 data directory: the 1.4.5 product code (from the tag tree) writes every data
// kind through its own writers, offline (a scripted provider, loopback only, fake tokens), and then
// answers the reads the Rust core must answer the same after the one-time migration. Output:
//   <out>/.mixdog/data, <out>/.mixdog/projects.json   the data the 1.4.5 code wrote
//   <out>/answers.json                                 what 1.4.5 answered for that data
//   <out>/MANIFEST.json                                the tag's commit (exact) and every file's hash
//
//   node benchmarks/rust-core/recorders/record-migration-145.mjs --tree <git clone at tag v1.4.5 with node_modules> --out <dir>
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { workflowAgentsApi } from './lib/migration-145-api.mjs';
import { parseArgs, resolveTree, tagCheckoutIdentity, walkFiles, writeSetManifest } from './lib/common.mjs';

const RELEASE_TAG = 'v1.4.5';
const args = parseArgs();
const tree = resolveTree(args);
// Only a clean checkout at the release tag's commit may record: the recording stands for what that release wrote.
const identity = tagCheckoutIdentity(tree, RELEASE_TAG);
const out = args.get('out') ? resolve(args.get('out')) : null;
if (!out) throw new Error('--out <dir> is required');
// The product runs in <out>.live; the recording is a copy taken before 1.4.5 answers (answering recovers
// an interrupted turn and so changes the directory).
const root = `${out}.live`;
rmSync(root, { recursive: true, force: true });
rmSync(out, { recursive: true, force: true });
const home = join(root, '.mixdog');
const data = join(home, 'data');
mkdirSync(data, { recursive: true });
const workdir = join(root, 'work');
mkdirSync(workdir, { recursive: true });
for (const key of ['HOME', 'USERPROFILE']) process.env[key] = root;
// Nothing of the real user profile is reachable from this run.
for (const [key, sub] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['MIXDOG_DESKTOP_USER_DATA', 'desktop'], ['MIXDOG_CONFIG_DIR', 'config'], ['MIXDOG_RUNTIME_ROOT', 'runtime']]) process.env[key] = join(root, sub);
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
// The product's own "pristine" guard: no memory (Postgres), MCP, channels, staged installs or backups.
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8')).guardEnv)) {
  if (k !== 'MIXDOG_DISABLE_MCP' && k !== 'MIXDOG_DISABLE_SKILLS') process.env[k] = v;
}
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.MIXDOG_DISABLE_PROVIDER_WARMUP = '1';
process.env.MIXDOG_DISABLE_MODEL_PREFETCH = '1';
process.env.MIXDOG_DISABLE_MODEL_CATALOG_WARMUP = '1';
const at = (p) => import(pathToFileURL(join(tree, p)).href);
const answers = {};

// ---- config (every setting kind), through the product's writers
const cfgMod = await at('src/runtime/shared/config.mjs');
const orch = await at('src/runtime/agent/orchestrator/config.mjs');
const quota = await at('src/runtime/shared/quota-resume-store.mjs');
cfgMod.updateConfig((c) => ({
  ...c,
  ui: { theme: 'dark' },
  channels: { access: { allowFrom: ['u1'] }, discord: { enabled: false } },
  voice: { enabled: true, language: 'ko' },
  desktop: { computerControl: true, browserControl: false, runInBackground: true, activityRailPins: { a: 1 }, zoom: 1.25 },
  search: { provider: 'none' },
  defaultsVersion: 2,
}));
cfgMod.updateSection('agent', (a) => ({
  ...(a || {}),
  default: 'Main',
  presets: [{ id: 'Main', name: 'Main', provider: 'stub', model: 'stub-model', effort: 'medium', fast: false }],
  modelSettings: { 'stub/stub-model': { effort: 'high', contextPercent: 80 } },
  autoClear: { enabled: true, idleMinutes: 45 },
  profile: { name: 'Recorded User', language: 'ko' },
  webSearchRoute: { provider: 'stub', model: 'stub-model' },
  builtins: { memory: false },
  enabledAgents: ['worker', 'reviewer'],
  orchestrationMode: 'auto',
  promptCacheWarming: false,
  heartbeat: true,
  onboarding: { done: true, step: 4 },
  extensionScopes: { skills: { mode: 'all' } },
  mcpServers: { filesystem: { command: 'node', args: ['server.js'], env: { MODE: 'ro' } }, remote: { url: 'http://127.0.0.1:9/mcp', headers: { 'x-test': '1' } } },
  compaction: { enabled: false, semanticModel: 'stub/stub-model', recallMemoryTimeoutMs: 7000, prune: true, onModelChange: true },
}));
quota.setQuotaAutoResumeEnabled(false);

console.error('config done');

// ---- accounts and OAuth stores (fake tokens), each provider with a default and a second account
const accounts = await at('src/runtime/shared/provider-accounts.mjs');
const binding = await at('src/runtime/shared/provider-auth-binding.mjs');
const atomic = await at('src/runtime/shared/atomic-file.mjs');
const P = 'src/runtime/agent/orchestrator/providers/';
const stores = {
  'openai-oauth': { mod: await at(`${P}openai-oauth-tokens.mjs`), tokens: (n) => ({ access_token: `fake-openai-access-${n}`, refresh_token: `fake-openai-refresh-${n}`, expires_at: 4102444800000, account_id: `acct-${n}` }) },
  'grok-oauth': { mod: await at(`${P}grok-oauth-tokens.mjs`), tokens: (n) => ({ access_token: `fake-grok-access-${n}`, refresh_token: `fake-grok-refresh-${n}`, expires_at: 4102444800000, user_id: `grok-user-${n}`, email: `grok${n}@example.test` }) },
  'antigravity-oauth': { mod: await at(`${P}antigravity-oauth-tokens.mjs`), tokens: (n) => ({ access_token: `fake-agy-access-${n}`, refresh_token: `fake-agy-refresh-${n}`, expires_at: 4102444800000, project_id: `proj-${n}`, email: `agy${n}@example.test` }) },
  'command-code-oauth': { mod: await at(`${P}command-code-oauth-tokens.mjs`), tokens: (n) => ({ apiKey: `fake-cc-key-${n}`, userId: `cc-user-${n}`, userName: `cc${n}` }) },
  'mimo-oauth': { mod: await at(`${P}mimo-oauth-tokens.mjs`), tokens: (n) => ({ apiKey: `fake-mimo-key-${n}`, uid: `${n}00` }) },
  'muse-code-oauth': { mod: await at(`${P}muse-code-oauth-tokens.mjs`), tokens: (n) => ({ accessToken: `fake-muse-access-${n}`, apiKey: `fake-muse-key-${n}`, accountId: `muse-${n}` }) },
};
for (const [provider, { mod, tokens }] of Object.entries(stores)) {
  await accounts.registerProviderAccount(provider, 'default', { label: 'Personal', includeDefault: true });
  mod.saveTokens(tokens(1));
  const second = `00000000-0000-4000-8000-00000000000${Object.keys(stores).indexOf(provider)}`;
  await accounts.registerProviderAccount(provider, second, { label: 'Work' });
  binding.withProviderAccount(provider, second, () => mod.saveTokens(tokens(2)));
  await accounts.changeProviderAccounts(provider, { policy: 'manual', selectedId: second });
}
atomic.writeJsonAtomicSync(
  join(data, 'anthropic-oauth-credentials.json'),
  { claudeAiOauth: { accessToken: 'fake-anthropic-access', refreshToken: 'fake-anthropic-refresh', expiresAt: 4102444800000, scopes: ['user:inference'], subscriptionType: 'max' } },
  { mode: 0o600, secret: true }
);
console.error('accounts done');

// ---- conversations: real createSession / askSession turns against a scripted provider
const manager = await at('src/runtime/agent/orchestrator/session/manager.mjs');
const pending = await at('src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const attach = await at('src/runtime/attachments/store.mjs');
const { _withRegisteredProviderForTestAsync } = await at('src/runtime/agent/orchestrator/providers/registry.mjs');
let script = [];
let sends = 0;
const stub = {
  name: 'stub',
  contextWindow: 128000,
  async send() {
    const step = script[Math.min(sends, script.length - 1)] ?? {};
    sends += 1;
    return {
      content: step.reply ?? '',
      toolCalls: step.toolCalls ?? [],
      stopReason: step.toolCalls ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 100 + sends, outputTokens: 20 + sends },
    };
  },
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const attRef = attach.storeAttachmentBuffer(png);
const pasteRef = attach.storeAttachmentBuffer(Buffer.from('pasted block, stored as an attachment\n'));
writeFileSync(join(workdir, 'notes.txt'), 'recorded notes\n');
const ids = {};
await _withRegisteredProviderForTestAsync('stub', stub, async () => {
  const ask = async (id, prompt, steps) => {
    script = steps;
    sends = 0;
    return manager.askSession(id, prompt, null, undefined, workdir, undefined, {});
  };
  const lead = manager.createSession({ provider: 'stub', model: 'stub-model', cwd: workdir, owner: 'user', sourceType: 'lead', agent: 'lead' });
  ids.lead = lead.id;
  await ask(lead.id, 'list the dir', [{ toolCalls: [{ id: 'call_1', name: 'list', arguments: { path: '.' } }] }, { reply: 'I listed it.' }]);
  await ask(lead.id, [{ type: 'text', text: 'what is in this image?' }, { type: 'image', ...attRef, mimeType: 'image/png' }, { type: 'text', textKind: 'paste', ...pasteRef, text: 'pasted block' }], [{ toolCalls: [{ id: 'call_2', name: 'read', arguments: { path: 'notes.txt' } }] }, { reply: 'A 1x1 image; notes say recorded.' }]);
  const worker = manager.createSession({ provider: 'stub', model: 'stub-model', cwd: workdir, owner: 'agent', agent: 'worker', ownerSessionId: lead.id, parentSessionId: lead.id, sourceType: 'lead', agentTag: 'w1', taskType: 'work' });
  ids.worker = worker.id;
  await ask(worker.id, 'summarize', [{ reply: 'summary done' }]);
  const closed = manager.createSession({ provider: 'stub', model: 'stub-model', cwd: workdir, owner: 'user', sourceType: 'lead', agent: 'lead' });
  ids.closed = closed.id;
  await ask(closed.id, 'hello', [{ reply: 'hi' }]);
  await manager.closeSession(closed.id, 'manual');
  const idle = manager.createSession({ provider: 'stub', model: 'stub-model', cwd: workdir, owner: 'user', sourceType: 'cli', agent: 'lead' });
  ids.idle = idle.id;
  pending.enqueuePendingMessage(lead.id, { id: 'pm1', message: 'queued while busy', notificationKind: 'routine', mode: 'queue', enqueuedAt: 1700000000000 });
  await pending.settlePendingMessageWrites?.();
});
await manager.flushPendingSessionSaves?.();
answers.ids = ids;
console.error('sessions done');

// ---- a crash in the middle of a turn: the checkpoint a killed 1.4.5 process leaves
const crashIdFile = join(workdir, 'crash-session-id');
spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'lib', 'migration-145-crash-turn.mjs'), tree, workdir, crashIdFile], { stdio: 'inherit', env: process.env });
ids.crashed = readFileSync(crashIdFile, 'utf8');
console.error('crash turn done');

// ---- agents, bots, workflows through the workflow-agents API (the desktop editors' backend)
const api = await workflowAgentsApi(tree, data);
const triage = await api.saveAgentDefinition({ name: 'Triage', description: 'Sorts issues', body: 'Sort issues by severity.', kind: 'agent' });
const concierge = await api.saveAgentDefinition({ name: 'Concierge', description: 'Plans the day', body: 'Plan my day.', kind: 'bot' });
await api.saveAgentDefinition({ name: 'Helper', body: 'Help out.' });
await api.createWorkflow({ name: 'Release train', description: 'Ship it', body: 'Plan, build, verify, ship.' });
const botSplit = await at('src/runtime/shared/bot-split-migration.mjs');
const botResult = botSplit.migrateBotsToOwnStore({ dataDir: data, shippedRoot: join(tree, 'src'), routeOf: () => null, leadRoute: null, log() {} });
answers.botSplit = botResult;
const agentStore = await at('src/runtime/shared/agent-store.mjs');
agentStore.writeBotRoute(data, concierge.id, { provider: 'stub', model: 'stub-model' });
console.error('agents done');

// ---- single-file stores through their owners
const quotaStore = quota;
quotaStore.scheduleQuotaResumeEntry({ sessionId: ids.lead, turnKey: 'turn-1', provider: 'stub', model: 'stub-model', resetAt: 4102444800000, routeProvider: 'stub', routeModel: 'stub-model' });
const goalRuntime = (await at('src/runtime/agent/orchestrator/runtime-core/goal-runtime.mjs')).createGoalRuntime({ dataDir: data });
await goalRuntime.control(ids.lead, { action: 'create', objective: 'Ship the recorded release', duration: '2h' });
const gate = await at('src/runtime/agent/orchestrator/session/human-gate/store.mjs');
await gate.setAgentPermission('worker', 'comment', 'allow');
await gate.setAgentPermission('worker', 'review', 'block');
await gate.recordAgentApprovalAudit('worker', 'comment', 'approve').catch(() => {});
const core = await at('src/runtime/memory/lib/core-memory-file.mjs');
await core.writeCoreMemoryFileSnapshot(data, { curated: [{ id: 1, indexRevision: 1, summary: 'Prefers terse answers', projectId: null, agentId: null, updatedAt: 1700000000000 }] });
const worktrees = await at('src/runtime/shared/worktrees/registry.mjs');
await worktrees.insertRecord({ id: 'wt1', txId: 'tx1', repoCommonDir: join(workdir, '.git'), projectPath: workdir, projectSubdir: '', path: join(workdir, 'wt1'), branch: 'feature/x', baseCommit: 'abc123', mergeTarget: 'main', createdAt: 1700000000000, ownerSessionId: ids.lead, existingBranch: false, exactBranch: false, state: 'active', disposable: true, warnings: [] });
const media = await at('src/runtime/media/store.mjs');
media.saveMediaAsset({ kind: 'image', lane: 'image', model: 'stub-image', prompt: 'a 1x1 pixel', options: { size: '1x1' }, mime: 'image/png', bytes: png });
const projects = await at('src/runtime/shared/projects.mjs');
projects.addProject(workdir);
// A user's file in a skill whose name only resembles a temp file: it is data and stays through the migration.
mkdirSync(join(data, 'skills', 'example'), { recursive: true });
writeFileSync(join(data, 'skills', 'example', 'SKILL.md'), ['---', 'name: example', 'description: An example skill', '---', 'Use the guide.', ''].join('\n'));
writeFileSync(join(data, 'skills', 'example', 'guide.mixdog-tmp-not-a-temp.md'), 'A guide whose name contains the temp marker.\n');
// Names that only resemble a temp file of some writer: all data, all kept.
answers.lookalikes = [
  'data/skills/example/guide.mixdog-tmp-not-a-temp.md',
  'data/prompt-cache-touches.json.mixdog-tmp-0123456789abcdef0',
  'data/.mixdog-tmp-0123456789abcdef',
  'data/goals/lookalike.json.mixdog-tmp-0123456789ABCDEF',
  'data/human-gate/lookalike.json.mixdog-tmp-0123abcd',
  'data/schedules/lookalike.json.mixdog-tmp-0123456789abcdef',
  'data/sessions/lookalike.json.mixdog-tmp-0123456789abcdef',
  'data/sessions/lookalike.compaction-archive.jsonl.mixdog-tmp-0123456789abcdef',
  'data/sessions/lookalike.json.0123456789abcdef01234567.tmp',
];
for (const rel of answers.lookalikes.slice(1)) {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), 'A file whose name only resembles a temp file.\n');
}
const history = await at('src/tui/prompt-history-store.mjs');
console.error('stores done');

// ---- usage ledger: the importer 1.4.5 runs at open, then more recorded requests of every route kind
const ledgerMod = await at('src/runtime/shared/llm/usage-ledger.mjs');
const importer = await at('src/runtime/shared/llm/usage-ledger-import.mjs');
const ledger = ledgerMod.getUsageLedger();
await importer.importUsageHistory(ledger, data);
const day = Date.UTC(2026, 5, 15, 12);
const rec = (extra) => ledgerMod.makeUsageRecord({ ts: day, status: 'completed', ...extra });
ledger.record([
  rec({ provider: 'openai', model: 'gpt-5', kind: 'api', sessionId: ids.lead, sourceType: 'lead', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 400, responseId: 'resp-1', ts: day }),
  rec({ provider: 'anthropic-oauth', model: 'claude-sonnet', kind: 'oauth', sessionId: ids.worker, ownerSessionId: ids.lead, sourceType: 'agent', inputTokens: 900, outputTokens: 120, account: 'default', responseId: 'resp-2', ts: day + 60_000 }),
  rec({ provider: 'mixdog-local', model: 'local-gguf', kind: 'local', sessionId: ids.idle, sourceType: 'lead', inputTokens: 50, outputTokens: 10, responseId: 'resp-3', ts: day + 120_000 }),
  rec({ provider: 'openai', model: 'gpt-5', kind: 'api', sessionId: ids.lead, sourceType: 'lead', inputTokens: 10, outputTokens: 0, status: 'failed', requestedModel: 'gpt-5-pro', responseId: 'resp-4', attempts: 2, ts: day + 180_000 }),
]);
ledger.recordQuota?.([{ provider: 'anthropic-oauth', account: 'default', label: '5h', ts: day, seenUntil: day + 3_600_000, usedPct: 42, resetAt: day + 18_000_000 }]);
await ledger.settleWrites();
console.error('ledger done');

// ---- the recording: the directory as the 1.4.5 code left it, before it answers anything. The process's own exit
// hooks run first (the prompt history flushes its coalesced writes there), as at the end of a real session.
history.appendPromptHistory(workdir, 'list the dir');
history.appendPromptHistory(workdir, 'what is in this image?');
process.emit('exit', 0);

ledgerMod.closeUsageLedgers?.();
await manager.flushPendingSessionSaves?.();
const NOT_RECORDED = new Set(['runtime', 'pgdata', 'pg.log', 'pg-spawn.lock']);
cpSync(home, join(out, '.mixdog'), { recursive: true, filter: (src) => !NOT_RECORDED.has(basename(src)) });

// ---- interrupted writes: each 1.4.5 writer that publishes through a temp file is killed at the step that would publish it,
// on a scratch copy of the recording (a kill leaves locks and half-state that are not part of the recording); the temp file
// it leaves is then placed in the recording where the writer put it.
const LEFTOVER_WRITERS = [
  { kind: 'goals', format: 'atomic-publish', writer: 'runtime-core/goal-storage.mjs:165' },
  { kind: 'human-gate', format: 'atomic-publish', writer: 'session/human-gate/store.mjs:49' },
  { kind: 'hooks', format: 'atomic-publish', writer: 'services/hook-bus/rule-file.mjs:74' },
  { kind: 'prompt-history', format: 'atomic-publish', writer: 'tui/prompt-history-store.mjs:64' },
  { kind: 'agents', format: 'atomic-publish', writer: 'workflow-agents-api/agent-editor.mjs:158' },
  { kind: 'bots', format: 'atomic-publish', writer: 'workflow-agents-api/agent-editor.mjs:158' },
  { kind: 'workflows', format: 'atomic-publish', writer: 'workflow-agents-api/workflow-packs.mjs:115' },
  { kind: 'skills', format: 'atomic-publish', writer: 'session-runtime/skills-api.mjs:27' },
  { kind: 'data-root', format: 'atomic-publish', writer: 'shared/config.mjs (mixdog-config.json)' },
  { kind: 'attachments', format: 'atomic-publish', writer: 'attachments/store.mjs:174' },
  { kind: 'session-save', format: 'session-save', writer: 'session/store.mjs:336' },
  { kind: 'compaction-pending', format: 'compaction-publish', writer: 'session/compaction-archive-capture.mjs:407' },
  { kind: 'compaction-archive', format: 'compaction-publish', writer: 'session/compaction-archive-capture.mjs:270' },
  { kind: 'lock-stage', format: 'lock-stage', writer: 'shared/file-lock.mjs:345' },
  { kind: 'owner-refresh', format: 'owner-refresh', writer: 'shared/singleton-owner.mjs:182' },
  { kind: 'set-aside', format: 'set-aside', writer: 'session/store/canonical-reader.mjs:407 (setAsideDamagedSessionRecord)' },
];
answers.leftovers = [];
answers.setAside = [];
const recordedHome = join(out, '.mixdog');
for (const { kind, format, writer } of LEFTOVER_WRITERS) {
  const scratch = `${root}.cut-${kind}`;
  rmSync(scratch, { recursive: true, force: true });
  const scratchHome = join(scratch, '.mixdog');
  cpSync(recordedHome, scratchHome, { recursive: true });
  const resultFile = join(scratch, 'cut-file');
  const env = { ...process.env, HOME: scratch, USERPROFILE: scratch, MIXDOG_HOME: scratchHome, MIXDOG_DATA_DIR: join(scratchHome, 'data') };
  const run = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'lib', 'migration-145-leftovers.mjs'), tree, scratchHome, kind, resultFile, ids.idle], { stdio: 'inherit', env });
  if (!existsSync(resultFile)) throw new Error(`the ${kind} writer left nothing (exit ${run.status})`);
  const cutFile = readFileSync(resultFile, 'utf8');
  const rel = relative(scratchHome, cutFile).split(sep).join('/');
  mkdirSync(dirname(join(recordedHome, rel)), { recursive: true });
  cpSync(cutFile, join(recordedHome, rel));
  rmSync(scratch, { recursive: true, force: true });
  (format === 'set-aside' ? answers.setAside : answers.leftovers).push({ format, writer, rel });
}
// A write can also still be in flight when the directory is copied (the idle-gap store writes behind): the process ended
// before it published, which is an interrupted write as well.
const planted = new Set([...answers.leftovers.map((leftover) => leftover.rel), ...answers.setAside.map((aside) => aside.rel), ...answers.lookalikes]);
for (const file of walkFiles(out)) {
  const rel = `${relative(recordedHome, file).split(sep).join('/')}`;
  if ((basename(rel).includes('.mixdog-tmp-') || basename(rel).endsWith('.tmp')) && !planted.has(rel)) {
    answers.leftovers.push({ format: 'in-flight', writer: 'a write in flight when 1.4.5 stopped (the idle-gap store writes behind; a session save cut by the killed turn)', rel });
  }
}
answers.leftovers.sort((a, b) => a.rel.localeCompare(b.rel));
// ---- what 1.4.5 answers for this data
const reader = await at('src/runtime/agent/orchestrator/session/store-summary-reader.mjs');
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const jsonSafe = (v) => JSON.parse(JSON.stringify(v ?? null));
const hideIds = (v) => v;
answers.threadList = jsonSafe(await reader.listStoredSessionSummaryPage({ limit: 50 }));
answers.threads = {};
for (const [name, id] of Object.entries(ids)) {
  answers.threads[name] = { id, transcript: jsonSafe(await reader.readStoredSessionTranscript(id)), record: jsonSafe(manager.loadSession ? await manager.loadSession(id) : null) };
}
answers.config = { file: JSON.parse(readFileSync(join(data, 'mixdog-config.json'), 'utf8')), quotaAutoResume: quota.quotaAutoResumeEnabled(), agentSection: jsonSafe(cfgMod.readSection('agent')), quotaSection: jsonSafe(cfgMod.readSection('quotaResume')) };
answers.accounts = {};
// What the product throws is its answer too (a dev-gated provider is not listed).
const answered = (fn) => {
  try {
    return jsonSafe(fn());
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
for (const provider of Object.keys(stores)) answers.accounts[provider] = answered(() => admin.listProviderAccounts(provider));
answers.oauth = {};
for (const [provider, { mod }] of Object.entries(stores)) answers.oauth[provider] = jsonSafe(mod.describe?.() ?? mod[Object.keys(mod).find((k) => /^describe/.test(k))]?.());
const reopened = ledgerMod.getUsageLedger();
answers.usage = {
  rollup: jsonSafe(await reopened.rollupAsync({})),
  sessions: jsonSafe(await reopened.sessionUsageAsync([ids.lead, ids.worker, ids.idle], [ids.lead])),
  requests: jsonSafe(await reopened.requestsAsync({})),
};
const usageApi = (await at('src/session-runtime/usage-stats-api.mjs')).createUsageStatsApi();
answers.usageStats = [];
for (const options of [{}, { view: 'hour' }, { days: 'all' }, { days: 7 }, { days: 30, source: 'conversation', modelLimit: 3 }]) {
  answers.usageStats.push({ options, answer: jsonSafe(await usageApi.getUsageStats(options)) });
}
answers.usageRequests = [];
for (const options of [{ view: 'day', limit: 20 }, { view: 'hour' }]) {
  answers.usageRequests.push({ options, answer: jsonSafe(await usageApi.getUsageRequests(options)) });
}
answers.agents = jsonSafe(api.listAgents().filter((a) => a.custom).map((a) => ({ id: a.id, label: a.label, kind: a.kind, route: a.route })));
answers.workflows = jsonSafe(api.listWorkflows());
answers.quotaResume = jsonSafe(quota.listQuotaResumeEntries());
answers.goals = jsonSafe(goalRuntime.storedSnapshot(ids.lead));
answers.humanGate = jsonSafe({ grants: await (await gate.humanGateStore()).listGrants(), audit: await (await gate.humanGateStore()).readAudit() });
answers.coreMemory = jsonSafe(core.readCoreMemoryFile(data));
answers.worktrees = jsonSafe(await worktrees.readRegistry());
answers.media = jsonSafe(media.listMediaAssets({}));
answers.projects = jsonSafe(projects.listProjects());
answers.promptHistory = jsonSafe(history.loadPromptHistory(workdir));
answers.pending = jsonSafe(pending._getPendingMessagesForSession(ids.lead));
writeFileSync(join(out, 'answers.json'), `${JSON.stringify(answers, null, 2)}\n`);
console.error('answers done');

// ---- provenance: the tag's commit and the hash of every recorded file
writeSetManifest(out, {
  set: 'migration-145',
  recorder: 'benchmarks/rust-core/recorders/record-migration-145.mjs',
  command: `node benchmarks/rust-core/recorders/record-migration-145.mjs --tree <git clone at ${RELEASE_TAG}> --out <fixture dir>`,
  identity,
});
console.error('manifest done');
