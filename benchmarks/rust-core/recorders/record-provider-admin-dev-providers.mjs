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
  replay: 'mixdog-core-domains ai_admin provider list (admin_providers): per step, apply the `developer` flags and compare `oauthIds`, `known` and `statusDevIds`; `listAccountsError` is the error text for an unknown OAuth provider.',
});
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = `${rec.dataDir}/backups`;
const { updateSection } = await rec.load('src/runtime/shared/config.mjs');
const { providerSetup, providerStatus, isKnownProvider, listProviderAccounts } = await rec.load('src/session-runtime/services/provider-admin.mjs');
const SRC = 'src/standalone/provider-admin-dev-providers.test.mjs';
const DEV = ['mimo-oauth', 'cursor-oauth', 'devin-oauth', 'antigravity-oauth'];
const KNOWN = [...DEV, 'openai-oauth', 'muse-code-oauth', 'command-code-oauth', 'openai', 'mixdog-local'];
const oauthIds = async () => (await providerSetup({}, { checkSecrets: false, detectLocal: false })).oauth.map((row) => row.id);
const step = async (developer) => {
  if (developer) updateSection('agent', (current) => ({ ...current, developer }));
  const listAccountsError = {};
  for (const id of DEV) {
    try {
      listProviderAccounts(id);
      listAccountsError[id] = null;
    } catch (error) {
      listAccountsError[id] = error.message;
    }
  }
  return {
    developer: developer ?? null,
    oauthIds: await oauthIds(),
    known: Object.fromEntries(KNOWN.map((id) => [id, isKnownProvider(id)])),
    statusDevIds: providerStatus({}).filter((row) => row.type === 'oauth').map((row) => row.id).filter((id) => DEV.includes(id)),
    listAccountsError,
  };
};
await rec.run('dev-oauth-providers-follow-developer-flags', `${SRC}:33`, {}, async () => {
  const steps = [await step(null)];
  for (const developer of [{ cursorOAuth: true }, { mimoOAuth: true }, { mimoOAuth: true, cursorOAuth: true, devinOAuth: true, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: true }, { mimoOAuth: false, cursorOAuth: false, antigravityOAuth: false }]) steps.push(await step(developer));
  return { steps };
});
await rec.finish();
