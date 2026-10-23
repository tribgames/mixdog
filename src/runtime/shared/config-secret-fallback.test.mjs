// A Linux host with no OS keychain provider (no secret-tool, no gdbus, no
// Secret Service) keeps provider keys in an owner-only file under the data dir,
// never in mixdog-config.json. Real spawns against an empty PATH simulate the
// missing tools; only process.platform is faked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const HOST_PLATFORM = process.platform;
const SECRET = 'sk-config-fallback-secret-9f8e7d6c';
const OTHER_SECRET = 'sk-config-fallback-other-1a2b3c4d';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-secret-fallback-'));
const dirs = {};
for (const name of ['data', 'home', 'config', 'backups', 'bin']) {
  dirs[name] = path.join(root, name);
  fs.mkdirSync(dirs[name]);
}
const saved = new Map();
function setEnv(key, value) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
setEnv('MIXDOG_DATA_DIR', dirs.data);
setEnv('MIXDOG_HOME', dirs.home);
setEnv('MIXDOG_CONFIG_DIR', dirs.config);
setEnv('MIXDOG_USER_DATA_BACKUP_ROOT', dirs.backups);
setEnv('HOME', dirs.home);
setEnv('USERPROFILE', dirs.home);
setEnv('PATH', dirs.bin); // no secret-tool, no gdbus
for (const key of ['OPENAI_API_KEY', 'MIXDOG_AGENT_OPENAI_APIKEY']) setEnv(key, undefined);

const config = await import('./config.mjs');
const { keychainIssueFor, providerSetup } = await import('../../session-runtime/services/provider-admin.mjs');
const keychain = require('../../lib/keychain-cjs.cjs');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'linux' });
after(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const account = config.SECRET_ACCOUNTS.agentApiKey('openai');
const secretsDir = path.join(dirs.data, 'secrets');
const secretFile = path.join(secretsDir, 'agent.openai.apiKey.secret');
const modeOf = (file) => fs.statSync(file).mode & 0o777;

function filesOutsideSecrets(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (full === secretsDir) continue;
    if (entry.isDirectory()) filesOutsideSecrets(full, found);
    else found.push(full);
  }
  return found;
}

test('no OS keychain: saveSecretAsync stores the key in an owner-only file, never in mixdog-config.json', async () => {
  config.updateSection('agent', (section) => ({ ...section, providers: { openai: { enabled: true } } }));
  await config.saveSecretAsync(account, SECRET);

  assert.equal(fs.readFileSync(secretFile, 'utf8'), SECRET);
  if (HOST_PLATFORM !== 'win32') {
    assert.equal(modeOf(secretFile), 0o600);
    assert.equal(modeOf(secretsDir), 0o700);
  }
  const configFile = config.configPath();
  assert.equal(path.dirname(configFile), dirs.data);
  assert.ok(fs.existsSync(configFile), 'the config file exists');
  assert.ok(!fs.readFileSync(configFile, 'utf8').includes(SECRET), 'mixdog-config.json never holds the key');
  for (const file of filesOutsideSecrets(root)) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), `${path.relative(root, file)} must not hold the key`);
  }
});

test('no OS keychain: the saved key is read back (cold) and reported as stored, not as a keychain failure', async () => {
  keychain.invalidateSecretCache();
  assert.equal(config.hasStoredSecret(account), true);
  assert.equal(config.getAgentApiKey('openai'), SECRET);
  assert.equal(config.getKeychainStatus().fallback, true);
  assert.equal(keychainIssueFor(true), null);

  const setup = await providerSetup({ providers: { openai: { enabled: true } } }, { checkSecrets: true });
  assert.equal(setup.keychain, undefined, 'no keychain alert while the fallback file is in use');
  const row = setup.api.find((provider) => provider.id === 'openai');
  assert.equal(row.stored, true);
  assert.equal(row.authenticated, true);
  assert.equal(row.keychainIssue, undefined);
  assert.equal(row.detail, 'stored in private file');
});

test('no OS keychain: sync saveSecret and both delete paths use the file', async () => {
  const other = config.SECRET_ACCOUNTS.agentApiKey('anthropic');
  const otherFile = path.join(secretsDir, 'agent.anthropic.apiKey.secret');
  config.saveSecret(other, OTHER_SECRET);
  assert.equal(fs.readFileSync(otherFile, 'utf8'), OTHER_SECRET);
  if (HOST_PLATFORM !== 'win32') assert.equal(modeOf(otherFile), 0o600);
  keychain.invalidateSecretCache();
  assert.equal(config.getAgentApiKey('anthropic'), OTHER_SECRET);

  config.deleteSecret(other);
  assert.equal(fs.existsSync(otherFile), false);
  await config.deleteSecretAsync(account);
  assert.equal(fs.existsSync(secretFile), false);
  keychain.invalidateSecretCache();
  assert.equal(config.hasStoredSecret(account), false);
  assert.equal(config.getAgentApiKey('openai'), null);
  assert.deepEqual(fs.readdirSync(secretsDir), []);
});

test('headless host (no gdbus, no secret-tool): after a prewarm the server-login alert stays off', async () => {
  await keychain.prewarmSecrets();
  await keychain.retryKeychain(); // a second probe, as the background retry would run
  const status = config.getKeychainStatus();
  assert.equal(status.state, 'missing');
  assert.equal(status.fallback, true);
  assert.equal(keychainIssueFor(true), null);
});

test('the environment variable still wins over the fallback file', async () => {
  await config.saveSecretAsync(account, SECRET);
  setEnv('OPENAI_API_KEY', 'sk-from-env');
  try {
    keychain.invalidateSecretCache();
    assert.equal(config.getAgentApiKey('openai'), 'sk-from-env');
  } finally {
    setEnv('OPENAI_API_KEY', undefined);
    await config.deleteSecretAsync(account);
  }
});

test('when the fallback file cannot be written the save fails with the env-var hint, and nothing leaks into the config', async () => {
  fs.rmSync(secretsDir, { recursive: true, force: true });
  fs.writeFileSync(secretsDir, 'a file where the directory should be');
  try {
    await assert.rejects(config.saveSecretAsync(account, SECRET), (error) => {
      assert.match(error.message, /could not save secret/);
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
    assert.throws(() => config.saveSecret(account, SECRET), /could not save secret/);
  } finally {
    fs.rmSync(secretsDir, { force: true });
  }
  for (const file of filesOutsideSecrets(root)) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), `${path.relative(root, file)} must not hold the key`);
  }
});
