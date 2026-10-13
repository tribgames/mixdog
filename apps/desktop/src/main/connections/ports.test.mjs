import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { DESKTOP_IPC } from '../../shared/contract-ipc.ts';
import { mergeListeningSockets, parseLsofListen, parseProcNetTcp } from '../server-ports.ts';
import { parseSshTarget } from '../ssh/ssh-command.ts';
import { SshTunnel } from '../ssh/tunnel.ts';
import {
  REMOTE_CLIENT_GRACE_DEFAULT_MS,
  RECONNECT_MAX_DELAY_MS,
  hostGraceMs,
  reconnectDelayCapMs,
} from './connection-link.ts';
import { forwardConnectionLink } from './link-ipc.ts';
import { ConnectionPool } from './pool.ts';
import { createPortForwardStore } from './port-forward-store.ts';
import { registerServerPortsIpc } from './ports-ipc.ts';
import { LOWEST_LOCAL_PORT, createServerPortForwards } from './server-port-forwards.ts';
import { WindowRouteRegistry } from './window-routes.ts';

const PROC_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:A028 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:D0F2 01 00000000:00000000 00:00000000 00000000     0        0 1003 1 0000000000000000 20 4 30 10 -1
`;
const PROC_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2001 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2002 1 0000000000000000 100 0 0 10 0
`;

test('listening ports are read from /proc/net/tcp{,6} and lsof, merged per port, without the service’s own', () => {
  const v4 = parseProcNetTcp(PROC_TCP, 4);
  assert.deepEqual(
    v4.map(({ port, address, inode }) => ({ port, address, inode })),
    [
      { port: 3000, address: '0.0.0.0', inode: '1001' },
      { port: 41000, address: '127.0.0.1', inode: '1002' },
    ],
    'only LISTEN rows'
  );
  const v6 = parseProcNetTcp(PROC_TCP6, 6);
  assert.deepEqual(
    v6.map(({ port, address }) => ({ port, address })),
    [
      { port: 8080, address: '::' },
      { port: 3000, address: '::1' },
    ]
  );
  const merged = mergeListeningSockets(
    [{ ...v4[0], pid: 10, process: 'node' }, { ...v4[1], pid: 99, process: 'node' }, ...v6],
    99
  );
  assert.deepEqual(merged, [
    { port: 3000, addresses: ['0.0.0.0', '::1'], process: 'node', pid: 10 },
    { port: 8080, addresses: ['::'] },
  ]);
  const lsof = parseLsofListen('p501\ncnode\nn*:3000\nn[::1]:3000\np777\ncpython3\nn127.0.0.1:8000\n');
  assert.deepEqual(mergeListeningSockets(lsof, 1), [
    { port: 3000, addresses: ['0.0.0.0', '::1'], process: 'node', pid: 501 },
    { port: 8000, addresses: ['127.0.0.1'], process: 'python3', pid: 777 },
  ]);
});

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

function portsFixture({ store = memoryStore(), busy = new Set(), scan = async () => [] } = {}) {
  const tunnels = fakeTunnels();
  let nextFree = 50_000;
  const ssh = [];
  const ports = createServerPortForwards({
    hostId: 'box',
    store,
    scan: () => scan(),
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
  const f = portsFixture({ scan: async () => listening });
  const pushed = [];
  f.ports.subscribe((view) => pushed.push(view));
  assert.deepEqual((await f.ports.refresh()).suggested, [], 'what listened before the first look is not new');
  listening = [
    ...listening,
    { port: 3000, addresses: ['127.0.0.1'], process: 'node' },
    { port: 5000, addresses: ['::'] },
  ];
  const view = await f.ports.refresh();
  assert.deepEqual(view.suggested, [3000, 5000]);
  assert.equal(f.tunnels.made.length, 0, 'nothing forwarded automatically');
  f.ports.dismiss(5000);
  await f.ports.forward(3000);
  assert.deepEqual(f.ports.view().suggested, [], 'a forwarded or ignored port is no longer offered');
  listening = [{ port: 22, addresses: ['0.0.0.0'] }];
  await f.ports.refresh();
  assert.deepEqual(
    f.ports.view().detected.map((port) => port.port),
    [22]
  );
  assert.ok(pushed.length > 0);
  // A failed scan keeps the forwards and says why.
  const failing = portsFixture({
    scan: async () => {
      throw new Error('Listing listening ports is not supported on win32.');
    },
  });
  const failed = await failing.ports.refresh();
  assert.equal(failed.detected, null);
  assert.match(failed.scanError, /not supported/);
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
    scan: async () => [],
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

test('port changes reach the server window that shows them', async () => {
  const f = portsFixture();
  const sent = [];
  const target = { isDestroyed: () => false, send: (channel, value) => sent.push([channel, value]) };
  const stop = forwardConnectionLink({ link: null, subscribeNotices: () => () => {}, ports: f.ports }, target);
  await f.ports.forward(3000);
  assert.ok(
    sent.some(([channel, view]) => channel === DESKTOP_IPC.serverPortsChanged && view.forwards[0]?.status === 'active')
  );
  stop();
  const count = sent.length;
  await f.ports.forward(4000);
  assert.equal(sent.length, count, 'nothing after the window closed');
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
