#!/usr/bin/env node
// When the provider registry refuses an init because nothing would be left (WP-AI-SVC): the REAL
// Node `initProviders` of providers/registry.mjs over configs that enable nothing. The guard
// (`_initProvidersUnsynchronized`, "every entry was disabled and nothing was preserved") refuses with
// `PROVIDERS_NONE_ENABLED` and its exact text, unless a registered OAuth provider is preserved: one
// the config does not name, or whose probe could not read the credential, kept while its stored
// credential is not a logout (the tri-state `oauthCredentialProbeState`: present / absent /
// unreadable). An explicit opt-out is never preserved.
//
//   node benchmarks/rust-core/recorders/record-provider-refusal.mjs [--tree <dir with node_modules>]
//
// Output: native/core/fixtures/provider-refusal/golden.json. No network: a custom provider with
// `preconnect: false` builds without touching the wire; the OAuth provider is registered through the
// registry's test seam, its credential file is a temp one. Every user directory is a fresh temp one
// BEFORE any product module loads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sandbox = mkdtempSync(join(tmpdir(), 'provider-refusal-'));
const dirs = Object.fromEntries(['data', 'home', 'appdata', 'localappdata'].map((name) => [name, join(sandbox, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const credentials = join(dirs.data, 'anthropic.json');
Object.assign(process.env, {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  APPDATA: dirs.appdata,
  LOCALAPPDATA: dirs.localappdata,
  ANTHROPIC_OAUTH_CREDENTIALS_PATH: credentials,
});
const { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-refusal');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-provider-refusal.mjs';
const REGISTRY = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs')).href;

const custom = { type: 'custom', name: 'Mine', baseURL: 'https://llm.example.com/v1', protocol: 'openai-chat', apiKey: 'k', preconnect: false, models: [{ id: 'm1' }] };
const CONFIGS = {
  valid: { 'custom-ok': { ...custom, enabled: true } },
  all_off: { 'custom-off': { ...custom, enabled: false } },
  oauth_opt_out: { 'anthropic-oauth': { enabled: false } },
  oauth_probe_unavailable: { 'anthropic-oauth': { enabled: false, credentialProbeUnavailable: true } },
};
// The credential file the probe reads: a signed-in document, none, or one that cannot be parsed.
const FILES = {
  present: () => writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: 'dummy-access', scopes: ['user:inference'], expiresAt: 0 } })),
  absent: () => rmSync(credentials, { force: true }),
  unreadable: () => writeFileSync(credentials, '{invalid-json'),
};
// `registered`: the OAuth provider is live in the registry (through the test seam), with `probe` as its file.
const SCENARIOS = [
  { name: 'all_off_on_an_empty_registry', steps: ['all_off'] },
  { name: 'all_off_after_a_valid_config', steps: ['valid', 'all_off'] },
  { name: 'an_explicit_opt_out_is_not_preserved', registered: true, probe: 'present', steps: ['oauth_opt_out'] },
  { name: 'a_probe_that_could_not_read_is_preserved', registered: true, probe: 'present', steps: ['oauth_probe_unavailable'] },
  { name: 'an_oauth_provider_the_config_does_not_name_is_kept', registered: true, probe: 'present', steps: ['all_off'] },
  { name: 'a_logged_out_oauth_provider_is_not_kept', registered: true, probe: 'absent', steps: ['all_off'] },
  { name: 'an_unreadable_credential_is_never_a_logout', registered: true, probe: 'unreadable', steps: ['all_off'] },
  { name: 'an_unavailable_probe_over_a_logout_is_not_kept', registered: true, probe: 'absent', steps: ['oauth_probe_unavailable'] },
];

const stderrWrite = process.stderr.write;
const recorded = [];
let n = 0;
for (const scenario of SCENARIOS) {
  n += 1;
  const registry = await import(`${REGISTRY}?scenario=${n}`);
  if (scenario.probe) FILES[scenario.probe]();
  const record = { name: scenario.name, registered: Boolean(scenario.registered), probe: scenario.probe ?? null, steps: [] };
  const run = async () => {
    for (const config of scenario.steps) {
      const row = { config };
      process.stderr.write = () => true;
      try {
        await registry.initProviders(structuredClone(CONFIGS[config]));
        row.outcome = 'ok';
        row.message = null;
        row.code = null;
      } catch (error) {
        row.outcome = 'refused';
        row.message = error.message;
        row.code = error.code ?? null;
      } finally {
        process.stderr.write = stderrWrite;
      }
      record.steps.push(row);
    }
  };
  if (scenario.registered) await registry._withRegisteredProviderForTestAsync('anthropic-oauth', { name: 'anthropic-oauth' }, run);
  else await run();
  recorded.push(record);
}
writeJson(join(stage, 'golden.json'), { configs: CONFIGS, scenarios: recorded });
writeSetManifest(stage, { set: 'provider-refusal', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);