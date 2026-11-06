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
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \\
//     benchmarks/rust-core/recorders/record-domain-seams.mjs [--tree <dir>]
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

// Two private functions the recording needs are exposed by one appended export line each (the module
// itself is not changed): plugin-admin's `runGit` and the notifier's `createNativePresenter`.
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    const loaded = await next(url, context);
    const add = url.endsWith('/src/session-runtime/services/plugin-admin.mjs')
      ? '\\nexport { runGit as __runGit };\\n'
      : url.endsWith('/apps/desktop/src/main/desktop-turn-notifier.ts')
        ? '\\nexport { createNativePresenter as __createNativePresenter };\\n'
        : '';
    return add ? { ...loaded, source: String(loaded.source) + add } : loaded;
  }`)}`
);

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
// compactValue keeps the FIRST 12 keys in insertion order; `writeJson` keeps that order in the payload and its compaction.
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

// ---- remote: relay URL, access settings, host name, pair-code manager ----
const relayDevice = await at('apps/desktop/src/main/remote-relay-device.ts');
const relayUrl = [undefined, '', '   ', '0', 'false', 'OFF', ' Off ', 'wss://relay.example', ' wss://relay.example/path?x=1 ', 'ws://127.0.0.1:9800', 'ws://localhost', 'ws://[::1]:9', 'ws://relay.example', 'https://relay.example', 'not a url', 'wss://user:pw@relay.example', 'wss://u@relay.example'].map((raw) => {
  const env = raw === undefined ? {} : { MIXDOG_RELAY_URL: raw };
  try {
    return { env: raw === undefined ? null : raw, url: relayDevice.resolveRelayUrl(env) };
  } catch (e) {
    return { env: raw === undefined ? null : raw, error: e.message };
  }
});
const { createRemoteAccessSettingsStore } = await at('apps/desktop/src/main/remote-access-settings.ts');
const settingsScenarios = [
  { name: 'fresh', files: {} },
  { name: 'activated', files: { 'remote-activated.json': '{"activatedAt":1}' } },
  { name: 'legacy-evidence', files: { 'relay-device.json': '{}' } },
  { name: 'trust-evidence', files: { 'remote-client-trust.json': '{}' } },
  { name: 'switched-off', files: { 'remote-activated.json': '{}', 'remote-access-settings.json': '{"enabled":false}' } },
  { name: 'named', files: { 'remote-access-settings.json': '{"name":"My PC","enabled":true}' } },
  { name: 'empty-name', files: { 'remote-access-settings.json': '{"name":""}' } },
  { name: 'long-name-kept', files: { 'remote-access-settings.json': JSON.stringify({ name: 'n'.repeat(100) }) } },
  { name: 'damaged', files: { 'remote-access-settings.json': '{broken' } },
  { name: 'wrong-types', files: { 'remote-access-settings.json': '{"enabled":"yes","name":5}' } },
];
const settingsReads = [];
for (const scenario of settingsScenarios) {
  const base = join(root, `access-${scenario.name}`);
  mkdirSync(base, { recursive: true });
  lay(base, scenario.files);
  const store = createRemoteAccessSettingsStore(base, () => 'HOST-FIXED');
  const view = await store.read();
  settingsReads.push({ name: scenario.name, files: scenario.files, view, disabled: await store.disabled(), aliases: await store.deviceAliases(), after: (await import('node:fs')).readdirSync(base).sort() });
}
const mutBase = join(root, 'access-mutations');
mkdirSync(mutBase, { recursive: true });
const mutStore = createRemoteAccessSettingsStore(mutBase, () => 'HOST-FIXED');
const readSettingsFile = () => {
  try {
    return JSON.parse(readFileSync(join(mutBase, 'remote-access-settings.json'), 'utf8'));
  } catch {
    return null;
  }
};
const settingsMutations = [];
const mutate = async (op, args, run) => {
  const result = await run();
  settingsMutations.push({ op, args, result, file: readSettingsFile() });
};
await mutate('setEnabled', [true], () => mutStore.setEnabled(true));
await mutate('setName', ['  My Desk  '], () => mutStore.setName('  My Desk  '));
await mutate('setName', ['x'.repeat(70)], () => mutStore.setName('x'.repeat(70)));
await mutate('setName', [''], () => mutStore.setName(''));
await mutate('setDeviceAlias', ['c1', '  Phone  '], () => mutStore.setDeviceAlias('c1', '  Phone  '));
await mutate('setDeviceAlias', ['c2', 'a'.repeat(90)], () => mutStore.setDeviceAlias('c2', 'a'.repeat(90)));
await mutate('setDeviceAlias', ['c1', ''], () => mutStore.setDeviceAlias('c1', ''));
await mutate('setEnabled', [false], () => mutStore.setEnabled(false));
const hostName = { hostname: os.hostname(), computerName: process.env.COMPUTERNAME ?? null, platform: process.platform };
const { createPairCodeManager } = await at('apps/desktop/src/main/remote-pair-code.ts');
const PAIR_STEPS = [
  { op: 'ensure', at: 0 },
  { op: 'ensure', at: 1000 },
  { op: 'issued', at: 2000, envelope: { ok: true, code: '123456', expiresInMs: 600000, lease: '$last' } },
  { op: 'ensure', at: 3000 },
  { op: 'used', at: 4000, envelope: { lease: '$other' } },
  { op: 'ensure', at: 4001 },
  { op: 'used', at: 5000, envelope: { lease: '$last' } },
  { op: 'ensure', at: 5001 },
  { op: 'issued', at: 6000, envelope: { ok: true, code: '654321', expiresInMs: 100000, lease: '$other' } },
  { op: 'issued', at: 6100, envelope: { ok: true, code: '654321', expiresInMs: 100000, lease: '$last' } },
  { op: 'ensure', at: 6500 },
  { op: 'ensure', at: 106100 },
  { op: 'release', at: 107000 },
  { op: 'release', at: 108000 },
  { op: 'ensure', at: 109000 },
  { op: 'connected', at: 109100 },
];
let pairNow = 0;
let leaseCounter = 0;
const pairSent = [];
const pair = createPairCodeManager({
  sendEnvelope: (payload) => {
    pairSent.push(payload);
    return true;
  },
  hostName: () => 'PC-FIXED',
  now: () => pairNow,
  newLease: () => `lease-${++leaseCounter}`,
});
let lastLease = null;
const pairSteps = [];
for (const step of PAIR_STEPS) {
  pairNow = step.at;
  pairSent.length = 0;
  const envelope = step.envelope && { ...step.envelope, lease: step.envelope.lease === '$last' ? lastLease : 'someone-else' };
  let result;
  if (step.op === 'ensure') result = pair.ensure();
  else if (step.op === 'issued') pair.onIssued(envelope);
  else if (step.op === 'used') pair.onUsed(envelope);
  else if (step.op === 'release') pair.release();
  else pair.onConnected();
  const sent = pairSent.map((payload) => {
    if (payload.lease) lastLease = payload.lease;
    return { ...payload, ...(payload.lease ? { lease: '$last' } : {}) };
  });
  pairSteps.push({ ...step, result: result ?? null, sent });
}
// The lease a manager mints when none is injected: what a relay sees.
const sample = [];
createPairCodeManager({ sendEnvelope: (p) => (sample.push(p), true), hostName: 'h' }).ensure();
const remote = {
  relayUrl,
  settings: { reads: settingsReads, mutations: settingsMutations },
  hostName,
  pairCode: { hostName: 'PC-FIXED', steps: pairSteps, defaultLease: { length: sample[0].lease.length, hex: /^[0-9a-f]+$/.test(sample[0].lease) } },
};

// ---- ProcessGit: plugin-admin's runGit ----
const { __runGit: runGit } = await at('src/session-runtime/services/plugin-admin.mjs');
const savedGitDir = process.env.GIT_DIR;
delete process.env.GIT_DIR; // the manifest step points git at the repository; the scenarios must not
const gitBase = join(root, 'git');
mkdirSync(gitBase, { recursive: true });
const subst = (text) => text.replaceAll('<root>', gitBase);
const GIT_STEPS = [
  { args: ['init', '<root>/source'] },
  { args: ['-C', '<root>/source', 'config', 'user.name', 'n'] },
  { args: ['-C', '<root>/source', 'config', 'core.autocrlf', 'false'] },
  { args: ['-C', '<root>/source', 'rev-parse', '--is-inside-work-tree'] },
  { args: ['clone', '<root>/none', '<root>/dest'] },
  { args: ['nosuchcommand'] },
  { args: ['-C', '<root>/source', 'diff', '--quiet'] },
  { args: ['-C', '<root>/source', 'status', '--porcelain'], before: { 'source/f.txt': 'one\n' } },
  { args: ['-C', '<root>/source', 'add', 'f.txt'] },
  { args: ['-C', '<root>/source', '-c', 'user.name=a', '-c', 'user.email=b@c', 'commit', '-q', '-m', 'm'] },
  { args: ['-C', '<root>/source', 'status', '--porcelain'], before: { 'source/f.txt': 'two\n' } },
  { args: ['-C', '<root>/source', 'diff', '--quiet'] },
];
const git = [];
for (const step of GIT_STEPS) {
  if (step.before) lay(gitBase, step.before);
  const args = step.args.map(subst);
  let out;
  try {
    out = { ok: runGit(args) };
  } catch (e) {
    out = { error: e.message };
  }
  git.push({ args: step.args, before: step.before ?? null, ...portableOutcome(out) });
}
function portableOutcome(outcome) {
  const swap = (text) => text.split(gitBase).join('<root>').split(gitBase.replaceAll('\\', '/')).join('<root>').replaceAll('\\', '/');
  return Object.fromEntries(Object.entries(outcome).map(([k, v]) => [k, swap(v)]));
}

if (savedGitDir !== undefined) process.env.GIT_DIR = savedGitDir;

// ---- node_runtime: the doctor's `{version, engines}` ----
const packageText = readFileSync(join(tree, 'package.json'), 'utf8');
const nodeRuntime = { packageJson: packageText, version: process.versions.node, engines: JSON.parse(packageText).engines?.node ?? null };

// ---- notification_clicks: the notifier's click report ----
const { __createNativePresenter: createNativePresenter } = await at('apps/desktop/src/main/desktop-turn-notifier.ts');
const reported = [];
const handlers = new Map();
const fake = { on: (name, fn) => handlers.set(name, fn), show: () => {}, close: () => {} };
const opened = [];
const { present } = createNativePresenter({ createNotification: () => fake, openSession: (id) => opened.push(id) }, (event, sessionId, details = {}) => reported.push({ event, sessionId, details }));
present('sess_click', { title: 't', body: 'b' });
handlers.get('click')();
// index.ts names the diagnostic `turn-notification-${event}`: the prefix is read from its source.
const indexSource = readFileSync(join(tree, 'apps/desktop/src/main/index.ts'), 'utf8');
const prefix = /diagnostic: \(event, details\) => \{\s*diagnostics\?\.write\(`([^`$]*)\$\{event\}`/.exec(indexSource)[1];
const clicks = { reported, opened, prefix };

const finalDir = join(FIXTURES_ROOT, 'domain-seams');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-domain-seams.mjs';
writeJson(join(stage, 'golden.json'), { frozenNow: FROZEN, shell, developer, fonts, instructions, hooks, sessionLog, marker, remote, git, nodeRuntime, clicks });
writeSetManifest(stage, { set: 'domain-seams', recorder, command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
