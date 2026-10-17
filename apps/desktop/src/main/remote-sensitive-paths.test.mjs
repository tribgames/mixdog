import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertNotSensitive,
  isSensitivePath,
  registerSensitiveRoot,
  sensitivePathMatcher,
} from './remote-sensitive-paths.ts';

const home = join(tmpdir(), 'someone');

test('credential folders, files and keys are denied; ordinary files are not', async () => {
  const denied = await sensitivePathMatcher();
  for (const path of [
    join(home, '.ssh', 'config'),
    join(home, '.gnupg', 'pubring.kbx'),
    join(home, '.aws', 'credentials'),
    join(home, '.azure', 'msal_token_cache.json'),
    join(home, '.kube', 'config'),
    join(home, '.docker', 'config.json'),
    join(home, '.config', 'gcloud', 'credentials.db'),
    join(home, '.netrc'),
    join(home, '.npmrc'),
    join(home, '.pypirc'),
    join(home, '.git-credentials'),
    join(home, 'project', '.env'),
    join(home, 'project', '.env.production'),
    join(home, 'project', 'prod.env'),
    join(home, 'project', 'cert.PEM'),
    join(home, 'project', 'tls.key'),
    join(home, 'project', 'bundle.p12'),
    join(home, 'project', 'bundle.pfx'),
    join(home, 'project', 'id_rsa'),
    join(home, 'project', 'id_ed25519_backup'),
    join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'),
    join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies'),
    join(home, '.mozilla', 'firefox', 'x.default', 'logins.json'),
    join(home, 'AppData', 'Roaming', 'Microsoft', 'Credentials', 'ABC'),
    join(home, 'AppData', 'Roaming', 'Microsoft', 'Protect', 'S-1-5', 'key'),
    join(home, 'Library', 'Keychains', 'login.keychain-db'),
    join(home, 'project', 'NOTES', '.SSH', 'x'),
    join(home, 'project', '.env::$DATA'),
    join(home, 'project', '.env.'),
  ]) {
    assert.equal(denied(path), true, path);
  }
  for (const path of [
    join(home, 'project', 'src', 'index.ts'),
    join(home, 'project', '.env.example'),
    join(home, 'project', '.env.sample'),
    join(home, 'project', 'id_rsa.pub'),
    join(home, 'project', 'keys.md'),
    join(home, 'project', '.venv', 'bin', 'python'),
  ]) {
    assert.equal(denied(path), false, path);
  }
});

test('secret file names are matched by explicit families, backups and exact template exceptions', async () => {
  const denied = await sensitivePathMatcher();
  const cases = [
    // Credential files, and backups of them.
    ['.npmrc', true],
    ['.npmrc.bak', true],
    ['.npmrc.old', true],
    ['.netrc~', true],
    ['.pypirc.orig', true],
    ['.git-credentials.backup.1', true],
    ['npmrc.md', false],
    ['.npmrc-guide.md', false],
    // Dotenv files: base, stages, `<stage>.env`, backups; only exact templates pass.
    ['.env', true],
    ['.env.local', true],
    ['.env.production', true],
    ['.env.production.local', true],
    ['.env.production.example', true],
    ['.env.example.local', true],
    ['.env.bak', true],
    ['prod.env', true],
    ['my.app.env', true],
    ['.env.example', false],
    ['.env.sample', false],
    ['.env.template', false],
    ['.env.dist', false],
    ['.env.example.bak', false],
    ['config.env.ts', false],
    ['environment.md', false],
    ['.venv', false],
    // Keys and keystores by extension, and backups of them.
    ['server.pem', true],
    ['server.pem.bak', true],
    ['tls.key~', true],
    ['store.jks', true],
    ['pem.md', false],
    ['keys.md', false],
    // OpenSSH private keys: no extension; the public half and documents pass.
    ['id_rsa', true],
    ['id_ed25519', true],
    ['id_ecdsa_sk', true],
    ['id_rsa_work', true],
    ['id_ed25519_backup', true],
    ['id_rsa.bak', true],
    ['id_rsa.pub', false],
    ['id_rsa_documentation.md', false],
    ['id_rsa.md', false],
    ['id_rsassa.txt', false],
    ['my_id_rsa_notes.txt', false],
  ];
  for (const [name, secret] of cases) {
    assert.equal(denied(join(home, 'project', name)), secret, name);
  }
});

test('a .git folder or pointer file is a secret folder of the shared list', async () => {
  const denied = await sensitivePathMatcher();
  assert.equal(denied(join(home, 'project', '.git', 'config')), true);
  assert.equal(denied(join(home, 'project', '.GIT', 'HEAD')), true);
  assert.equal(denied(join(home, 'project', 'worktree', '.git')), true);
  for (const open of ['.gitignore', '.github', '.gitattributes']) {
    assert.equal(denied(join(home, 'project', open, 'x')), false, open);
  }
});

test('Mixdog home and data folders keep only their secrets private', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-paths-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const previous = { home: process.env.MIXDOG_HOME, data: process.env.MIXDOG_DATA_DIR };
  t.after(() => {
    for (const [name, value] of [
      ['MIXDOG_HOME', previous.home],
      ['MIXDOG_DATA_DIR', previous.data],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.MIXDOG_HOME = join(base, 'mx');
  process.env.MIXDOG_DATA_DIR = join(base, 'elsewhere');
  const denied = await sensitivePathMatcher();
  for (const secret of [
    join('elsewhere', 'mixdog-config.json'),
    join('elsewhere', 'mixdog-config.json.bak-old'),
    join('elsewhere', 'secrets', 'agent.openai.apiKey.dpapi'),
    join('elsewhere', 'grok-oauth.json'),
    join('elsewhere', 'anthropic-oauth-credentials.json'),
    join('elsewhere', 'browser-bridge.json'),
    join('elsewhere', 'provider-accounts.json'),
    join('mx', 'agent', 'auth.json'),
    join('mx', 'relay-data', 'devices.json'),
  ]) {
    assert.equal(denied(join(base, secret)), true, secret);
  }
  for (const open of [
    join('elsewhere', 'tool-results', 'a.txt'),
    join('elsewhere', 'shell-output', 'job.log'),
    join('elsewhere', 'openai-oauth-models.json'),
    join('mx', 'projects.json'),
  ]) {
    assert.equal(denied(join(base, open)), false, open);
  }
});

test('a registered app profile is denied except its named subfolders', async () => {
  registerSensitiveRoot(join(home, 'profile'), ['Workspace']);
  const denied = await sensitivePathMatcher();
  assert.equal(denied(join(home, 'profile', 'relay-e2ee.json')), true);
  assert.equal(denied(join(home, 'profile', 'Local Storage', 'leveldb', '1.log')), true);
  assert.equal(denied(join(home, 'profile', 'workspace', 'unclassified', 'notes.md')), false);
});

test('Mixdog data and home inside a registered profile keep their own rule (dev and isolated profiles)', async (t) => {
  const profile = join(home, 'dev-isolated-profile');
  const previous = { home: process.env.MIXDOG_HOME, data: process.env.MIXDOG_DATA_DIR };
  t.after(() => {
    for (const [name, value] of [
      ['MIXDOG_HOME', previous.home],
      ['MIXDOG_DATA_DIR', previous.data],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.MIXDOG_HOME = join(profile, 'home');
  process.env.MIXDOG_DATA_DIR = join(profile, 'data');
  registerSensitiveRoot(profile, ['workspace']);
  const denied = await sensitivePathMatcher();
  // Generated media and tool output in the data folder stay reachable…
  assert.equal(denied(join(profile, 'data', 'media', '2026', 'image.png')), false);
  assert.equal(denied(join(profile, 'data', 'shell-output', 'job.log')), false);
  assert.equal(denied(join(profile, 'home', 'projects.json')), false);
  // …its secrets do not, nor does the rest of the profile.
  assert.equal(denied(join(profile, 'data', 'secrets', 'key.dpapi')), true);
  assert.equal(denied(join(profile, 'data', 'mixdog-config.json')), true);
  assert.equal(denied(join(profile, 'home', 'auth.json')), true);
  assert.equal(denied(join(profile, 'Local Storage', 'leveldb', '1.log')), true);
  assert.equal(denied(join(profile, 'relay-e2ee.json')), true);
});

test('a link cannot reach a denied place under an innocent name', async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sensitive-links-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, '.aws'));
  mkdirSync(join(base, 'plain'));
  symlinkSync(join(base, '.aws'), join(base, 'plain', 'shortcut'), 'junction');
  assert.equal(await isSensitivePath(join(base, 'plain', 'fresh.txt')), false);
  await assert.rejects(assertNotSensitive(join(base, 'plain', 'shortcut')), /credentials or secrets/);
  // A file that does not exist yet is judged by its nearest existing folder.
  await assert.rejects(assertNotSensitive(join(base, 'plain', 'shortcut', 'new.txt')), /credentials or secrets/);
  await assertNotSensitive(join(base, 'plain', 'fresh.txt'));
});
