#!/usr/bin/env node
// Golden twin of `scripts/session-transport/call-contract.test.mjs`: the session call contract of the daemon.
//   15   `createSessionOAuthFlowRegistry` status / complete / cancel (provider callbacks scripted; the registry's 10-minute
//        TTL timer is armed on a never-advanced clock: every `setTimeout` armed is recorded);
//   82   `session.list` is the one catalog route and never rides session responses (`createSessionService().handleCall`);
//   130  `session.read` with `messageStart` returns raw agent messages;
//   156  call idempotency is isolated per client process (same callId, two clients: both run);
//   243  submit ACKs queue intake and unsubscribe/disconnect never interrupt execution (HTTP + SSE, detachable runtime);
//   299  session faults answer as call errors and non-serializable values are dropped;
//   320  an addressed session never silently moves to another id (service log lines recorded);
//   369  responses after an address mismatch keep the addressed id; the proxy `createTransitions().applyResult` binding;
//   438  a retried call with the same id runs exactly one runtime mutation;
//   465  what a client sees across a session: its own submission mirrored, abort restoration (draft suppresses the
//        rewind / interrupt restores the prompt and images), a New task starting from a fresh transcript, a second view
//        owning another session. Recorded at the level a client sees: the service calls the remote runtime made, the HTTP
//        exchanges, and what the runtime returned and reported after every step;
//   507  reusing a callId with a different payload fails closed.
// Calls over HTTP go through the real transport + `attachSession` client; the stub runtimes are scripted endpoints.
//
// NOT recorded (reasons in `notRecorded`): 48 (a Node daemon log line), 451 (the Node transport's call-cache entry counter).
//
//   node benchmarks/rust-core/recorders/record-session-transport-call-contract.mjs --tree <dir>
import { exact, exactArgs } from './lib/exact.mjs';
import { DETERMINISM, FIXED_CWD, FIXED_PID, FIXED_PPID, Signal, installDeterminism, withLoggedDaemon } from './lib/session-wire-harness.mjs';
import { outcomeExact, runSessionRecorder } from './lib/session-rec.mjs';

installDeterminism();

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-call-contract',
  testFile: 'scripts/session-transport/call-contract.test.mjs',
  entry: 'Ran src/tui/session/oauth-flows.mjs, src/standalone/session-service.mjs createSessionService().handleCall (scripted runtime factory / readStoredSession / listSessions / log), the real HTTP session transport + session-client attachSession and createSession (callId cache, client registry, remote runtime proxy) with the stub runtimes of scripts/session-transport/_shared.mjs, and src/standalone/session-proxy/transitions.mjs createTransitions. A TCP tap in front of the transport records every HTTP exchange (status line, headers in order, body). Did not run the log-summary and call-cache-metric cases (see notRecorded).',
  replay: 'App-server protocol methods of the Rust core (native/core/crates/mixdog-app-protocol methods.rs, served by mixdog-app-server): session.create -> thread/start, session.read -> thread/read, session.submit -> turn/start, session.abort -> turn/interrupt, session.subscribe/unsubscribe -> thread/resume + thread/unsubscribe, session.configure (setRoute, renameSessionTitle) -> thread/setEffort / thread/rename and the other thread/set* methods, session.list -> thread/list; OAuth flows -> account/beginOAuthProviderLogin, account/completeOAuthProviderLogin, account/cancelOAuthProviderLogin, account/getOAuthProviderLoginStatus. Drive the same ordered calls with the same arguments and callIds (op-id replay and payload conflict: mixdog-core-base ops) and compare each outcome (value, or error name/message/code), the service call list (name, args, context), the scripted-endpoint counters and the log lines whole. The Node HTTP exchange log (wire) documents the Node transport only: the Rust transport is the app-server WebSocket, so compare the calls and results, not the HTTP bytes. The remote-runtime proxy (transitions.applyResult, createSession projection) has no Rust counterpart: Rust-side work, recorded here as the client-visible contract.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'cases 48 and 451 are listed in notRecorded with their reasons',
    'wire taps record the HTTP exchanges in request order: `Host` header port value -> <port> and the response `Date` header value -> <date>, at those header paths only; no other value is normalised',
    ...DETERMINISM,
  ],
}, async ({ imp }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const { createTransitions } = await imp('src/standalone/session-proxy/transitions.mjs');
  const cases = [];
  const add = (name, line, input, result) => cases.push({ name, testLine: line, input: exact(input), result });
  const sessionClient = (discovery, leadPid) => S.attachSession({ discovery, cwd: FIXED_CWD, leadPid });
  const setup = { cwd: FIXED_CWD, leadPid: FIXED_PID, ppid: FIXED_PPID };

  // test line 15
  {
    const realSetTimeout = globalThis.setTimeout;
    const armed = [];
    globalThis.setTimeout = function (fn, delay, ...rest) { armed.push(exact(delay)); return realSetTimeout.call(this, fn, delay, ...rest); };
    const registry = S.createSessionOAuthFlowRegistry();
    let cancelled = 0;
    const steps = [];
    const cloneOutcome = (value) => { try { return { ok: exact(structuredClone(value)) }; } catch (error) { return { error: exact(error) }; } };
    try {
      const started = registry.register({ provider: 'anthropic-oauth', manualUrl: 'https://example.test/oauth', completeCode: async (code) => code === 'code-123' });
      steps.push({ step: "register({provider: anthropic-oauth, manualUrl, completeCode: code === 'code-123'})", status: exact(started), structuredClone: cloneOutcome(started) });
      const completed = await registry.complete(started.flowId, 'code-123');
      steps.push({ step: "complete(flowId, 'code-123')", status: exact(completed) });
      const second = registry.register({ provider: 'openai', cancel: async () => { cancelled += 1; } });
      steps.push({ step: 'register({provider: openai, cancel})', status: exact(second) });
      const cancelledStatus = await registry.cancel(second.flowId);
      steps.push({ step: 'cancel(second flowId)', status: exact(cancelledStatus), cancelCallbackCalls: cancelled });
      steps.push({ step: 'status(second flowId) after cancel', status: exact(registry.status(second.flowId)) });
    } finally { registry.cancelAll(); globalThis.setTimeout = realSetTimeout; }
    add('daemon-owned-oauth-flows-expose-serializable-status-completion-and-cancellation', 15, { registry: 'createSessionOAuthFlowRegistry() defaults (ttl 10 min)', providers: ['anthropic-oauth', 'openai'] }, { steps, timersArmedDelaysMs: armed });
  }

  // test line 82
  {
    let scans = 0;
    const service = S.createSessionService({
      createSessionRuntime: async () => ({ ...S.createStubSessionRuntime(), renameSessionTitle() { return true; } }),
      listSessions() { scans += 1; return [{ id: 'catalog-row', updatedAt: scans }]; },
      getRemoteSessionState() { return { enabled: true, sessionId: 'catalog-row' }; },
    });
    const steps = [];
    const call = async (label, name, args) => { const out = await outcomeExact(() => service.handleCall(name, args)); steps.push({ step: label, ...out, scans }); return out; };
    let created;
    let read;
    try {
      await call('session.list', 'session.list', {});
      created = await call('session.create', 'session.create', {});
      const createdValue = await service.handleCall('session.read', { sessionId: created.ok.sessionId, baseRevision: created.ok.revision });
      steps.push({ step: 'session.read {sessionId, baseRevision: created.revision}', ok: exact(createdValue), scans });
      read = createdValue;
      await call("session.configure {action: renameSessionTitle, args: ['renamed'], baseRevision: read.revision}", 'session.configure', { sessionId: read.sessionId, action: 'renameSessionTitle', args: ['renamed'], baseRevision: read.revision });
      await call('session.list again', 'session.list', {});
    } finally { await service.stop('recorder end'); }
    add('session-catalog-has-one-explicit-route-and-never-rides-session-responses', 82, { listSessions: 'rows [{id: catalog-row, updatedAt: <scan count>}]', getRemoteSessionState: { enabled: true, sessionId: 'catalog-row' } }, { steps });
  }

  // test line 130
  {
    const messages = [{ role: 'user', content: 'worker brief' }, { role: 'assistant', content: 'worker handoff' }];
    const runtime = S.createStubSessionRuntime('agent_read_session');
    const storedCalls = [];
    const service = S.createSessionService({
      createSessionRuntime: async () => runtime,
      readStoredSession: async (sessionId, options = {}) => { storedCalls.push(exact({ sessionId, options })); return { items: [], ...(options.includeMessages === true ? { messages } : {}) }; },
    });
    let out;
    try { out = await outcomeExact(() => service.handleCall('session.read', { sessionId: 'agent_read_session', messageStart: 1 })); } finally { await service.stop('recorder end'); }
    add('canonical-session-read-returns-raw-agent-messages', 130, { call: ['session.read', { sessionId: 'agent_read_session', messageStart: 1 }], stored: { messages } }, { outcome: out, readStoredSessionCalls: storedCalls });
  }

  // test line 156
  {
    const result = await withLoggedDaemon(S, async ({ discovery, calls, wire }) => {
      const first = await sessionClient(discovery, FIXED_PID);
      const second = await sessionClient(discovery, FIXED_PPID);
      const created = await first.call('session.create', { cwd: FIXED_CWD });
      const { sessionId } = created;
      const args = { sessionId, prompt: 'same payload' };
      const steps = [];
      steps.push({ step: 'first.session.create', ok: exact(created) });
      steps.push({ step: 'first.submit callId same-process-local-id', ...(await outcomeExact(() => first.call('session.submit', args, { callId: 'same-process-local-id' }))) });
      steps.push({ step: 'second.submit callId same-process-local-id (other leadPid)', ...(await outcomeExact(() => second.call('session.submit', args, { callId: 'same-process-local-id' }))) });
      steps.push({ step: 'first.read', ...(await outcomeExact(() => first.call('session.read', { sessionId }))) });
      await second.close('recorder end');
      await first.close('recorder end');
      return { steps, serviceCalls: calls, wire: await wire.exchanges() };
    });
    add('call-idempotency-is-isolated-per-client-process', 156, { clients: [{ leadPid: FIXED_PID }, { leadPid: FIXED_PPID }], callId: 'same-process-local-id', ...setup }, result);
  }

  // test line 243
  {
    const handle = { finishWork: null, abortCalls: 0, eagerSessionCreates: 0 };
    const sessionFactory = async () => {
      let state = { sessionId: '', items: [], busy: false };
      const listeners = new Set();
      const publish = () => { for (const listener of [...listeners]) listener(); };
      return {
        getState: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        reserveSession(id) { state = { ...state, sessionId: String(id) }; publish(); return true; },
        async newSession() { handle.eagerSessionCreates += 1; state = { ...state, sessionId: 'durable-session' }; publish(); return true; },
        async resume(id) { state = { ...state, sessionId: String(id) }; publish(); return true; },
        async submitAsync(text) {
          state = { ...state, busy: true, items: [...state.items, { id: 'prompt', text: String(text) }] };
          publish();
          handle.finishWork = () => { state = { ...state, busy: false, items: [...state.items, { id: 'answer', text: 'completed after detach' }] }; publish(); };
          return true;
        },
        abort() { handle.abortCalls += 1; state = { ...state, busy: false }; publish(); return true; },
        resolveToolApproval() { return true; },
        async dispose() {},
      };
    };
    const result = await withLoggedDaemon(S, async ({ discovery, service, signal, calls, wire }) => {
      const terminalFrames = [];
      const terminal = await S.attachSession({ discovery, cwd: FIXED_CWD, onFrame: (frame) => { terminalFrames.push(exact(frame)); signal.notify(); } });
      const desktop = await S.attachSession({ discovery, cwd: FIXED_CWD });
      const steps = [];
      const created = await terminal.call('session.create', { cwd: FIXED_CWD });
      steps.push({ step: 'terminal session.create', ok: exact(created), eagerSessionCreates: handle.eagerSessionCreates });
      const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
      steps.push({ step: 'desktop session.subscribe', ok: exact(subscribed) });
      const submitted = await terminal.call('session.submit', { sessionId: created.sessionId, prompt: 'keep running', options: { id: 'durable-submit' } }, { callId: 'session-submit:durable-session:durable-submit' });
      steps.push({ step: 'terminal session.submit (callId session-submit:durable-session:durable-submit)', ok: exact(submitted) });
      await signal.until(() => S.sessionSnapshotFromFrames(terminalFrames.map((f) => f), created.sessionId)?.busy === true, 'the session stream reports the accepted turn');
      steps.push({ step: 'terminal stream reports busy', snapshot: exact(S.sessionSnapshotFromFrames(terminalFrames, created.sessionId)) });
      await desktop.call('session.unsubscribe', { sessionId: created.sessionId });
      await desktop.close('desktop closed');
      steps.push({ step: 'desktop unsubscribe + close', abortCalls: handle.abortCalls, serviceSize: service.size });
      handle.finishWork();
      const completed = await signal.until(() => { const snapshot = S.sessionSnapshotFromFrames(terminalFrames, created.sessionId); return snapshot?.items?.at(-1)?.text === 'completed after detach' ? snapshot : null; }, 'terminal observes completion after desktop detach');
      steps.push({ step: 'work finished; terminal snapshot', snapshot: exact(completed), abortCalls: handle.abortCalls });
      await terminal.call('session.unsubscribe', { sessionId: created.sessionId });
      await terminal.close('recorder end');
      return { steps, terminalFrames, serviceCalls: calls, wire: await wire.exchanges() };
    }, { sessionFactory });
    add('session-protocol-acks-intake-and-unsubscribe-never-interrupts-execution', 243, { clients: ['terminal (frames)', 'desktop'], submit: { prompt: 'keep running', options: { id: 'durable-submit' }, callId: 'session-submit:durable-session:durable-submit' }, runtime: 'detachable: submit leaves it busy until the recorder calls finishWork', ...setup }, result);
  }

  // test line 299
  {
    const result = await withLoggedDaemon(S, async ({ discovery, calls, wire }) => {
      const client = await sessionClient(discovery);
      const created = await client.call('session.create', { cwd: FIXED_CWD });
      const { sessionId } = created;
      const steps = [{ step: 'session.create', ok: exact(created) }];
      for (const action of ['getProfile', 'getOutputStyle', 'getTheme']) steps.push({ step: `session.read action ${action}`, ...(await outcomeExact(() => client.call('session.read', { sessionId, action, args: [] }))) });
      await client.close('recorder end');
      return { steps, serviceCalls: calls, wire: await wire.exchanges() };
    });
    add('session-faults-answer-as-call-errors-and-non-serializable-values-are-dropped', 299, { actions: ['getProfile (stub throws "stub failure")', 'getOutputStyle (not on the stub)', 'getTheme (returns {ok, callback: fn, when: Date(0)})'], ...setup }, result);
  }

  // test line 320 and 369: address-moving runtimes
  const movingFactory = (newId) => async () => {
    let state = { sessionId: '', items: [], queued: [], busy: false };
    const listeners = new Set();
    const publish = () => { for (const listener of [...listeners]) listener(); };
    return {
      getState: () => state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      reserveSession(id) { state = { ...state, sessionId: String(id) }; publish(); return true; },
      setRoute() { state = { ...state, sessionId: newId }; publish(); return true; },
      async dispose() {},
    };
  };
  {
    const logs = [];
    const service = S.createSessionService({ createSessionRuntime: movingFactory('silently-rebound-session'), log: (line) => logs.push(exact(line)) });
    const steps = [];
    try {
      steps.push({ step: "session.create {sessionId: 'addressed-session'}", ...(await outcomeExact(() => service.handleCall('session.create', { sessionId: 'addressed-session', cwd: FIXED_CWD }))) });
      steps.push({ step: 'session.configure setRoute (the runtime then reports another id)', ...(await outcomeExact(() => service.handleCall('session.configure', { sessionId: 'addressed-session', action: 'setRoute', args: [{ model: 'test-model', applyToCurrentSession: true }] }))) });
      steps.push({ step: 'session.read', ...(await outcomeExact(() => service.handleCall('session.read', { sessionId: 'addressed-session' }))) });
    } finally { await service.stop('recorder end'); }
    add('addressed-session-action-cannot-silently-move-to-another-id', 320, { create: { sessionId: 'addressed-session' }, configure: { action: 'setRoute', args: [{ model: 'test-model', applyToCurrentSession: true }] } }, { steps, logLines: logs });
  }

  // test line 369
  {
    const service = S.createSessionService({ createSessionRuntime: movingFactory('runtime-new-id'), log: () => {} });
    const steps = [];
    try {
      steps.push({ step: 'create addressed-a', ...(await outcomeExact(() => service.handleCall('session.create', { sessionId: 'addressed-a', cwd: FIXED_CWD }))) });
      steps.push({ step: 'create addressed-b', ...(await outcomeExact(() => service.handleCall('session.create', { sessionId: 'addressed-b', cwd: FIXED_CWD }))) });
      const configured = await service.handleCall('session.configure', { sessionId: 'addressed-a', action: 'setRoute', args: [{ model: 'test-model', applyToCurrentSession: true }] });
      steps.push({ step: 'session.configure setRoute', ok: exact(configured) });
      steps.push({ step: 'session.read', ...(await outcomeExact(() => service.handleCall('session.read', { sessionId: 'addressed-a' }))) });
      steps.push({ step: 'session.subscribe', ...(await outcomeExact(() => service.handleCall('session.subscribe', { sessionId: 'addressed-a' }))) });
      const binding = { sessionId: 'addressed-a', attachment: {}, disposed: false };
      const moves = [];
      const transitions = createTransitions({
        binding,
        projection: { applyBody: () => true, baseRevisionFor: () => null },
        pool: { addView: (_a, id) => moves.push(exact(id)), removeView() {}, viewCount: () => 1 },
        sendCall: async () => ({}),
        resync() {}, openParams: {}, log() {}, getView: () => ({}),
      });
      steps.push({ step: "createTransitions(binding addressed-a).applyResult(configured, 'configure')", ...(await outcomeExact(() => transitions.applyResult(configured, 'configure'))), binding: exact(binding), poolMoves: moves });
    } finally { await service.stop('recorder end'); }
    add('responses-after-an-address-mismatch-keep-the-addressed-id', 369, { runtime: 'setRoute rebinds the runtime to runtime-new-id', sessions: ['addressed-a', 'addressed-b'] }, { steps });
  }

  // test line 438
  {
    const result = await withLoggedDaemon(S, async ({ discovery, calls, wire }) => {
      const client = await sessionClient(discovery);
      const created = await client.call('session.create', { cwd: FIXED_CWD });
      const { sessionId } = created;
      const callId = 'stable-call-id';
      const steps = [{ step: 'session.create', ok: exact(created) }];
      steps.push({ step: 'session.submit once (callId stable-call-id)', ...(await outcomeExact(() => client.call('session.submit', { sessionId, prompt: 'once' }, { callId }))) });
      steps.push({ step: 'session.submit once again (same callId, same payload)', ...(await outcomeExact(() => client.call('session.submit', { sessionId, prompt: 'once' }, { callId }))) });
      steps.push({ step: 'session.read', ...(await outcomeExact(() => client.call('session.read', { sessionId }))) });
      await client.close('recorder end');
      return { steps, serviceCalls: calls, wire: await wire.exchanges() };
    });
    add('retried-call-with-the-same-id-runs-exactly-one-runtime-mutation', 438, { callId: 'stable-call-id', payload: { prompt: 'once' }, times: 2, ...setup }, result);
  }

  // test line 465: the remote runtime a client holds, recorded as the calls it makes and what it reports after each step
  {
    const result = await withLoggedDaemon(S, async ({ calls, wire, signal }) => {
      const steps = [];
      const mark = () => ({ serviceCalls: calls.length, exchanges: wire.mark() });
      const stepOf = async (label, fn, runtimeOf) => {
        const before = mark();
        const out = await outcomeExact(fn);
        steps.push({ step: label, ...out, ...(runtimeOf ? { state: exact(runtimeOf().getState()) } : {}), serviceCalls: calls.slice(before.serviceCalls), exchanges: await wire.since(before.exchanges) });
      };
      const runtime = await S.createSession({ cwd: FIXED_CWD });
      steps.push({ step: 'createSession({cwd})', isRemoteSession: runtime.isRemoteSession, state: exact(runtime.getState()), serviceCalls: calls.slice(), exchanges: await wire.exchanges() });
      const notified = [];
      const unsubscribe = runtime.subscribe(() => { notified.push(exact(runtime.getState())); signal.notify(); });
      await stepOf("runtime.submit('through the proxy')", () => runtime.submit('through the proxy'), () => runtime);
      await signal.until(() => runtime.getState().items?.length === 1, 'proxy mirrors its own submission');
      steps.push({ step: 'proxy mirrors its own submission', state: exact(runtime.getState()), notifiedCount: notified.length });
      await stepOf("runtime.setProgressHint('working')", () => runtime.setProgressHint('working'), () => runtime);
      await stepOf('runtime.abortAsync({ restorePrompt: false })', () => runtime.abortAsync({ restorePrompt: false }), () => runtime);
      await stepOf("runtime.setProgressHint('working') again", () => runtime.setProgressHint('working'), () => runtime);
      await stepOf('runtime.abortAsync()', () => runtime.abortAsync(), () => runtime);
      unsubscribe();
      const previousSessionId = runtime.getState().sessionId;
      await stepOf('runtime.newSession()', () => runtime.newSession(), () => runtime);
      steps.push({ step: 'after New task', previousSessionId, state: exact(runtime.getState()) });
      let second;
      await stepOf('createSession({cwd}) second view', async () => { second = await S.createSession({ cwd: FIXED_CWD }); return undefined; }, () => second ?? runtime);
      steps.push({ step: 'second view state', state: exact(second.getState()), firstViewState: exact(runtime.getState()) });
      await second.dispose('test');
      await runtime.dispose('test');
      return { steps, notifiedStates: notified, allServiceCalls: calls, allExchanges: await wire.exchanges() };
    });
    add('the-remote-session-projection-keeps-the-store-contract', 465, { cwd: FIXED_CWD, steps: ['createSession', 'submit', 'setProgressHint', 'abortAsync({restorePrompt:false})', 'setProgressHint', 'abortAsync()', 'newSession', 'second createSession'], stubAbort: 'restoreText "restored prompt" and pastedImages {image_1: {filename: restored.png}}, replaced by a drafted prompt' }, result);
  }

  // test line 507
  {
    const result = await withLoggedDaemon(S, async ({ discovery, calls, wire }) => {
      const client = await sessionClient(discovery);
      const created = await client.call('session.create', { cwd: FIXED_CWD });
      const { sessionId } = created;
      const callId = 'conflicting-call-id';
      const steps = [{ step: 'session.create', ok: exact(created) }];
      steps.push({ step: 'session.submit prompt first (callId conflicting-call-id)', ...(await outcomeExact(() => client.call('session.submit', { sessionId, prompt: 'first' }, { callId }))) });
      steps.push({ step: 'session.submit prompt second (same callId)', ...(await outcomeExact(() => client.call('session.submit', { sessionId, prompt: 'second' }, { callId }))) });
      steps.push({ step: 'session.read', ...(await outcomeExact(() => client.call('session.read', { sessionId }))) });
      await client.close('recorder end');
      return { steps, serviceCalls: calls, wire: await wire.exchanges() };
    });
    add('reusing-a-mutation-callid-with-a-different-payload-fails-closed', 507, { callId: 'conflicting-call-id', payloads: ['first', 'second'], ...setup }, result);
  }

  const notRecorded = [
    { testLine: 48, name: 'session calls log only a bounded result summary, never the transcript body', reason: 'asserts the text of a Node daemon log line (`session action ... result=object items=200`); the Rust core has no per-call result log' },
    { testLine: 451, name: 'replay-safe session reads do not retain snapshots in the mutation cache', reason: 'asserts the Node transport\'s callCacheEntries counter (a health-probe metric of an in-memory cache that does not exist in Rust)' },
  ];
  return { cases, notRecorded };
});
process.exit(0);
