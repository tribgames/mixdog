#!/usr/bin/env node
// `providerSetup` in the model-proxy client mode (session-runtime/services/provider-admin.mjs
// `modelProxyProviderSetup`): an SSH server holds no model credentials, so the setup projects only
// the PC's advertised availability. The REAL function runs with `MIXDOG_MODEL_PROXY=client` and the
// real `ModelProxyChannel` answering `providerConfig` from a publisher stub (the way the product's
// own test drives it); one scenario has no PC connected. Rust
// `mixdog_core_domains::domains::ai_account::provider_setup::model_proxy_provider_setup` must give the
// same document, key order included, from the advertised providers.
//
//   node benchmarks/rust-core/recorders/record-model-proxy-setup.mjs [--tree <dir>]
//
// Output: native/core/fixtures/model-proxy-setup/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'model-proxy-setup');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-model-proxy-setup.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'proxy-setup-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'proxy-setup-home-'));
process.env.MIXDOG_MODEL_PROXY = 'client';
const at = (path) => importFrom(tree, path);
const channelMod = await at('src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs');
const providerMod = await at('src/runtime/agent/orchestrator/providers/model-proxy-provider.mjs');
const { providerSetup } = await at('src/session-runtime/services/provider-admin.mjs');
const { ModelProxyChannel, MODEL_PROXY_OPERATIONS, encodeModelProxyWire, installModelProxyChannel } = channelMod;

const id = (n) => `custom-${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const SCENARIOS = [
  { name: 'every kind of provider', providers: {
    openai: { enabled: true }, 'openai-oauth': { enabled: true, authState: 'present' }, 'anthropic-oauth': { enabled: false },
    'cursor-oauth': { enabled: true }, 'mixdog-local': { enabled: true }, xai: { enabled: false, authState: 'present' },
  } },
  { name: 'auth states', providers: {
    openai: { enabled: true, authState: 'present' }, anthropic: { enabled: true, authState: 'absent' }, gemini: { enabled: true, authState: 'unreadable' },
    deepseek: { enabled: false, authState: 'present' }, xai: { enabled: false, authState: 'absent' }, openrouter: { enabled: false, authState: 'unreadable' },
    'grok-oauth': { enabled: true, authState: 'bogus' },
  } },
  { name: 'old desktops advertise only enabled', providers: { openai: { enabled: true }, anthropic: { enabled: false }, 'openai-oauth': { enabled: true } } },
  { name: 'enabled must be exactly true', providers: { openai: { enabled: 'yes' }, anthropic: { enabled: 1 }, gemini: {}, xai: null } },
  { name: 'secrets are never projected', providers: { 'openai-oauth': { enabled: true, access_token: 'must-not-leak', accountId: 'private-account' } } },
  { name: 'custom providers', providers: {
    [id(1)]: { type: 'custom', name: ' Alpha ', enabled: true, authState: 'present', hiddenModels: ['m1', 5, 'm2'] },
    [id(2)]: { type: 'custom', enabled: false },
    [id(3)]: { type: 'custom', name: '   ', enabled: true },
    [id(4)]: { type: 'openai', name: 'not custom', enabled: true },
    'custom-not-a-uuid': { type: 'custom', enabled: true },
    [id(5)]: null,
  } },
  { name: 'custom hidden models of a custom provider that is off', providers: { [id(1)]: { type: 'custom', name: 'Off', enabled: false, authState: 'present', hiddenModels: 'nope' } } },
  { name: 'the local provider', providers: { 'mixdog-local': { enabled: false } } },
  { name: 'nothing advertised', providers: {} },
  { name: 'providers the page does not list', providers: { nothing: { enabled: true }, 'devin-oauth': { enabled: true }, 'antigravity-oauth': { enabled: true } } },
];

const results = [];
let channel = new ModelProxyChannel();
let uninstall = installModelProxyChannel(channel);
let current = {};
const attach = (ch) =>
  ch.attachPublisher((snapshot) => {
    for (const { id: requestId } of snapshot.requests) {
      const claim = ch.handleOperation(MODEL_PROXY_OPERATIONS.claim, [requestId]);
      if (!claim) continue;
      queueMicrotask(() => ch.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [requestId, true, encodeModelProxyWire({ providers: current, ready: true }), null]));
    }
  });
const keepAlive = setInterval(() => {}, 1000);
const detach = attach(channel);
for (const scenario of SCENARIOS) {
  current = scenario.providers;
  providerMod._resetModelProxyProviderConfigForTest();
  const result = await providerSetup({ providers: { openai: { enabled: true } } }, { force: true });
  results.push({ name: scenario.name, providers: scenario.providers, result: JSON.parse(JSON.stringify(result)) });
}
detach();
uninstall();
// No PC connected: the read waits its second, then the setup says so.
channel = new ModelProxyChannel();
uninstall = installModelProxyChannel(channel);
providerMod._resetModelProxyProviderConfigForTest();
const unavailable = JSON.parse(JSON.stringify(await providerSetup({}, { force: true })));
results.push({ name: 'no PC connected', providers: null, result: unavailable });
uninstall();
clearInterval(keepAlive);
writeJson(join(stage, 'golden.json'), { scenarios: results });
writeSetManifest(stage, { set: 'model-proxy-setup', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
process.exit(0);
