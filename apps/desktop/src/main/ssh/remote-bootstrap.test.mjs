import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isTerminalRemoteError,
  parseRemoteDiscovery,
  parseRemoteReport,
  REMOTE_DESKTOP_DEPENDENCIES,
  RemoteBootstrapError,
  remoteFileUrl,
  remoteLayout,
  remoteShellCommand,
} from './remote-bootstrap.ts';
import { remoteProgramScript } from './remote-install-program.ts';
import { remoteSessionOptions, resolveRemoteCwd } from './remote-session.ts';

const daemonJson = (overrides = {}) =>
  JSON.stringify({
    pid: 4242,
    endpoints: { session: { port: 41001, token: 'secret-token' }, channel: { port: 41002, token: 'c' } },
    ...overrides,
  });

test('remote discovery reads the session endpoint and pid from daemon.json', () => {
  assert.deepEqual(parseRemoteDiscovery(daemonJson()), { port: 41001, token: 'secret-token', pid: 4242 });
  assert.deepEqual(parseRemoteDiscovery(JSON.parse(daemonJson())), { port: 41001, token: 'secret-token', pid: 4242 });
});

test('remote discovery rejects incomplete or malformed daemon.json', () => {
  assert.equal(parseRemoteDiscovery('not json'), null);
  assert.equal(parseRemoteDiscovery(null), null);
  assert.equal(parseRemoteDiscovery(daemonJson({ pid: 0 })), null);
  assert.equal(parseRemoteDiscovery(daemonJson({ pid: 'x' })), null);
  assert.equal(parseRemoteDiscovery(daemonJson({ endpoints: { session: { port: 41001 } } })), null);
  assert.equal(parseRemoteDiscovery(daemonJson({ endpoints: { session: { port: 70000, token: 't' } } })), null);
  assert.equal(parseRemoteDiscovery(daemonJson({ endpoints: { channel: { port: 1, token: 't' } } })), null);
});

test('bootstrap report parsing takes the result line, its discovery and the install state', () => {
  const result = {
    home: '/home/alice',
    uid: 1000,
    nodeVersion: '22.19.0',
    runtimeRoot: '/tmp/mixdog-1000',
    versionDir: '/home/alice/.mixdog-remote/versions/1.1.2-0123456789abcdef',
    installed: true,
    installedVersion: '1.1.2',
    terminalsAvailable: false,
    terminalsError: 'no prebuilt binary',
    daemonJson: daemonJson(),
    healthy: true,
    daemonVersion: '1.1.2',
    daemonBuildHash: '0123456789abcdef',
    daemonCurrent: true,
  };
  const report = parseRemoteReport(
    `motd noise\nMIXDOG_PLATFORM Linux x86_64|glibc\nMIXDOG_RESULT ${JSON.stringify(result)}\n`
  );
  assert.equal(report.home, '/home/alice');
  assert.equal(report.healthy, true);
  assert.equal(report.daemonCurrent, true);
  assert.equal(report.terminalsAvailable, false);
  assert.equal(report.packageVersion, '1.1.2');
  assert.deepEqual(report.discovery, { port: 41001, token: 'secret-token', pid: 4242 });
  assert.equal(report.modelProxy, null);
  assert.equal(report.started, false);
  assert.equal(report.replaced, null);
  const replaced = parseRemoteReport(
    `MIXDOG_RESULT ${JSON.stringify({ ...result, modelProxy: 'client', started: true, replaced: { pid: 7, version: '1.1.1', graceful: true } })}`
  );
  assert.equal(replaced.modelProxy, 'client');
  assert.deepEqual(replaced.replaced, { pid: 7, version: '1.1.1', buildHash: null, graceful: true });
  const missing = parseRemoteReport(`MIXDOG_RESULT ${JSON.stringify({ ...result, daemonJson: null, healthy: true })}`);
  assert.equal(missing.discovery, null);
  assert.equal(missing.healthy, false);
  assert.equal(missing.daemonCurrent, false);
});

test('bootstrap errors surface their code and message', () => {
  assert.throws(
    () =>
      parseRemoteReport('MIXDOG_ERROR node-too-old Mixdog needs Node.js 22 or newer on the server; found 20.11.1.\n'),
    (error) =>
      error instanceof RemoteBootstrapError && error.code === 'node-too-old' && /found 20\.11\.1/.test(error.message)
  );
  assert.throws(
    () => parseRemoteReport('bash: sh: not found'),
    (error) => error.code === 'protocol'
  );
});

test('an unsupported platform outranks whatever failed after the probe', () => {
  assert.throws(
    () => parseRemoteReport('MIXDOG_PLATFORM Linux x86_64|musl\nMIXDOG_ERROR node-missing Node.js was not found\n'),
    (error) => error.code === 'unsupported-platform' && /musl/.test(error.message) && isTerminalRemoteError(error)
  );
});

test('the login shell only ever sees base64 inside single quotes', () => {
  const script = remoteProgramScript({
    mode: 'probe',
    installId: '1.1.2-0123456789abcdef',
    version: '1.1.2',
    buildHash: '0123456789abcdef',
  });
  const command = remoteShellCommand(script);
  const match = /^sh -c 'eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/.exec(command);
  assert.ok(match, command.slice(0, 80));
  assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), script);
  assert.match(script, /Node\.js 22 or newer/);
  assert.match(script, /uname -sm/);
  assert.doesNotMatch(script, /npm root -g|npm i -g/);
  // ssh.exe on Windows takes at most 32767 characters of command line.
  assert.ok(command.length < 30_000, `command line is ${command.length} characters`);
});

test('server layout lives in an immutable version dir and options are remapped there', () => {
  const layout = remoteLayout('/home/alice', '1.1.2-0123456789abcdef');
  assert.equal(layout.base, '/home/alice/.mixdog-remote/versions/1.1.2-0123456789abcdef');
  assert.equal(
    layout.bundlePath,
    '/home/alice/.mixdog-remote/versions/1.1.2-0123456789abcdef/apps/desktop/out/main/daemon.cjs'
  );
  assert.equal(
    remoteFileUrl(layout.bundlePath, '1.1.2:abc'),
    'file:///home/alice/.mixdog-remote/versions/1.1.2-0123456789abcdef/apps/desktop/out/main/daemon.cjs?build=1.1.2%3Aabc'
  );
  assert.equal(remoteFileUrl('/home/a b/x#y.cjs'), 'file:///home/a%20b/x%23y.cjs');
  const local = {
    userDataPath: 'C:\\Users\\alice\\AppData\\Roaming\\Mixdog',
    packaged: true,
    resourcesPath: 'C:\\Program Files\\Mixdog\\resources',
    appPath: 'C:\\Program Files\\Mixdog\\resources\\app.asar',
    appVersion: '1.1.2',
    rendererDir: 'C:\\Program Files\\Mixdog\\resources\\app.asar.unpacked\\out\\renderer',
  };
  const base = '/home/alice/.mixdog-remote/versions/1.1.2-0123456789abcdef';
  assert.deepEqual(remoteSessionOptions(local, layout), {
    userDataPath: '/home/alice/.mixdog-remote/user-data',
    packaged: false,
    resourcesPath: `${base}/resources`,
    appPath: `${base}/apps/desktop`,
    appVersion: '1.1.2',
    rendererDir: `${base}/apps/desktop/out/renderer`,
  });
  assert.throws(() => remoteLayout('relative/home', '1.1.2-0123456789abcdef'));
  assert.throws(() => remoteLayout('/home/alice', '../escape'));
});

const desktopDir = fileURLToPath(new URL('../../../', import.meta.url));

// PROPOSED SOURCE-TEXT EXCEPTION: build-daemon.mjs runs the esbuild build on import, so its
// DAEMON_EXTERNALS list cannot be imported and is read as text.
test('server-installed bundle externals are exactly the build externals, pinned to the lockfile', () => {
  const build = readFileSync(join(desktopDir, 'scripts', 'build-daemon.mjs'), 'utf8');
  const externals = [...(/DAEMON_EXTERNALS = \[([^\]]*)\]/.exec(build)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(
    (m) => m[1]
  );
  assert.deepEqual(Object.keys(REMOTE_DESKTOP_DEPENDENCIES).sort(), externals.sort());
  const lock = JSON.parse(readFileSync(join(desktopDir, 'package-lock.json'), 'utf8'));
  for (const [name, version] of Object.entries(REMOTE_DESKTOP_DEPENDENCIES)) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version, name);
  }
});

test('remote cwd defaults to the server home and expands ~', () => {
  assert.equal(resolveRemoteCwd(null, '/home/alice'), '/home/alice');
  assert.equal(resolveRemoteCwd('~/src/app', '/home/alice'), '/home/alice/src/app');
  assert.equal(resolveRemoteCwd('/srv/app/', '/home/alice'), '/srv/app/');
  assert.throws(() => resolveRemoteCwd('src/app', '/home/alice'));
});
