#!/usr/bin/env node
// Golden twin of `scripts/session-transport/state-lanes.test.mjs`: how session and channel state reaches clients.
//   48   `diffSessionState` / `applySessionStatePatch`: a 2k-item tool-card update sends only the changed suffix;
//   67   `session.subscribe` of an unknown session is refused before any runtime exists (`sessionExists` scripted);
//   94   an agent session publishes through the ordinary subscribed `session-state` lane
//        (`subscribeExternalSessionStates` / `readStoredSession` / `onFrame` scripted; frames captured as sent);
//   192  a live daemon event stream that ends is reconnected in place with the same client registration, while ordinary
//        calls keep working (scripted daemon, the real client; what the daemon saw and what the client reported);
//   275  a disconnected client gets a bounded `resyncRequired` marker instead of a huge backlog (the frame as received);
//   303  a disconnected channel client keeps only the latest remote-state frame (10 000 writes through the channel
//        transport's `_writeRemoteStateToForTest`, the test hook that is the transport's own write function);
//   327  the channel transport publishes the pinned remote session (`activate_channel_bridge` over HTTP): the Node of the
//        base commit AND the Node with the fix of `node-fix-remote-state-null-session.patch`;
//   365  every attached client observes the same session snapshot stream (three clients on the real HTTP/SSE session
//        transport, the stub runtime);
//   428  an in-daemon transport connection receives frames without owning the daemon's lifetime (clientCount /
//        connectionCount / the clients-empty callback);
//   446  a local attachment keeps a silent stream: ten virtual minutes pass without a disconnect; only the socket closing
//        ends it (virtual clock: the recorder ticks the mocked setTimeout, every tick is a recorded step);
//   493  a silent stream is reconnected and a continuous reconnect storm exhausts its budget (virtual wall clock: every
//        move of Date.now is a recorded step; the scripted daemon holds each reconnect until the recorder releases it).
//
// NOT recorded (reasons in `notRecorded`): 19 asserts object identity (no clone) of a Node in-memory snapshot.
//
//   node benchmarks/rust-core/recorders/record-session-transport-state-lanes.mjs --tree <dir>
import http from 'node:http';
import { rmSync } from 'node:fs';
import { mock } from 'node:test';
import { exact } from './lib/exact.mjs';
import { buildPatchedTree } from './lib/patched-tree.mjs';
import { DETERMINISM, FIXED_CWD, FIXED_PID, FIXED_NOW, Signal, clock, installDeterminism, startWireTap, withLoggedDaemon } from './lib/session-wire-harness.mjs';
import { outcomeExact, runSessionRecorder } from './lib/session-rec.mjs';

installDeterminism();
const PATCH = 'benchmarks/rust-core/recorders/patches/node-fix-remote-state-null-session.patch';

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-state-lanes',
  testFile: 'scripts/session-transport/state-lanes.test.mjs',
  dataFiles: [PATCH],
  patch: { file: PATCH, applied: 'to a temporary copy of the tree\'s src for the second recording of case 327 only; every other case runs the unpatched tree', fixes: 'src/standalone/channel-transport/remote-state.mjs: String(null) published Remote as enabled for the session "null" (case 327, first state)' },
  entry: 'Ran src/standalone/session-state-patch.mjs (diffSessionState/applySessionStatePatch), session-service.mjs createSessionService().handleCall with scripted sessionExists / readStoredSession / subscribeExternalSessionStates / onFrame, channel-transport.mjs createChannelTransport over real HTTP on 127.0.0.1 (behind a TCP tap), the real session transport + session-client attachSession with the stub runtime of scripts/session-transport/_shared.mjs, and, for 192/446/493, the real session client against a scripted HTTP daemon (the test\'s own stand-in, a recorder-side http.createServer) behind the tap. Every HTTP exchange (status line, headers in order, body; an event stream as its frames) is recorded. Did not run the identity case 19.',
  replay: "Replayed over the transport harness of native/core/crates/mixdog-app-server/src/tests/wire.rs: the server behind its real WebSocket listener on a loopback port, real client connections driven as the daemon drives them, over a real session thread. Every frame each client received is compared whole and in order (session_transport.rs whole); the only normalization is wire::normalized: ids the core generates become <id:N> in order of first appearance and clock readings (*At fields, clientHostPid) become <clock>/<pid>. The recorded HTTP exchanges (wire: start lines, headers, Content-Length) are Node's HTTP/SSE framing of each call; the core's client transport is one WebSocket carrying each JSON-RPC message as one text frame (mixdog-app-server-transport websocket.rs), so the frame bodies are compared and the HTTP framing has no counterpart. Cases: 67 an_unknown_thread_is_refused_and_nothing_is_created, 94 an_unsubscribed_client_receives_nothing_more, 365 every_attached_client_folds_the_same_items (the desktop's prompt, sent while the terminal's runs, waits in the thread's queue and runs next: the core runs one turn at a time), 303 remote_state_churn_with_no_reader_leaves_only_the_latest (10000 hostState.remoteSession publications with no client, then a client attaching receives one snapshot holding the latest). 327 (--with-the-fix) is replayed by mixdog-services channels/tests_runtime.rs the_bridge_binding_publishes_the_pinned_session_as_node_does: every hostState.remoteSession publication whole, Node's frames applied as the desktop applies them (session-host-publication.ts:290); Node's second frame is the client registration adding its cwd, which has no core counterpart (no channel transport client registers). 428 is replayed by mixdog-app-server-daemon late_lifecycle.rs the_last_client_connection_closing_stops_the_core_as_nodes_clients_empty through the server's connection entry (client_opened/client_closed); Node's connectionCount also counts its in-daemon transport connection (lifecycle:false), and the core's in-daemon callers use CallContext::internal, never a connection, so the core's count is Node's minus that one. Not replayed: 48 (Node's transcript patch has no core counterpart: the core's thread lane carries one event per item after its snapshot, never the transcript); 192, 446, 493 (Node's SSE event stream: reconnect in place, liveness timeout and reconnect budget of Node's HTTP client); 275 (Node's resync marker frame; a lagging core subscription is resynced by the app-server lane recovery, mixdog-app-server tests/storm.rs); 327 base commit (records the String(null) defect the patch fixes).",
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'case 19 is listed in notRecorded with its reason',
    'wire taps record the HTTP exchanges in request order: `Host` header port value -> <port> and the response `Date` header value -> <date>, at those header paths; and this machine\'s roots (the checkout process.cwd() -> <CWD>, the OS temp dir -> <TMP>, the user home -> <HOME>, in every spelling found: as written, forward slashes, JSON-escaped, URL-encoded, each also lower-cased; text after the root, separators included, is kept) in every request/response startLine, header value, body and event-stream frame (lib/tmp-mark.mjs). The Content-Length is the one Node sent: a message that had a root replaced carries `rewrites` {label: {originalLength, count}} (a label for a spelling other than as written reads "<CWD> (JSON-escaped)"), so length(recorded body) + sum(count * (originalLength - label length)) = Content-Length. No other value is normalised',
    'case 303: written through the transport\'s `_writeRemoteStateToForTest` hook (the same function the pointer uses) because the production writer needs a displaced client',
    'cases 446 and 493 move virtual clocks: 446 ticks the mocked global setTimeout (only setTimeout is faked; sockets keep their own timers), 493 moves Date.now() by recorded steps while the client\'s own 5-20 ms timers run in real time and the scripted daemon holds every reconnect until released',
    ...DETERMINISM,
  ],
}, async ({ imp, tree, importFrom }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const cases = [];
  const add = (name, line, input, result) => cases.push({ name, testLine: line, input: exact(input), result });
  const setup = { cwd: FIXED_CWD, leadPid: FIXED_PID };

  // test line 48
  {
    const items = Array.from({ length: 2_000 }, (_, index) => ({ id: `item-${index}`, kind: index === 1_999 ? 'tool' : 'message', status: 'settled', text: `row-${index}` }));
    const nextItems = items.slice();
    nextItems[1_999] = { ...nextItems[1_999], status: 'completed', text: 'tool result' };
    const previous = { sessionId: 'suffix-test', busy: true, items };
    const next = { sessionId: 'suffix-test', busy: false, items: nextItems };
    const patch = S.diffSessionState(previous, next);
    const applied = S.applySessionStatePatch(previous, patch);
    add('tool-card-update-sends-only-the-changed-transcript-suffix', 48, { previous, next }, { patch: exact(patch), applied: exact(applied) });
  }

  // test line 67
  {
    let creations = 0;
    const exists = [];
    const service = S.createSessionService({
      createSessionRuntime: async () => { creations += 1; throw new Error('an unknown session must not reach the runtime factory'); },
      sessionExists: async (id) => { exists.push(id); return false; },
    });
    let outcome;
    try { outcome = await outcomeExact(() => service.handleCall('session.subscribe', { sessionId: 'missing_session' }, { clientToken: 'stale_pane' })); } finally { await service.stop('recorder end'); }
    add('unknown-session-subscription-is-rejected-before-a-runtime-is-created', 67, { call: ['session.subscribe', { sessionId: 'missing_session' }, { clientToken: 'stale_pane' }], sessionExists: 'always false' }, { outcome, runtimeCreations: creations, sessionExistsCalls: exists, serviceSize: service.size });
  }

  // test line 94
  {
    let publishAgentSession = null;
    let creations = 0;
    const frames = [];
    const reads = [];
    const service = S.createSessionService({
      createSessionRuntime: async () => { creations += 1; throw new Error('a live agent projection must not create another runtime'); },
      readStoredSession: async (sessionId) => { reads.push(sessionId); return { sessionId, items: [{ id: 'brief', kind: 'user', text: 'worker brief' }], queued: [] }; },
      subscribeExternalSessionStates(listener) { publishAgentSession = listener; return () => { publishAgentSession = null; }; },
      onFrame(frame, targets) { frames.push(exact({ frame, targets: [...(targets || [])] })); },
    });
    const client = { clientToken: 'desktop-pane' };
    const steps = [];
    try {
      steps.push({ step: 'session.subscribe(agent_child)', ...(await outcomeExact(() => service.handleCall('session.subscribe', { sessionId: 'agent_child' }, client))) });
      publishAgentSession({ sessionId: 'agent_child', snapshot: { sessionId: 'agent_child', items: [{ id: 'brief', kind: 'user', text: 'worker brief' }, { id: 'tool-1', kind: 'tool', text: 'read source' }], queued: [], busy: true } });
      steps.push({ step: 'external publish (brief, tool-1; busy)', frames: frames.slice(), pendingViewerSessions: exact(service.status.pendingViewerSessions), runtimeCreations: creations });
      steps.push({ step: 'session.read(agent_child)', ...(await outcomeExact(() => service.handleCall('session.read', { sessionId: 'agent_child' }, client))) });
      steps.push({ step: 'session.unsubscribe(agent_child)', ...(await outcomeExact(() => service.handleCall('session.unsubscribe', { sessionId: 'agent_child' }, client))) });
      const before = frames.length;
      publishAgentSession?.({ sessionId: 'agent_child', snapshot: { sessionId: 'agent_child', items: [{ id: 'ignored', kind: 'assistant', text: 'not observed' }], queued: [] } });
      steps.push({ step: 'external publish after unsubscribe (ignored item)', publisherStillRegistered: publishAgentSession !== null, newFrames: frames.slice(before) });
    } finally { await service.stop('recorder end'); }
    add('agent-session-publishes-through-the-subscribed-session-state-lane', 94, { client, storedSession: { items: [{ id: 'brief', kind: 'user', text: 'worker brief' }] } }, { steps, readStoredSessionCalls: reads, runtimeCreations: creations, allFrames: frames });
  }

  // A scripted daemon: the test's own stand-in for the daemon (cases 192, 446, 493), behind the wire tap.
  const startScripted = async (handler) => {
    const server = http.createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const tap = await startWireTap(server.address().port);
    return { server, tap, stop: async () => { await tap.stop(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
  };
  const jsonSend = (res, value, statusCode = 200) => { res.writeHead(statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

  // test line 192
  {
    const signal = new Signal();
    const streamResponses = [];
    const reconnects = [];
    const fatals = [];
    let registrations = 0;
    const scripted = await startScripted((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') { jsonSend(res, { error: 'temporarily overloaded' }, 503); return; }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write(': attached\n\n');
        streamResponses.push(res);
        signal.notify();
        return;
      }
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST' && url.pathname === '/client/register') { registrations += 1; jsonSend(res, { token: 'client-token', pid: process.pid }); return; }
        if (req.method === 'POST' && url.pathname === '/client/deregister') { jsonSend(res, { ok: true }); return; }
        if (req.method === 'POST' && url.pathname === '/call') { jsonSend(res, { result: 'still-connected' }); return; }
        res.writeHead(404);
        res.end();
      });
    });
    const steps = [];
    let client = null;
    try {
      client = await S.attachSession({
        discovery: { port: scripted.tap.port, token: 'server-token', pid: process.pid },
        onFatal: (reason) => fatals.push(exact(reason)),
        onStreamReconnect: (details) => { reconnects.push(exact(details)); signal.notify(); },
        streamReconnectBaseMs: 5,
        streamReconnectMaxMs: 10,
      });
      await signal.until(() => streamResponses.length === 1, 'the first event stream reached the daemon');
      steps.push({ step: 'attach: first event stream open', registrations });
      streamResponses[0].end();
      steps.push({ step: "daemon ends the stream; client.call('probe')", ...(await outcomeExact(() => client.call('probe'))) });
      await signal.until(() => streamResponses.length === 2, 'the client opened a second event stream');
      await signal.until(() => reconnects.length === 1, 'the client reported its reconnect');
      steps.push({ step: 'second stream open and reconnect reported', registrations, fatals: fatals.slice(), reconnects: reconnects.slice() });
    } finally {
      await client?.close('recorder end');
      for (const response of streamResponses) { try { response.end(); } catch { /* already ended */ } }
    }
    const wire = await scripted.tap.exchanges();
    await scripted.stop();
    add('live-daemon-sse-stream-reconnects-in-place-with-the-same-client-registration', 192, { scriptedDaemon: 'GET /health 503 {error: temporarily overloaded}; GET /events 200 event-stream ": attached"; POST /client/register {token: client-token, pid}; POST /client/deregister {ok}; POST /call {result: still-connected}', client: { streamReconnectBaseMs: 5, streamReconnectMaxMs: 10 }, daemonToken: 'server-token' }, { steps, wire });
  }

  // test line 275
  {
    const result = await withLoggedDaemon(S, async ({ discovery, transport, calls, wire }) => {
      const registered = await S.daemonPost(discovery, '/client/register', { protocol: S.SESSION_PROTOCOL, leadPid: process.pid, cwd: FIXED_CWD, lifecycle: false });
      const target = new Set([registered.token]);
      const large = 'x'.repeat(160 * 1024);
      for (let index = 0; index < 3; index += 1) {
        transport.broadcast({ type: 'session-state', key: `session-state:budget-${index}`, sessionId: `budget-${index}`, revision: index + 1, full: { sessionId: `budget-${index}`, items: [{ text: large }] } }, target);
      }
      // Read until the last broadcast's frame, so the stream the tap saw ends at the same frame every run (reading
      // only to the first marker left the later frames racing the close).
      const last = await S.waitForSseFrame(discovery, registered.token, (frame) => frame?.key === 'session-state:budget-2');
      await S.daemonPost(discovery, '/client/deregister', { token: registered.token });
      return { registered: exact(registered), last: exact(last), serviceCalls: calls, wire: await wire.exchanges() };
    });
    add('disconnected-client-receives-bounded-session-resync-markers-instead-of-a-huge-backlog', 275, { register: { protocol: 'SESSION_PROTOCOL', leadPid: FIXED_PID, cwd: FIXED_CWD, lifecycle: false }, broadcast: '3 session-state frames of one 160 KiB item each (keys session-state:budget-0..2, revisions 1..3) to the registered client while it has no event stream', then: 'the client opens its event stream and the recorder reads until the frame of session-state:budget-2', env: 'MIXDOG_SESSION_SSE_PENDING_MB=0.25 (set by the test scaffold)' }, result);
  }

  // test line 303 (the channel transport behind the tap)
  {
    const transport = S.createChannelTransport({ handleCall: async () => ({ ok: true }) });
    const endpoint = await transport.start();
    const tap = await startWireTap(endpoint.port);
    let result;
    try {
      const registered = await S.daemonPost({ port: tap.port, token: endpoint.token }, '/client/register', { leadPid: process.pid, cwd: FIXED_CWD, passive: true });
      const client = transport._clientsForTest.get(registered.token);
      for (let index = 0; index < 10_000; index += 1) transport._writeRemoteStateToForTest(client, `state-${index}`);
      result = { registered: exact(registered), clientFound: !!client, pendingRemoteStateFrame: client.pendingRemoteStateFrame, pendingQueueFieldPresent: Object.hasOwn(client, 'pending'), wire: await tap.exchanges() };
    } finally { await tap.stop(); await transport.stop(); }
    add('disconnected-channel-remote-state-churn-keeps-only-the-latest-frame', 303, { register: { leadPid: FIXED_PID, cwd: FIXED_CWD, passive: true }, writes: 'remote state "state-0" .. "state-9999" in order, client has no SSE stream' }, result);
  }

  // test line 327: the Node of the base commit, then the Node with the fix
  const run327 = async (createChannelTransport) => {
    const states = [];
    const hostCalls = [];
    const transport = createChannelTransport({
      handleCall: async (name, args) => {
        hostCalls.push(exact({ name, args }));
        if (name === 'activate_channel_bridge' && args.active === true) transport.notify('notifications/mixdog/remote', { state: 'acquired' });
        return { ok: true };
      },
      onRemoteStateChange: (state) => states.push(exact(state)),
    });
    const endpoint = await transport.start();
    const tap = await startWireTap(endpoint.port);
    const steps = [];
    try {
      const registered = await S.daemonPost({ port: tap.port, token: endpoint.token }, '/client/register', { leadPid: process.pid, cwd: FIXED_CWD, passive: true });
      steps.push({ call: 'POST /client/register', registered: exact(registered) });
      for (const args of [{ active: true, sessionId: 'session_remote' }, { active: false, sessionId: 'session_remote' }]) {
        const response = await outcomeExact(() => S.daemonPost({ port: tap.port, token: endpoint.token }, '/call', { token: registered.token, name: 'activate_channel_bridge', args }));
        steps.push({ call: { name: 'activate_channel_bridge', args: exact(args) }, response, statesSoFar: states.slice() });
      }
    } finally { await tap.stop(); await transport.stop(); }
    return { steps, states, hostCalls };
  };
  const channelInput = { register: { leadPid: FIXED_PID, cwd: FIXED_CWD, passive: true }, calls: [{ active: true, sessionId: 'session_remote' }, { active: false, sessionId: 'session_remote' }] };
  {
    const out = await run327(S.createChannelTransport);
    add('channel-transport-publishes-the-pinned-remote-session-independently-of-state-file-persistence', 327, { ...channelInput, node: 'base commit b6f10295a' }, out);
    // Bug recorded as it is: `states[0]` is `{ enabled: true, sessionId: "null" }` (String(null) in remote-state.mjs:17) -- see the patch.
  }
  {
    const patched = buildPatchedTree(tree, PATCH);
    try {
      const patchedChannel = await importFrom(patched, 'src/standalone/channel-transport.mjs');
      const out = await run327(patchedChannel.createChannelTransport);
      add('channel-transport-publishes-the-pinned-remote-session-independently-of-state-file-persistence--with-the-fix', 327, { ...channelInput, node: 'base commit b6f10295a with node-fix-remote-state-null-session.patch applied' }, out);
    } finally { rmSync(patched, { recursive: true, force: true }); }
  }

  // test line 365
  {
    const result = await withLoggedDaemon(S, async ({ discovery, signal, calls, wire }) => {
      const terminalFrames = [];
      const desktopFrames = [];
      const unrelatedFrames = [];
      const attach = (sink) => S.attachSession({ discovery, cwd: FIXED_CWD, onFrame: (frame) => { sink.push(exact(frame)); signal.notify(); } });
      const terminal = await attach(terminalFrames);
      const desktop = await attach(desktopFrames);
      const unrelated = await attach(unrelatedFrames);
      const steps = [];
      const created = await terminal.call('session.create', { cwd: FIXED_CWD });
      steps.push({ step: 'terminal session.create', ok: exact(created) });
      const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
      steps.push({ step: 'desktop session.subscribe', ok: exact(subscribed) });
      desktopFrames.push(exact({ type: 'session-state', sessionId: created.sessionId, revision: subscribed.revision, full: subscribed.full, patch: subscribed.patch }));
      await terminal.call('session.submit', { sessionId: created.sessionId, prompt: 'from terminal' });
      const seen = await signal.until(() => { const items = S.itemsFromFrames(desktopFrames); return items.length === 1 ? items : null; }, 'desktop view receives the terminal submission');
      steps.push({ step: 'terminal session.submit "from terminal"; desktop view folded items', items: exact(seen) });
      await desktop.call('session.submit', { sessionId: created.sessionId, prompt: 'from desktop' });
      await signal.until(() => S.itemsFromFrames(terminalFrames).length === 2, 'terminal view receives the desktop submission');
      steps.push({ step: 'desktop session.submit "from desktop"; terminal view folded items', items: exact(S.itemsFromFrames(terminalFrames)) });
      await terminal.close('recorder end');
      await desktop.close('recorder end');
      await unrelated.close('recorder end');
      return { steps, terminalFrames, desktopFrames, unrelatedFrames, serviceCalls: calls, wire: await wire.exchanges() };
    });
    add('every-attached-client-observes-the-same-session-snapshot-stream', 365, { clients: ['terminal', 'desktop', 'unrelated'], steps: ['terminal session.create', 'desktop session.subscribe', 'terminal submit "from terminal"', 'desktop submit "from desktop"'], ...setup }, result);
  }

  // test line 428
  {
    const result = await withLoggedDaemon(S, async ({ discovery, transport, clientsEmpty, signal, wire }) => {
      const steps = [];
      const external = await S.attachSession({ discovery, cwd: FIXED_CWD });
      const internal = await S.attachSession({ discovery, cwd: FIXED_CWD, lifecycle: false });
      steps.push({ step: 'attach an external client and an in-daemon (lifecycle:false) client', clientCount: transport.clientCount, connectionCount: transport.connectionCount, clientsEmpty: clientsEmpty() });
      await external.close('external client closed');
      await signal.until(() => clientsEmpty() === 'empty', 'lifecycle emptiness ignores the internal connection');
      steps.push({ step: 'external client closed', clientCount: transport.clientCount, connectionCount: transport.connectionCount, clientsEmpty: clientsEmpty() });
      await internal.close('recorder end');
      return { steps, wire: await wire.exchanges() };
    });
    add('in-daemon-transport-connection-receives-frames-without-owning-daemon-lifetime', 428, { attach: [{ lifecycle: true }, { lifecycle: false }], close: 'the external client', ...setup }, result);
  }

  // test line 446: the stream is silent; virtual time (the mocked global setTimeout) moves only by recorded ticks
  {
    const signal = new Signal();
    let eventRequests = 0;
    const streams = [];
    const scripted = await startScripted((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/events') {
        eventRequests += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write(': attached\n\n');
        streams.push(res);
        signal.notify();
        return;
      }
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(url.pathname === '/client/register' ? { token: 'client-token', pid: process.pid } : {})); });
    });
    const disconnects = [];
    const steps = [];
    let client = null;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      client = await S.attachSession({
        discovery: { port: scripted.tap.port, token: 'server-token', pid: process.pid },
        onStreamDisconnect: (details) => { disconnects.push(exact(details)); signal.notify(); },
      });
      await signal.until(() => eventRequests === 1, 'the event stream reached the daemon');
      steps.push({ step: 'attached; event stream open', eventRequests, disconnects: disconnects.slice() });
      mock.timers.tick(10 * 60_000);
      steps.push({ step: 'virtual clock tick 600000 ms (setTimeout only)' });
      steps.push({ step: "client.call('probe') (an answered call is the barrier: the stream's liveness timers had their chance)", ...(await outcomeExact(() => client.call('probe'))), eventRequests, disconnects: disconnects.slice() });
      streams[0].socket.destroy();
      await signal.until(() => disconnects.length === 1, 'the stream reported its disconnect after the daemon closed the socket');
      steps.push({ step: 'daemon destroys the stream socket', eventRequests, disconnects: disconnects.slice() });
    } finally {
      mock.timers.reset();
      await client?.close('recorder end');
    }
    const wire = await scripted.tap.exchanges();
    await scripted.stop();
    add('local-attachment-keeps-a-silent-stream-only-the-socket-closing-ends-it', 446, { scriptedDaemon: 'GET /events 200 event-stream ": attached" then silent; any other request 200 json ({token: client-token, pid} for /client/register, {} otherwise)', virtualClock: [{ tick: 'setTimeout', ms: 600_000 }] }, { steps, wire });
  }

  // test line 493: virtual wall clock (Date.now); the daemon holds each reconnect until released, so the attempts are counted
  {
    const signal = new Signal();
    const fatals = [];
    const disconnects = [];
    const held = [];
    let eventRequests = 0;
    const scripted = await startScripted((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') { jsonSend(res, { status: 'ok', pid: process.pid }); return; }
      if (req.method === 'GET' && url.pathname === '/events') {
        eventRequests += 1;
        if (eventRequests === 1) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
          res.write(': attached\n\n');
        } else held.push(res);
        signal.notify();
        return;
      }
      req.resume();
      req.on('end', () => {
        if (req.method === 'POST' && url.pathname === '/client/register') jsonSend(res, { token: 'client-token', pid: process.pid });
        else if (req.method === 'POST' && url.pathname === '/client/deregister') jsonSend(res, { ok: true });
        else jsonSend(res, { error: 'not found' }, 404);
      });
    });
    const release = () => jsonSend(held.shift(), { error: 'temporary stream failure' }, 503);
    const steps = [];
    let client = null;
    clock.now = 1_000;
    steps.push({ step: 'virtual wall clock set', dateNow: 1_000 });
    try {
      client = await S.attachSession({
        discovery: { port: scripted.tap.port, token: 'server-token', pid: process.pid },
        onFatal: (reason) => { fatals.push(exact(reason)); signal.notify(); },
        onStreamDisconnect: (details) => { disconnects.push(exact(details)); signal.notify(); },
        streamReconnectBaseMs: 5,
        streamReconnectMaxMs: 10,
        streamLivenessTimeoutMs: 20,
        streamReconnectBudgetMs: 60,
      });
      await signal.until(() => held.length === 1, 'the silent stream was declared dead and the first reconnect reached the daemon');
      steps.push({ step: 'liveness timeout 20 ms: first reconnect (daemon holds it)', eventRequests, fatals: fatals.slice(), disconnects: disconnects.slice() });
      clock.now += 59;
      steps.push({ step: 'virtual wall clock +59', dateNow: clock.now });
      release();
      await signal.until(() => held.length === 1, 'the client retried after the first 503');
      steps.push({ step: 'daemon answers the first reconnect 503; the client retries (held)', eventRequests, fatals: fatals.slice() });
      clock.now += 1;
      steps.push({ step: 'virtual wall clock +1', dateNow: clock.now });
      release();
      await signal.until(() => fatals.length === 1, 'the reconnect budget was exhausted');
      steps.push({ step: 'daemon answers the retry 503; budget exhausted', eventRequests, fatals: fatals.slice(), disconnects: disconnects.slice() });
    } finally {
      clock.now = FIXED_NOW;
      await client?.close('recorder end');
      for (const res of held.splice(0)) { try { jsonSend(res, { error: 'recorder end' }, 503); } catch { /* closed */ } }
    }
    const wire = await scripted.tap.exchanges();
    await scripted.stop();
    add('silent-sse-is-reconnected-and-a-continuous-reconnect-storm-exhausts-its-budget', 493, { scriptedDaemon: 'GET /health 200 {status: ok, pid}; GET /events: first 200 event-stream ": attached" then silent, every later one held until released then 503 {error: temporary stream failure}; POST /client/register {token: client-token, pid}; POST /client/deregister {ok}; else 404', client: { streamReconnectBaseMs: 5, streamReconnectMaxMs: 10, streamLivenessTimeoutMs: 20, streamReconnectBudgetMs: 60 }, virtualWallClock: [1_000, '+59', '+1'] }, { steps, wire });
  }

  const notRecorded = [
    { testLine: 19, name: 'wire-safe runtime state crosses the daemon without a transcript clone', reason: 'asserts object identity (result.full === state, same items array) of a Node in-memory snapshot: a memory property with no wire-visible value' },
  ];
  return { cases, notRecorded };
});
process.exit(0);
