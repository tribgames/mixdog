import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isSensitiveLocalPath, matchesSensitivePath, mixdogSensitiveScopes } from './sensitive-path-rules.mjs';

const home = join(tmpdir(), 'someone');

const project = (...rest) => join(home, 'project', ...rest);
const denied = (paths) => {
  for (const path of paths) assert.equal(matchesSensitivePath(path), true, path);
};
const allowed = (paths) => {
  for (const path of paths) assert.equal(matchesSensitivePath(path), false, path);
};

test('credential JSON: credentials.json, *credentials*.json, service accounts, OAuth client secrets', () => {
  denied([
    project('credentials.json'),
    project('gcp-credentials-prod.json'),
    project('Credential.JSON'),
    project('service-account.json'),
    project('service_account_key.json'),
    project('client_secret_123.apps.googleusercontent.com.json'),
    project('credentials.json.bak'),
  ]);
  allowed([project('credentials.md'), project('package.json'), project('accounts.json')]);
});

test('every .env* file is denied, templates included; templates only for a user-initiated remote open', () => {
  denied([
    project('.env'),
    project('.env.local'),
    project('.env.production.local'),
    project('.envrc'),
    project('.environment'),
    project('.env-staging'),
    project('prod.env'),
    project('.env.example'),
    project('.env.sample'),
    project('.env.template'),
    project('.env.dist'),
  ]);
  assert.equal(matchesSensitivePath(project('.env.example'), [], { envTemplates: true }), false);
  assert.equal(matchesSensitivePath(project('.env.example.local'), [], { envTemplates: true }), true);
  assert.equal(matchesSensitivePath(project('.env'), [], { envTemplates: true }), true);
  allowed([project('environment.md'), project('env.ts')]);
});

test('token files: .netrc, .npmrc, .pypirc and their backups', () => {
  denied([join(home, '.netrc'), join(home, '_netrc'), project('.npmrc'), project('.pypirc'), project('.npmrc.bak.1')]);
});

test('private keys: any id_<type> without extension, key and keystore extensions', () => {
  denied([
    project('id_rsa'),
    project('id_ed25519'),
    project('id_ecdsa_sk'),
    project('id_xmss'),
    project('id_rsa_work'),
    project('tls.KEY'),
    project('cert.pem'),
    project('bundle.p12'),
    project('bundle.pfx'),
    project('vault.kdbx'),
    project('putty.ppk'),
  ]);
  allowed([project('id_rsa.pub'), project('id_rsa_notes.md'), project('keys.txt')]);
});

test('cloud CLI folders and files', () => {
  denied([
    join(home, '.aws', 'credentials'),
    join(home, '.aws', 'config'),
    join(home, '.azure', 'msal_token_cache.json'),
    join(home, '.config', 'gcloud', 'application_default_credentials.json'),
    join(home, '.config', 'gcloud', 'configurations', 'config_default'),
    join(home, '.kube', 'config'),
    join(home, '.docker', 'config.json'),
    join(home, '.ssh', 'config'),
    project('.git', 'config'),
  ]);
  allowed([join(home, '.docker', 'daemon.md'), project('shot.png'), project('notes.md')]);
});

test("Mixdog's own folders deny only their secret subset", () => {
  const data = join(home, 'mixdog-data');
  const within = mixdogSensitiveScopes([data]);
  assert.equal(matchesSensitivePath(join(data, 'secrets', 'x.json'), within), true);
  assert.equal(matchesSensitivePath(join(data, 'openai-oauth.json'), within), true);
  assert.equal(matchesSensitivePath(join(data, 'media', 'assets', 'a.png'), within), false);
  assert.equal(isSensitiveLocalPath(join(data, 'mcp-oauth', 'a.rev'), { extraData: [data] }), true);
});
