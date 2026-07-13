import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceProviderAuthBindings } from './provider-auth-binding.mjs';
import {
  AGENT_PROVIDER_ENV_ALIASES,
  getAgentApiKey,
} from './provider-api-key.mjs';

const contractPath = fileURLToPath(
  new URL('./pristine-execution-contract.json', import.meta.url),
);
const patchManifestPath = fileURLToPath(
  new URL('../agent/orchestrator/tools/patch-manifest.json', import.meta.url),
);

export const PRISTINE_EXECUTION_CONTRACT = Object.freeze(
  JSON.parse(readFileSync(contractPath, 'utf8')),
);

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function clean(value) {
  return String(value ?? '').trim();
}

export function validateExplicitPristineRoute({ provider, model, effort, fast } = {}) {
  const selectedProvider = clean(provider);
  const selectedModel = clean(model);
  if (!selectedProvider || !selectedModel) {
    return 'headless role commands require both --provider <name> and --model <name>; host route fallback is disabled';
  }
  const selectedEffort = clean(effort).toLowerCase();
  if (selectedEffort && !EFFORTS.has(selectedEffort)) {
    return `invalid --effort ${JSON.stringify(clean(effort))}; expected low, medium, high, xhigh, or max`;
  }
  if (fast !== undefined && typeof fast !== 'boolean') {
    return '--fast must be an explicit boolean flag';
  }
  return null;
}

export function buildMinimalPristineConfig({ provider, model, effort, fast } = {}) {
  const routeError = validateExplicitPristineRoute({ provider, model, effort, fast });
  if (routeError) throw new Error(routeError);
  const selectedProvider = clean(provider);
  const selectedModel = clean(model);
  const selectedEffort = clean(effort).toLowerCase();
  const route = {
    provider: selectedProvider,
    model: selectedModel,
    ...(selectedEffort ? { effort: selectedEffort } : {}),
    ...(fast === true ? { fast: true } : {}),
  };
  const providerConfig = {
    enabled: true,
    ...(selectedProvider === 'openai-oauth' ? { websocket: true } : {}),
  };
  const modelSettings = {};
  if (selectedEffort || fast === true) {
    modelSettings[`${selectedProvider}/${selectedModel}`] = {
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(fast === true ? { fast: true } : {}),
    };
  }
  return {
    agent: {
      providers: { [selectedProvider]: providerConfig },
      presets: [{
        id: 'headless-explicit-route',
        name: 'HEADLESS EXPLICIT ROUTE',
        type: 'agent',
        tools: 'full',
        ...route,
      }],
      default: 'headless-explicit-route',
      workflow: { active: 'default' },
      workflowRoutes: {},
      agents: {},
      modelSettings,
      mcpServers: {},
    },
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createSelectedProviderPristineLoader({
  config,
  provider,
  apiKey = null,
} = {}) {
  const selectedProvider = clean(provider);
  const runtimeConfig = cloneJson(config?.agent || {});
  const selectedConfig = {
    ...(runtimeConfig.providers?.[selectedProvider] || {}),
    enabled: true,
    ...(apiKey ? { apiKey } : {}),
  };
  runtimeConfig.providers = { [selectedProvider]: selectedConfig };
  return () => cloneJson(runtimeConfig);
}

function hostDataDir(env) {
  if (clean(env.MIXDOG_DATA_DIR)) return resolve(env.MIXDOG_DATA_DIR);
  const home = clean(env.MIXDOG_HOME)
    ? resolve(env.MIXDOG_HOME)
    : join(homedir(), '.mixdog');
  return join(home, 'data');
}

function patchPlatformKey() {
  const os = process.platform === 'win32' ? 'win32' : process.platform;
  return `${os}-${process.arch}`;
}

export function seedVerifiedPatchBinaryCache(
  sourceDataDir,
  dataDir,
  { manifestPath = patchManifestPath } = {},
) {
  try {
    const sourcePatchDir = join(sourceDataDir, 'patch-bin');
    const manifestBytes = readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const asset = manifest?.assets?.[patchPlatformKey()];
    const version = String(manifest?.version || '');
    const expectedSha256 = clean(asset?.sha256).toLowerCase();
    if (!/^[A-Za-z0-9._-]+$/.test(version) || !/^[a-f0-9]{64}$/.test(expectedSha256)) return false;

    const binaryName = `mixdog-patch-${version}${process.platform === 'win32' ? '.exe' : ''}`;
    const sourceBinary = join(sourcePatchDir, binaryName);
    if (!existsSync(sourceBinary)) return false;
    const binaryBytes = readFileSync(sourceBinary);
    const actualSha256 = createHash('sha256').update(binaryBytes).digest('hex');
    if (actualSha256 !== expectedSha256) return false;

    const targetPatchDir = join(dataDir, 'patch-bin');
    mkdirSync(targetPatchDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(targetPatchDir, binaryName), binaryBytes, { mode: 0o700 });
    writeFileSync(join(targetPatchDir, 'manifest.json'), manifestBytes, { mode: 0o600 });
    return true;
  } catch {
    // A missing, stale, or malformed host cache is optional acceleration only.
    // Leave the pristine runtime empty so the normal fetch path handles it.
    return false;
  }
}

function auditDocument({
  provider,
  model,
  effort,
  fast,
  configBytes,
  authMode,
  catalogCount,
}) {
  const contract = PRISTINE_EXECUTION_CONTRACT;
  return {
    schemaVersion: contract.schemaVersion,
    mode: 'headless-role-pristine',
    provider: clean(provider),
    model: clean(model),
    effort: clean(effort).toLowerCase() || null,
    fast: fast === true,
    configSha256: createHash('sha256').update(configBytes).digest('hex'),
    authMode,
    authArtifactFilesCopied: 0,
    injectedModelCatalogFileCount: catalogCount,
    personalState: {
      hostConfigRead: false,
      ...Object.fromEntries(contract.personalStateCounters.map((name) => [name, 0])),
    },
    featuresEnabled: Object.fromEntries(
      contract.disabledFeatures.map((name) => [name, false]),
    ),
  };
}

export function formatPristineExecutionAudit(audit) {
  return [
    `pristine-execution-audit v${audit.schemaVersion}`,
    'mode=headless-role',
    'personal-files=0',
    'host-config=0',
    'mcp=0',
    'skills=0',
    'core-memory=0',
    'channels=0',
    'plugins=0',
    'profiles=0',
    'prior-sessions=0',
    `provider=${audit.provider}`,
    `model=${audit.model}`,
    `effort=${audit.effort || 'provider-default'}`,
    `fast=${String(audit.fast)}`,
    `auth=${audit.authMode}`,
    `catalogs=${audit.injectedModelCatalogFileCount}`,
  ].join(' ');
}

export function createPristineExecutionBoundary({
  provider,
  model,
  effort,
  fast,
  env = process.env,
  approvedExecutionEnv = {},
  apiKeyResolver = getAgentApiKey,
} = {}) {
  const routeError = validateExplicitPristineRoute({ provider, model, effort, fast });
  if (routeError) throw new Error(routeError);

  const contract = PRISTINE_EXECUTION_CONTRACT;
  const hostEnv = { ...env };
  const originalEnv = new Map();
  const touchedKeys = new Set();
  const setEnv = (name, value) => {
    if (!touchedKeys.has(name)) {
      originalEnv.set(name, Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined);
      touchedKeys.add(name);
    }
    env[name] = String(value);
  };
  const unsetEnv = (name) => {
    if (!touchedKeys.has(name)) {
      originalEnv.set(name, Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined);
      touchedKeys.add(name);
    }
    delete env[name];
  };
  const rootDir = mkdtempSync(join(tmpdir(), 'mixdog-headless-pristine-'));
  const dataDir = join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let cleaned = false;
  let restoreAuthBindings = () => {};
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    restoreAuthBindings();
    rmSync(rootDir, { recursive: true, force: true });
  };

  try {
    const sourceDataDir = hostDataDir(hostEnv);
    seedVerifiedPatchBinaryCache(sourceDataDir, dataDir);
    const approvedNames = new Set(contract.approvedExecutionEnv || []);
    for (const name of Object.keys(approvedExecutionEnv || {})) {
      if (!approvedNames.has(name)) {
        throw new Error(`unapproved pristine execution environment override: ${name}`);
      }
    }
    const inheritedExecutionEnv = Object.fromEntries(
      [...approvedNames]
        .filter((name) => hostEnv[name] !== undefined)
        .map((name) => [name, hostEnv[name]]),
    );
    const selectedProvider = clean(provider);
    const oauth = contract.oauthProviders[selectedProvider];
    const apiKeyEnv = contract.apiKeyProviders[selectedProvider];
    let selectedApiKey = null;
    if (apiKeyEnv) {
      // Resolve before scrubbing so the selected provider may use its standard,
      // MIXDOG_AGENT_*, alias, or one provider-scoped keychain account. No
      // general config loader or all-provider credential scan is involved.
      selectedApiKey = clean(apiKeyResolver(selectedProvider));
    }
    // Fail closed: no inherited Mixdog behavior reaches the child runtime.
    // Only contract-listed operational controls are reintroduced below.
    for (const name of Object.keys(env)) {
      if (name.startsWith('MIXDOG_')) unsetEnv(name);
    }
    for (const entry of Object.values(contract.oauthProviders)) {
      unsetEnv(entry.credentialPathEnv);
    }
    for (const name of Object.values(contract.apiKeyProviders)) unsetEnv(name);
    for (const aliases of Object.values(AGENT_PROVIDER_ENV_ALIASES)) {
      for (const name of aliases) unsetEnv(name);
    }
    setEnv('MIXDOG_HOME', rootDir);
    setEnv('MIXDOG_DATA_DIR', dataDir);
    for (const [name, value] of Object.entries({
      ...inheritedExecutionEnv,
      ...approvedExecutionEnv,
    })) {
      setEnv(name, value);
    }
    for (const [name, value] of Object.entries(contract.guardEnv)) setEnv(name, value);

    let authMode = 'provider-managed';
    let catalogCount = 0;
    if (oauth) {
      const sourceCredential = clean(hostEnv[oauth.credentialPathEnv])
        ? resolve(hostEnv[oauth.credentialPathEnv])
        : join(sourceDataDir, oauth.credentialFile);
      if (!existsSync(sourceCredential)) {
        throw new Error(`required ${clean(provider)} credentials are unavailable; sign in before using the headless role command`);
      }
      // Authentication is the sole host-state exception. Bind in-process (not
      // via child-visible environment) so tools cannot discover the auth path.
      restoreAuthBindings = replaceProviderAuthBindings({
        [selectedProvider]: sourceCredential,
      });
      authMode = 'in-process-host-oauth-binding';
      const sourceCatalog = join(sourceDataDir, oauth.modelCatalogFile);
      if (existsSync(sourceCatalog)) {
        copyFileSync(sourceCatalog, join(dataDir, oauth.modelCatalogFile));
        catalogCount = 1;
      }
    } else if (apiKeyEnv) {
      if (!selectedApiKey) {
        throw new Error(`required ${selectedProvider} authentication is unavailable; set ${apiKeyEnv}`);
      }
      authMode = 'in-process-api-key';
    }

    const config = buildMinimalPristineConfig({ provider, model, effort, fast });
    const loadConfig = createSelectedProviderPristineLoader({
      config,
      provider,
      apiKey: selectedApiKey,
    });
    const configBytes = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(join(dataDir, contract.configFileName), configBytes, { mode: 0o600 });
    const audit = auditDocument({
      provider,
      model,
      effort,
      fast,
      configBytes,
      authMode,
      catalogCount,
    });
    return { rootDir, dataDir, config, audit, loadConfig, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
