#!/usr/bin/env node
// The provider setup snapshot: session-runtime/services/provider-admin.mjs `providerSetup`, the
// real function, over a temp data dir. Each scenario records the config, the options, the
// process environment it ran under and the facts of the world the rows were built from (read
// through the same real modules the function reads), then its result. Rust
// `mixdog_core_domains::domains::ai_account::provider_setup::provider_setup` must build the same
// document from the same facts. Custom-provider rows and catalog failures are later slices:
// no scenario has a custom provider.
//
//   node benchmarks/rust-core/recorders/record-provider-setup.mjs [--tree <dir>]
//
// Output: native/core/fixtures/provider-setup/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
// The gcloud-login row probes the metadata server in the background; nothing leaves this machine.
globalThis.fetch = async () => {
  throw new Error('offline');
};
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, recordingProvenance, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-setup');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-provider-setup.mjs';
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'provider-setup-rec-'));
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'provider-setup-home-'));
const at = (path) => importFrom(tree, path);
// The keychain probe is the seam: config.mjs binds `keychainStatus` and `hasFallbackSecret` from
// keychain-cjs.cjs when it is imported, so they are replaced on that module's exports first. A
// scenario that names a keychain state answers it; otherwise the real probe answers.
const keychainCjs = createRequire(join(tree, 'src/runtime/shared/config.mjs'))('../../lib/keychain-cjs.cjs');
const realKeychainStatus = keychainCjs.keychainStatus;
const realHasFallbackSecret = keychainCjs.hasFallbackSecret;
let stubbedKeychain = null;
let stubbedFallback = new Set();
keychainCjs.keychainStatus = () => stubbedKeychain ?? realKeychainStatus();
keychainCjs.hasFallbackSecret = (account) => stubbedFallback.has(account) || realHasFallbackSecret(account);
const admin = await at('src/session-runtime/services/provider-admin.mjs');
const cfg = await at('src/runtime/shared/config.mjs');
const keyMod = await at('src/runtime/shared/provider-api-key.mjs');
const probes = await at('src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs');
const vertexAuth = await at('src/runtime/agent/orchestrator/providers/vertex-ai-auth.mjs');
const vertexModels = await at('src/runtime/agent/orchestrator/providers/vertex-ai-models.mjs');
const describers = {
  'openai-oauth': (await at('src/runtime/agent/orchestrator/providers/openai-oauth-tokens.mjs')).describeOpenAIOAuthCredentials,
  'anthropic-oauth': (await at('src/runtime/agent/orchestrator/providers/anthropic-oauth-credentials.mjs')).describeAnthropicOAuthCredentials,
  'grok-oauth': (await at('src/runtime/agent/orchestrator/providers/grok-oauth-tokens.mjs')).describeGrokOAuthCredentials,
  'muse-code-oauth': (await at('src/runtime/agent/orchestrator/providers/muse-code-oauth-tokens.mjs')).describeMuseCodeOAuthCredentials,
  'command-code-oauth': (await at('src/runtime/agent/orchestrator/providers/command-code-oauth-tokens.mjs')).describeCommandCodeOAuthCredentials,
  'opencode-go-oauth': (await at('src/runtime/agent/orchestrator/providers/opencode-go-oauth-tokens.mjs')).describeOpenCodeGoOAuthCredentials,
  'mimo-oauth': (await at('src/runtime/agent/orchestrator/providers/mimo-oauth-tokens.mjs')).describeMimoOAuthCredentials,
  'cursor-oauth': (await at('src/runtime/agent/orchestrator/providers/cursor-auth.mjs')).describeCursorOAuthCredentials,
  'devin-oauth': (await at('src/runtime/agent/orchestrator/providers/devin-auth.mjs')).describeDevinOAuthCredentials,
  'antigravity-oauth': (await at('src/runtime/agent/orchestrator/providers/antigravity-oauth-tokens.mjs')).describeAntigravityOAuthCredentials,
};

const API_IDS = ['openrouter', 'openai', 'anthropic', 'gemini', 'vertex-ai', 'deepseek', 'xai'];
// Every variable a key can come from, so a scenario starts from a clean environment.
const KEY_ENV = [
  'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY',
  ...API_IDS.map((id) => `MIXDOG_AGENT_${id.replace(/[.\s]+/g, '_').toUpperCase()}_APIKEY`),
  'GOOGLE_VERTEX_LOCATION', 'GOOGLE_CLOUD_LOCATION', 'CLOUD_ML_REGION',
];
const account = (id) => `agent.${id}.apiKey`;
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', project_id: 'rec-project', client_email: 'rec@rec-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' });
const LOCAL_READY = { runtime: { installed: true }, models: [{ id: 'm1', installed: true }, { id: 'm2', installed: false }] };
const LOCAL_TWO = { runtime: { installed: true }, models: [{ installed: true }, { installed: true }] };

const LOCKED = 'Keyring is locked. Unlock it to read stored keys.';
const SCENARIOS = [
  { name: 'empty config with secrets', config: {}, options: {} },
  { name: 'empty config without secrets', config: {}, options: { checkSecrets: false } },
  { name: 'openai enabled without a key', config: { providers: { openai: { enabled: true } } }, options: {} },
  { name: 'openai from its environment variable', config: { providers: { openai: { enabled: true } } }, env: { OPENAI_API_KEY: 'sk-env' }, options: {} },
  { name: 'xai from the GROK alias', config: {}, env: { GROK_API_KEY: 'g-env' }, options: {} },
  { name: 'anthropic from the mixdog variable', config: {}, env: { MIXDOG_AGENT_ANTHROPIC_APIKEY: 'a-env' }, options: {} },
  { name: 'openai stored in the keychain, not enabled', config: {}, stored: { openai: 'sk-stored' }, options: {} },
  { name: 'stored and environment together', config: { providers: { openai: { enabled: true } } }, env: { OPENAI_API_KEY: 'sk-env' }, stored: { openai: 'sk-stored' }, options: {} },
  { name: 'deepseek enabled, secrets not checked', config: { providers: { deepseek: { enabled: true } } }, options: { checkSecrets: false } },
  { name: 'vertex service account stored', config: { providers: { 'vertex-ai': { enabled: true, location: 'europe-west4' } } }, stored: { 'vertex-ai': SERVICE_ACCOUNT }, options: {} },
  { name: 'vertex service account with a saved project', config: { providers: { 'vertex-ai': { enabled: true, projectId: 'saved-project' } } }, stored: { 'vertex-ai': SERVICE_ACCOUNT }, options: {} },
  { name: 'vertex express key', config: { providers: { 'vertex-ai': { enabled: true, authMode: 'api-key' } } }, stored: { 'vertex-ai': 'express-key' }, options: {} },
  { name: 'vertex without credentials, location from the environment', config: { providers: { 'vertex-ai': { enabled: true } } }, env: { GOOGLE_CLOUD_LOCATION: 'asia-east1' }, options: {} },
  { name: 'vertex gcloud login, secrets not checked', config: { providers: { 'vertex-ai': { enabled: true, authMode: 'adc', projectId: 'adc-project', location: 'us-east5' } } }, options: { checkSecrets: false } },
  { name: 'vertex gcloud login, secrets checked', config: { providers: { 'vertex-ai': { enabled: true, authMode: 'adc', projectId: 'adc-project' } } }, options: {} },
  { name: 'oauth providers enabled, secrets not checked', config: { providers: { 'openai-oauth': { enabled: true }, 'anthropic-oauth': { enabled: true } } }, options: { checkSecrets: false } },
  {
    name: 'local provider ready',
    config: { providers: { 'mixdog-local': { enabled: true } }, builtins: { localProvider: { installed: true } } },
    options: {},
    local: LOCAL_READY,
  },
  { name: 'local provider installed but off', config: { builtins: { localProvider: { installed: true } } }, options: {}, local: LOCAL_TWO },
  { name: 'local provider installed, no model', config: { builtins: { localProvider: { installed: true } } }, options: {}, local: { runtime: { installed: true }, models: [] } },
  { name: 'local provider disabled by its module', config: { providers: { 'mixdog-local': { enabled: true } }, builtins: { localProvider: { installed: true } }, modules: { localProvider: { enabled: false } } }, options: {}, local: LOCAL_READY },
  { name: 'local provider not asked', config: { providers: { 'mixdog-local': { enabled: true } }, builtins: { localProvider: { installed: true } } }, options: { detectLocal: false }, local: LOCAL_READY },
  { name: 'local status throws', config: {}, options: {}, local: 'throws' },
  { name: 'keyring locked', config: { providers: { openai: { enabled: true }, 'vertex-ai': { enabled: true } } }, keychain: { state: 'locked', message: LOCKED, fallback: false }, options: {} },
  { name: 'keyring locked, key from the environment', config: { providers: { openai: { enabled: true } } }, env: { OPENAI_API_KEY: 'sk-env' }, keychain: { state: 'locked', message: LOCKED, fallback: false }, options: {} },
  { name: 'keyring locked, secrets not checked', config: { providers: { openai: { enabled: true } } }, keychain: { state: 'locked', message: LOCKED, fallback: false }, options: { checkSecrets: false } },
  { name: 'keyring missing', config: { providers: { anthropic: { enabled: true } } }, keychain: { state: 'missing', message: '', fallback: false }, options: {} },
  { name: 'keyring unreachable', config: {}, keychain: { state: 'unreachable', message: '', fallback: false }, options: {} },
  { name: 'keyring error', config: {}, keychain: { state: 'error', message: '', fallback: false }, options: {} },
  { name: 'keyring ok', config: {}, keychain: { state: 'ok', message: '', fallback: false }, options: {} },
  { name: 'private file store in use, key stored there', config: {}, keychain: { state: 'ok', message: '', fallback: true }, stored: { openai: 'sk-file' }, fallbackStored: ['openai'], options: {} },
  { name: 'private file store in use, locked state ignored', config: { providers: { openai: { enabled: true } } }, keychain: { state: 'locked', message: LOCKED, fallback: true }, options: {} },
  { name: 'private file store with unsafe permissions', config: { providers: { openai: { enabled: true } } }, keychain: { state: 'ok', message: '', fallback: true, unsafeStore: { path: '/data/secrets', kind: 'permissions' } }, options: {} },
  { name: 'private file store owned by another user', config: {}, keychain: { state: 'ok', message: '', fallback: true, unsafeStore: { path: '/data/secrets', kind: 'owner' } }, options: {} },
  { name: 'private file store is a symlink', config: {}, keychain: { state: 'ok', message: '', fallback: true, unsafeStore: { path: '/data/secrets', kind: 'type' } }, options: {} },
  { name: 'private file store with an unknown fault', config: {}, keychain: { state: 'ok', message: '', fallback: true, unsafeStore: { path: '/data/secrets', kind: 'other' } }, options: {} },
];

const results = [];
for (const scenario of SCENARIOS) {
  for (const name of KEY_ENV) delete process.env[name];
  const env = scenario.env ?? {};
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  const stored = scenario.stored ?? {};
  stubbedKeychain = scenario.keychain ?? null;
  stubbedFallback = new Set((scenario.fallbackStored ?? []).map(account));
  for (const [id, secret] of Object.entries(stored)) await cfg.saveSecretAsync(account(id), secret);
  const options = { ...scenario.options };
  if (scenario.local !== undefined) {
    options.getLocalProviderStatus = () => {
      if (scenario.local === 'throws') throw new Error('status failed');
      return scenario.local;
    };
  }
  const configured = scenario.config.providers?.['vertex-ai'] ?? {};
  const projectId = configured.projectId;
  const world = {
    resolvedEnv: Object.fromEntries(API_IDS.map((id) => [id, keyMod.agentApiKeyEnvName(id)])),
    stored: API_IDS.filter((id) => cfg.hasStoredSecret(account(id))),
    fallback: API_IDS.filter((id) => cfg.isFallbackSecret(account(id))),
    keyPresent: API_IDS.filter((id) => Boolean(keyMod.getAgentApiKey(id))),
    keychain: cfg.getKeychainStatus(),
    oauthAvailable: Object.keys(describers).filter((id) => probes.isOAuthProviderAvailable(id)),
    oauthDescribe: Object.fromEntries(Object.entries(describers).map(([id, describe]) => [id, describe()])),
    vertexEnvLocation: vertexModels.vertexEnvLocation() || null,
    vertexAdc: scenario.options.checkSecrets === false ? null : (vertexAuth.describeVertexAdc({ projectId }) ?? null),
    vertexKeyProject: null,
  };
  if (stored['vertex-ai'] === SERVICE_ACCOUNT) world.vertexKeyProject = vertexAuth.parseVertexServiceAccount(SERVICE_ACCOUNT).projectId || null;
  const result = await admin.providerSetup(scenario.config, options);
  results.push({
    name: scenario.name,
    config: scenario.config,
    options: { checkSecrets: scenario.options.checkSecrets ?? null, detectLocal: scenario.options.detectLocal ?? null },
    env,
    world,
    local: scenario.local ?? null,
    keychainStubbed: Boolean(scenario.keychain),
    result: JSON.parse(JSON.stringify(result)),
  });
  for (const id of Object.keys(stored)) await cfg.deleteSecretAsync(account(id));
}
writeJson(join(stage, 'golden.json'), { scenarios: results });
writeSetManifest(stage, { set: 'provider-setup', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, extra: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']) });
commitStage(stage, finalDir);
