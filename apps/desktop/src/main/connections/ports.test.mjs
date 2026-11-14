import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract-ipc.ts';
import { parseSshTarget } from '../ssh/ssh-command.ts';
import { SshTunnel } from '../ssh/tunnel.ts';
import {
  REMOTE_CLIENT_GRACE_DEFAULT_MS,
  RECONNECT_MAX_DELAY_MS,
  hostGraceMs,
  reconnectDelayCapMs,
} from './connection-link.ts';
import { ConnectionPool } from './pool.ts';
import { createPortForwardStore } from './port-forward-store.ts';
import { registerServerPortsIpc } from './ports-ipc.ts';
import { LOWEST_LOCAL_PORT, createServerPortForwards } from './server-port-forwards.ts';
import { WindowRouteRegistry } from './window-routes.ts';

function memoryStore() {
  const data = new Map();
  return {
    data,
    async load(id) {
      return (data.get(id) ?? []).map((entry) => ({ ...entry }));
    },
    async save(id, list) {
      data.set(
        id,
        list.map((entry) => ({ ...entry }))
      );
    },
  };
}

function fakeTunnels() {
  const made = [];
  const create = ({ freePort, onChange }) => {
    const tunnel = {
      boundPort: 0,
      alive: false,
      failure: null,
      revived: 0,
      closed: false,
      remote: 0,
      async ensure(remote) {
        tunnel.remote = remote;
        tunnel.boundPort ||= await freePort();
        tunnel.alive = true;
        onChange();
        return tunnel.boundPort;
      },
      revive() {
        tunnel.revived += 1;
      },
      async close() {
        tunnel.closed = true;
        tunnel.alive = false;
      },
    };
    made.push(tunnel);
    return tunnel;
  };
  return { made, create };
}

function portsFixture({ store = memoryStore(), busy = new Set() } = {}) {
  const tunnels = fakeTunnels();
  let nextFree = 50_000;
  const ssh = [];
  const ports = createServerPortForwards({
    hostId: 'box',
    store,
    createTunnel: tunnels.create,
    runSsh: async (run) => {
      ssh.push('run');
      return run();
    },
    localPortFree: async (port) => !busy.has(port),
    freePort: async () => nextFree++,
  });
  return { ports, tunnels, store, busy, ssh };
}

test('a forward takes the server’s port number on this PC when it is free, any free port otherwise', async () => {
  const f = portsFixture({ busy: new Set([5173]) });
  const same = await f.ports.forward(3000);
  assert.deepEqual(same, { remotePort: 3000, localPort: 3000, status: 'active' });
  const taken = await f.ports.forward(5173);
  assert.equal(taken.localPort, 50_000, 'busy here: a free port instead');
  const privileged = await f.ports.forward(80);
  assert.ok(privileged.localPort >= LOWEST_LOCAL_PORT, 'a server port below 1024 maps to an unprivileged local port');
  assert.equal(f.ssh.length, 3, 'every ssh start runs under the host settings');
  assert.deepEqual(await f.store.load('box'), [
    { remotePort: 3000, localPort: 3000 },
    { remotePort: 5173, localPort: 50_000 },
    { remotePort: 80, localPort: 50_001 },
  ]);
  // The asked-for local port is used as is or refused.
  await assert.rejects(f.ports.forward(9000, 443), /^Error: port-privileged:|port-privileged:/);
  await assert.rejects(f.ports.forward(9000, 5173), /port-busy: Port 5173/);
  await assert.rejects(f.ports.forward(0), /port-invalid/);
  assert.equal(f.tunnels.made.length, 3, 'refusals start no ssh');
  // A second request for a forwarded port joins it.
  assert.equal((await f.ports.forward(3000)).localPort, 3000);
  assert.equal(f.tunnels.made.length, 3);
  assert.equal(f.ports.browserUrl(3000), 'http://127.0.0.1:3000/');
  assert.throws(() => f.ports.browserUrl(4000), /port-not-active/);
});

test('forwards are saved per server: stop forgets one, closing the window keeps them, reconnecting restores them', async () => {
  const store = memoryStore();
  const first = portsFixture({ store });
  await first.ports.forward(3000);
  await first.ports.forward(8080, 18080);
  await first.ports.stop(8080);
  assert.equal(first.tunnels.made[1].closed, true);
  assert.deepEqual(await store.load('box'), [{ remotePort: 3000, localPort: 3000 }]);
  await first.ports.forward(8080, 18080);
  await first.ports.dispose();
  assert.ok(
    first.tunnels.made.every((tunnel) => tunnel.closed),
    'the window closed: every ssh child stops'
  );
  assert.deepEqual(
    (await store.load('box')).map((entry) => entry.remotePort),
    [3000, 8080],
    'the saved list stays'
  );

  // The server window opens again: its connection restores the saved forwards.
  const second = portsFixture({ store });
  await Promise.all([second.ports.restore(), second.ports.restore()]);
  assert.deepEqual(second.ports.view().forwards, [
    { remotePort: 3000, localPort: 3000, status: 'active' },
    { remotePort: 8080, localPort: 18080, status: 'active' },
  ]);
  assert.equal(second.tunnels.made.length, 2, 'two restore calls share one pass');
  // A later reconnect wakes the running ones instead of starting more.
  await second.ports.restore();
  assert.equal(second.tunnels.made.length, 2);
  assert.deepEqual(
    second.tunnels.made.map((tunnel) => tunnel.revived),
    [1, 1]
  );
  // A saved local port taken meanwhile: any free one.
  const third = portsFixture({ store, busy: new Set([18080]) });
  await third.ports.restore();
  assert.equal(third.ports.view().forwards.find((entry) => entry.remotePort === 8080).localPort, 50_000);
});

test('new listening ports are suggested, never forwarded on their own', async () => {
  let listening = [{ port: 22, addresses: ['0.0.0.0'] }];
  const f = portsFixture();
  const pushed = [];
  f.ports.subscribe((view) => pushed.push(view));
  f.ports.update(listening);
  assert.deepEqual(f.ports.view().suggested, [], 'what listened before the first look is not new');
  listening = [
    ...listening,
    { port: 3000, addresses: ['127.0.0.1'], process: 'node' },
    { port: 5000, addresses: ['::'] },
  ];
  f.ports.update(listening);
  assert.deepEqual(f.ports.view().suggested, [3000, 5000]);
  assert.equal(f.tunnels.made.length, 0, 'nothing forwarded automatically');
  f.ports.dismiss(5000);
  await f.ports.forward(3000);
  assert.deepEqual(f.ports.view().suggested, [], 'a forwarded or ignored port is no longer offered');
  listening = [{ port: 22, addresses: ['0.0.0.0'] }];
  f.ports.update(listening);
  assert.deepEqual(
    f.ports.view().detected.map((port) => port.port),
    [22]
  );
  assert.ok(pushed.length > 0);
  // Before the core pushes the first list nothing is detected.
  assert.equal(portsFixture().ports.view().detected, null);
});

test('a forward is one ssh -L child bound to this PC’s loopback', async (t) => {
  const spawned = [];
  const spawnImpl = (_command, args) => {
    spawned.push(args);
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.exitCode = 0;
      setImmediate(() => child.emit('exit', 0, null));
      return true;
    };
    return child;
  };
  const ports = createServerPortForwards({
    hostId: 'box',
    store: memoryStore(),
    runSsh: (run) => run(),
    localPortFree: async () => true,
    createTunnel: ({ freePort, onChange }) =>
      new SshTunnel(parseSshTarget('root@127.0.0.1:2223'), {
        spawnImpl,
        freePort,
        portAccepts: async () => true,
        log: onChange,
      }),
  });
  t.after(() => ports.dispose());
  assert.equal((await ports.forward(4000)).status, 'active');
  const args = spawned[0];
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:4000:127.0.0.1:4000');
  assert.ok(args.includes('BatchMode=yes'), 'a forward never prompts');
});

test('the saved forwards survive a restart of the app', async (t) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-ports-'));
  t.after(() => rm(userDataPath, { recursive: true, force: true }));
  await createPortForwardStore(userDataPath).save('box', [{ remotePort: 3000, localPort: 3000 }]);
  await createPortForwardStore(userDataPath).save('other', [{ remotePort: 22, localPort: 2222 }]);
  const reopened = createPortForwardStore(userDataPath);
  assert.deepEqual(await reopened.load('box'), [{ remotePort: 3000, localPort: 3000 }]);
  await reopened.save('box', []);
  assert.deepEqual(await createPortForwardStore(userDataPath).load('box'), []);
  assert.deepEqual(await createPortForwardStore(userDataPath).load('other'), [{ remotePort: 22, localPort: 2222 }]);
});

function portsIpcFixture() {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const routes = new WindowRouteRegistry();
  const pool = new ConnectionPool();
  const opened = [];
  const f = portsFixture();
  pool.add({ id: 'local', kind: 'local', ports: null });
  pool.add({ id: 'box', kind: 'ssh', ports: f.ports });
  const contents = (id) => ({ id, once() {} });
  routes.register(contents(1), 'local');
  routes.register(contents(2), 'box');
  registerServerPortsIpc({ ipcMain, routes, pool, openExternal: async (url) => void opened.push(url) });
  const invoke = (senderId, channel, ...args) => handlers.get(channel)({ sender: { id: senderId } }, ...args);
  return { invoke, opened, f };
}

test('only a server window forwards, and the browser opens the forward’s loopback URL', async () => {
  const { invoke, opened, f } = portsIpcFixture();
  for (const channel of [DESKTOP_IPC.serverPortForward, DESKTOP_IPC.serverPortsList, DESKTOP_IPC.serverPortOpen]) {
    await assert.rejects(invoke(1, channel, 3000), /ssh-unsupported/, `${channel} refused in this PC’s window`);
  }
  await assert.rejects(invoke(9, DESKTOP_IPC.serverPortForward, 3000), /connection-route-missing/);
  assert.equal(f.tunnels.made.length, 0);
  assert.equal((await invoke(2, DESKTOP_IPC.serverPortForward, 3000, null)).localPort, 3000);
  await invoke(2, DESKTOP_IPC.serverPortOpen, 3000);
  assert.deepEqual(opened, ['http://127.0.0.1:3000/']);
  await assert.rejects(invoke(2, DESKTOP_IPC.serverPortOpen, 4000), /port-not-active/);
  await invoke(2, DESKTOP_IPC.serverPortStop, 3000);
  assert.deepEqual((await invoke(2, DESKTOP_IPC.serverPortsList, false)).forwards, []);
});

test('a host’s grace setting caps the reconnect backoff', () => {
  assert.equal(hostGraceMs(undefined), null);
  assert.equal(hostGraceMs(0), null);
  assert.equal(hostGraceMs('5'), null);
  assert.equal(hostGraceMs(2), 120_000);
  assert.equal(reconnectDelayCapMs(hostGraceMs(2)), 20_000, 'six attempts fit in two minutes');
  assert.equal(reconnectDelayCapMs(hostGraceMs(240)), RECONNECT_MAX_DELAY_MS);
  assert.equal(REMOTE_CLIENT_GRACE_DEFAULT_MS, 1_800_000);
});
