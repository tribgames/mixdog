#!/usr/bin/env node
// What the cache-warm account gate (providers/cache-warm-admission.mjs) reads from the process
// (WP-AI-CORE): `providerAvailable(name)` over the stored Developer options, and
// `readCachedOAuthUsageSnapshot({ provider, model: '' })` over the usage cache file. The quota
// resume pause is `quotaResumeEntry(sessionId)`, recorded by the quota-resume twin. The REAL
// functions, a sandboxed data directory, no network.
//
//   node benchmarks/rust-core/recorders/record-warm-gate-seams.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/warm-gate-seams/golden.json.
//  - providerSwitch: for each stored `agent.developer` value, each provider name and the
//    `MIXDOG_MODEL_PROXY` mode, whether the provider is available.
//  - usageSnapshot: for each usage cache file (snapshots aged `ageMs` at the moment of writing,
//    each marked by its first window's `usedPct`), the snapshot served for a provider, as the gate
//    reads it: the first window's `usedPct` (null when none is served or it has no windows) and
//    the age of its `cachedAt`.
// Every user directory is a fresh temp one BEFORE any product module loads.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'warm-gate-seams-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
});
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'warm-gate-seams');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-warm-gate-seams.mjs';
const config = await importFrom(tree, 'src/runtime/shared/config.mjs');
const availability = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/provider-availability.mjs');
const usage = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/oauth-usage.mjs');

// ---- providerSwitch -----------------------------------------------------------------------------
const NAMES = ['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth', 'gemini', 'grok-oauth', 'antigravity-oauth', 'cursor-oauth', 'devin-oauth', 'mimo-oauth', 'opencode-go-oauth', 'muse-code-oauth', 'command-code-oauth', 'custom-x', ''];
const DEVELOPERS = [
  { absent: true },
  { value: {} },
  { value: { antigravityOAuth: true, cursorOAuth: true, devinOAuth: true, mimoOAuth: true } },
  { value: { antigravityOAuth: true } },
  { value: { cursorOAuth: true } },
  { value: { devinOAuth: true } },
  { value: { mimoOAuth: true } },
  { value: { cursorOAuth: false, mimoOAuth: true } },
  { value: { cursorOAuth: 'true' } },
  { value: { cursorOAuth: 1, devinOAuth: null } },
  { value: ['cursorOAuth'] },
  { value: 'x' },
  { value: { allowAllActions: true } },
];
const providerSwitch = [];
for (const developer of DEVELOPERS) {
  config.updateSection('agent', (agent) => {
    const next = { ...agent };
    delete next.developer;
    if (!developer.absent) next.developer = developer.value;
    return next;
  });
  config.invalidateConfigReadCache();
  for (const proxyClient of [false, true]) {
    if (proxyClient) process.env.MIXDOG_MODEL_PROXY = 'client';
    else delete process.env.MIXDOG_MODEL_PROXY;
    providerSwitch.push({
      developer: developer.absent ? { absent: true } : { value: developer.value },
      proxyClient,
      available: Object.fromEntries(NAMES.map((name) => [name, availability.providerAvailable(name)])),
    });
  }
}
delete process.env.MIXDOG_MODEL_PROXY;

// ---- usageSnapshot ------------------------------------------------------------------------------
const MIN = 60_000;
const FUTURE = 4_000_000_000_000;
const window = (usedPct, resetAt = FUTURE) => ({ label: '5H', usedPct, resetAt });
// `route` is the cache key: the provider alone (account `default`), or `provider\u0002account`.
const snap = (usedPct, ageMs, extra = {}) => ({ provider: 'anthropic-oauth', quotaWindows: [window(usedPct)], ageMs, ...extra });
const SCENARIOS = [
  { name: 'no_file', routes: null },
  { name: 'empty_file', routes: {} },
  { name: 'fresh_provider_snapshot', routes: { 'anthropic-oauth': snap(11, 1000) } },
  { name: 'older_than_the_disk_ttl', routes: { 'anthropic-oauth': snap(12, 11 * MIN) } },
  { name: 'just_inside_the_disk_ttl', routes: { 'anthropic-oauth': snap(13, 9 * MIN) } },
  { name: 'the_route_key_for_an_empty_model', routes: { 'anthropic-oauth\u0001': snap(14, 2000) } },
  { name: 'the_newest_of_the_providers_account_snapshots', routes: { 'anthropic-oauth\u0002acct-a': snap(15, 5000), 'anthropic-oauth\u0002acct-b': snap(16, 2000), 'anthropic-oauth\u0002acct-c': snap(17, 9000) } },
  { name: 'a_model_route_of_the_provider_counts', routes: { 'anthropic-oauth\u0001claude-x': snap(18, 3000) } },
  { name: 'the_provider_key_wins_over_the_newest', routes: { 'anthropic-oauth': snap(19, 8000), 'anthropic-oauth\u0002acct-b': snap(20, 1000) } },
  { name: 'another_providers_snapshot_is_not_served', routes: { 'openai-oauth': snap(21, 1000) } },
  { name: 'every_window_already_reset', routes: { 'anthropic-oauth': { provider: 'anthropic-oauth', quotaWindows: [window(22, 1_000)], ageMs: 1000 } } },
  { name: 'a_snapshot_with_no_windows', routes: { 'anthropic-oauth': { provider: 'anthropic-oauth', quotaWindows: [], ageMs: 1000 } } },
  { name: 'a_balance_only_snapshot', routes: { 'anthropic-oauth': { provider: 'anthropic-oauth', balance: { remainingUsd: 5 }, ageMs: 1000 } } },
  { name: 'no_cachedAt', routes: { 'anthropic-oauth': { provider: 'anthropic-oauth', quotaWindows: [window(23)] } } },
  { name: 'the_provider_name_is_lower_cased', provider: 'Anthropic-OAuth', routes: { 'anthropic-oauth': snap(24, 1000) } },
];
const cacheFile = join(dirs.data, 'gateway-oauth-usage-cache.json');
const usageSnapshot = [];
for (const scenario of SCENARIOS) {
  const written = Date.now();
  if (scenario.routes !== null) {
    const routes = Object.fromEntries(
      Object.entries(scenario.routes).map(([key, { ageMs, ...snapshot }]) => [key, { ...snapshot, ...(ageMs === undefined ? {} : { cachedAt: written - ageMs }) }])
    );
    writeFileSync(cacheFile, JSON.stringify({ routes }));
  } else {
    writeFileSync(cacheFile, '');
  }
  const provider = scenario.provider ?? 'anthropic-oauth';
  const served = usage.readCachedOAuthUsageSnapshot({ provider, model: '' });
  usageSnapshot.push({
    name: scenario.name,
    provider,
    routes: scenario.routes,
    served: served
      ? { usedPct: served.quotaWindows?.[0]?.usedPct ?? null, windows: served.quotaWindows ?? null, ageMs: Math.round((written - served.cachedAt) / 1000) * 1000 }
      : null,
  });
}
writeJson(join(stage, 'golden.json'), { providerSwitch, usageSnapshot });
writeSetManifest(stage, { set: 'warm-gate-seams', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
