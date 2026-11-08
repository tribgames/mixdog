// LR §11.11 on the desktop side: monotonic SSH install. The decision itself
// (`compat::order`) is made by `mixdogd server-ensure` on the server; these
// tests pin what the desktop does with each answer — what it uploads, what it
// asks, what it refuses to retry — against a scripted server.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { bootstrapRemoteDaemon, isTerminalRemoteError, RemoteBootstrapError } from './remote-bootstrap.ts';
import { setServerPayloadResolver } from './remote-install-payload.ts';
import { RemoteSession } from './remote-session.ts';
import { parseSshTarget, SshError } from './ssh-command.ts';
import { describeConnectFailure } from './connect-failure.ts';
import { discoveryJson, errorReply, programArgs, reply, scriptedSsh, scriptOf, stagedPayloads } from './remote-fixture.mjs';

const { payloads } = await stagedPayloads('1.4.6');
const INSTALL_ID = payloads.identity.installId;
setServerPayloadResolver(async () => payloads);
after(() => setServerPayloadResolver(null));

const result = (overrides = {}) =>
  reply({
    home: '/home/alice',
    uid: 1000,
    runtimeRoot: '/tmp/mixdog-1000',
    versionDir: `/home/alice/.mixdog-remote/versions/${INSTALL_ID}`,
    installed: true,
    daemonJson: discoveryJson(),
    healthy: true,
    coreCurrent: true,
    started: false,
    ...overrides,
  });

/** What a server with an older core, or none, reports to the probe. */
const OLDER = { coreCurrent: false, daemonJson: discoveryJson({ version: '1.4.5', build: 'old' }) };
const EMPTY = { installed: false, healthy: false, coreCurrent: false, daemonJson: null };

const bootstrap = (ssh, extra = {}) =>
  bootstrapRemoteDaemon({ target: parseSshTarget('devbox'), spawnImpl: ssh.spawnImpl, payloads, ...extra });

test('an equal, serving core is attached to after one probe, uploading nothing', async () => {
  const ssh = scriptedSsh([result()]);
  const state = await bootstrap(ssh);
  assert.equal(state.discovery.rpcPort, 41001);
  assert.equal(state.discovery.controlPort, 41002);
  assert.equal(state.discovery.token, 'session-secret-1');
  assert.equal(ssh.calls.length, 1);
  const probe = programArgs(ssh.calls[0]);
  assert.deepEqual([probe.mode, probe.installId, probe.version], ['probe', INSTALL_ID, '1.4.6']);
  assert.equal(probe.upload, undefined);
});

test('a missing install uploads the gzip of the server platform’s binary with its digest', async () => {
  const ssh = scriptedSsh([result(EMPTY), result({ started: true })]);
  const state = await bootstrap(ssh);
  assert.equal(ssh.calls.length, 2);
  const ensure = programArgs(ssh.calls[1]);
  assert.equal(ensure.mode, 'ensure');
  assert.equal(ensure.upload, true);
  const binary = await payloads.binary({ os: 'linux', arch: 'x64' });
  assert.equal(ensure.sha256, binary.sha256);
  assert.match(gunzipSync(ssh.inputs[1]).toString(), /linux-x64/);
  assert.match(scriptOf(ssh.calls[1]), /gzip -dc/);
  assert.equal(state.report.started, true);
});

test('ClientNewer: an installed build with an older core runs ensure without upload and reports the replaced core', async () => {
  const ssh = scriptedSsh([result(OLDER), result({ started: true, replaced: { pid: 4000, version: '1.4.5', graceful: true } })]);
  const state = await bootstrap(ssh);
  const ensure = programArgs(ssh.calls[1]);
  assert.equal(ensure.mode, 'ensure');
  assert.equal(ensure.upload, undefined);
  assert.equal(ssh.inputs[1].length, 0);
  assert.deepEqual(state.report.replaced, { pid: 4000, version: '1.4.5', graceful: true });
});

test('a build removed between probe and ensure is uploaded on a second ensure', async () => {
  const ssh = scriptedSsh([
    result(OLDER),
    errorReply('install-missing', 'The Mixdog runtime is not installed on the server and must be uploaded.'),
    result({ started: true }),
  ]);
  await bootstrap(ssh);
  assert.equal(ssh.calls.length, 3);
  assert.equal(programArgs(ssh.calls[2]).upload, true);
  assert.ok(ssh.inputs[2].length > 0);
});

test('ClientOlder: the server refuses, nothing is retried, and the error ends the connection', async () => {
  const ssh = scriptedSsh([
    result(EMPTY),
    errorReply('client-outdated', 'This Mixdog (1.4.6) is older than the one on the server (1.5.0). Update Mixdog on this PC.'),
  ]);
  await assert.rejects(bootstrap(ssh), (error) => {
    assert.equal(error.code, 'client-outdated');
    assert.ok(isTerminalRemoteError(error));
    assert.equal(describeConnectFailure(error, parseSshTarget('devbox'), 'linux').kind, 'failed');
    return true;
  });
  assert.equal(ssh.calls.length, 2);
});

test('an older core with running work fails with its listing; confirming sends exactly that listing’s token, once', async () => {
  const drain = {
    drainId: 'd1',
    confirmToken: 'tok-1',
    running: [{ kind: 'turn', threadId: 't1', turnId: 'u1', title: 'fix the build' }],
  };
  const busy = errorReply('daemon-busy-other-version', 'The Mixdog core (1.4.5) is running 1 turn on the server.', drain);
  const ssh = scriptedSsh([result(OLDER), busy, result(OLDER), result({ started: true }), result(OLDER), result({ started: true })]);
  await assert.rejects(bootstrap(ssh), (error) => {
    assert.equal(error.code, 'daemon-busy-other-version');
    assert.equal(error.drain.running[0].title, 'fix the build');
    assert.ok(isTerminalRemoteError(error));
    return true;
  });
  assert.equal(programArgs(ssh.calls[1]).confirmToken, undefined);
  // The user confirms: the same server gets the token of the listing they saw.
  await bootstrap(ssh, { forceRestart: true });
  assert.equal(programArgs(ssh.calls[3]).confirmToken, 'tok-1');
  // The confirmation covered that open only.
  await bootstrap(ssh, { forceRestart: true });
  assert.equal(programArgs(ssh.calls[5]).confirmToken, undefined);
});

test('a confirmation without a prior listing sends no token: the server lists again', async () => {
  const ssh = scriptedSsh([result(OLDER), result({ started: true })]);
  await bootstrap(ssh, { forceRestart: true, target: parseSshTarget('never-listed') });
  assert.equal(programArgs(ssh.calls[1]).confirmToken, undefined);
});

test('a core that is still not serving this version after ensure is unhealthy', async () => {
  const ssh = scriptedSsh([result(OLDER), result({ coreCurrent: false })]);
  await assert.rejects(bootstrap(ssh), (error) => error.code === 'daemon-unhealthy');
});

test('server logins travel as the model login argument, this PC’s logins as nothing', async () => {
  const pc = scriptedSsh([result()]);
  await bootstrap(pc);
  assert.equal('modelLogin' in programArgs(pc.calls[0]), false);
  const server = scriptedSsh([result()]);
  await bootstrap(server, { modelLogin: 'server' });
  assert.equal(programArgs(server.calls[0]).modelLogin, 'server');
});

test('a Windows server is an unsupported platform', async () => {
  const ssh = scriptedSsh([{ stdout: '', stderr: "'sh' is not recognized as an internal or external command,", code: 1 }]);
  await assert.rejects(bootstrap(ssh), (error) => error.code === 'unsupported-platform' && /Windows/.test(error.message));
});

test('a server platform this desktop ships no runtime for is refused before anything is sent', async () => {
  const ssh = scriptedSsh([
    { stdout: 'MIXDOG_PLATFORM Linux aarch64|glibc\nMIXDOG_RESULT {"home":"/h","installed":false}\n' },
  ]);
  const lonely = { identity: payloads.identity, binary: async () => { throw new RemoteBootstrapError('local-payload', 'no runtime'); } };
  await assert.rejects(bootstrap(ssh, { payloads: lonely }), (error) => error.code === 'local-payload' && isTerminalRemoteError(error));
  assert.equal(ssh.calls.length, 1);
});

test('terminal classification covers refusals and mismatches, not transient trouble', () => {
  for (const code of [
    'client-outdated',
    'daemon-model-login',
    'protocol-mismatch',
    'unsupported-platform',
    'daemon-busy-other-version',
    'install-locked',
    'port-unavailable',
    'local-payload',
  ]) {
    assert.ok(isTerminalRemoteError(new RemoteBootstrapError(code, code)), code);
  }
  for (const code of ['protocol', 'remote-shell', 'daemon-timeout', 'daemon-exited', 'daemon-unhealthy', 'install-failed', 'install-missing']) {
    assert.ok(!isTerminalRemoteError(new RemoteBootstrapError(code, code)), code);
  }
  assert.ok(isTerminalRemoteError(new SshError('Host key verification failed.', 'terminal')));
  assert.ok(!isTerminalRemoteError(new SshError('Connection refused', 'transient')));
  assert.ok(!isTerminalRemoteError(new Error('ECONNRESET')));
});

test('a local file error before ssh runs is terminal; network and ssh-spawn errors keep retrying', () => {
  const errno = (code, syscall) => Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
  assert.ok(isTerminalRemoteError(errno('ENOENT', 'open')), 'missing runtime file');
  assert.ok(isTerminalRemoteError(errno('EACCES', 'open')));
  assert.ok(isTerminalRemoteError(new RemoteBootstrapError('local-payload', 'runtime not found')));
  assert.ok(!isTerminalRemoteError(errno('ECONNRESET', 'read')));
  assert.ok(!isTerminalRemoteError(errno('ENOENT', 'spawn ssh')));
});

const phases = (events) => events.map((event) => event.phase);

/** Tunnel stand-in: the forwarded control port answers /health as the probed core. */
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
  const control = createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', pid: 4242, version: '1.4.6', busy: 0, ...health })));
  control.listen(0, '127.0.0.1');
  control.unref();
  after(() => control.close());
  const listening = once(control, 'listening');
  let asked = 0;
  return {
    spawnImpl,
    portAccepts: async () => true,
    // First the RPC end (nothing listens there in the test), then the control end.
    freePort: async () => {
      await listening;
      asked += 1;
      return asked % 2 === 1 ? 50111 : control.address().port;
    },
  };
}

const remoteSession = (ssh, extra = {}) =>
  new RemoteSession({ target: 'devbox', remoteCwd: null, spawnImpl: ssh.spawnImpl, ...extra });

test('a serving core reports connect, check, start, ready and attaches through the RPC forward', async () => {
  const events = [];
  const ssh = scriptedSsh([result()]);
  const session = remoteSession(ssh, { onProgress: (event) => events.push(event), tunnel: liveTunnel() });
  const endpoint = await session.connect(() => {});
  assert.deepEqual(phases(events), ['connect', 'check', 'start', 'ready']);
  assert.equal(events[1].detail, 'linux-x64');
  assert.deepEqual(endpoint.discovery, { port: 50111, token: 'session-secret-1', pid: 4242 });
  assert.equal(endpoint.coreVersion, '1.4.6');
  assert.equal(endpoint.cwd, '/home/alice');
  assert.equal(await session.busySessions(2_000), 0);
  assert.ok((await session.probeHealth(2_000)) >= 0);
  await session.close();
});

test('a server without the install reports install before start', async () => {
  const events = [];
  const ssh = scriptedSsh([result(EMPTY), result({ started: true })]);
  const session = remoteSession(ssh, { onProgress: (event) => events.push(event), tunnel: liveTunnel() });
  await session.connect(() => {});
  assert.deepEqual(phases(events), ['connect', 'check', 'install', 'start', 'ready']);
  await session.close();
});

test('another process answering behind the forward stops the connection before a token is sent', async () => {
  const ssh = scriptedSsh([result()]);
  const session = remoteSession(ssh, { tunnel: liveTunnel({ pid: 777 }) });
  await assert.rejects(session.connect(() => {}), (error) => error instanceof SshError && /Another process answered/.test(error.message));
  await assert.rejects(session.connect(() => {}), /Another process answered/);
  assert.equal(ssh.calls.length, 1, 'no second probe after a terminal failure');
  assert.equal(session.currentDiscovery(), null);
  await session.close();
});

test('the same pid answering as another build stops the connection before a token is sent', async () => {
  const ssh = scriptedSsh([result()]);
  const session = remoteSession(ssh, { tunnel: liveTunnel({ version: '1.4.7' }) });
  await assert.rejects(session.connect(() => {}), (error) => error instanceof SshError && /Another process answered/.test(error.message));
  assert.equal(session.currentDiscovery(), null);
  await session.close();
});

test('refusals stop the connection supervisor instead of re-probing', async () => {
  for (const [code, message] of [
    ['client-outdated', 'This Mixdog is older than the server. Update Mixdog on this PC.'],
    ['unsupported-platform', 'The server is Linux x86_64 with musl libc (Alpine or similar).'],
  ]) {
    const ssh = scriptedSsh([errorReply(code, message)]);
    const session = remoteSession(ssh);
    await assert.rejects(session.connect(() => {}), (error) => error.code === code && error.message === message);
    await assert.rejects(session.connect(() => {}), (error) => error.code === code);
    assert.equal(ssh.calls.length, 1, `${code}: no second ssh probe`);
    await session.close();
  }
});

test('transient bootstrap trouble is retried on the next connect', async () => {
  const ssh = scriptedSsh([{ stdout: 'motd only\n', code: 0 }]);
  const session = remoteSession(ssh);
  await assert.rejects(session.connect(() => {}), (error) => error.code === 'protocol');
  await assert.rejects(session.connect(() => {}), (error) => error.code === 'protocol');
  assert.equal(ssh.calls.length, 2);
  await session.close();
});

test('fail() latches a mismatch found after connecting', async () => {
  const ssh = scriptedSsh([result()]);
  const session = remoteSession(ssh);
  const mismatch = new RemoteBootstrapError('protocol-mismatch', 'Update the server.');
  session.fail(mismatch);
  await assert.rejects(session.connect(() => {}), (error) => error === mismatch);
  assert.equal(ssh.calls.length, 0);
  assert.equal(session.currentDiscovery(), null);
  await session.close();
});

test('a failure stops the phases where it happened', async () => {
  const events = [];
  const ssh = scriptedSsh([result(OLDER), errorReply('daemon-busy-other-version', 'busy (pid 4242)')]);
  const session = remoteSession(ssh, { onProgress: (event) => events.push(event) });
  await assert.rejects(session.connect(() => {}), /pid 4242/);
  assert.deepEqual(phases(events), ['connect', 'check', 'start']);
  await session.close();
});
