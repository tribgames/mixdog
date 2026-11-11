#!/usr/bin/env node
// provider-admin-dev-providers.test.mjs (1 test): the real provider-admin `providerSetup` / `providerStatus` / `isKnownProvider` /
// `listProviderAccounts` over a data directory whose `agent.developer` flags are rewritten through `updateSection`; the dev-only OAuth
// providers appear and disappear per flag without a reload. Each step records the OAuth ids, the known-provider answers and the thrown error.
//   node benchmarks/rust-core/recorders/record-provider-admin-dev-providers.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-admin-dev-providers',
  net: false,
  entry: 'src/session-runtime/services/provider-admin.mjs providerSetup({}, { checkSecrets: false, detectLocal: false }).oauth / providerStatus({}) / isKnownProvider / listProviderAccounts, with src/runtime/shared/config.mjs updateSection("agent", ...) over the recording data dir (MIXDOG_CONFIG_READ_TTL_MS=0).',
  compare: 'mixdog-core-domains ai_admin provider list (admin_providers): per step, apply the `developer` flags and compare `oauthIds`, `known` and `statusDevIds`; `listAccountsError` is the error text for an unknown OAuth provider.',
  replay: "Rust entry (pub, on o1): mixdog_ai::service::admin_models developer_option_for_provider (service/admin_models.rs:427), developer_option_enabled (:438) and provider_available (:445) over the stored `developer` section (`pub mod admin_models`, service/mod.rs:5): replay `provider_available(name, client_mode, stored_developer)` per option state; the provider setup list that the Node test also reads (`oauth` rows) is the registry listing built over it (registry/effective.rs:31-33).",
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
    developer: developer ?? null,
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
