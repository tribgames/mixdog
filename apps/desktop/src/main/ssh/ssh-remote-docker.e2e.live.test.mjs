// End-to-end test of the SSH server feature against a throwaway Docker server.
//
// It drives the real main-process modules — the ipc-ssh-hosts handlers (first-
// contact fingerprint pin, connect, cleanup), the connection manager and
// createDesktopConnection (bootstrap, install, tunnel, attach, reconnect) — over
// the system OpenSSH client, against a container this test builds and removes
// itself (ubuntu:24.04 + Node 22 + sshd, a random loopback port, a temp key
// pair). Nothing under ~/.ssh is read for keys or written. No model call is made.
//
// Live lane (needs Docker, OpenSSH and a built desktop service bundle):
//   npm run test:ssh:e2e --prefix apps/desktop
// Without Docker it skips with a message.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLE = join(DESKTOP_DIR, 'out', 'main', 'daemon.cjs');
const SERVER_DEPS = join(DESKTOP_DIR, 'out', 'server', 'deps', 'server-package-lock.json');
const SERVER_USER = 'mixdog';
const SERVER_HOME = `/home/${SERVER_USER}`;
const STATE_DIR = `${SERVER_HOME}/.mixdog-remote`;

/** Runs a program to completion; never rejects (a missing program is code -1). */
function exec(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolveRun({ code: -1, stdout: '', stderr: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: -1, stdout, stderr: stderr + String(error.message) });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function unavailableReason() {
  if (!existsSync(BUNDLE) || !existsSync(SERVER_DEPS)) {
    return 'the desktop service bundle is not built (run: npm run build:fast --prefix apps/desktop)';
  }
  const docker = await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
  if (docker.code === -1) return 'the Docker CLI was not found on PATH';
  if (docker.code !== 0) return 'the Docker daemon is not running (start Docker Desktop)';
  for (const tool of ['ssh', 'ssh-keygen', 'ssh-keyscan']) {
    if ((await exec(tool, tool === 'ssh' ? ['-V'] : ['-?'], { timeoutMs: 10_000 })).code === -1) {
      return `the OpenSSH client tool "${tool}" was not found on PATH`;
    }
  }
  return null;
}

const skipReason = await unavailableReason();
if (skipReason) console.log(`[ssh-remote e2e] skipped: ${skipReason}`);

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

async function waitFor(what, check, timeoutMs, intervalMs = 250) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const DOCKERFILE = `FROM node:22-bookworm-slim AS node
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
 && apt-get install -y --no-install-recommends openssh-server ca-certificates curl git procps \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /run/sshd
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \\
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN useradd -m -s /bin/bash -p '*' ${SERVER_USER} && mkdir -p ${SERVER_HOME}/.ssh \\
 && chmod 700 ${SERVER_HOME}/.ssh && chown ${SERVER_USER}:${SERVER_USER} ${SERVER_HOME}/.ssh
COPY --chown=${SERVER_USER}:${SERVER_USER} authorized_keys ${SERVER_HOME}/.ssh/authorized_keys
RUN chmod 600 ${SERVER_HOME}/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
`;

test('SSH server feature end to end against a Docker server', {
  skip: skipReason ?? false,
  timeout: 40 * 60_000,
}, async (t) => {
  const suffix = randomBytes(4).toString('hex');
  const image = `mixdog-ssh-e2e:${suffix}`;
  const container = `mixdog-ssh-e2e-${suffix}`;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-ssh-e2e-'));
  const userData = join(root, 'userdata');
  const fakeHome = join(root, 'home');
  const keyFile = join(root, 'keys', 'id_ed25519');
  mkdirSync(join(root, 'keys'), { recursive: true });
  mkdirSync(join(root, 'docker'), { recursive: true });
  mkdirSync(userData, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  const diagnostics = [];
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    await exec('docker', ['rm', '-f', container], { timeoutMs: 60_000 });
    await exec('docker', ['rmi', '-f', image], { timeoutMs: 60_000 });
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const docker = async (args, options) => {
    const result = await exec('docker', args, options);
    assert.equal(result.code, 0, `docker ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  };
  /** A command in the container as the server user. */
  const onServer = (script) =>
    exec('docker', ['exec', '-u', SERVER_USER, container, 'sh', '-c', script], { timeoutMs: 30_000 });

  try {
    // ---- the throwaway server ------------------------------------------------
    const keygen = await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'mixdog-ssh-e2e', '-f', keyFile]);
    assert.equal(keygen.code, 0, keygen.stderr);
    writeFileSync(join(root, 'docker', 'authorized_keys'), readFileSync(`${keyFile}.pub`, 'utf8'));
    writeFileSync(join(root, 'docker', 'Dockerfile'), DOCKERFILE);
    await docker(['build', '-q', '-t', image, join(root, 'docker')], { timeoutMs: 15 * 60_000 });
    const port = await freePort();
    await docker(['run', '-d', '--name', container, '-p', `127.0.0.1:${port}:22`, image]);
    await onServer(`printf 'secret-word: pelican\\n' > ${SERVER_HOME}/e2e-note.txt`);
    const target = `${SERVER_USER}@127.0.0.1:${port}`;
    const serverFingerprints = (
      await exec('docker', [
        'exec',
        container,
        'sh',
        '-c',
        'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done',
      ])
    ).stdout;
    assert.match(serverFingerprints, /SHA256:/);
    await waitFor(
      'sshd in the container',
      async () => (await exec('ssh-keyscan', ['-T', '3', '-p', String(port), '127.0.0.1'])).stdout.includes('ssh-'),
      90_000,
      1_000
    );

    // ---- the real main-process modules ---------------------------------------
    const load = (relative) => import(pathToFileURL(join(DESKTOP_DIR, 'src', 'main', relative)).href);
    const { DESKTOP_IPC } = await import(pathToFileURL(join(DESKTOP_DIR, 'src', 'shared', 'contract-ipc.ts')).href);
    const { registerSshHostIpc } = await load('ipc-ssh-hosts.ts');
    const { ConnectionPool, createConnectionManager, createDesktopConnection } = await load('connections/index.ts');
    const { configureMixdogSsh, mixdogKnownHostsFile, mixdogSshConfigFile, resetMixdogSsh } =
      await load('ssh/mixdog-ssh-config.ts');
    const { inspectHostKey, runTool } = await load('ssh/host-key.ts');
    const { runWithSshContext } = await load('ssh/ssh-context.ts');
    const { sharedSshHostStore } = await load('ssh/ssh-host-store.ts');
    const appVersion = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')).version;
    cleanups.push(async () => resetMixdogSsh());

    const dependencies = {
      moduleUrl: () => pathToFileURL(BUNDLE).href,
      environmentReady: async () => undefined,
      sessionOptions: () => ({
        userDataPath: join(root, 'local-user-data'),
        packaged: false,
        resourcesPath: join(DESKTOP_DIR, 'resources'),
        appPath: DESKTOP_DIR,
        appVersion,
        rendererDir: join(DESKTOP_DIR, 'out', 'renderer'),
      }),
      loadModelProxyRuntime: async () => {
        throw new Error('The model proxy is not used by this test.');
      },
      appVersion,
      bundlePath: BUNDLE,
      onDiagnostic: (connection, event, data) =>
        diagnostics.push(`${connection.id} ${event} ${JSON.stringify(data).slice(0, 300)}`),
    };
    const pool = new ConnectionPool();
    const shown = [];
    const phases = new Map();
    const created = [];
    const manager = createConnectionManager({
      pool,
      createConnection: (spec, onProgress, options) => {
        const connection = createDesktopConnection(
          { id: spec.id, kind: 'ssh', name: spec.name, target: spec.target },
          dependencies,
          {
            onProgress: (progress) => {
              phases.set(spec.id, [...(phases.get(spec.id) ?? []), progress.phase]);
              return onProgress?.(progress);
            },
            ...(options?.forceRestart ? { forceRestart: true } : {}),
          }
        );
        created.push(spec.id);
        return connection;
      },
      showWindow: (connection) => void shown.push(connection.id),
      closeWindows: () => undefined,
    });
    cleanups.push(() => manager.closeAll());

    // This PC's own app window, as main sees it.
    const handlers = new Map();
    const sent = [];
    const sender = Object.assign(new EventEmitter(), {
      id: 1,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push([channel, payload]),
    });
    sender.mainFrame = {};
    const event = { sender, senderFrame: sender.mainFrame };
    // Mixdog's own ssh config and known_hosts live in the temp user-data folder; the
    // user's ~/.ssh/config is never included (the home is a temp dir).
    const configureSsh = () => configureMixdogSsh({ userDataPath: userData, run: runTool, home: fakeHome });
    const isolatedRun = (command, args, timeoutMs) =>
      runTool(
        command,
        command === 'ssh' && mixdogSshConfigFile() ? ['-F', mixdogSshConfigFile(), ...args] : args,
        timeoutMs
      );
    const unregister = registerSshHostIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      routes: { connectionIdFor: (id) => (id === sender.id ? 'local' : undefined) },
      userDataPath: userData,
      connections: manager,
      configureSsh,
      inspect: (where) => inspectHostKey(where, { run: isolatedRun, home: fakeHome }),
      appVersion: 'e2e',
    });
    cleanups.push(async () => unregister());
    const ipc = (channel, ...args) => handlers.get(channel)(event, ...args);

    // The saved server carries this test's key (a user would pick it under "Login key file").
    const store = await sharedSshHostStore(userData);
    const hostId = 'e2e-docker-server';
    await store.save({ id: hostId, name: 'docker-e2e', target, lastConnectedAt: null });
    await store.updateSettings(hostId, { identityFile: keyFile });

    await t.test('first contact: the fingerprint is shown, then pinned only after confirmation', async () => {
      const inspection = await ipc(DESKTOP_IPC.sshInspectHostKey, target);
      assert.equal(inspection.check.status, 'unknown');
      const hash = /SHA256:[A-Za-z0-9+/]+/.exec(inspection.check.fingerprint)?.[0];
      assert.ok(
        hash && serverFingerprints.includes(hash),
        `fingerprint ${inspection.check.fingerprint} is one of the server's keys`
      );
      assert.equal(readFileSync(mixdogKnownHostsFile(), 'utf8'), '', 'nothing is pinned before the user confirms');
      await assert.rejects(ipc(DESKTOP_IPC.sshConnect, { attemptId: inspection.attemptId }), /fingerprint/i);
      const result = await ipc(DESKTOP_IPC.sshConnect, { attemptId: inspection.attemptId, trustHostKey: true });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.host.id, hostId);
      assert.equal(result.host.open, true);
      assert.match(readFileSync(mixdogKnownHostsFile(), 'utf8'), new RegExp(`^\\[127\\.0\\.0\\.1\\]:${port} `));
      const reported = sent
        .filter(([channel]) => channel === DESKTOP_IPC.sshProgress)
        .map(([, progress]) => progress.phase);
      assert.ok(reported.includes('install'), `first connection installs (phases: ${reported})`);
      assert.equal(reported.at(-1), 'ready');
      const again = await ipc(DESKTOP_IPC.sshInspectHostKey, target);
      assert.equal(again.check.status, 'trusted');
      assert.deepEqual(shown, [hostId]);
    });

    const first = () => pool.get(hostId);
    const terminal = async (connection, command) => {
      let output = '';
      const stop = connection.terminals.subscribe((chunk) => (output += chunk.data));
      try {
        const session = await connection.terminals.ensure(null, SERVER_HOME, null);
        const marker = `E2E${randomBytes(3).toString('hex')}`;
        connection.terminals.write(session.id, `${command}; echo ${marker}_$((20+22))\r`);
        await waitFor(`terminal output of "${command}"`, () => output.includes(`${marker}_42`), 60_000);
        connection.terminals.dispose(session.id);
        return output;
      } finally {
        stop();
      }
    };

    await t.test('attached: a shell command and a file read run on the server, as a normal user', async () => {
      const connection = first();
      assert.ok(connection, 'the connection is in the pool');
      assert.equal(connection.serviceUserDataPath(), `${STATE_DIR}/user-data`);
      assert.ok(Array.isArray(await connection.client.listSessions()));
      assert.equal(connection.link.view().state.status, 'connected');
      assert.equal(connection.link.view().terminalsAvailable, true);
      const output = await terminal(connection, 'uname -s; cat ~/e2e-note.txt; echo UID_$(id -u)');
      assert.match(output, /Linux/);
      assert.match(output, /secret-word: pelican/);
      const uid = /UID_(\d+)\r?\n/.exec(output)?.[1];
      assert.ok(uid && uid !== '0', `runs as a non-root user (uid ${uid})`);
    });

    await t.test('the server holds only the Mixdog state folder, loopback-only', async () => {
      const listing = await onServer(`ls -A ${STATE_DIR}`);
      for (const entry of ['versions', 'user-data', 'daemon.log', 'runtime'])
        assert.match(listing.stdout, new RegExp(`^${entry}$`, 'm'), `${entry} exists`);
      // The daemon's session port listens (state 0A) on 127.0.0.1 only.
      const serverPort = first().remote.tunnel.remotePort;
      assert.ok(serverPort > 0);
      const table = (await exec('docker', ['exec', container, 'cat', '/proc/net/tcp'])).stdout;
      const hex = serverPort.toString(16).toUpperCase().padStart(4, '0');
      const rows = table
        .split('\n')
        .map((row) => row.trim().split(/\s+/))
        .filter((cols) => cols[1]?.endsWith(`:${hex}`) && cols[3] === '0A');
      assert.ok(rows.length > 0, `port ${serverPort} listens on the server`);
      assert.ok(
        rows.every((cols) => cols[1].startsWith('0100007F:')),
        'and only on the loopback address'
      );
    });

    await t.test('killing the ssh tunnel reconnects to the same daemon', async () => {
      const connection = first();
      const daemonPid = connection.remote.currentDiscovery().pid;
      const tunnel = connection.remote.tunnel;
      const oldPid = tunnel.child.pid;
      const states = [];
      const unsubscribe = connection.link.subscribe((view) => states.push(view.state.status));
      process.kill(oldPid);
      await waitFor('a new tunnel process', () => tunnel.child && tunnel.child.pid !== oldPid && tunnel.alive, 120_000);
      await waitFor(
        'the link to be connected again',
        () => connection.link.view().state.status === 'connected',
        120_000
      );
      unsubscribe();
      assert.equal(connection.remote.currentDiscovery().pid, daemonPid, 'the same daemon answers');
      const output = await terminal(connection, 'cat ~/e2e-note.txt');
      assert.match(output, /secret-word: pelican/);
      t.diagnostic(`link states while reconnecting: ${states.join(' > ') || '(none seen)'}`);
    });

    await t.test('a second window to the same server reuses the running daemon', async () => {
      const daemonPid = first().remote.currentDiscovery().pid;
      // Opening the same server again only focuses its window.
      await runWithSshContext({ settings: { identityFile: keyFile } }, () =>
        manager.open({ id: hostId, name: 'docker-e2e', target })
      );
      assert.deepEqual(created, [hostId]);
      assert.deepEqual(shown, [hostId, hostId]);
      // Another connection (another window process) to the same server: no install, same daemon.
      await runWithSshContext({ settings: { identityFile: keyFile } }, () =>
        manager.open({ id: 'e2e-second', name: 'docker-e2e-2', target })
      );
      const second = pool.get('e2e-second');
      assert.ok(second);
      assert.ok(
        !phases.get('e2e-second').includes('install'),
        `second connection skips the install (phases: ${phases.get('e2e-second')})`
      );
      assert.equal(second.remote.currentDiscovery().pid, daemonPid);
      assert.ok(Array.isArray(await second.client.listSessions()));
      await manager.close('e2e-second');
      const alive = await onServer(`kill -0 ${daemonPid} && echo alive`);
      assert.match(alive.stdout, /alive/, 'the daemon outlives a closed window');
      assert.ok(Array.isArray(await first().client.listSessions()), 'the first window keeps working');
    });

    await t.test('cleanup stops the daemon and removes ~/.mixdog-remote', async () => {
      const daemonPid = first().remote.currentDiscovery().pid;
      const result = await ipc(DESKTOP_IPC.sshCleanupHost, hostId, {
        operationId: 'e2e-cleanup',
        removeUserData: true,
        forget: true,
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.hosts, []);
      assert.equal(manager.isOpen(hostId), false, 'the server window was closed first');
      const phasesSeen = sent
        .filter(([channel]) => channel === DESKTOP_IPC.sshCleanupProgress)
        .map(([, progress]) => progress.phase);
      assert.deepEqual(
        phasesSeen.filter((phase, index) => phasesSeen.indexOf(phase) === index),
        ['connect', 'stop', 'remove', 'done']
      );
      const gone = await onServer(`test ! -e ${STATE_DIR} && ! kill -0 ${daemonPid} 2>/dev/null && echo clean`);
      assert.match(gone.stdout, /clean/);
      assert.equal(store.get(hostId), undefined);
    });
  } catch (error) {
    console.error(`[ssh-remote e2e] recent connection diagnostics:\n${diagnostics.slice(-40).join('\n')}`);
    throw error;
  }
});
