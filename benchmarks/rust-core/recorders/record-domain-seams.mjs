#!/usr/bin/env node
// The observable effects behind the `DomainSeams` inputs of `compose_domains`, through Node's real
// functions (nothing hand-written on the expectation side; inputs are the files each scenario lays down):
//   shell      setConfiguredShell / getConfiguredShell (shell-runtime.mjs)
//   developer  developerOption / developerOptionEnabled (developer-options.mjs): the provider each option gates
//   fonts      NOTO_FONT_DEFINITIONS, verifyFontBuffer, prepareOfficeFonts over a stubbed `fetch`
//              (os.platform is moved off win32/linux so no font is registered with the OS)
//   instructions  announce() of createInstructionFilesApi: the call order of the cache drop and the listeners
//   hooks      createStandaloneHookBus: emit + status() per scenario, summarizePayload / compactValue / summarizeRule
//   sessionLog readSessionLogMigration (doctor-session-log.mjs) over scenario data folders
//   marker     announceStoredStateChange('plugins'): the marker file bytes (pid, clock and uuid frozen)
// The only normalization: in the hook status and the font results the scenario's temp folder is written
// `<root>` and backslashes `/`, so the golden is the same on every OS. Clock, pid and uuid are frozen.
// Rust `mixdog-app-server-daemon` `domain_seams` must answer the same for the same inputs.
//
//   node benchmarks/rust-core/recorders/record-domain-seams.mjs [--tree <dir>]
//
// Output: native/core/fixtures/domain-seams/golden.json.
process.env.TZ = 'UTC';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { register, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const FROZEN = 1_700_000_000_000;
let clock = FROZEN;
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(clock);
    else super(...a);
  }
  static now() {
    return clock;
  }
}
globalThis.Date = FrozenDate;
const PID = 4242;
const UUID = '0b4f6a55-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
Object.defineProperty(process, 'pid', { value: PID, configurable: true });
crypto.randomUUID = () => UUID;
const realPlatform = os.platform;
const realHomedir = os.homedir;
syncBuiltinESMExports();

const root = mkdtempSync(join(tmpdir(), 'domain-seams-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
process.env.MIXDOG_DATA_DIR = dataDir;
delete process.env.MIXDOG_HOOKS_FILE;
const at = (path) => importFrom(tree, path);
const lay = (base, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  }
};
/** The scenario folder `root` becomes `<root>`, backslashes `/`. */
const portable = (value) => {
  const swap = (text) => text.split(root).join('<root>').replaceAll('\\', '/');
  if (typeof value === 'string') return swap(value);
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [swap(k), portable(v)]));
  return value;
};

// ---- shell ----
const shellRuntime = await at('src/runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs');
const SHELL_VALUES = ['   ', '  pwsh.exe ', 'pwsh.exe', '', ' C:\\Program Files\\Git\\bin\\bash.exe', undefined, null, 0, 'zsh'];
const shell = [];
for (const value of SHELL_VALUES) {
  shellRuntime.setConfiguredShell(value);
  shell.push({ set: value === undefined ? { undefined: true } : value, get: shellRuntime.getConfiguredShell() });
}

// ---- developer options ----
const dev = await at('src/runtime/shared/developer-options.mjs');
const optionIds = dev.developerSettingsView({}).sections.flatMap((section) => section.options.map((option) => option.id));
const STORED = [{}, null, [], 'x', { __ID__: true }, { __ID__: false }, { __ID__: 'true' }, { __ID__: 1 }, { other: true }];
const developer = [...optionIds, 'no-such-option'].map((id) => ({
  id,
  provider: dev.developerOption(id)?.provider ?? null,
  enabled: STORED.map((stored) => {
    const value = stored && typeof stored === 'object' && !Array.isArray(stored)
      ? Object.fromEntries(Object.entries(stored).map(([k, v]) => [k === '__ID__' ? id : k, v]))
      : stored;
    return { stored: value, enabled: dev.developerOptionEnabled(id, value) };
  }),
}));

// ---- fonts ----
const fontModule = await at('src/runtime/office/portable/font-provisioner.mjs');
const definitions = fontModule.NOTO_FONT_DEFINITIONS.map((def) => ({ ...def }));
const buffer = (text) => Buffer.from(text);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const GOOD = buffer('good-font-bytes');
const verify = [];
for (const [name, def, buf] of [
  ['ok', { family: 'F', bytes: GOOD.length, sha256: sha(GOOD) }, GOOD],
  ['size', { family: 'F', bytes: GOOD.length + 1, sha256: sha(GOOD) }, GOOD],
  ['sha', { family: 'F', bytes: GOOD.length, sha256: sha(buffer('other-font-bytes')) }, GOOD],
]) {
  let error = null;
  try {
    fontModule.verifyFontBuffer(def, buf);
  } catch (e) {
    error = e.message;
  }
  verify.push({ name, family: def.family, bytes: def.bytes, sha256: def.sha256, buffer: buf.toString(), error });
}
const home = join(root, 'home');
os.platform = () => 'freebsd';
os.homedir = () => home;
syncBuiltinESMExports();
const userFonts = join(home, '.local', 'share', 'fonts');
lay(userFonts, { 'Present.ttf': 'already here' });
const serve = { '/ok.ttf': { status: 200, body: GOOD }, '/missing.ttf': { status: 404, body: buffer('') }, '/short.ttf': { status: 200, body: buffer('short') }, '/wrong.ttf': { status: 200, body: buffer('wrong-font-byte') } };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const hit = serve[new URL(url).pathname];
  return new Response(hit.body, { status: hit.status });
};
const target = (id, file, bytes, digest) => ({ id, family: `Family ${id}`, fileName: file, registryName: `${id} (TrueType)`, url: `https://fonts.test/${file === 'Present.ttf' ? 'ok.ttf' : file}`, bytes, sha256: digest });
const targets = [
  target('present', 'Present.ttf', GOOD.length, sha(GOOD)),
  target('missing', 'missing.ttf', GOOD.length, sha(GOOD)),
  target('short', 'short.ttf', GOOD.length, sha(GOOD)),
  target('wrong', 'wrong.ttf', GOOD.length, sha(GOOD)),
  target('fresh', 'ok.ttf', GOOD.length, sha(GOOD)),
];
const prepared = await fontModule.prepareOfficeFonts({ targets });
globalThis.fetch = realFetch;
os.platform = realPlatform;
os.homedir = realHomedir;
syncBuiltinESMExports();
const fonts = {
  definitions,
  verify,
  prepare: {
    targets: targets.map((t) => ({ id: t.id, family: t.family, fileName: t.fileName, bytes: t.bytes, sha256: t.sha256, served: new URL(t.url).pathname })),
    served: Object.fromEntries(Object.entries(serve).map(([path, v]) => [path, { status: v.status, body: v.body.toString() }])),
    presentFile: 'Present.ttf',
    results: portable(prepared),
  },
};

// ---- instructions ----
const profile = await at('src/session-runtime/agent-profile-changes.mjs');
const { createInstructionFilesApi } = await at('src/session-runtime/workflow-agents-api/instruction-files.mjs');
const trace = [];
const subs = [
  profile.subscribeAgentProfileChanges(async () => {
    trace.push('listener-a');
    throw new Error('a runtime failed');
  }),
  profile.subscribeAgentProfileChanges(async () => {
    trace.push('listener-b');
  }),
];
const api = createInstructionFilesApi({ invalidateContextStatusCache: () => trace.push('context-status'), dataDir });
let saved = null;
let saveError = null;
try {
  saved = await api.saveInstructionFile({ group: 'delegation', id: 'focused', body: 'A changed instruction.' });
} catch (e) {
  saveError = e.message;
}
subs[1].unsubscribe();
const firstTrace = [...trace];
trace.length = 0;
await api.saveInstructionFile({ group: 'delegation', id: 'focused', body: 'Another changed instruction.' });
const instructions = { trace: firstTrace, saveError, userOverride: saved?.userOverride ?? null, afterUnsubscribe: [...trace] };
subs[0].unsubscribe();

// ---- hooks ----
const { createStandaloneHookBus } = await at('src/session-runtime/services/hook-bus.mjs');
const { createConfigLoader } = await at('src/session-runtime/services/hook-bus/config-loader.mjs');
const { hookRulesPath } = await at('src/session-runtime/services/hook-bus/config.mjs');
const payloadModule = await at('src/session-runtime/services/hook-bus/payload.mjs');
const rulesModule = await at('src/session-runtime/services/hook-bus/rules.mjs');
const PAYLOADS = [
  {},
  { session_id: 's1', tool_name: 'bash', provider: 'p', model: 'm', prompt: 'a   b\n c', reason: 'r', error: 'e', elapsedMs: 12 },
  { sessionId: 'x', name: 'n', model: 'only-model' },
  { provider: 'only-provider', elapsedMs: 0 },
  { prompt: `${'p '.repeat(50)}`, reason: 'r'.repeat(200), error: 'é'.repeat(130) },
  { sessionId: 0, name: '', prompt: 0, elapsedMs: null },
  { apiKey: 'k', Token: 't', nested: { password: 'p', ok: 1, list: [1, 2, 3, 4, 5, 6, 7, 8, 9, { secret: 's' }] }, text: 'x'.repeat(200), flag: true, none: null, n: 1.5 },
  { a1: 1, a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: 8, a9: 9, a10: 10, a11: 11, a12: 12, a13: 13 },
];
const RULES = [
  {},
  { tool: 'bash', action: 'deny', match: 'rm', cwd: '/x', reason: 'no' },
  { name: 'edit', decision: 'ask', contains: 'x', message: 'm', enabled: false, patch: { token: 'x', path: 'y' } },
  { tools: ['a', 'b'], args: { key: 'v', n: 2 }, action: '', decision: 'modify', enabled: 0 },
  { tool: null, name: 'n2', match: null, contains: 'c', reason: '', message: 'mm' },
];
const hookPayloads = PAYLOADS.map((payload) => ({ payload, summary: payloadModule.summarizePayload(payload), compact: payloadModule.compactValue(payload) }));
const hookRules = RULES.map((rule, index) => ({ rule, index, summary: rulesModule.summarizeRule(rule, index) }));
const stdHook = (command, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
const SCENARIOS = [
  {
    name: 'legacy-rules',
    files: { 'data/hooks.json': JSON.stringify([{ tool: 'bash', action: 'deny', match: 'rm -rf', reason: 'no' }, { name: 'edit', decision: 'ask', enabled: false, patch: { token: 'x', path: 'y' } }]) },
    events: [['runtime:start', { sessionId: 'boot' }],['tool:deny', { name: 'bash', reason: 'r' }], ['tool:deny', { name: 'bash', reason: 'r' }], ['my:event', { prompt: 'hello   world' }]],
  },
  {
    name: 'standard-merge-order',
    files: {
      'project/.mixdog/hooks.json': JSON.stringify({ hooks: { Stop: [stdHook('echo a')], PreToolUse: [stdHook('echo b', 'Bash')], Bad: 'nope' } }),
      'data/hooks.json': JSON.stringify({ hooks: { SessionStart: [stdHook('echo c')], Stop: [stdHook('echo d')] } }),
    },
    events: [['PreToolUse', { tool_name: 'Bash' }], ['tool:ask', { name: 'x' }]],
  },
  {
    name: 'disabled',
    files: { 'data/hooks.json': JSON.stringify({ disableAllHooks: true, hooks: { Stop: [stdHook('echo a')] } }) },
    events: [],
  },
  { name: 'empty', files: {}, events: [['turn:start', { sessionId: 's' }]] },
];
const hookScenarios = [];
for (const scenario of SCENARIOS) {
  const base = join(root, `hooks-${scenario.name}`);
  mkdirSync(join(base, 'project'), { recursive: true });
  mkdirSync(join(base, 'data'), { recursive: true });
  lay(base, scenario.files);
  const baseRoot = base;
  process.chdir(join(base, 'project'));
  const bus = createStandaloneHookBus({ dataDir: join(base, 'data') });
  for (const [name, payload] of scenario.events) bus.emit(name, payload);
  const status = bus.status();
  const swap = (text) => text.split(baseRoot).join('<root>').replaceAll('\\', '/');
  const portableHere = (value) => {
    if (typeof value === 'string') return swap(value);
    if (Array.isArray(value)) return value.map(portableHere);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [swap(k), portableHere(v)]));
    return value;
  };
  // The config read of `status()` writes a `hook:error` per parse problem whose text carries the folder's
  // path, and the log clips that text by length, so its clipped form depends on where the folder is. The
  // log's entries are therefore split: every entry but those, `recentNames` for all of them in order, and
  // the loader's own emissions (the real config loader over the same files, unclipped) in `loaderEmits`.
  const portableStatus = portableHere(status);
  const recentNames = portableStatus.recent.map((entry) => entry.name);
  portableStatus.recent = portableStatus.recent.filter((entry) => entry.name !== 'hook:error');
  const loaderEmits = [];
  const loader = createConfigLoader({
    dataDir: join(base, 'data'),
    rulesPath: hookRulesPath(join(base, 'data')),
    emit: (name, payload) => loaderEmits.push({ name, payload: portableHere(payload) }),
    pendingPatches: () => null,
  });
  loader.loadConfig(join(base, 'project'));
  hookScenarios.push({
    name: scenario.name,
    files: scenario.files,
    events: scenario.events,
    countOrder: Object.keys(status.counts),
    recentNames,
    loaderEmits,
    status: portableStatus,
  });
}
process.chdir(root);
const hooks = { payloads: hookPayloads, rules: hookRules, scenarios: hookScenarios };

// ---- session log ----
const { readSessionLogMigration } = await at('src/tui/app/doctor-session-log.mjs');
const progress = (extra) => JSON.stringify({ v: 1, migrationId: 'json-to-log-v1', cursor: null, complete: false, updatedAt: 5, skipped: {}, ...extra });
const LOG_SCENARIOS = [
  { name: 'nothing', files: {} },
  { name: 'no-progress-legacy-pending', files: { 'sessions/a.json': '{}', 'sessions/b.json': '{}' } },
  { name: 'complete', files: { 'session-log-migration.json': progress({ complete: true }), 'sessions/a.log.jsonl': '', 'sessions/b.log.jsonl': '' } },
  {
    name: 'skips',
    files: {
      'session-log-migration.json': progress({ skipped: { a: { reason: 'unreadable' }, b: { reason: 'busy' }, z9: { reason: 'failed' } } }),
      'sessions/a.json': '{}', 'sessions/b.json': '{}', 'sessions/c.json': '{}', 'sessions/c.log.jsonl': '', 'sessions/d.json': '{}',
      'sessions/bad name.json': '{}', 'sessions/e.log.jsonl.torn-1-ab': '', 'sessions/note.txt': '',
    },
  },
  { name: 'never-started', files: { 'session-log-migration.json': progress({ updatedAt: 0 }), 'sessions/a.json': '{}' } },
  { name: 'wrong-version', files: { 'session-log-migration.json': JSON.stringify({ v: 2 }) } },
  { name: 'not-json', files: { 'session-log-migration.json': '{broken' } },
  { name: 'wrong-id', files: { 'session-log-migration.json': progress({ migrationId: 'other' }) } },
];
const sessionLog = [];
for (const scenario of LOG_SCENARIOS) {
  const base = join(root, `log-${scenario.name}`);
  mkdirSync(base, { recursive: true });
  lay(base, scenario.files);
  sessionLog.push({ name: scenario.name, files: scenario.files, status: await readSessionLogMigration(base) });
}

// ---- plugins marker ----
const config = await at('src/runtime/shared/config.mjs');
const MARKER_CASES = [
  { name: 'none', prior: null },
  { name: 'keeps-others', prior: '{"openai":"t0","#deleted":"d0"}' },
  { name: 'replaces-own', prior: '{"#plugins":"old","openai":"t0"}' },
  { name: 'array-starts-over', prior: '[1]' },
];
const marker = { pid: PID, now: FROZEN, uuid: UUID, cases: [] };
for (const scenario of MARKER_CASES) {
  const base = join(root, `marker-${scenario.name}`);
  mkdirSync(base, { recursive: true });
  process.env.MIXDOG_DATA_DIR = base;
  if (scenario.prior !== null) writeFileSync(join(base, 'mixdog-secrets-changed.json'), scenario.prior);
  config.announceStoredStateChange('plugins');
  marker.cases.push({ name: scenario.name, prior: scenario.prior, file: readFileSync(join(base, 'mixdog-secrets-changed.json'), 'utf8') });
}

const finalDir = join(FIXTURES_ROOT, 'domain-seams');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-domain-seams.mjs';
writeJson(join(stage, 'golden.json'), { frozenNow: FROZEN, shell, developer, fonts, instructions, hooks, sessionLog, marker });
writeSetManifest(stage, { set: 'domain-seams', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
