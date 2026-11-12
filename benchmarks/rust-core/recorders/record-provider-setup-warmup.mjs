#!/usr/bin/env node
// What a reader of the provider setup sees across a cold start: the REAL Node `createSetupApi().getProviderSetup`
// over the REAL `createProviderUsage().cachedProviderSetup`, with a scripted `providerSetup` builder and keychain
// prewarm. The first read (prewarm pending) answers the no-secrets snapshot flagged `pendingSecrets`; the
// scheduled warm-up builds the authoritative setup into the cache, and the NEXT read answers it. Node pushes
// nothing: its reader pulls. Rust's pushed `providerSetup` section must therefore hold the second read's value once the
// warm-up has filled the cache.
//
//   node benchmarks/rust-core/recorders/record-provider-setup-warmup.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/provider-setup-warmup/golden.json. No network, no credential.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'provider-setup-warmup-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'provider-setup-warmup-home-'));
const { FIXTURES_ROOT, REPO_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, recordingProvenance, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-setup-warmup');
const stage = stageSet(finalDir);
// The Node commit the recording is exact for; the manifest compares the loaded tree against it.
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const recorder = 'benchmarks/rust-core/recorders/record-provider-setup-warmup.mjs';
const { createSetupApi } = await importFrom(tree, 'src/session-runtime/provider-auth/setup.mjs');
const { createProviderUsage } = await importFrom(tree, 'src/session-runtime/provider-usage.mjs');
const { createProviderReadiness } = await importFrom(tree, 'src/session-runtime/provider-readiness.mjs');

// What `providerSetup(displayConfig(), options)` builds: the snapshot reads no secret and detects no local runtime.
const row = (id, extra = {}) => ({ id, name: id, authenticated: false, ...extra });
const BUILT = {
  quick: { api: [row('openai', { env: true })], oauth: [row('anthropic-oauth')], local: [row('ollama')] },
  full: {
    api: [row('openai', { env: true, authenticated: true, status: 'Connected', stored: true })],
    oauth: [row('anthropic-oauth', { authenticated: true, status: 'Connected', plan: 'max' })],
    local: [row('ollama', { authenticated: true, detected: true, status: 'Detected' })],
  },
};

const readiness = createProviderReadiness({
  rt: { config: { providers: {} } },
  keychain: { prewarmSecrets: async () => {} },
  getReg: () => ({}),
  getWarmProviderModelCache: () => () => {},
});
const builds = [];
let prewarmReady = false;
const prewarm = Promise.withResolvers();
let warmup = null;
let usage;
usage = createProviderUsage({
  caches: readiness.providerUsageCaches,
  getReg: () => ({ getProvider: () => ({}) }),
  displayConfig: () => ({}),
  providerSetup: async (_config, options = {}) => {
    builds.push({ detectLocal: options.detectLocal !== false, checkSecrets: options.checkSecrets !== false });
    return structuredClone(options.checkSecrets === false ? BUILT.quick : BUILT.full);
  },
  createUsageDashboard: async () => ({}),
  consumeOpenAICodexResetCredit: async () => ({ outcome: 'reset' }),
  isCloseRequested: () => false,
  getProviderSetupWarmupTimer: () => warmup,
  scheduleProviderSetupWarmup: () => {
    // `warmup/provider-warmups.mjs`: the timer fires `cachedProviderSetup()` once the keychain is ready.
    warmup = prewarm.promise.then(() => usage.cachedProviderSetup({})).finally(() => { warmup = null; });
  },
});
const api = createSetupApi({
  awaitKeychainPrewarm: () => prewarm.promise,
  isKeychainPrewarmReady: () => prewarmReady,
  hasProviderSetupCached: () => Boolean(readiness.providerUsageCaches.providerSetupCache?.setup),
  reloadFullConfig: () => {},
  cachedProviderSetup: (options) => usage.cachedProviderSetup(options),
  getUsageDashboard: async () => ({}),
  consumeCodexRateLimitResetCredit: async () => ({}),
  collectProviderModels: async () => [],
});

const reads = [];
reads.push({ when: 'cold, keychain prewarm pending', value: await api.getProviderSetup({}) });
prewarmReady = true;
prewarm.resolve();
await warmup;
reads.push({ when: 'after the warm-up', value: await api.getProviderSetup({}) });
writeJson(join(stage, 'golden.json'), { built: BUILT, builds, reads });
writeSetManifest(stage, { set: 'provider-setup-warmup', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, identityRef: NODE_COMMIT, extra: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']) });
commitStage(stage, finalDir);