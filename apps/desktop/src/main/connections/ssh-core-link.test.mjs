// A server connection end to end over everything but ssh and the core: the real bootstrap (scripted ssh), tunnel,
// RemoteSession identity check, protocol connection and service client, against a fake core that speaks the wire
// (a WebSocket server) and a fake control listener (`/health`). The old test line stopped at RemoteSession; this one
// runs what a window gets after it: sections, capabilities and the link's reaction to a dropped socket.
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import test, { after } from 'node:test';

import { WebSocketServer } from 'ws';

import { waitUntil } from '../bounded-wait.mjs';
import { createProtocolConnection } from '../protocol/connection.ts';
import { resolveTunnelEndpoint } from '../protocol/discovery.ts';
import { openCore } from '../protocol/open-core.ts';
import { setServerPayloadResolver } from '../ssh/remote-install-payload.ts';
import { discoveryJson, errorReply, reply, scriptedSsh, stagedPayloads } from '../ssh/remote-fixture.mjs';
import { parseSshTarget } from '../ssh/ssh-command.ts';
import { SshTunnel } from '../ssh/tunnel.ts';
import { createDesktopConnection } from './index.ts';
import { fakeProtocol } from './fake-core-protocol.mjs';

const { initializeResult } = JSON.parse(
  readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const { payloads } = await stagedPayloads('1.4.6');
setServerPayloadResolver(async () => payloads);
after(() => setServerPayloadResolver(null));

const TOKEN = 'session-secret-1';

/** The server's core as the tunnel's far end exposes it: the RPC WebSocket (`/rpc`, bearer token) and the control
 *  listener's `/health` (pid and run identity, no token). */
async function fakeCore(t, { initialize: firstInitialize } = {}) {
  const received = [];
  const sockets = new Set();
  // What the core answers initialize with (a refusal, or null for the normal result) and who it is.
  let initialize = firstInitialize ?? null;
  let who = { pid: 4242, instanceId: 'i-1', serverInstanceId: 's1' };
  // The RPC port turns every dial away while `/health` still answers: a core up but not taking this client.
  let refusingSockets = false;
  let rpc;
  let control;
  const serve = async (rpcPort, controlPort) => {
    rpc = new WebSocketServer({
      host: '127.0.0.1',
      port: rpcPort,
      path: '/rpc',
      verifyClient: ({ req }) => !refusingSockets && req.headers.authorization === `Bearer ${TOKEN}`,
    });
    rpc.on('connection', onConnection);
    control = createServer((_request, response) =>
      response.end(JSON.stringify({ status: 'ok', pid: who.pid, instanceId: who.instanceId, busy: 0 }))
    );
    control.listen(controlPort, '127.0.0.1');
    await Promise.all([once(rpc, 'listening'), once(control, 'listening')]);
  };
  const onConnection = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      if (frame.id === undefined) return;
      received.push(frame);
      const answer = (result) => socket.send(JSON.stringify({ id: frame.id, result }));
      if (frame.method === 'initialize') {
        if (initialize) return socket.send(JSON.stringify({ id: frame.id, ...initialize }));
        return answer({ ...initializeResult, serverInstanceId: who.serverInstanceId });
      }
      if (frame.method === 'app/subscribe') {
        answer({ subscription: { id: 'as', mode: 'snapshot', epoch: 'ae', startSeq: 1 } });
        return socket.send(
          JSON.stringify({
            method: 'app/snapshot',
            params: { sections: [{ section: 'notice', key: 'hello', revision: 1, value: { text: 'from the server' } }] },
            feed: { id: 'app', epoch: 'ae', seq: 0 },
          })
        );
      }
      if (frame.method === 'thread/read') return answer({ thread: { id: frame.params.threadId }, state: {}, items: [], hasOlder: false });
      return answer(frame.method === 'mcp/mcpStatus' ? { servers: [], from: who.instanceId } : {});
    });
  };
  const stop = async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.all([new Promise((done) => rpc.close(done)), new Promise((done) => control.close(done))]);
  };
  await serve(0, 0);
  t.after(stop);
  const ports = [rpc.address().port, control.address().port];
  return {
    received,
    ports,
    /** The ports and run identity a probe reports for this core (the server's side of the tunnel). */
    remote: { rpc: 41001, control: 41002 },
    /** Another run of the core answers: the listeners go and come back (the tunnel's local ends stay), the
     *  identity differs, and the server's own ports are new ones. */
    async restart(next) {
      await stop();
      who = { ...who, ...next.who };
      this.remote = next.remote;
      await serve(ports[0], ports[1]);
    },
    /** Answer initialize with this refusal, or with the normal result for null. */
    refuse(answer) {
      initialize = answer;
    },
    identity: () => who,
    refuseSockets(on) {
      refusingSockets = on;
    },
    liveSockets: () => sockets.size,
    /** The server side drops every socket (a restarted core, a network cut). */
    drop: () => sockets.forEach((socket) => socket.terminate()),
  };
}

/** The discovery file of the core as it runs now: its pid, run identity and the server's own ports. */
function coreDiscovery(core) {
  const { pid, instanceId } = core.identity();
  const file = JSON.parse(discoveryJson({ instanceId, rpc: { port: core.remote.rpc }, control: { port: core.remote.control } }));
  file.pid = pid;
  file.endpoints.session.port = core.remote.control;
  return JSON.stringify(file);
}

/** What `remote probe` prints for a server whose core already serves: nothing to install or start. */
const probe = (core) => ({
  // Read when ssh is spawned: a core that restarted meanwhile is reported as it runs now.
  get stdout() {
    return reply({
      home: '/home/alice',
      uid: 1000,
      runtimeRoot: '/tmp/mixdog-1000',
      versionDir: '/home/alice/.mixdog-remote/versions/x',
      installed: true,
      daemonJson: core ? coreDiscovery(core) : discoveryJson(),
      healthy: true,
      coreCurrent: true,
      started: false,
    }).stdout;
  },
});

/** An ssh child that lives until killed, with the tunnel's two local ends pointed at the fake core. */
function tunnelDependencies(core) {
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
  // Each tunnel asks for its RPC end, then its control end: a session opened again gets the same two.
  let asked = 0;
  return { spawnImpl, portAccepts: async () => true, freePort: async () => core.ports[asked++ % 2] };
}

/** The connection main builds for a server (index.ts createProtocol): a protocol connection that dials through the
 *  connector, so every (re)dial goes through the session's bootstrap and tunnel. */
function serverConnection(t, core, ssh) {
  const events = [];
  const connection = createDesktopConnection(
    { id: 'srv', kind: 'ssh', name: 'Box', target: 'root@127.0.0.1:2223' },
    {
      moduleUrl: () => {
        throw new Error('the Node service is not reached by a server');
      },
      environmentReady: () => Promise.resolve(),
      sessionOptions: () => ({ userDataPath: '', packaged: false, resourcesPath: '', appPath: '', appVersion: '0.0.0', rendererDir: '' }),
      loadModelProxyRuntime: async () => {
        throw new Error('unused');
      },
      appVersion: '1.4.6',
      createProtocol: (_identity, connector) =>
        createProtocolConnection({
          open: openCore({
            resolve: () => resolveTunnelEndpoint(connector),
            version: '1.4.6',
            capabilities: { approvalsInbox: true },
          }),
        }),
      localProtocol: () => fakeProtocol(),
      onServiceReady: (_identity, context) => events.push(`ready:${context.generation}`),
      onDiagnostic: (_identity, event) => {
        if (event.startsWith('core-link')) events.push(event);
      },
    }
  );
  connection.remote.config.spawnImpl = ssh.spawnImpl;
  const dependencies = tunnelDependencies(core);
  // The first session's tunnel, and the tunnels of the sessions Reconnect opens later.
  connection.remote.tunnel = new SshTunnel(parseSshTarget('root@127.0.0.1:2223'), dependencies);
  connection.remote.config.tunnel = dependencies;
  t.after(() => connection.dispose());
  return { connection, events };
}

test('a server connection bootstraps, tunnels, reaches the core\'s ready state and runs a capability on it', async (t) => {
  const core = await fakeCore(t);
  const ssh = scriptedSsh([probe()]);
  const { connection, events } = serverConnection(t, core, ssh);
  await connection.start();
  assert.equal(ssh.calls.length, 1, 'one probe: the equal, serving core is attached to as it is');
  assert.equal(connection.protocol.status, 'ready');
  assert.equal(connection.transport(), null, 'no Node service leg is started for a server');
  assert.equal(connection.link.view().state.status, 'connected');
  assert.deepEqual(events, ['ready:1']);
  // The first snapshot reaches the connection's sections.
  await waitUntil(
    () => connection.protocol.snapshot().entries.some((entry) => entry.section === 'notice'),
    "the core's first app snapshot to be folded"
  );
  // One real capability call: the client's lane sends it to the core as its op, and the reply is the result.
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-1' });
  assert.ok(core.received.some((frame) => frame.method === 'mcp/mcpStatus' && frame.params.threadId === 'pane-7'));
  assert.ok(!core.received.some((frame) => frame.method === '/client/register'), 'nothing speaks the Node daemon wire');
});

test('a dropped socket takes the link down, and the next dial re-reads the server before the core is attached again', async (t) => {
  const core = await fakeCore(t);
  const ssh = scriptedSsh([probe()]);
  const { connection, events } = serverConnection(t, core, ssh);
  await connection.start();
  const states = [];
  connection.link.subscribe((view) => states.push(view.state.status));
  core.drop();
  await waitUntil(() => events.includes('ready:2'), 'the connection to attach again');
  assert.deepEqual(events, ['ready:1', 'core-link-lost', 'core-link-restored', 'ready:2']);
  assert.ok(states.includes('reconnecting'), 'the window shows the outage');
  assert.equal(connection.link.view().state.status, 'connected');
  assert.ok(ssh.calls.length >= 2, 'the redial bootstrapped again instead of reusing the old token and port');
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-1' });
});

test('a core that refuses this desktop\'s version ends the connection with the words of the refusal', async (t) => {
  const core = await fakeCore(t, {
    initialize: {
      error: { code: -32000, message: 'clientOutdated', data: { reason: 'clientOutdated', serverVersion: '9.0.0', clientVersion: '1.4.6' } },
    },
  });
  const { connection } = serverConnection(t, core, scriptedSsh([probe()]));
  await assert.rejects(connection.start(), (error) => {
    assert.equal(error.code, 'client-outdated');
    assert.match(error.message, /older than the core on root@127\.0\.0\.1:2223 \(9\.0\.0\)\. Update Mixdog on this PC\./);
    return true;
  });
  assert.equal(connection.stopped(), true, 'only the user\'s reconnect dials again');
});

test('a bootstrap the server refuses surfaces its own error from start', async (t) => {
  const core = await fakeCore(t);
  const { connection } = serverConnection(
    t,
    core,
    scriptedSsh([errorReply('client-outdated', 'This Mixdog (1.4.6) is older than the one on the server (1.5.0). Update Mixdog on this PC.')])
  );
  await assert.rejects(connection.start(), (error) => error.code === 'client-outdated');
  assert.equal(connection.stopped(), true);
});

const OUTDATED = {
  error: { code: -32000, message: 'clientOutdated', data: { reason: 'clientOutdated', serverVersion: '9.0.0', clientVersion: '1.4.6' } },
};

test('after a refusal ends the client during recovery, Reconnect opens a new one once the server is fixed', async (t) => {
  const core = await fakeCore(t);
  const ssh = scriptedSsh([probe(core)]);
  const { connection, events } = serverConnection(t, core, ssh);
  await connection.start();
  const first = connection.protocol.status;
  assert.equal(first, 'ready');
  // The server is replaced by a version this desktop is refused by: the library's recovery ends for good.
  core.refuse(OUTDATED);
  core.drop();
  await waitUntil(() => connection.link.view().state.status === 'lost', 'the refusal to end the connection');
  assert.equal(connection.protocol.status, 'closed');
  assert.equal(connection.stopped(), true);
  await assert.rejects(connection.client.invokeCapability('mcpStatus', [], 'pane-7'));
  // The server is fixed, then the user reconnects.
  core.refuse(null);
  await connection.reconnect();
  assert.equal(connection.protocol.status, 'ready');
  assert.equal(connection.link.view().state.status, 'connected');
  assert.equal(connection.stopped(), false);
  assert.equal(events.at(-1), 'ready:2');
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-1' });
});

test('a first start the server refused is retried by Reconnect against the fixed server', async (t) => {
  const core = await fakeCore(t, { initialize: OUTDATED });
  const { connection, events } = serverConnection(t, core, scriptedSsh([probe(core)]));
  await assert.rejects(connection.start(), (error) => error.code === 'client-outdated');
  await assert.rejects(connection.protocol.whenSynced());
  core.refuse(null);
  await connection.reconnect();
  await connection.protocol.whenSynced();
  assert.equal(connection.protocol.status, 'ready');
  assert.equal(connection.link.view().state.status, 'connected');
  assert.deepEqual(events, ['ready:1']);
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-1' });
  assert.ok(core.received.some((frame) => frame.method === 'app/subscribe'));
});

test('a core that restarted with new ports and another identity is attached again and answers', async (t) => {
  const core = await fakeCore(t);
  const ssh = scriptedSsh([probe(core)]);
  const { connection, events } = serverConnection(t, core, ssh);
  await connection.start();
  const before = ssh.calls.length;
  await core.restart({ who: { pid: 4343, instanceId: 'i-2', serverInstanceId: 's2' }, remote: { rpc: 41101, control: 41102 } });
  await waitUntil(() => events.includes('ready:2'), 'the connection to attach to the restarted core');
  assert.ok(ssh.calls.length > before, 'the redial bootstrapped again and read the new identity and ports');
  assert.equal(connection.protocol.status, 'ready');
  assert.equal(connection.link.view().state.status, 'connected');
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-2' });
});
test('a reopen racing a model login switch leaves one live client against the core', async (t) => {
  const core = await fakeCore(t);
  const { connection } = serverConnection(t, core, scriptedSsh([probe(core)]));
  await connection.start();
  // The switch dials after the server session is replaced; the reopen begins first and is superseded by it.
  const login = connection.applyModelLogin('server');
  const racing = connection.protocol.reopen();
  await Promise.all([login, racing]);
  await waitUntil(() => core.liveSockets() === 1, 'the superseded client\'s socket to close');
  assert.equal(connection.protocol.status, 'ready');
  assert.equal(connection.link.view().state.status, 'connected');
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-1' });
});

test('Reconnect during an outage opens the core connection now instead of waiting out the library\'s delay', async (t) => {
  const core = await fakeCore(t);
  const { connection } = serverConnection(t, core, scriptedSsh([probe(core)]));
  await connection.start();
  const reopens = [];
  const reopen = connection.protocol.reopen.bind(connection.protocol);
  connection.protocol.reopen = () => (reopens.push(true), reopen());
  // The core is up (its /health answers) but turns this client's dial away: the library's own redial keeps failing.
  core.refuseSockets(true);
  core.drop();
  await waitUntil(() => connection.link.view().state.status === 'reconnecting', 'the outage to show');
  // The user's dial reports the refusal itself, and it was made now: the ladder's wait is not part of it.
  await assert.rejects(connection.reconnect());
  assert.equal(reopens.length >= 1, true, 'Reconnect opened the core connection at once');
  core.refuseSockets(false);
  await connection.reconnect();
  await waitUntil(
    () => connection.protocol.status === 'ready' && connection.link.view().state.status === 'connected',
    'the core to be attached again'
  );
  const result = await connection.client.invokeCapability('mcpStatus', [], 'pane-7');
  assert.deepEqual(result.value, { servers: [], from: 'i-1' });
});

test('a visible thread keeps its stream when the client is replaced: it is resumed on the new one without the user', async (t) => {
  const core = await fakeCore(t);
  const { connection } = serverConnection(t, core, scriptedSsh([probe(core)]));
  await connection.start();
  const resumes = () => core.received.filter((frame) => frame.method === 'thread/resume' && frame.params.threadId === 't1').length;
  await connection.client.setVisibleSessions(['t1']);
  await waitUntil(() => resumes() === 1, 'the visible thread to be resumed');
  await connection.protocol.reopen();
  await waitUntil(() => resumes() === 2, 'the thread to be resumed on the replacing client');
});