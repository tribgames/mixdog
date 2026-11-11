#!/usr/bin/env node
// Golden twin of `scripts/session-transport/state-lanes.test.mjs`: how session and channel state reaches clients.
//   48   `diffSessionState` / `applySessionStatePatch`: a 2k-item tool-card update sends only the changed suffix;
//   67   `session.subscribe` of an unknown session is refused before any runtime exists (`sessionExists` scripted);
//   94   an agent session publishes through the ordinary subscribed `session-state` lane
//        (`subscribeExternalSessionStates` / `readStoredSession` / `onFrame` scripted; frames captured as sent);
//   303  a disconnected channel client keeps only the latest remote-state frame (10 000 writes through the channel
//        transport's `_writeRemoteStateToForTest`, the test hook that is the transport's own write function);
//   327  the channel transport publishes the pinned remote session (`activate_channel_bridge` over HTTP);
//   365  every attached client observes the same session snapshot stream (three clients on the real HTTP/SSE session
//        transport, the stub runtime; the folded snapshots are recorded at each event-driven wait);
//   428  an in-daemon transport connection receives frames without owning the daemon's lifetime (clientCount /
//        connectionCount / the clients-empty callback).
//
// NOT recorded (reasons in `notRecorded`): 19 asserts object identity (no clone) of a Node in-memory snapshot;
// 192, 275, 446, 493 are the Node HTTP/SSE stream itself (reconnect in place, resync markers, silent-stream liveness,
// reconnect budget) which the Rust core replaces with the app-server WebSocket: no Rust counterpart.
//
//   node benchmarks/rust-core/recorders/record-session-transport-state-lanes.mjs --tree <dir>
import { NORMALISED, callOutcome, createNormaliser, withLoggedDaemon } from './lib/session-daemon-harness.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-state-lanes',
  testFile: 'scripts/session-transport/state-lanes.test.mjs',
  entry: 'Ran src/standalone/session-state-patch.mjs (diffSessionState/applySessionStatePatch), session-service.mjs createSessionService().handleCall with scripted sessionExists / readStoredSession / subscribeExternalSessionStates / onFrame, channel-transport.mjs createChannelTransport over real HTTP on 127.0.0.1, and the real session transport + session-client attachSession with the stub runtime of scripts/session-transport/_shared.mjs. Did not run the SSE reconnect/liveness cases (192, 275, 446, 493) nor the identity case 19.',
  replay: 'mixdog-app-server thread/transcript patches and lane pushes (APP/lane_pushes.rs, subscriptions.rs) and mixdog-app-server-daemon lifecycle (DMN/lifecycle): case 48 compare the patch for the same two states byte for byte; 67/94 compare refusal text, subscribed answer and pushed frames; 303/327 compare the latest pending frame / ordered state callbacks; 365 compare each view\'s folded items; 428 compare client/connection counts and the clients-empty signal.',
  exclusions: [
    'cases 19, 192, 275, 446, 493 are listed in notRecorded with their reasons',
    'case 365: frames are DELTAS of a stream with timing-dependent coalescing, so only the folded transcript (itemsFromFrames, as the test folds it) is recorded at each wait, not the frame list',
    'case 303: written through the transport\'s `_writeRemoteStateToForTest` hook (the same function the pointer uses) because the production writer needs a displaced client',
    'case 327: the published state objects carry updatedAt (ms) -> <ms> and daemonPid -> <pid>',
    ...NORMALISED,
  ],
}, async ({ imp }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const cases = [];

  // test line 48
  {
    const items = Array.from({ length: 2_000 }, (_, index) => ({ id: `item-${index}`, kind: index === 1_999 ? 'tool' : 'message', status: 'settled', text: `row-${index}` }));
    const nextItems = items.slice();
    nextItems[1_999] = { ...nextItems[1_999], status: 'completed', text: 'tool result' };
    const previous = { sessionId: 'suffix-test', busy: true, items };
    const next = { sessionId: 'suffix-test', busy: false, items: nextItems };
    const patch = S.diffSessionState(previous, next);
    const applied = S.applySessionStatePatch(previous, patch);
    cases.push({
      name: 'tool-card-update-sends-only-the-changed-transcript-suffix',
      testLine: 48,
      input: { generator: '2000 items {id: item-<i>, kind: message (tool for i=1999), status: settled, text: row-<i>}; next = same with item 1999 {status: completed, text: tool result} and busy true->false', previous: { sessionId: 'suffix-test', busy: true, itemCount: 2000 }, next: { sessionId: 'suffix-test', busy: false, itemCount: 2000 } },
      result: { patch, patchHasItemsInSet: Object.hasOwn(patch.set, 'items'), patchJsonLength: JSON.stringify(patch).length, appliedEqualsNext: JSON.stringify(applied) === JSON.stringify(next) },
    });
  }

  // test line 67
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    let creations = 0;
    const exists = [];
    const service = S.createSessionService({
      createSessionRuntime: async () => { creations += 1; throw new Error('an unknown session must not reach the runtime factory'); },
      sessionExists: async (id) => { exists.push(id); return false; },
    });
    let outcome;
    try { outcome = await callOutcome(ids.norm, service.handleCall('session.subscribe', { sessionId: 'missing_session' }, { clientToken: 'stale_pane' })); } finally { await service.stop('recorder end'); }
    cases.push({ name: 'unknown-session-subscription-is-rejected-before-a-runtime-is-created', testLine: 67, input: { call: ['session.subscribe', { sessionId: 'missing_session' }, { clientToken: 'stale_pane' }], sessionExists: 'always false' }, result: { outcome, runtimeCreations: creations, sessionExistsCalls: exists, serviceSize: service.size } });
  }

  // test line 94
  {
    const ids94 = createNormaliser(S.RUNTIME_ROOT);
    let publishAgentSession = null;
    let creations = 0;
    const frames = [];
    const reads = [];
    const service = S.createSessionService({
      createSessionRuntime: async () => { creations += 1; throw new Error('a live agent projection must not create another runtime'); },
      readStoredSession: async (sessionId) => { reads.push(sessionId); return { sessionId, items: [{ id: 'brief', kind: 'user', text: 'worker brief' }], queued: [] }; },
      subscribeExternalSessionStates(listener) { publishAgentSession = listener; return () => { publishAgentSession = null; }; },
      onFrame(frame, targets) { frames.push({ frame, targets: [...(targets || [])] }); },
    });
    const client = { clientToken: 'desktop-pane' };
    const steps = [];
    try {
      steps.push({ step: "session.subscribe(agent_child)", ...(await callOutcome(ids94.norm, service.handleCall('session.subscribe', { sessionId: 'agent_child' }, client))) });
      publishAgentSession({ sessionId: 'agent_child', snapshot: { sessionId: 'agent_child', items: [{ id: 'brief', kind: 'user', text: 'worker brief' }, { id: 'tool-1', kind: 'tool', text: 'read source' }], queued: [], busy: true } });
      steps.push({ step: 'external publish (brief, tool-1; busy)', frames: ids94.norm(frames), pendingViewerSessions: service.status.pendingViewerSessions, runtimeCreations: creations });
      steps.push({ step: 'session.read(agent_child)', ...(await callOutcome(ids94.norm, service.handleCall('session.read', { sessionId: 'agent_child' }, client))) });
      steps.push({ step: 'session.unsubscribe(agent_child)', ...(await callOutcome(ids94.norm, service.handleCall('session.unsubscribe', { sessionId: 'agent_child' }, client))) });
      const before = frames.length;
      publishAgentSession?.({ sessionId: 'agent_child', snapshot: { sessionId: 'agent_child', items: [{ id: 'ignored', kind: 'assistant', text: 'not observed' }], queued: [] } });
      steps.push({ step: 'external publish after unsubscribe (ignored item)', publisherStillRegistered: publishAgentSession !== null, newFrames: frames.length - before });
    } finally { await service.stop('recorder end'); }
    cases.push({ name: 'agent-session-publishes-through-the-subscribed-session-state-lane', testLine: 94, input: { client, storedSession: { items: [{ id: 'brief', kind: 'user', text: 'worker brief' }] } }, result: { steps, readStoredSessionCalls: reads, runtimeCreations: creations, totalFrames: frames.length } });
  }

  // test line 303
  {
    const transport = S.createChannelTransport({ handleCall: async () => ({ ok: true }) });
    const endpoint = await transport.start();
    let result;
    try {
      const registered = await S.daemonPost(endpoint, '/client/register', { leadPid: process.pid, cwd: process.cwd(), passive: true });
      const client = transport._clientsForTest.get(registered.token);
      for (let index = 0; index < 10_000; index += 1) transport._writeRemoteStateToForTest(client, `state-${index}`);
      result = { clientFound: !!client, pendingRemoteStateFrame: client.pendingRemoteStateFrame, hasPendingQueue: Object.hasOwn(client, 'pending') };
    } finally { await transport.stop(); }
    cases.push({ name: 'disconnected-channel-remote-state-churn-keeps-only-the-latest-frame', testLine: 303, input: { register: { leadPid: '<pid>', passive: true }, writes: 'remote state "state-0" .. "state-9999" in order, client has no SSE stream' }, result });
  }

  // test line 327
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const maskState = (s) => ids.norm({ ...s, updatedAt: '<ms>', daemonPid: s.daemonPid === process.pid ? '<pid>' : s.daemonPid });
    const states = [];
    const hostCalls = [];
    const transport = S.createChannelTransport({
      handleCall: async (name, args) => {
        hostCalls.push({ name, args });
        if (name === 'activate_channel_bridge' && args.active === true) transport.notify('notifications/mixdog/remote', { state: 'acquired' });
        return { ok: true };
      },
      onRemoteStateChange: (state) => states.push(state),
    });
    const endpoint = await transport.start();
    const steps = [];
    try {
      const registered = await S.daemonPost(endpoint, '/client/register', { leadPid: process.pid, cwd: process.cwd(), passive: true });
      for (const args of [{ active: true, sessionId: 'session_remote' }, { active: false, sessionId: 'session_remote' }]) {
        const response = await callOutcome(ids.norm, S.daemonPost(endpoint, '/call', { token: registered.token, name: 'activate_channel_bridge', args }));
        steps.push({ call: { name: 'activate_channel_bridge', args }, response, lastState: states.length ? maskState(states.at(-1)) : null, stateCount: states.length });
      }
    } finally { await transport.stop(); }
    cases.push({ name: 'channel-transport-publishes-the-pinned-remote-session-independently-of-state-file-persistence', testLine: 327, input: { register: { leadPid: '<pid>', passive: true }, calls: steps.map((s) => s.call) }, result: { steps, states: states.map(maskState), hostCalls } });
  }

  // test line 365
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, signal, calls }) => {
      const terminalFrames = [];
      const desktopFrames = [];
      const unrelatedFrames = [];
      const attach = (sink) => S.attachSession({ discovery, cwd: process.cwd(), onFrame: (frame) => { sink.push(frame); signal.notify(); } });
      const terminal = await attach(terminalFrames);
      const desktop = await attach(desktopFrames);
      const unrelated = await attach(unrelatedFrames);
      const steps = [];
      const created = await terminal.call('session.create', { cwd: process.cwd() });
      steps.push({ step: 'terminal session.create', sessionIdMatches: /^sess_daemon_/.test(created.sessionId), reservedOnly: created.reservedOnly });
      const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
      steps.push({ step: 'desktop session.subscribe', subscribed: subscribed.subscribed });
      desktopFrames.push({ type: 'session-state', sessionId: created.sessionId, revision: subscribed.revision, full: subscribed.full, patch: subscribed.patch });
      await terminal.call('session.submit', { sessionId: created.sessionId, prompt: 'from terminal' });
      const seen = await signal.until(() => { const items = S.itemsFromFrames(desktopFrames); return items.length === 1 ? items : null; }, 'desktop view receives the terminal submission');
      steps.push({ step: 'terminal session.submit "from terminal"; desktop view folded items', items: ids.norm(seen) });
      await desktop.call('session.submit', { sessionId: created.sessionId, prompt: 'from desktop' });
      await signal.until(() => S.itemsFromFrames(terminalFrames).length === 2, 'terminal view receives the desktop submission');
      steps.push({ step: 'desktop session.submit "from desktop"; terminal view folded items', items: ids.norm(S.itemsFromFrames(terminalFrames)) });
      steps.push({ step: 'unrelated client frames for the session', count: unrelatedFrames.filter((frame) => frame.sessionId === created.sessionId).length });
      await terminal.close('recorder end');
      await desktop.close('recorder end');
      await unrelated.close('recorder end');
      return { steps, serviceCalls: calls.map(({ name, args, context, error }) => ({ name, args, context, error: error ?? null })) };
    });
    cases.push({ name: 'every-attached-client-observes-the-same-session-snapshot-stream', testLine: 365, input: { clients: ['terminal', 'desktop', 'unrelated'], steps: ['terminal session.create', 'desktop session.subscribe', 'terminal submit "from terminal"', 'desktop submit "from desktop"'] }, result });
  }

  // test line 428
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, transport, clientsEmpty, signal }) => {
      const steps = [];
      const external = await S.attachSession({ discovery, cwd: process.cwd() });
      const internal = await S.attachSession({ discovery, cwd: process.cwd(), lifecycle: false });
      steps.push({ step: 'attach an external client and an in-daemon (lifecycle:false) client', clientCount: transport.clientCount, connectionCount: transport.connectionCount, clientsEmpty: clientsEmpty() });
      await external.close('external client closed');
      await signal.until(() => clientsEmpty() === 'empty', 'lifecycle emptiness ignores the internal connection');
      steps.push({ step: 'external client closed', clientCount: transport.clientCount, connectionCount: transport.connectionCount, clientsEmpty: clientsEmpty() });
      await internal.close('recorder end');
      return { steps };
    });
    cases.push({ name: 'in-daemon-transport-connection-receives-frames-without-owning-daemon-lifetime', testLine: 428, input: { attach: [{ lifecycle: true }, { lifecycle: false }], close: 'the external client' }, result });
  }

  const notRecorded = [
    { testLine: 19, name: 'wire-safe runtime state crosses the daemon without a transcript clone', reason: 'asserts object identity (result.full === state, same items array) of a Node in-memory snapshot: a memory property with no wire-visible value' },
    { testLine: 192, name: 'a live daemon SSE stream reconnects in place with the same client registration', reason: 'the Node HTTP/SSE stream client itself; the Rust core serves the app-server WebSocket, no counterpart' },
    { testLine: 275, name: 'a disconnected client receives bounded session resync markers instead of a huge backlog', reason: 'SSE backlog budget and resyncRequired markers of the Node transport; removed in the Rust protocol (no resync markers)' },
    { testLine: 446, name: 'a local attachment keeps a silent stream: only the socket closing ends it', reason: 'SSE stream-liveness timers of the Node client (mock clock on its own HTTP server); no Rust counterpart' },
    { testLine: 493, name: 'a silent SSE is reconnected and a continuous reconnect storm exhausts its budget', reason: 'SSE liveness timeout and reconnect budget of the Node client; no Rust counterpart' },
  ];
  return { cases, notRecorded };
});
process.exit(0);
