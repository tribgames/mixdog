import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  acquireLease,
  allocatePorts,
  assertIsolation,
  copyDevAuth,
  instanceEnv,
  instanceProcessIds,
  isPidAlive,
  leaseIsStale,
  prepareAppDir,
  seedReadyConfig,
  startInstance,
  stopInstance,
  sweep,
} from './dev-isolated.mjs';
import { DEV_DEBUG_PORT, devRendererPortFor, persistentDevProfileDir } from './dev-profile.mjs';

const exec = promisify(execFile);
const moduleUrl = new URL('./dev-isolated.mjs', import.meta.url).href;

// Fixture instances must sit outside every shared location assertIsolation forbids. A TEMP
// inside ~/.mixdog (an agent session's scratch) is one of them, so the base moves out of it.
const isInside = (parent, path) => {
  const rel = relative(parent, path);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
};
const fixtureBase = isInside(join(homedir(), '.mixdog'), tmpdir()) ? homedir() : tmpdir();

test('the fixture base check treats only a whole ".." segment as leaving the shared folder', () => {
  const shared = join(homedir(), '.mixdog');
  assert.equal(isInside(shared, join(shared, '..scratch')), true, 'a child named ..scratch is inside');
  assert.equal(isInside(shared, join(shared, 'data', 'scratch')), true);
  assert.equal(isInside(shared, shared), true);
  assert.equal(isInside(shared, join(shared, '..', 'elsewhere')), false);
  assert.equal(isInside(shared, join(homedir(), '.mixdog-other')), false);
});

async function tempRoot(t) {
  const root = await mkdtemp(join(fixtureBase, 'mixdog-isolated-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid;
}

test('concurrent starters in separate processes never share a port, and never get 9342', async (t) => {
  const root = await tempRoot(t);
  // A small range around the shared port forces contention and the exclusion.
  const range = [DEV_DEBUG_PORT - 6, DEV_DEBUG_PORT + 5];
  const script = `
    const { allocatePorts } = await import(${JSON.stringify(moduleUrl)});
    const ports = await allocatePorts(${JSON.stringify(root)}, process.argv[1], { range: ${JSON.stringify(range)}, start: 0 });
    console.log(JSON.stringify(ports));`;
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      exec(process.execPath, ['--input-type=module', '-e', script, `agent-${index}`]).then(({ stdout }) =>
        JSON.parse(stdout)
      )
    )
  );
  const cdp = results.map((result) => result.cdpPort);
  assert.equal(new Set(cdp).size, cdp.length, `duplicate CDP ports: ${cdp}`);
  assert.equal(new Set(results.map((result) => result.rendererPort)).size, results.length);
  for (const { cdpPort, rendererPort } of results) {
    assert.notEqual(cdpPort, DEV_DEBUG_PORT);
    assert.notEqual(rendererPort, devRendererPortFor(DEV_DEBUG_PORT));
    assert.equal(rendererPort, devRendererPortFor(cdpPort));
  }
  assert.equal((await readdir(join(root, 'ports'))).length, 8);
});

test('the instance root carries the runtime package.json the SSH server payload reads', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'payload-000000');
  await mkdir(instanceDir, { recursive: true });
  await prepareAppDir(instanceDir);
  const repoPackage = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
  assert.equal(await readFile(join(instanceDir, 'package.json'), 'utf8'), repoPackage);
  assert.ok(existsSync(join(instanceDir, 'src', 'standalone', 'daemon.mjs')));
  assert.ok(existsSync(join(instanceDir, 'app', 'desktop', 'package.json')));
});

test('a port in use is skipped and its reservation released', async (t) => {
  const root = await tempRoot(t);
  const busy = new Set([9400, devRendererPortFor(9401)]);
  const ports = await allocatePorts(root, 'a', {
    range: [9400, 9403],
    start: 0,
    probe: async (port) => !busy.has(port),
  });
  assert.deepEqual(ports, { cdpPort: 9402, rendererPort: devRendererPortFor(9402) });
  assert.deepEqual(await readdir(join(root, 'ports')), ['9402.json']);
  await assert.rejects(allocatePorts(root, 'b', { range: [9402, 9402], probe: async () => true }), /No free/);
  await assert.rejects(
    allocatePorts(root, 'c', { range: [DEV_DEBUG_PORT, DEV_DEBUG_PORT], probe: async () => true }),
    /No free/
  );
});

test('an isolated instance keeps the Google OAuth client so the built-in sign-in can be tested', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'google-000000');
  const parent = {
    ...process.env,
    MIXDOG_GOOGLE_OAUTH_CLIENT_ID: 'mixdog.apps.googleusercontent.com',
    MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-public',
    MIXDOG_RELAY_URL: 'wss://relay.example.com',
  };
  const env = await instanceEnv({
    instanceDir,
    cdpPort: 9501,
    rendererPort: 10501,
    appDir: join(instanceDir, 'app', 'desktop'),
    parent,
  });
  assert.equal(env.MIXDOG_GOOGLE_OAUTH_CLIENT_ID, 'mixdog.apps.googleusercontent.com');
  assert.equal(env.MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET, 'GOCSPX-public');
  assert.equal(env.MIXDOG_RELAY_URL, 'off', 'every other live override is still replaced');
});

test('the instance environment never names the real data, userData or the shared dev profile', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'x-000000');
  const parent = {
    ...process.env,
    MIXDOG_DATA_DIR: join(homedir(), '.mixdog', 'data'),
    MIXDOG_HOME: join(homedir(), '.mixdog'),
    MIXDOG_DESKTOP_USER_DATA: 'C:\\real-user-data',
    MIXDOG_RELAY_URL: 'wss://relay.example.com',
  };
  const env = await instanceEnv({
    instanceDir,
    cdpPort: 9500,
    rendererPort: 10500,
    appDir: join(instanceDir, 'app', 'desktop'),
    parent,
  });
  for (const key of [
    'MIXDOG_DESKTOP_USER_DATA',
    'MIXDOG_HOME',
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
    'MIXDOG_BRIDGE_DISCOVERY_DIR',
    'MIXDOG_PROJECTS_FILE',
  ]) {
    assert.ok(env[key].startsWith(instanceDir), `${key}=${env[key]}`);
  }
  assert.equal(env.MIXDOG_RELAY_URL, 'off');
  assert.equal(env.MIXDOG_DEV_RENDERER_PORT, '10500');

  const ports = { instanceDir, cdpPort: 9500, rendererPort: 10500, parent };
  assert.throws(
    () => assertIsolation({ ...env, MIXDOG_DATA_DIR: join(homedir(), '.mixdog', 'data') }, ports),
    /MIXDOG_DATA_DIR/
  );
  assert.throws(() => assertIsolation({ ...env, MIXDOG_RELAY_URL: '' }, ports), /relay/);
  assert.throws(() => assertIsolation(env, { ...ports, cdpPort: DEV_DEBUG_PORT }), /9342/);
  assert.throws(() => assertIsolation(env, { ...ports, rendererPort: devRendererPortFor(DEV_DEBUG_PORT) }), /9342/);
  // An instance root placed inside a shared location is refused too.
  for (const shared of [join(homedir(), '.mixdog'), persistentDevProfileDir('default', parent)]) {
    const inside = join(shared, 'instances', 'y');
    const sharedEnv = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value.replace(instanceDir, inside)])
    );
    assert.throws(() => assertIsolation(sharedEnv, { ...ports, instanceDir: inside }), /shared location/);
  }
});

test('a ready profile skips onboarding and the guide, and keeps the dev profile routes when signed in', async (t) => {
  const root = await tempRoot(t);
  const devDataDir = join(root, 'dev-data');
  const dataDir = join(root, 'data');
  await mkdir(devDataDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const devConfig = {
    agent: { default: 'workflow-lead', providers: { 'anthropic-oauth': {} }, onboarding: { completed: false } },
    defaultsVersion: 3,
  };
  await writeFile(join(devDataDir, 'mixdog-config.json'), JSON.stringify(devConfig));
  const read = async () => JSON.parse(await readFile(join(dataDir, 'mixdog-config.json'), 'utf8'));

  await seedReadyConfig(dataDir, { withRoutes: true, devDataDir });
  const signedIn = await read();
  assert.equal(signedIn.agent.default, 'workflow-lead');
  assert.deepEqual(signedIn.agent.providers, { 'anthropic-oauth': {} });
  assert.equal(signedIn.defaultsVersion, 3);
  assert.equal(signedIn.agent.onboarding.completed, true);
  assert.equal(signedIn.agent.onboarding.version, 1);
  assert.deepEqual(signedIn.agent.onboarding.starterGuide, { closed: true, welcomed: true, visited: [] });

  await seedReadyConfig(dataDir, { devDataDir });
  const skipped = await read();
  assert.deepEqual(Object.keys(skipped), ['agent'], 'no routes without sign-ins');
  assert.deepEqual(Object.keys(skipped.agent), ['onboarding']);
  assert.equal(skipped.agent.onboarding.completed, true);

  await writeFile(
    join(devDataDir, 'mixdog-config.json'),
    JSON.stringify({ agent: { ...devConfig.agent, onboarding: { completed: true } }, defaultsVersion: 3 })
  );
  await seedReadyConfig(dataDir, { withRoutes: true, skipOnboarding: false, devDataDir });
  const firstRun = await read();
  assert.equal(firstRun.agent.default, 'workflow-lead', 'copy-auth with onboarding keeps the routes');
  assert.equal(firstRun.agent.onboarding, undefined, 'and leaves the first-run screens to run');
});

async function devProfile(root, { secrets = true } = {}) {
  const profile = join(root, 'dev-profile');
  await mkdir(join(profile, 'data', 'secrets'), { recursive: true });
  await writeFile(join(profile, 'data', 'provider-accounts.json'), '{}');
  await writeFile(join(profile, 'data', 'unrelated.json'), '{}');
  if (secrets) await writeFile(join(profile, 'data', 'secrets', 'a.dpapi'), 'secret');
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  return { profile, dataDir };
}

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

test('--copy-auth copies only allowlisted sign-ins; a missing secrets directory is a no-op', async (t) => {
  const root = await tempRoot(t);
  const { profile, dataDir } = await devProfile(root);
  assert.deepEqual(await copyDevAuth(dataDir, { devProfileDir: profile }), [
    'provider-accounts.json',
    'secrets/a.dpapi',
  ]);
  assert.equal(existsSync(join(dataDir, 'unrelated.json')), false);

  await rm(join(profile, 'data', 'secrets'), { recursive: true });
  const bare = join(root, 'data2');
  await mkdir(bare);
  assert.deepEqual(await copyDevAuth(bare, { devProfileDir: profile }), ['provider-accounts.json']);
});

test('--copy-auth copies each provider account credential the pool file names', async (t) => {
  const root = await tempRoot(t);
  const { profile, dataDir } = await devProfile(root, { secrets: false });
  const accounts = join(profile, 'data', 'provider-accounts', 'anthropic-oauth');
  await mkdir(accounts, { recursive: true });
  await writeFile(join(accounts, 'acct-1.json'), '{"token":"t"}');
  await writeFile(join(accounts, 'notes.txt'), 'skip');
  assert.deepEqual(await copyDevAuth(dataDir, { devProfileDir: profile }), [
    'provider-accounts.json',
    'provider-accounts/anthropic-oauth/acct-1.json',
  ]);
  assert.equal(
    readFileSync(join(dataDir, 'provider-accounts', 'anthropic-oauth', 'acct-1.json'), 'utf8'),
    '{"token":"t"}'
  );
  assert.equal(existsSync(join(dataDir, 'provider-accounts', 'anthropic-oauth', 'notes.txt')), false);
});

const DAY_MS = 24 * 3600_000;
const GPT_ACCOUNT = '62c398ce-834f-4b32-bfab-03d9c95cd018';
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');

/** The kept dev profile's layout: the pool file plus one GPT account credential beside it. */
async function gptProfile(root, overrides = {}) {
  const { profile, dataDir } = await devProfile(root);
  const accounts = join(profile, 'data', 'provider-accounts', 'openai-oauth');
  await mkdir(accounts, { recursive: true });
  const credential = {
    access_token: 'access-1',
    refresh_token: 'refresh-secret-1',
    expires_at: Date.now() + 10 * DAY_MS,
    account_id: 'acct',
    identity: { id: 'user:acct', email: 'dev@example.com' },
    ...overrides,
  };
  await writeFile(join(accounts, `${GPT_ACCOUNT}.json`), JSON.stringify(credential));
  return { profile, dataDir, credential, copiedPath: `provider-accounts/openai-oauth/${GPT_ACCOUNT}.json` };
}

/** Every file below `dir` with its bytes and mtime. */
async function snapshot(dir) {
  const rows = {};
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      for (const [name, row] of Object.entries(await snapshot(path))) rows[join(entry, name)] = row;
    } else {
      rows[entry] = { bytes: (await readFile(path)).toString('hex'), mtimeMs: info.mtimeMs };
    }
  }
  return rows;
}

test('--copy-auth copies sign-ins without refresh tokens and leaves the kept profile byte-identical', async (t) => {
  const root = await tempRoot(t);
  const { profile, dataDir, credential, copiedPath } = await gptProfile(root);
  const data = join(profile, 'data');
  await writeFile(
    join(data, 'openai-oauth.json'),
    JSON.stringify({ access_token: 'access-0', refresh_token: 'refresh-secret-0', expires_at: credential.expires_at })
  );
  await writeFile(
    join(data, 'anthropic-oauth-credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'claude-access', refreshToken: 'refresh-secret-2', expiresAt: 1, scopes: [] },
    })
  );
  const before = await snapshot(profile);

  const copied = await copyDevAuth(dataDir, { devProfileDir: profile });
  assert.deepEqual(copied.sort(), [
    'anthropic-oauth-credentials.json',
    'openai-oauth.json',
    'provider-accounts.json',
    copiedPath,
    'secrets/a.dpapi',
  ]);
  assert.deepEqual(await snapshot(profile), before, 'the kept profile is byte-identical after the copy');

  for (const name of ['anthropic-oauth-credentials.json', 'openai-oauth.json', copiedPath]) {
    assert.doesNotMatch(await readFile(join(dataDir, name), 'utf8'), /refresh/i, `${name} carries no refresh token`);
  }
  const { refresh_token: _kept, ...coasting } = credential;
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, copiedPath), 'utf8')), coasting);
  assert.equal(
    JSON.parse(await readFile(join(dataDir, 'anthropic-oauth-credentials.json'), 'utf8')).claudeAiOauth.accessToken,
    'claude-access'
  );
  assert.equal(await readFile(join(dataDir, 'provider-accounts.json'), 'utf8'), '{}');
  // The source still holds every refresh token it had.
  assert.match(await readFile(join(profile, 'data', copiedPath), 'utf8'), /refresh-secret-1/);
});

test('--copy-auth refuses a GPT access token that cannot last the lease and says how to refresh it', async (t) => {
  const root = await tempRoot(t);
  const cases = [
    ['expired', { expires_at: Date.now() - 60_000 }, /is expired/],
    [
      'inside-lease',
      { expires_at: Date.now() + 3600_000 },
      /valid for only \d+ more minutes, less than this 120-minute lease/,
    ],
    ['unreadable', { expires_at: undefined, access_token: 'opaque' }, /no readable access-token expiry/],
  ];
  const openKeptApp = /Open the kept dev app once \(npm run dev in apps\/desktop\)/;
  for (const [name, overrides, problem] of cases) {
    const caseRoot = join(root, name);
    await mkdir(caseRoot);
    const { profile, dataDir, copiedPath } = await gptProfile(caseRoot, overrides);
    let message = '';
    await assert.rejects(copyDevAuth(dataDir, { devProfileDir: profile }), (error) => {
      message = error.message;
      assert.match(message, problem, name);
      assert.doesNotMatch(message, /access-1|opaque|refresh-secret/);
      return true;
    });
    assert.equal(existsSync(join(dataDir, copiedPath)), false, `${name}: nothing is copied for the refused sign-in`);
    if (name === 'inside-lease') {
      // Opening the kept app would not refresh it yet: the message offers a shorter lease instead.
      assert.doesNotMatch(message, openKeptApp);
      const suggested = Number(/--ttl-minutes (\d+) or less/.exec(message)?.[1]);
      assert.ok(suggested > 0 && suggested < 60, `suggested lease ${suggested}`);
      const retryDir = join(caseRoot, 'retry');
      await mkdir(retryDir);
      await copyDevAuth(retryDir, { devProfileDir: profile, ttlMs: suggested * 60_000 });
      assert.equal(existsSync(join(retryDir, copiedPath)), true, 'the suggested lease is accepted');
    } else {
      assert.match(message, openKeptApp, name);
    }
  }

  // A token that clears a shorter lease is accepted, and the expiry may come from the JWT itself.
  const shortRoot = join(root, 'short');
  await mkdir(shortRoot);
  const short = await gptProfile(shortRoot, { expires_at: Date.now() + 3600_000 });
  await copyDevAuth(short.dataDir, { devProfileDir: short.profile, ttlMs: 30 * 60_000 });
  const jwtRoot = join(root, 'jwt');
  await mkdir(jwtRoot);
  const fromJwt = await gptProfile(jwtRoot, {
    expires_at: undefined,
    access_token: jwt({ exp: Math.floor((Date.now() + 10 * DAY_MS) / 1000) }),
  });
  await copyDevAuth(fromJwt.dataDir, { devProfileDir: fromJwt.profile });
  assert.equal(existsSync(join(fromJwt.dataDir, fromJwt.copiedPath)), true);
});

test('a start with --copy-auth is refused, and cleaned up, when the GPT access token is expired', async (t) => {
  const root = await tempRoot(t);
  const kept = join(root, 'kept');
  await mkdir(kept);
  const { profile } = await gptProfile(kept, { expires_at: Date.now() - 60_000 });
  const isolated = join(root, 'isolated');
  await assert.rejects(
    startInstance({ name: 'expired', copyAuth: true, root: isolated, devProfileDir: profile, timeoutMs: 1000 }),
    /GPT sign-in .* is expired.*Open the kept dev app once/
  );
  assert.deepEqual(await readdir(join(isolated, 'instances')), []);
  assert.deepEqual(await readdir(join(isolated, 'leases')), []);
});

test('--copy-auth fails clearly when the dev profile is missing, unreadable or holds no sign-ins', async (t) => {
  const root = await tempRoot(t);
  const { profile, dataDir } = await devProfile(root);
  await assert.rejects(copyDevAuth(dataDir, { devProfileDir: join(root, 'absent') }), /--copy-auth: cannot read/);
  // A data entry that is a file cannot be listed: the read error surfaces, not an empty list.
  const broken = join(root, 'broken');
  await mkdir(broken);
  await writeFile(join(broken, 'data'), 'not a directory');
  await assert.rejects(copyDevAuth(dataDir, { devProfileDir: broken }), /--copy-auth/);
  // An unreadable secrets directory is an error too, not "no secrets".
  await rm(join(profile, 'data', 'secrets'), { recursive: true });
  await writeFile(join(profile, 'data', 'secrets'), 'not a directory');
  await assert.rejects(copyDevAuth(dataDir, { devProfileDir: profile }), /--copy-auth: cannot read/);
  // Nothing to copy is a failure, not a silent success.
  const empty = join(root, 'empty');
  await mkdir(join(empty, 'data'), { recursive: true });
  await assert.rejects(copyDevAuth(dataDir, { devProfileDir: empty }), /no provider sign-ins/);
});

test('--copy-auth never reads through a link out of the dev profile', async (t) => {
  const root = await tempRoot(t);
  const outside = join(root, 'outside');
  await mkdir(join(outside, 'secrets'), { recursive: true });
  await writeFile(join(outside, 'provider-accounts.json'), 'stolen');
  await writeFile(join(outside, 'secrets', 'x.dpapi'), 'stolen');

  // The profile directory itself, its data directory and its secrets directory.
  const linkedProfile = join(root, 'linked-profile');
  await symlink(outside, linkedProfile, linkType);
  const { profile, dataDir } = await devProfile(root);
  const linkedData = join(root, 'linked-data');
  await mkdir(linkedData);
  await symlink(outside, join(linkedData, 'data'), linkType);
  await rm(join(profile, 'data', 'secrets'), { recursive: true });
  await symlink(join(outside, 'secrets'), join(profile, 'data', 'secrets'), linkType);
  for (const devProfileDir of [linkedProfile, linkedData, profile]) {
    await assert.rejects(copyDevAuth(dataDir, { devProfileDir }), /symlink or junction/);
  }
  assert.equal(existsSync(join(dataDir, 'secrets', 'x.dpapi')), false);

  // A linked credential file (file symlinks need a privilege some Windows accounts lack).
  const fileProfile = join(root, 'file-profile');
  await mkdir(join(fileProfile, 'data'), { recursive: true });
  try {
    await symlink(join(outside, 'provider-accounts.json'), join(fileProfile, 'data', 'provider-accounts.json'), 'file');
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('file symlink not permitted here; skipping the linked-file case');
    return;
  }
  // A fresh destination: the profile case above already copied its own regular file.
  const fileDataDir = join(root, 'file-dest');
  await assert.rejects(copyDevAuth(fileDataDir, { devProfileDir: fileProfile }), /symlink or junction/);
  assert.equal(existsSync(join(fileDataDir, 'provider-accounts.json')), false);
});

test('--copy-auth refuses a link above the kept dev profile, but accepts a linked trusted root', async (t) => {
  const root = await tempRoot(t);
  const outside = join(root, 'outside');
  await mkdir(join(outside, 'default', 'data', 'secrets'), { recursive: true });
  await writeFile(join(outside, 'default', 'data', 'provider-accounts.json'), 'stolen');
  await writeFile(join(outside, 'default', 'data', 'secrets', 'x.dpapi'), 'stolen');
  await writeFile(join(outside, 'default', 'data', 'mixdog-config.json'), '{}');

  // base/mixdog-dev is a junction (on Windows: fs.symlinkSync(target, path, 'junction'), no admin needed).
  const base = join(root, 'base');
  await mkdir(base);
  const keptRoot = join(base, 'mixdog-dev');
  try {
    await symlink(outside, keptRoot, linkType);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip(`${linkType} creation denied (${error.code}); the ancestor-link case did not run`);
    return;
  }
  const dataDir = join(root, 'data');
  await mkdir(dataDir);

  // The default trusted root is the directory holding mixdog-dev.
  await assert.rejects(copyDevAuth(dataDir, { devProfileDir: join(keptRoot, 'default') }), /symlink or junction/);
  await assert.rejects(
    seedReadyConfig(dataDir, { withRoutes: true, devDataDir: join(keptRoot, 'default', 'data') }),
    /symlink or junction/
  );
  // A link deeper above the profile is caught from an explicit, higher trusted root.
  const deep = join(base, 'deep');
  await mkdir(deep);
  await symlink(outside, join(deep, 'kept'), linkType);
  await assert.rejects(
    copyDevAuth(dataDir, { devProfileDir: join(deep, 'kept', 'default'), trustedRoot: base }),
    /symlink or junction/
  );
  assert.deepEqual(await readdir(dataDir), []);

  // The trusted root itself may be reached through a link; only components below it are checked.
  await devProfile(root);
  const alias = join(root, 'alias');
  await symlink(root, alias, linkType);
  assert.deepEqual(await copyDevAuth(dataDir, { devProfileDir: join(alias, 'dev-profile'), trustedRoot: alias }), [
    'provider-accounts.json',
    'secrets/a.dpapi',
  ]);
});

test('a failed --copy-auth aborts the start and cleans up its instance', async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(
    startInstance({ name: 'noauth', copyAuth: true, root, devProfileDir: join(root, 'absent'), timeoutMs: 1000 }),
    /--copy-auth: cannot read/
  );
  assert.deepEqual(await readdir(join(root, 'instances')), []);
  assert.deepEqual(await readdir(join(root, 'leases')), []);
});

test('stale leases (dead owner or past TTL) are reclaimed; a live one is refused', async (t) => {
  const root = await tempRoot(t);
  const list = () => [];
  const writeLease = async (name, lease) => {
    const instanceDir = join(root, 'instances', `${name}-abcdef`);
    await mkdir(join(instanceDir, 'profile'), { recursive: true });
    await mkdir(join(root, 'leases'), { recursive: true });
    await mkdir(join(root, 'ports'), { recursive: true });
    await writeFile(join(root, 'ports', `${lease.cdpPort}.json`), JSON.stringify({ name }));
    await writeFile(join(root, 'leases', `${name}.json`), JSON.stringify({ name, instanceDir, ...lease }));
    return instanceDir;
  };
  const dead = await writeLease('dead', {
    pid: await deadPid(),
    cdpPort: 9601,
    startedAt: new Date().toISOString(),
    ttlMs: 60_000,
  });
  const old = await writeLease('old', {
    pid: process.pid,
    cdpPort: 9602,
    startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  });
  await writeLease('live', { pid: process.pid, cdpPort: 9603, startedAt: new Date().toISOString(), ttlMs: 60_000 });

  assert.equal(leaseIsStale({ pid: process.pid, startedAt: new Date().toISOString() }), false);
  await acquireLease(root, 'dead', { list });
  assert.equal(existsSync(dead), false);
  await assert.rejects(acquireLease(root, 'live', { list }), /is running/);

  const swept = await sweep(root, { list });
  assert.deepEqual(
    swept.map((result) => result.name),
    ['old']
  );
  assert.equal(existsSync(old), false);
  assert.deepEqual((await readdir(join(root, 'leases'))).sort(), ['dead.json', 'live.json']);
  assert.deepEqual(await readdir(join(root, 'ports')), ['9603.json']);
});

test('process matching: the instance tree and its daemon, never a reused or unrelated pid', () => {
  const instanceDir = 'C:\\iso\\instances\\a-123456';
  const processes = [
    { pid: 10, ppid: 1, cmd: `node electron-vite.js dev --outDir ${instanceDir}\\app\\desktop\\out` },
    { pid: 11, ppid: 10, cmd: `electron.exe ${instanceDir}\\app\\desktop` },
    { pid: 12, ppid: 11, cmd: 'electron.exe C:\\repo\\src\\standalone\\daemon.mjs' },
    { pid: 13, ppid: 12, cmd: 'node memory\\index.mjs' },
    { pid: 20, ppid: 1, cmd: 'electron.exe C:\\iso\\instances\\a-123456-ffffff\\app\\desktop' },
    { pid: 30, ppid: 1, cmd: 'electron.exe --remote-debugging-port=9342 .' },
    { pid: 40, ppid: 99, cmd: 'orphan child of a killed main' },
  ];
  const needle = `${instanceDir}\\`;
  assert.deepEqual(instanceProcessIds(processes, { needle }).sort(), [10, 11, 12, 13]);
  assert.deepEqual(
    instanceProcessIds(processes, { needle, ancestors: new Map([[99, undefined]]) }).sort(),
    [10, 11, 12, 13, 40]
  );
  assert.deepEqual(instanceProcessIds(processes, { needle: 'nothing', ancestors: new Map([[30, undefined]]) }), []);
});

test('process matching: a process naming a reused parent pid is not adopted (Windows keeps dead parents in ppid)', () => {
  const instanceDir = 'C:\\iso\\instances\\a-123456';
  const processes = [
    { pid: 10, ppid: 1, cmd: `electron.exe ${instanceDir}\\app\\desktop`, created: 5_000 },
    { pid: 11, ppid: 10, cmd: 'electron.exe --type=renderer', created: 5_100 },
    // Opened by the user long before; its real parent (pid 10 back then) died and the pid was reused.
    { pid: 50, ppid: 10, cmd: 'Notepad.exe', created: 1_000 },
    // Same story through an already killed ancestor (pid 77 started at 4_000).
    { pid: 51, ppid: 77, cmd: 'Notepad.exe', created: 2_000 },
    { pid: 52, ppid: 77, cmd: 'orphan child of the killed main', created: 4_500 },
  ];
  const ids = instanceProcessIds(processes, { needle: `${instanceDir}\\`, ancestors: new Map([[77, 4_000]]) }).sort();
  assert.deepEqual(ids, [10, 11, 52]);
});

test('process matching: a killed ancestor pid reused by another process does not adopt that process children', () => {
  const processes = [
    // pid 77 was our main (started 4_000, killed); an unrelated program now holds pid 77.
    { pid: 77, ppid: 1, cmd: 'unrelated.exe', created: 6_000 },
    { pid: 78, ppid: 77, cmd: 'child of the unrelated program', created: 6_100 },
    { pid: 79, ppid: 77, cmd: 'orphan child of the killed main', created: 4_500 },
  ];
  const ids = instanceProcessIds(processes, { needle: 'nothing', ancestors: new Map([[77, 4_000]]) }).sort();
  assert.deepEqual(ids, [79]);
});

test('stop kills the whole tree, an orphaned daemon included, and deletes the instance', async (t) => {
  const root = await tempRoot(t);
  const instanceDir = join(root, 'instances', 'tree-abcdef');
  const profile = join(instanceDir, 'profile');
  await mkdir(join(profile, 'runtime'), { recursive: true });
  // A link like the real layout's: stopping must remove the link, not its target.
  const target = join(root, 'link-target');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'x');
  await symlink(target, join(instanceDir, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  // A parent naming the instance that spawns a grandchild which does not.
  const tree = spawn(
    process.execPath,
    [
      '-e',
      "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e3)'],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1e3)",
      join(instanceDir, 'marker'),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const treeReady = new Promise((resolve) => tree.stdout.once('data', resolve));
  // A daemon whose parent is gone: found only through the profile's daemon.json.
  const daemonDir = join(root, 'repo', 'src', 'standalone');
  await mkdir(daemonDir, { recursive: true });
  await writeFile(join(daemonDir, 'daemon.mjs'), 'setInterval(() => {}, 1000);');
  const daemon = spawn(process.execPath, [join(daemonDir, 'daemon.mjs')], { stdio: 'ignore', detached: true });
  daemon.unref();
  await writeFile(join(profile, 'runtime', 'daemon.json'), JSON.stringify({ pid: daemon.pid }));
  t.after(() => {
    for (const pid of [tree.pid, daemon.pid]) if (isPidAlive(pid)) process.kill(pid);
  });
  await treeReady; // the grandchild exists once the parent says so

  const lease = { name: 'tree', instanceDir, profile, startedAt: new Date().toISOString(), cdpPort: 9700 };
  await mkdir(join(root, 'leases'), { recursive: true });
  await writeFile(join(root, 'leases', 'tree.json'), JSON.stringify(lease));
  const result = await stopInstance(root, lease);
  assert.deepEqual(result.remaining, []);
  assert.equal(result.removed, true);
  assert.ok(result.killed.includes(tree.pid) && result.killed.includes(daemon.pid));
  assert.equal(result.killed.length, 3, `killed ${result.killed}`);
  assert.equal(isPidAlive(tree.pid), false);
  assert.equal(isPidAlive(daemon.pid), false);
  assert.equal(existsSync(instanceDir), false);
  assert.equal(existsSync(join(target, 'keep.txt')), true);
  assert.deepEqual(await readdir(join(root, 'leases')), []);
});
