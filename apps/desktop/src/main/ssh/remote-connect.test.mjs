import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import {
  bootstrapRemoteDaemon,
  isTerminalRemoteError,
  RemoteBootstrapError,
  sshHostGraceMs,
} from './remote-bootstrap.ts';
import { describeConnectFailure } from './connect-failure.ts';
import { runWithSshContext } from './ssh-context.ts';
import { createServerPayload, setServerPayloadResolver } from './remote-install-payload.ts';
import { RemoteSession } from './remote-session.ts';
import { parseSshTarget, SshError } from './ssh-command.ts';

const BUNDLE = Buffer.from('module.exports = {};\n');
const BUNDLE_SHA = createHash('sha256').update(BUNDLE).digest('hex');
const SESSION_TOKEN = 'session-secret-1';

const fixturePayload = (bundle) =>
  createServerPayload(
    [
      { path: 'package.json', source: Buffer.from('{"name":"mixdog","version":"1.1.2"}') },
      { path: 'src/standalone/daemon.mjs', source: Buffer.from('// daemon\n') },
      { path: 'apps/desktop/out/main/daemon.cjs', source: bundle },
    ],
    '1.1.2'
  );
const PAYLOAD = await fixturePayload(BUNDLE);
setServerPayloadResolver(fixturePayload);
after(() => setServerPayloadResolver(null));

/** ssh stand-in: each exec prints the next scripted stdout and exits. */
function scriptedSsh(replies) {
  const calls = [];
  const inputs = [];
  const spawnImpl = (_command, args) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(args);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    const chunks = [];
    child.stdin.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('end', () => inputs.push(Buffer.concat(chunks)));
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(reply.stdout ?? '');
      child.stderr.end(reply.stderr ?? '');
      setTimeout(() => {
        child.exitCode = reply.code ?? 0;
        child.emit('close', child.exitCode, null);
      }, 5);
    });
    return child;
  };
  return { calls, inputs, spawnImpl };
}

/** The server program arguments of one recorded ssh call. */
function programArgs(sshArgs) {
  const command = sshArgs[sshArgs.length - 1];
  const script = Buffer.from(/printf %s ([A-Za-z0-9+/=]+) \|/.exec(command)[1], 'base64').toString('utf8');
  const encoded = /'([A-Za-z0-9+/=]+)'\s*$/.exec(script.trim())[1];
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

const result = (overrides = {}) => ({
  stdout: `MIXDOG_PLATFORM Linux x86_64|glibc\nMIXDOG_RESULT ${JSON.stringify({
    home: '/home/alice',
    uid: 1000,
    nodeVersion: '22.19.0',
    runtimeRoot: '/tmp/mixdog-1000',
    versionDir: `/home/alice/.mixdog-remote/versions/${PAYLOAD.installId}`,
    installed: true,
    installedVersion: '1.1.2',
    terminalsAvailable: true,
    daemonJson: JSON.stringify({ pid: 4242, endpoints: { session: { port: 41000, token: SESSION_TOKEN } } }),
    healthy: true,
    modelProxy: 'client',
    daemonVersion: '1.1.2',
    daemonBuildHash: PAYLOAD.buildHash,
    daemonBusy: 0,
    daemonCurrent: true,
    started: false,
    ...overrides,
  })}\n`,
});

const stale = { daemonVersion: '1.1.1', daemonBuildHash: 'ffffffffffffffff', daemonCurrent: false };

const bootstrap = (ssh, extra = {}) =>
  bootstrapRemoteDaemon({
    target: parseSshTarget('devbox'),
    args: { version: '1.1.2', graceMs: '' },
    bundle: BUNDLE,
    bundleSha256: BUNDLE_SHA,
    spawnImpl: ssh.spawnImpl,
    ...extra,
  });

test('a current, healthy daemon in client proxy mode is reused after one probe', async () => {
  const ssh = scriptedSsh([result()]);
  const state = await bootstrap(ssh);
  assert.deepEqual(state.discovery, { port: 41000, token: SESSION_TOKEN, pid: 4242 });
  assert.equal(state.terminalsAvailable, true);
  assert.equal(state.layout.base, `/home/alice/.mixdog-remote/versions/${PAYLOAD.installId}`);
  assert.equal(ssh.calls.length, 1);
  assert.equal(programArgs(ssh.calls[0]).mode, 'probe');
  assert.equal(programArgs(ssh.calls[0]).buildHash, PAYLOAD.buildHash);
});

test('the saved server grace (minutes, clamped) is forwarded for the daemon start', async () => {
  assert.equal(sshHostGraceMs(undefined), 30 * 60_000);
  assert.equal(sshHostGraceMs(-5), 30 * 60_000);
  assert.equal(sshHostGraceMs(Number.NaN), 30 * 60_000);
  assert.equal(sshHostGraceMs(0.25), 60_000);
  assert.equal(sshHostGraceMs(90), 90 * 60_000);
  assert.equal(sshHostGraceMs(30 * 24 * 60), 7 * 24 * 60 * 60_000);
  const graceOf = async (context, graceMs = '') => {
    const ssh = scriptedSsh([result({ ...stale }), result({ started: true })]);
    const run = () => bootstrap(ssh, { args: { version: '1.1.2', graceMs } });
    await (context ? runWithSshContext(context, run) : run());
    return ssh.calls.map((call) => programArgs(call).graceMs);
  };
  assert.deepEqual(await graceOf(null), ['1800000', '1800000']);
  assert.deepEqual(await graceOf({ settings: { graceMinutes: 90 } }), ['5400000', '5400000']);
  assert.deepEqual(await graceOf({ settings: {} }), ['1800000', '1800000']);
  // The desktop's own MIXDOG_REMOTE_CLIENT_GRACE_MS stays a developer override.
  assert.deepEqual(await graceOf({ settings: { graceMinutes: 90 } }, '5000'), ['5000', '5000']);
});

test('a missing install uploads the payload archive in the ensure run', async () => {
  const ssh = scriptedSsh([
    result({ installed: false, healthy: false, daemonJson: null, daemonCurrent: false, terminalsAvailable: null }),
    result({ started: true }),
  ]);
  const state = await bootstrap(ssh);
  assert.equal(ssh.calls.length, 2);
  const ensure = programArgs(ssh.calls[1]);
  assert.equal(ensure.mode, 'ensure');
  assert.equal(ensure.upload, true);
  assert.equal(ensure.installId, PAYLOAD.installId);
  assert.deepEqual(ssh.inputs[1], await PAYLOAD.archive());
  assert.equal(state.report.started, true);
});

test('an installed build with another daemon runs ensure without upload; forceRestart is forwarded', async () => {
  const ssh = scriptedSsh([
    result({ ...stale, modelProxy: null }),
    result({ replaced: { pid: 4000, version: '1.1.1' } }),
  ]);
  const state = await bootstrap(ssh, { forceRestart: true });
  const ensure = programArgs(ssh.calls[1]);
  assert.equal(ensure.upload, false);
  assert.equal(ensure.forceRestart, true);
  assert.equal(ssh.inputs[1].length, 0);
  assert.equal(state.report.replaced.pid, 4000);
});

test('a build removed between probe and ensure is uploaded on a second ensure', async () => {
  const ssh = scriptedSsh([
    result({ ...stale }),
    { stdout: 'MIXDOG_ERROR install-missing The server install is missing and must be uploaded.\n', code: 3 },
    result(),
  ]);
  await bootstrap(ssh);
  assert.equal(ssh.calls.length, 3);
  assert.equal(programArgs(ssh.calls[2]).upload, true);
});

test('a busy daemon of another build fails with its version and pid, as a terminal error', async () => {
  const message = 'A Mixdog daemon of another version (mixdog 1.1.1, pid 4000) is running 1 turn on the server.';
  const ssh = scriptedSsh([
    result({ ...stale, daemonBusy: 1 }),
    { stdout: `MIXDOG_ERROR daemon-busy-other-version ${message}\n`, code: 3 },
  ]);
  await assert.rejects(bootstrap(ssh), (error) => {
    assert.equal(error.code, 'daemon-busy-other-version');
    assert.match(error.message, /1\.1\.1/);
    assert.match(error.message, /pid 4000/);
    assert.ok(isTerminalRemoteError(error));
    return true;
  });
});

const ATTACHED = {
  stdout:
    'MIXDOG_ERROR daemon-clients-attached A Mixdog daemon of another version (mixdog 1.1.1, pid 4000) has 1 attached client on the server.\n',
  code: 3,
};

test('an old daemon whose only obstacle is an attached client is re-checked until its lease ends', async () => {
  const ssh = scriptedSsh([
    result({ installed: false, ...stale }),
    ATTACHED,
    ATTACHED,
    result({ started: true, replaced: { pid: 4000, version: '1.1.1', graceful: true } }),
  ]);
  const events = [];
  const state = await bootstrap(ssh, { onProgress: (event) => events.push(event), clientLeasePollMs: 10 });
  assert.equal(state.report.replaced.pid, 4000);
  assert.equal(ssh.calls.length, 4);
  // The first ensure uploaded and installed; re-checks only start the daemon.
  assert.deepEqual(
    ssh.calls.slice(1).map((call) => programArgs(call).upload),
    [true, false, false]
  );
  const waits = events.filter((event) => event.detail === '이전 연결이 끝나기를 기다리는 중');
  assert.deepEqual(
    waits.map((event) => event.phase),
    ['install', 'start']
  );
  // Re-checks never flip the screen back to a bare phase.
  assert.deepEqual(
    events.map((event) => event.phase),
    ['check', 'install', 'install', 'start']
  );
});

test('an attached client that outlives the lease window fails as daemon-busy-other-version', async () => {
  const ssh = scriptedSsh([result({ ...stale }), ATTACHED]);
  await assert.rejects(bootstrap(ssh, { clientLeaseWaitMs: 60, clientLeasePollMs: 20 }), (error) => {
    assert.equal(error.code, 'daemon-busy-other-version');
    assert.match(error.message, /pid 4000\) has 1 attached client/);
    assert.ok(isTerminalRemoteError(error));
    return true;
  });
  assert.ok(ssh.calls.length >= 3);
});

test('terminals that cannot run keep the connection with terminalsAvailable false', async () => {
  const ssh = scriptedSsh([result({ terminalsAvailable: false, terminalsError: 'no prebuilt binary' })]);
  const lines = [];
  const state = await bootstrap(ssh, { log: (line) => lines.push(line) });
  assert.equal(state.terminalsAvailable, false);
  assert.ok(lines.some((line) => /no prebuilt binary/.test(line)));
});

test('a daemon outside proxy mode after ensure is refused with its pid', async () => {
  const ssh = scriptedSsh([result({ ...stale }), result({ modelProxy: null, started: true })]);
  await assert.rejects(bootstrap(ssh), (error) => {
    assert.equal(error.code, 'daemon-not-proxy');
    assert.match(error.message, /kill 4242/);
    return true;
  });
});

const serverLogins = { args: { version: '1.1.2', graceMs: '', modelLogin: 'server' } };

test("this PC's logins (the default): the server program arguments carry no model login", async () => {
  const ssh = scriptedSsh([result({ ...stale }), result({ started: true })]);
  await bootstrap(ssh);
  assert.deepEqual(
    ssh.calls.map((call) => 'modelLogin' in programArgs(call)),
    [false, false]
  );
});

test('server logins: a current daemon without the model proxy is reused after one probe', async () => {
  const ssh = scriptedSsh([result({ modelProxy: null })]);
  const state = await bootstrap(ssh, serverLogins);
  assert.equal(ssh.calls.length, 1);
  assert.equal(programArgs(ssh.calls[0]).modelLogin, 'server');
  assert.equal(state.discovery.pid, 4242);
});

test('server logins: a proxy-mode daemon is replaced through ensure, never attached', async () => {
  const ssh = scriptedSsh([
    // Even a probe that calls it current is not trusted while its mode differs.
    result(),
    result({ modelProxy: null, started: true, replaced: { pid: 4000, version: '1.1.2' } }),
  ]);
  const state = await bootstrap(ssh, { ...serverLogins, forceRestart: true });
  assert.equal(ssh.calls.length, 2);
  const ensure = programArgs(ssh.calls[1]);
  assert.equal(ensure.mode, 'ensure');
  assert.equal(ensure.modelLogin, 'server');
  assert.equal(ensure.forceRestart, true);
  assert.equal(state.report.replaced.pid, 4000);
});

test('server logins: a daemon still in proxy mode after ensure is refused with its pid', async () => {
  const ssh = scriptedSsh([result({ ...stale }), result({ started: true })]);
  await assert.rejects(bootstrap(ssh, serverLogins), (error) => {
    assert.equal(error.code, 'daemon-model-login');
    assert.match(error.message, /kill 4242/);
    assert.ok(isTerminalRemoteError(error));
    assert.deepEqual(describeConnectFailure(error, parseSshTarget('devbox'), 'linux'), {
      kind: 'daemon-running',
      pid: 4242,
      code: 'daemon-model-login',
    });
    return true;
  });
});

test('a Windows server is an unsupported platform', async () => {
  const ssh = scriptedSsh([
    { stdout: '', stderr: "'sh' is not recognized as an internal or external command,", code: 1 },
  ]);
  await assert.rejects(
    bootstrap(ssh),
    (error) => error.code === 'unsupported-platform' && /Windows/.test(error.message)
  );
});

test('terminal classification covers setup failures, mismatches and ssh auth, not transient trouble', () => {
  for (const code of [
    'node-missing',
    'node-too-old',
    'npm-missing',
    'daemon-not-proxy',
    'daemon-model-login',
    'protocol-mismatch',
    'unsupported-platform',
    'daemon-busy-other-version',
    'install-locked',
    'port-unavailable',
  ]) {
    assert.ok(isTerminalRemoteError(new RemoteBootstrapError(code, code)), code);
  }
  for (const code of [
    'protocol',
    'remote-shell',
    'daemon-timeout',
    'daemon-exited',
    'daemon-unhealthy',
    'install-failed',
    'deps-install',
  ]) {
    assert.ok(!isTerminalRemoteError(new RemoteBootstrapError(code, code)), code);
  }
  assert.ok(isTerminalRemoteError(new SshError('Host key verification failed.', 'terminal')));
  assert.ok(!isTerminalRemoteError(new SshError('Connection refused', 'transient')));
  assert.ok(!isTerminalRemoteError(new Error('ECONNRESET')));
});

test('a local file error before ssh runs is terminal; network and ssh-spawn errors keep retrying', () => {
  const errno = (code, syscall) => Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
  assert.ok(isTerminalRemoteError(errno('ENOENT', 'open')), 'missing payload file');
  assert.ok(isTerminalRemoteError(errno('ENOENT', 'stat')), 'missing payload file');
  assert.ok(isTerminalRemoteError(errno('EACCES', 'open')));
  assert.ok(isTerminalRemoteError(new RemoteBootstrapError('local-payload', 'runtime not found')));
  assert.ok(!isTerminalRemoteError(errno('ECONNRESET', 'read')));
  assert.ok(!isTerminalRemoteError(errno('ENOENT', 'spawn ssh')));
});

async function remoteSession(ssh, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-remote-connect-'));
  const bundlePath = join(dir, 'daemon.cjs');
  await writeFile(bundlePath, BUNDLE);
  return new RemoteSession({
    target: 'devbox',
    remoteCwd: null,
    graceMs: '',
    appVersion: '1.1.2',
    bundlePath,
    spawnImpl: ssh.spawnImpl,
    ...extra,
  });
}

test('setup errors stop the connection supervisor instead of re-probing', async () => {
  for (const [code, message] of [
    ['node-missing', 'Node.js was not found on the server.'],
    ['node-too-old', 'Mixdog needs Node.js 22 or newer on the server; found 20.11.1.'],
    ['unsupported-platform', 'The server is Linux x86_64 with musl libc (Alpine or similar).'],
  ]) {
    const ssh = scriptedSsh([{ stdout: `MIXDOG_ERROR ${code} ${message}\n`, code: 3 }]);
    const session = await remoteSession(ssh);
    await assert.rejects(
      session.connect(() => {}),
      (error) => error.code === code && error.message === message
    );
    await assert.rejects(
      session.connect(() => {}),
      (error) => error.code === code
    );
    assert.equal(ssh.calls.length, 1, `${code}: no second ssh probe`);
    await session.close();
  }
});

test('transient bootstrap trouble is retried on the next connect', async () => {
  const ssh = scriptedSsh([{ stdout: 'motd only\n', code: 0 }]);
  const session = await remoteSession(ssh);
  await assert.rejects(
    session.connect(() => {}),
    (error) => error.code === 'protocol'
  );
  await assert.rejects(
    session.connect(() => {}),
    (error) => error.code === 'protocol'
  );
  assert.equal(ssh.calls.length, 2);
  await session.close();
});

test('fail() latches a mismatch found after connecting', async () => {
  const ssh = scriptedSsh([result()]);
  const session = await remoteSession(ssh);
  const mismatch = new RemoteBootstrapError('protocol-mismatch', 'Update the server.');
  session.fail(mismatch);
  await assert.rejects(
    session.connect(() => {}),
    (error) => error === mismatch
  );
  assert.equal(ssh.calls.length, 0);
  assert.equal(session.currentDiscovery(), null);
  await session.close();
});

const phases = (events) => events.map((event) => event.phase);

function liveTunnel(health = {}) {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.exitCode = 255;
      setImmediate(() => child.emit('exit', 255, null));
      return true;
    };
    return child;
  };
  // The forwarded port answers /health as the probed daemon (pid and build).
  const daemon = createServer((_req, res) =>
    res.end(JSON.stringify({ status: 'ok', pid: 4242, buildHash: PAYLOAD.buildHash, ...health }))
  );
  daemon.listen(0, '127.0.0.1');
  daemon.unref();
  after(() => daemon.close());
  const listening = once(daemon, 'listening');
  return {
    spawnImpl,
    portAccepts: async () => true,
    freePort: async () => {
      await listening;
      return daemon.address().port;
    },
  };
}

test('a healthy server reports connect, check, start, ready; the node version rides on check', async () => {
  const events = [];
  const ssh = scriptedSsh([result()]);
  const session = await remoteSession(ssh, { onProgress: (event) => events.push(event), tunnel: liveTunnel() });
  const endpoint = await session.connect(() => {});
  assert.deepEqual(phases(events), ['connect', 'check', 'start', 'ready']);
  assert.equal(events[1].detail, '22.19.0');
  assert.match(
    endpoint.moduleUrl,
    new RegExp(`/versions/${PAYLOAD.installId}/apps/desktop/out/main/daemon\\.cjs\\?build=`)
  );
  await session.close();
});

test('a server without the install reports install before start', async () => {
  const events = [];
  const ssh = scriptedSsh([
    result({ installed: false, healthy: false, daemonJson: null, modelProxy: null, daemonCurrent: false }),
    result({ started: true }),
  ]);
  const session = await remoteSession(ssh, { onProgress: (event) => events.push(event), tunnel: liveTunnel() });
  await session.connect(() => {});
  assert.deepEqual(phases(events), ['connect', 'check', 'install', 'start', 'ready']);
  await session.close();
});

test("a server session on the server's logins bootstraps in that mode and reads the running sessions", async () => {
  const ssh = scriptedSsh([result({ modelProxy: null })]);
  const session = await remoteSession(ssh, {
    modelLogin: 'server',
    tunnel: liveTunnel({ busySessions: 2, idle: false }),
  });
  assert.equal(await session.busySessions(2_000), null, 'nothing attached yet');
  await session.connect(() => {});
  assert.equal(programArgs(ssh.calls[0]).modelLogin, 'server');
  assert.equal(await session.busySessions(2_000), 2);
  await session.close();
});

test("a server session on the server's logins stops for good at a daemon in proxy mode", async () => {
  const ssh = scriptedSsh([result({ ...stale }), result({ started: true })]);
  const session = await remoteSession(ssh, { modelLogin: 'server', tunnel: liveTunnel() });
  await assert.rejects(
    session.connect(() => {}),
    (error) => error.code === 'daemon-model-login'
  );
  await assert.rejects(
    session.connect(() => {}),
    (error) => error.code === 'daemon-model-login'
  );
  assert.equal(ssh.calls.length, 2, 'no further ssh run');
  await session.close();
});

test('a failure stops the phases where it happened', async () => {
  const events = [];
  const ssh = scriptedSsh([
    result({ ...stale, daemonBusy: 2 }),
    { stdout: 'MIXDOG_ERROR daemon-busy-other-version busy (pid 4242)\n', code: 3 },
  ]);
  const session = await remoteSession(ssh, { onProgress: (event) => events.push(event) });
  await assert.rejects(
    session.connect(() => {}),
    /pid 4242/
  );
  assert.deepEqual(phases(events), ['connect', 'check', 'start']);
  await session.close();
});
