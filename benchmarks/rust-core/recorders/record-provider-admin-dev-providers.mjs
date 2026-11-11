#!/usr/bin/env node
// provider-admin-dev-providers.test.mjs (1 test): the real provider-admin `providerSetup` / `providerStatus` / `isKnownProvider` /
// `listProviderAccounts` over a data directory whose `agent.developer` flags are rewritten through `updateSection`; the dev-only OAuth
// providers appear and disappear per flag without a reload. Each step records the whole provider setup and status results, the known-provider answers and the thrown error.
//   node benchmarks/rust-core/recorders/record-provider-admin-dev-providers.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-admin-dev-providers',
  net: false,
  entry: 'src/session-runtime/services/provider-admin.mjs providerSetup({}, { checkSecrets: false, detectLocal: false }).oauth / providerStatus({}) / isKnownProvider / listProviderAccounts, with src/runtime/shared/config.mjs updateSection("agent", ...) over the recording data dir (MIXDOG_CONFIG_READ_TTL_MS=0).',
  compare: 'per step, apply the `developer` flags (stored `agent.developer`) and compare `provider_available(name, client_mode=false, stored_developer)` for each name in `known`, and the whole `setup` (providerSetup result: the `oauth` rows) and `status` (providerStatus rows) the product listed; `listAccountsError` is the whole error for an unknown OAuth provider.',
  replay: "PURE, per output: (1) availability per option state: mixdog_ai::service::admin_models developer_option_for_provider (service/admin_models.rs:427), developer_option_enabled (:438) and provider_available (:445) (`pub mod admin_models`, service/mod.rs:5); (2) the provider setup rows (`setup`, the oauth rows): mixdog-core-domains/src/domains/ai_account/provider_setup.rs:451 `pub fn provider_setup(world: &dyn SetupWorld, config: &Value, options: SetupOptions) -> Value` (`pub mod provider_setup`, ai_account/mod.rs:19); (3) the account-listing error for an unknown OAuth provider: mixdog-core-domains/src/domains/ai_account/admin.rs:379 `list_provider_accounts(&self, provider)` (`pub mod admin`, ai_account/mod.rs:4). (4) `status` (providerStatus rows): RUST WORK - looked for a public provider_status / providers_status function in mixdog-core-domains ai_account, mixdog-ai service and registry: none; the closest, registry/effective.rs:31-33, builds the listing but is not a status function.",
});
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = `${rec.dataDir}/backups`;
const { updateSection } = await rec.load('src/runtime/shared/config.mjs');
const { providerSetup, providerStatus, isKnownProvider, listProviderAccounts } = await rec.load('src/session-runtime/services/provider-admin.mjs');
const SRC = 'src/standalone/provider-admin-dev-providers.test.mjs';
const DEV = ['mimo-oauth', 'cursor-oauth', 'devin-oauth', 'antigravity-oauth'];
const KNOWN = [...DEV, 'openai-oauth', 'muse-code-oauth', 'command-code-oauth', 'openai', 'mixdog-local'];
const step = async (developer) => {
  if (developer) updateSection('agent', (current) => ({ ...current, developer }));
  const listAccountsError = {};
  for (const id of DEV) {
    try {
      listProviderAccounts(id);
      listAccountsError[id] = null;
    } catch (error) {
      listAccountsError[id] = error;
    }
  }
  return {
    developer,
    setup: await providerSetup({}, { checkSecrets: false, detectLocal: false }),
    known: Object.fromEntries(KNOWN.map((id) => [id, isKnownProvider(id)])),
    status: providerStatus({}),
    listAccountsError,
  };
};
await rec.run('dev-oauth-providers-follow-developer-flags', `${SRC}:33`, {}, async () => {
  const steps = [await step(null)];
  for (const developer of [{ cursorOAuth: true }, { mimoOAuth: true }, { mimoOAuth: true, cursorOAuth: true, devinOAuth: true, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: false }]) steps.push(await step(developer));
  return { steps };
});
await rec.finish();
