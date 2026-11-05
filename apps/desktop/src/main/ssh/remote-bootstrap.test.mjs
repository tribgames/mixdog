import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
import {
  isTerminalRemoteError,
  parseRemoteDiscovery,
  parseRemoteReport,
  RemoteBootstrapError,
  remoteShellCommand,
} from './remote-bootstrap.ts';
import { loadServerPayloads, localServerCoresDir, manifestBuild } from './remote-install-payload.ts';
import { remoteProgramScript } from './remote-install-program.ts';
import { resolveRemoteCwd } from './remote-session.ts';
import { discoveryJson, isGitSh, programArgs, shellPath, stagedPayloads } from './remote-fixture.mjs';

test('remote discovery reads the control port, the serving RPC port, token and identity', () => {
  const expected = {
    rpcPort: 41001,
    controlPort: 41002,
    token: 'session-secret-1',
    pid: 4242,
    instanceId: 'i-1',
    processStartTime: 't',
    state: 'serving',
    version: '1.4.6',
    build: 'b',
  };
  assert.deepEqual(parseRemoteDiscovery(discoveryJson()), expected);
  assert.deepEqual(parseRemoteDiscovery(JSON.parse(discoveryJson())), expected);
  // A draining core keeps its control listener and has no RPC listener.
  const draining = parseRemoteDiscovery(discoveryJson({ state: 'draining', rpc: undefined }));
  assert.equal(draining.rpcPort, null);
  assert.equal(draining.controlPort, 41002);
});

test('remote discovery rejects incomplete or malformed daemon.json', () => {
  assert.equal(parseRemoteDiscovery('not json'), null);
  assert.equal(parseRemoteDiscovery(null), null);
  assert.equal(parseRemoteDiscovery(JSON.stringify({ ...JSON.parse(discoveryJson()), pid: 0 })), null);
  assert.equal(parseRemoteDiscovery(JSON.stringify({ ...JSON.parse(discoveryJson()), core: undefined })), null);
  assert.equal(parseRemoteDiscovery(discoveryJson({ control: { port: 70000 } })), null);
  assert.equal(
    parseRemoteDiscovery(JSON.stringify({ ...JSON.parse(discoveryJson()), endpoints: { session: { port: 1 } } })),
    null
  );
  // A 1.4.5 daemon's file has no core block: it is not a 1.4.6 discovery document.
  assert.equal(
    parseRemoteDiscovery(JSON.stringify({ pid: 9, endpoints: { session: { port: 4100, token: 't' } } })),
    null
  );
});

test('bootstrap report parsing takes the result line, its discovery and the install state', () => {
  const result = {
    home: '/home/alice',
    uid: 1000,
    runtimeRoot: '/tmp/mixdog-1000',
    versionDir: '/home/alice/.mixdog-remote/versions/1.4.6-0123456789abcdef',
    installed: true,
    daemonJson: discoveryJson(),
    healthy: true,
    coreCurrent: true,
  };
  const report = parseRemoteReport(
    `motd noise\nMIXDOG_PLATFORM Linux x86_64|glibc\nMIXDOG_RESULT ${JSON.stringify(result)}\n`
  );
  assert.equal(report.home, '/home/alice');
  assert.equal(report.healthy, true);
  assert.equal(report.coreCurrent, true);
  assert.equal(report.discovery.rpcPort, 41001);
  assert.equal(report.started, false);
  assert.equal(report.replaced, null);
  const replaced = parseRemoteReport(
    `MIXDOG_RESULT ${JSON.stringify({ ...result, started: true, replaced: { pid: 7, version: '1.4.5', graceful: true } })}`
  );
  assert.deepEqual(replaced.replaced, { pid: 7, version: '1.4.5', graceful: true });
  const missing = parseRemoteReport(`MIXDOG_RESULT ${JSON.stringify({ ...result, daemonJson: null, healthy: true })}`);
  assert.equal(missing.discovery, null);
  assert.equal(missing.healthy, false);
  assert.equal(missing.coreCurrent, false);
  // A core without an RPC listener (draining) never counts as serving.
  const draining = parseRemoteReport(
    `MIXDOG_RESULT ${JSON.stringify({ ...result, daemonJson: discoveryJson({ state: 'draining', rpc: undefined }) })}`
  );
  assert.equal(draining.healthy, false);
  assert.equal(draining.coreCurrent, false);
});

test('bootstrap errors surface their code, message and the work a drain lists', () => {
  assert.throws(
    () => parseRemoteReport('MIXDOG_ERROR client-outdated This Mixdog is older than the server.\n'),
    (error) => error instanceof RemoteBootstrapError && error.code === 'client-outdated' && isTerminalRemoteError(error)
  );
  const drain = {
    drainId: 'd1',
    confirmToken: 'tok',
    running: [{ kind: 'turn', threadId: 't1', turnId: null, title: 'fix the build' }],
  };
  assert.throws(
    () =>
      parseRemoteReport(
        `MIXDOG_DRAIN ${JSON.stringify(drain)}\nMIXDOG_ERROR daemon-busy-other-version The older core is running 1 turn.\n`
      ),
    (error) => error.code === 'daemon-busy-other-version' && error.drain?.confirmToken === 'tok' && error.drain.running[0].title === 'fix the build'
  );
  assert.throws(
    () => parseRemoteReport('bash: sh: not found'),
    (error) => error.code === 'protocol'
  );
});

test('an unsupported platform outranks whatever failed after the probe', () => {
  assert.throws(
    () => parseRemoteReport('MIXDOG_PLATFORM Linux x86_64|musl\nMIXDOG_ERROR install-failed gzip missing\n'),
    (error) => error.code === 'unsupported-platform' && /musl/.test(error.message) && isTerminalRemoteError(error)
  );
});

test('the login shell only ever sees base64 inside single quotes', () => {
  const script = remoteProgramScript({ mode: 'probe', installId: '1.4.6-0123456789abcdef', version: '1.4.6', build: '0123456789abcdef' });
  const command = remoteShellCommand(script);
  const match = /^sh -c 'eval "\$\(printf %s ([A-Za-z0-9+/=]+) \| base64 -d\)"'$/.exec(command);
  assert.ok(match, command.slice(0, 80));
  assert.equal(Buffer.from(match[1], 'base64').toString('utf8'), script);
  assert.match(script, /uname -sm/);
  // No JavaScript runtime is looked for, ever (D6).
  assert.doesNotMatch(script, /\bnode\b|\bnpm\b/);
  assert.ok(command.length < 30_000, `command line is ${command.length} characters`);
});

test('a server install id is a safe path segment and an upload names its digest', () => {
  const args = { mode: 'ensure', installId: '1.4.6-abc', version: '1.4.6', build: 'abc' };
  assert.throws(() => remoteProgramScript({ ...args, installId: '../escape' }));
  assert.throws(() => remoteProgramScript({ ...args, installId: "1.4.6'; rm -rf ~" }));
  assert.throws(() => remoteProgramScript({ ...args, upload: true }));
  assert.throws(() => remoteProgramScript({ ...args, upload: true, sha256: 'not-a-digest' }));
  assert.throws(() => remoteProgramScript({ ...args, upload: true, sha256: 'a'.repeat(64) }));
});

test('the staged release names one build for every platform and serves the verified bundle', async () => {
  const { dir, payloads } = await stagedPayloads('1.4.6');
  assert.equal(payloads.identity.installId, `1.4.6-${payloads.identity.build}`);
  const binary = await payloads.binary({ os: 'linux', arch: 'arm64' });
  const wire = await binary.archive();
  assert.equal(createHash('sha256').update(wire).digest('hex'), binary.bundleSha256);
  assert.match(gunzipSync(wire).toString(), /linux-arm64/);
  await assert.rejects(payloads.binary({ os: 'linux', arch: 'riscv' }), (error) => error.code === 'local-payload');
  // A bundle changed after staging is refused, never uploaded.
  writeFileSync(join(dir, 'darwin-x64', 'bundle.tgz'), 'tampered');
  const tampered = await payloads.binary({ os: 'darwin', arch: 'x64' });
  await assert.rejects(tampered.archive(), (error) => error.code === 'local-payload');
  // A manifest whose build does not follow from its binaries is refused.
  const manifest = JSON.parse(readFileSync(join(dir, 'servers.json'), 'utf8'));
  writeFileSync(join(dir, 'servers.json'), JSON.stringify({ ...manifest, build: manifestBuild({}) }));
  await assert.rejects(loadServerPayloads(dir), (error) => error.code === 'local-payload');
});

test('the staged releases are found in the packaged resources and in a checkout', () => {
  const sep = process.platform === 'win32' ? '\\' : '/';
  const packaged = ['', 'opt', 'Mixdog', 'resources', 'app.asar', 'out', 'main'].join(sep);
  assert.equal(localServerCoresDir(packaged), ['', 'opt', 'Mixdog', 'resources', 'server-cores'].join(sep));
  const checkout = join(makeTempDirSync('ssh-checkout'), 'repo');
  const staged = join(checkout, 'apps', 'desktop', '.runtime', 'server-cores');
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, 'servers.json'), '{}');
  assert.equal(localServerCoresDir(join(checkout, 'apps', 'desktop', 'src', 'main', 'ssh')), staged);
  assert.throws(() => localServerCoresDir(join(checkout, '..')), (error) => error.code === 'local-payload');
});

// The generated script, run by a real POSIX sh against a throwaway HOME with a
// stub `mixdogd`: only the shell logic is exercised, nothing is installed.
const sh = [process.env.MIXDOG_TEST_SH, 'sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe'].find(
  (candidate) => candidate && spawnSync(candidate, ['-c', 'exit 0']).status === 0
);
const withHome = (name, fn) => {
  const home = makeTempDirSync(name);
  const path = shellPath(sh);
  // The script goes through a file: Windows command-line quoting would mangle its backslashes.
  const scriptFile = join(makeTempDirSync(`${name}-script`), 'script.sh');
  const run = (script, input) => {
    writeFileSync(scriptFile, script);
    return spawnSync(sh, [scriptFile.replaceAll('\\', '/')], {
      env: { ...process.env, PATH: path, HOME: home.replaceAll('\\', '/') },
      input,
      encoding: 'utf8',
    });
  };
  return fn(home, run);
};
const stubBinary = `#!/bin/sh\nprintf 'MIXDOG_RESULT {"argv0":"%s","mode":"%s"}\\n' "$1" "$(printf %s "$2" | base64 -d | sed 's/.*"mode":"\\([a-z]*\\)".*/\\1/')"\n`;

test('shell: probe reports an empty server, then runs the installed mixdogd', { skip: !sh && 'no POSIX sh' }, () =>
  withHome('ssh-sh-probe', (home, run) => {
    const args = { mode: 'probe', installId: '1.4.6-abc', version: '1.4.6', build: 'abc' };
    const empty = run(remoteProgramScript(args));
    assert.match(empty.stdout, /MIXDOG_RESULT \{"home":"[^"]+","uid":\d+,"installed":false\}/);
    const dir = join(home, '.mixdog-remote', 'versions', '1.4.6-abc');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mixdogd'), stubBinary);
    chmodSync(join(dir, 'mixdogd'), 0o755);
    const installed = run(remoteProgramScript(args));
    assert.match(installed.stdout, /MIXDOG_RESULT \{"argv0":"server-ensure","mode":"probe"\}/);
    // ensure without an upload on an empty server asks for the runtime.
    const missing = run(remoteProgramScript({ ...args, installId: '1.4.6-zzz', mode: 'ensure' }));
    assert.match(missing.stdout, /MIXDOG_ERROR install-missing /);
    assert.equal(missing.status, 3);
  }));

test('shell: an upload is verified against its digest, unpacked privately and run from the unpacked mixdogd', { skip: !sh && 'no POSIX sh' }, () =>
  withHome('ssh-sh-upload', (home, run) => {
    // mixdogd reports what sits beside it: the JS runtime payload travels in the same bundle.
    const stub = `#!/bin/sh\nprintf 'MIXDOG_RESULT {"argv0":"%s","payload":"%s"}\\n' "$1" "$(ls "$(dirname "$0")/payload/js")"\nprintf 'MODE %s\\n' "$(ls -ld "$(dirname "$0")" | cut -c1-10)"\n`;
    const assembly = makeTempDirSync('ssh-sh-bundle');
    mkdirSync(join(assembly, 'payload', 'js'), { recursive: true });
    writeFileSync(join(assembly, 'mixdogd'), stub);
    writeFileSync(join(assembly, 'payload', 'js', 'node'), 'not a real node');
    const bundlePath = join(makeTempDirSync('ssh-sh-bundle-out'), 'bundle.tgz');
    assert.equal(spawnSync('tar', ['-czf', bundlePath, '-C', assembly, 'mixdogd', 'payload']).status, 0);
    const bundle = readFileSync(bundlePath);
    const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
    const args = {
      mode: 'ensure',
      installId: '1.4.6-abc',
      version: '1.4.6',
      build: 'abc',
      upload: true,
      sha256: createHash('sha256').update(stub).digest('hex'),
      bundleSha256,
    };
    const ok = run(remoteProgramScript(args), bundle);
    assert.match(ok.stdout, /MIXDOG_RESULT \{"argv0":"server-ensure","payload":"node"\}/, ok.stderr);
    // The unpacked tree is private to the user. Only a filesystem with POSIX modes can show it.
    if (!isGitSh(sh)) assert.match(ok.stdout, /MODE drwx------/);
    // The upload and its unpacked tree are gone on every exit.
    const tmp = join(home, '.mixdog-remote', 'tmp');
    assert.ok(existsSync(tmp));
    assert.deepEqual(readdirSync(tmp), []);
    const wrong = run(remoteProgramScript({ ...args, bundleSha256: 'f'.repeat(64) }), bundle);
    assert.match(wrong.stdout, /MIXDOG_ERROR install-failed .*digest/);
    assert.equal(wrong.status, 3);
    assert.deepEqual(readdirSync(tmp), []);
  }));

test('remote cwd defaults to the server home and expands ~', () => {
  assert.equal(resolveRemoteCwd(null, '/home/alice'), '/home/alice');
  assert.equal(resolveRemoteCwd('~/src/app', '/home/alice'), '/home/alice/src/app');
  assert.equal(resolveRemoteCwd('/srv/app/', '/home/alice'), '/srv/app/');
  assert.throws(() => resolveRemoteCwd('src/app', '/home/alice'));
});

test('program arguments round-trip through the recorded script', () => {
  const args = { mode: 'ensure', installId: '1.4.6-abc', version: '1.4.6', build: 'abc', confirmToken: 'tok' };
  assert.deepEqual(programArgs(['ssh', remoteShellCommand(remoteProgramScript(args))]), args);
});
