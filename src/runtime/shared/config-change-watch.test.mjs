// The shared config-change subscription: it survives a failing directory
// watch, and a keychain write in another process reaches it although
// mixdog-config.json never changes. Keys live in the owner-only fallback file
// (a Linux host with no keychain provider: only process.platform is faked and
// PATH is empty), so no OS keychain is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-config-change-watch-'));
const dirs = {};
for (const name of ['data', 'home', 'config', 'backups', 'bin']) {
  dirs[name] = path.join(root, name);
  fs.mkdirSync(dirs[name]);
}
const env = {
  MIXDOG_DATA_DIR: dirs.data,
  MIXDOG_HOME: dirs.home,
  MIXDOG_CONFIG_DIR: dirs.config,
  MIXDOG_USER_DATA_BACKUP_ROOT: dirs.backups,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  PATH: dirs.bin,
};
const saved = new Map();
for (const [key, value] of Object.entries(env)) {
  saved.set(key, process.env[key]);
  process.env[key] = value;
}
for (const key of ['OPENAI_API_KEY', 'MIXDOG_AGENT_OPENAI_APIKEY']) {
  saved.set(key, process.env[key]);
  delete process.env[key];
}
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'linux' });

const configModule = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.mjs');
const oauthClientModule = path.join(
  path.dirname(configModule),
  '..',
  'agent',
  'orchestrator',
  'mcp',
  'oauth-client.mjs'
);
const gmailModule = path.join(path.dirname(configModule), '..', 'connectors', 'gmail-app-password.mjs');
const pluginAdminModule = path.join(
  path.dirname(configModule),
  '..',
  '..',
  'session-runtime',
  'services',
  'plugin-admin.mjs'
);
const config = await import(pathToFileURL(configModule).href);

// Run `body` (module code) in another process of the same install.
function inAnotherProcess(body) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', body], {
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

after(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

test('a failed directory watch is re-established and announces the changes it may have missed', async () => {
  const realWatch = config.configWatchDeps.watch;
  const watchers = [];
  config.configWatchDeps.watch = (_dir, onChange) => {
    const watcher = Object.assign(new EventEmitter(), { onChange, close() {} });
    watchers.push(watcher);
    return watcher;
  };
  let notified = 0;
  const unsubscribe = config.subscribeConfigChange(() => {
    notified += 1;
  });
  try {
    assert.equal(watchers.length, 1);
    watchers[0].emit('error', new Error('EPERM: watched directory went away'));
    assert.ok(await waitFor(() => watchers.length === 2 && notified === 1), 'the watch came back and re-announced');
    // A rewrite of identical bytes (another process re-saving a marker) is no change.
    watchers[1].onChange('rename', 'mixdog-secrets-changed.json');
    await sleep(300);
    assert.equal(notified, 1, 'identical content announces nothing');
    const configFile = config.configPath();
    const before = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    fs.writeFileSync(configFile, JSON.stringify({ ...before, watchProbe: 1 }));
    watchers[1].onChange('rename', 'mixdog-config.json');
    assert.ok(await waitFor(() => notified === 2), 'the new watch delivers changes');
  } finally {
    unsubscribe();
    config.configWatchDeps.watch = realWatch;
  }
});

test('a half-written hand edit is never quarantined by the watch: the change is read once it parses', async () => {
  const realWatch = config.configWatchDeps.watch;
  let watcher = null;
  config.configWatchDeps.watch = (_dir, onChange) => {
    watcher = Object.assign(new EventEmitter(), { onChange, close() {} });
    return watcher;
  };
  const configFile = config.configPath();
  fs.writeFileSync(configFile, JSON.stringify({ ui: { theme: 'before' } }));
  const seen = [];
  const unsubscribe = config.subscribeConfigChange(() => seen.push(config.readConfig().ui?.theme));
  try {
    fs.writeFileSync(configFile, '{"ui": {"theme": "aft');
    watcher.onChange('change', 'mixdog-config.json');
    await sleep(150);
    // Nothing re-reads it while it stays torn.
    await sleep(400);
    assert.deepEqual(seen, [], 'no pass ran a listener on the torn content');
    // The completing write fires its own event; that pass reads it.
    fs.writeFileSync(configFile, JSON.stringify({ ui: { theme: 'after' } }));
    watcher.onChange('change', 'mixdog-config.json');
    assert.ok(await waitFor(() => seen.includes('after')), `notified with ${JSON.stringify(seen)}`);
    assert.deepEqual(seen, ['after'], 'the torn content was never read');
    const corrupt = fs.readdirSync(path.dirname(configFile)).filter((name) => name.includes('.corrupt-'));
    assert.deepEqual(corrupt, [], 'nothing was kept aside');
  } finally {
    unsubscribe();
    config.configWatchDeps.watch = realWatch;
  }
});

test('a partial save landing while a pass runs is never quarantined by the pass’s own reads', async () => {
  const realWatch = config.configWatchDeps.watch;
  let watcher = null;
  config.configWatchDeps.watch = (_dir, onChange) => {
    watcher = Object.assign(new EventEmitter(), { onChange, close() {} });
    return watcher;
  };
  const configFile = config.configPath();
  fs.writeFileSync(configFile, JSON.stringify({ ui: { theme: 'one' } }));
  let torn = false;
  const seen = [];
  // The first listener stands for the time the pass takes: a second save,
  // half written, lands before the next listener reads.
  const first = config.subscribeConfigChange(() => {
    if (torn) return;
    torn = true;
    fs.writeFileSync(configFile, '{"ui": {"theme": "thr');
  });
  const second = config.subscribeConfigChange(() => {
    try {
      seen.push(config.readConfig().ui?.theme);
    } catch (error) {
      seen.push(error.code);
    }
  });
  try {
    fs.writeFileSync(configFile, JSON.stringify({ ui: { theme: 'two' } }));
    watcher.onChange('change', 'mixdog-config.json');
    assert.ok(await waitFor(() => seen.length === 1), 'the pass ran');
    assert.deepEqual(seen, ['ECONFIG_MID_WRITE'], 'the read kept the current config');
    // The save completes and fires its own event; that pass reads it.
    fs.writeFileSync(configFile, JSON.stringify({ ui: { theme: 'three' } }));
    watcher.onChange('change', 'mixdog-config.json');
    assert.ok(await waitFor(() => seen.length === 2), `notified with ${JSON.stringify(seen)}`);
    assert.equal(seen[1], 'three');
    const corrupt = fs.readdirSync(path.dirname(configFile)).filter((name) => name.includes('.corrupt-'));
    assert.deepEqual(corrupt, [], 'nothing was kept aside');
  } finally {
    first();
    second();
    config.configWatchDeps.watch = realWatch;
  }
});

test('a config replaced by one of the same size and mtime is read fresh', () => {
  const configFile = config.configPath();
  fs.writeFileSync(configFile, JSON.stringify({ ui: { theme: 'aaaa' } }));
  const mtime = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(configFile, mtime, mtime);
  assert.equal(config.readConfig().ui.theme, 'aaaa');
  const temp = `${configFile}.tmp-same-size`;
  fs.writeFileSync(temp, JSON.stringify({ ui: { theme: 'bbbb' } }));
  fs.utimesSync(temp, mtime, mtime);
  fs.renameSync(temp, configFile);
  assert.equal(fs.statSync(configFile).mtimeMs, mtime.getTime());
  assert.equal(config.readConfig().ui.theme, 'bbbb');
});

test('a key saved by another process reaches this process although the config file is untouched', async () => {
  const account = config.SECRET_ACCOUNTS.agentApiKey('openai');
  await config.saveSecretAsync(account, 'sk-old-key');
  assert.equal(config.getAgentApiKey('openai'), 'sk-old-key');
  const configBefore = fs.existsSync(config.configPath()) ? fs.readFileSync(config.configPath(), 'utf8') : null;
  const seen = [];
  const unsubscribe = config.subscribeConfigChange(() => seen.push(config.getAgentApiKey('openai')));
  try {
    const writer = `
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const config = await import(${JSON.stringify(pathToFileURL(configModule).href)});
      await config.saveSecretAsync(config.SECRET_ACCOUNTS.agentApiKey('openai'), 'sk-new-key');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {
      env: { ...process.env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(await waitFor(() => seen.includes('sk-new-key')), `notified with ${JSON.stringify(seen)}`);
    assert.equal(config.getAgentApiKey('openai'), 'sk-new-key');
    const configAfter = fs.existsSync(config.configPath()) ? fs.readFileSync(config.configPath(), 'utf8') : null;
    assert.equal(configAfter, configBefore, 'the key never went through mixdog-config.json');
  } finally {
    unsubscribe();
  }
});

test('an MCP OAuth client secret and a Gmail app password changed in another process reach this one', async () => {
  const { mcpOAuthClientSecretAccount } = await import(pathToFileURL(oauthClientModule).href);
  const { gmailAppPasswordSecretAccount } = await import(pathToFileURL(gmailModule).href);
  const url = 'https://mcp.example.test/mcp';
  const mcpAccount = mcpOAuthClientSecretAccount(url);
  const gmailAccount = gmailAppPasswordSecretAccount('me@example.com');
  // The app password was saved here earlier; the other process forgets it.
  await config.keychainSecretStore.setSecretAsync(gmailAccount, 'abcdwxyzabcdwxyz');
  const before = config.secretChangeTokens();
  let notified = 0;
  const unsubscribe = config.subscribeConfigChange(() => {
    notified += 1;
  });
  try {
    const writer = `
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { saveMcpOAuthClientSecret } = await import(${JSON.stringify(pathToFileURL(oauthClientModule).href)});
      const { forgetGmailAppPassword } = await import(${JSON.stringify(pathToFileURL(gmailModule).href)});
      await saveMcpOAuthClientSecret(${JSON.stringify(url)}, 'client-secret-from-elsewhere');
      await forgetGmailAppPassword('me@example.com');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {
      env: { ...process.env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const changed = () => {
      const tokens = config.secretChangeTokens();
      return tokens[mcpAccount] !== before[mcpAccount] && tokens[gmailAccount] !== before[gmailAccount];
    };
    assert.ok(await waitFor(() => notified > 0 && changed()), 'both keychain writes were announced here');
    assert.equal(await config.keychainSecretStore.getSecretAsync(mcpAccount), 'client-secret-from-elsewhere');
    assert.equal(config.hasStoredSecret(gmailAccount), false);
    const marker = JSON.parse(fs.readFileSync(path.join(dirs.data, 'mixdog-secrets-changed.json'), 'utf8'));
    assert.equal(gmailAccount in marker, false, 'a deleted account leaves the marker');
  } finally {
    unsubscribe();
  }
});

test('a process with no change subscriber never serves a secret forgotten elsewhere from its cache', async () => {
  const { createRequire } = await import('node:module');
  const keychain = createRequire(import.meta.url)('../../lib/keychain-cjs.cjs');
  const { gmailAppPasswordSecretAccount } = await import(pathToFileURL(gmailModule).href);
  const account = gmailAppPasswordSecretAccount('cached@example.com');
  // The OS keychain, shared by every process, with this process's read cache.
  const shared = new Map();
  const cache = new Map();
  const real = { ...keychain };
  Object.assign(keychain, {
    getSecretAsync: async (key) =>
      cache.has(key) ? cache.get(key) : (cache.set(key, shared.get(key) ?? null), shared.get(key) ?? null),
    setSecretAsync: async (key, value) => void (shared.set(key, value), cache.delete(key)),
    invalidateSecretCache: (key) => (key == null ? cache.clear() : cache.delete(key)),
  });
  try {
    await config.keychainSecretStore.setSecretAsync(account, 'abcdwxyzabcdwxyz');
    assert.equal(await config.keychainSecretStore.getSecretAsync(account), 'abcdwxyzabcdwxyz');
    inAnotherProcess(`
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { forgetGmailAppPassword } = await import(${JSON.stringify(pathToFileURL(gmailModule).href)});
      await forgetGmailAppPassword('cached@example.com');
    `);
    shared.delete(account); // what the other process's delete did to the shared keychain
    assert.equal(await config.keychainSecretStore.getSecretAsync(account), null);
  } finally {
    Object.assign(keychain, real);
  }
});

test('a plugin installed or removed in another process reaches this one', async () => {
  const source = path.join(root, 'local-plugin');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'plugin.json'), JSON.stringify({ name: 'local-test' }));
  const tokens = [config.secretChangeTokens()['#plugins']];
  const unsubscribe = config.subscribeConfigChange(() => {});
  try {
    const admin = JSON.stringify(pathToFileURL(pluginAdminModule).href);
    inAnotherProcess(`const { addPlugin } = await import(${admin}); addPlugin(${JSON.stringify(source)});`);
    assert.ok(await waitFor(() => config.secretChangeTokens()['#plugins'] !== tokens[0]), 'the install was announced');
    tokens.push(config.secretChangeTokens()['#plugins']);
    inAnotherProcess(`const { removePlugin } = await import(${admin}); removePlugin('local-test');`);
    assert.ok(await waitFor(() => config.secretChangeTokens()['#plugins'] !== tokens[1]), 'the removal was announced');
  } finally {
    unsubscribe();
  }
});
