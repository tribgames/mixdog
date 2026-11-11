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
//   507  reusing a callId with a different payload fails closed.
// Calls over HTTP go through the real transport + `attachSession` client; the stub runtimes are scripted endpoints.
//
// NOT recorded (reasons in `notRecorded`): 48 (a Node daemon log line), 451 (the Node transport's call-cache entry
// counter), 465 (the Node remote-runtime client proxy: store contract of the TUI's own projection).
//
//   node benchmarks/rust-core/recorders/record-session-transport-call-contract.mjs --tree <dir>
import { NORMALISED, callOutcome, createNormaliser, withLoggedDaemon } from './lib/session-daemon-harness.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-transport-call-contract',
  testFile: 'scripts/session-transport/call-contract.test.mjs',
  entry: 'Ran src/tui/session/oauth-flows.mjs, src/standalone/session-service.mjs createSessionService().handleCall (scripted runtime factory / readStoredSession / listSessions / log), the real HTTP session transport + session-client attachSession (callId cache, client registry) with the stub runtimes of scripts/session-transport/_shared.mjs, and src/standalone/session-proxy/transitions.mjs createTransitions. Did not run the log-summary, call-cache-metric and remote-projection cases (see notRecorded).',
  replay: 'mixdog-app-server dispatch (APP/dispatch.rs, handshake.rs, subscriptions.rs), mixdog-core-base ops (ops/tests.rs op-id replay and payload conflict), ai_account/flows.rs OAuth flow status/complete/cancel and thread/read raw messages: drive the same ordered calls with the same arguments/callIds and compare each outcome (value or error message+code), the service call list (name, args, context), scripted-endpoint counters and recorded log lines whole.',
  exclusions: [
    'cases 48, 451, 465 are listed in notRecorded with their reasons',
    'case 15: flow ids oauth_<ms base36>_<seq base36> -> oauth_<ms>_<seq>; the registry timers armed are recorded by delay',
    'wire envelope: the client-visible result/error (message and code) is recorded, plus the call the service received; HTTP headers/bytes are not',
    ...NORMALISED,
  ],
}, async ({ imp }) => {
  const S = await imp('scripts/session-transport/_shared.mjs');
  const { createTransitions } = await imp('src/standalone/session-proxy/transitions.mjs');
  const cases = [];
  const add = (name, line, input, result) => cases.push({ name, testLine: line, input, result });
  const keep = (calls) => calls.map(({ name, args, context, result, error }) => ({ name, args, context, ...(error ? { error } : { result: result ?? null }) }));

  // test line 15
  {
    const realSetTimeout = globalThis.setTimeout;
    const armed = [];
    globalThis.setTimeout = function (fn, delay, ...rest) { armed.push(delay); return realSetTimeout.call(this, fn, delay, ...rest); };
    const flowId = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'flowId' && typeof v === 'string' ? v.replace(/^oauth_[a-z0-9]+_([a-z0-9]+)$/i, 'oauth_<ms>_$1') : v)));
    const registry = S.createSessionOAuthFlowRegistry();
    let cancelled = 0;
    const steps = [];
    try {
      const started = registry.register({ provider: 'anthropic-oauth', manualUrl: 'https://example.test/oauth', completeCode: async (code) => code === 'code-123' });
      steps.push({ step: "register({provider: anthropic-oauth, manualUrl, completeCode: code === 'code-123'})", status: flowId(started), structuredCloneOk: (() => { try { structuredClone(started); return true; } catch { return false; } })() });
      const completed = await registry.complete(started.flowId, 'code-123');
      steps.push({ step: "complete(flowId, 'code-123')", status: flowId(completed) });
      const second = registry.register({ provider: 'openai', cancel: async () => { cancelled += 1; } });
      steps.push({ step: 'register({provider: openai, cancel})', status: flowId(second) });
      const cancelledStatus = await registry.cancel(second.flowId);
      steps.push({ step: 'cancel(second flowId)', status: flowId(cancelledStatus), cancelCallbackCalls: cancelled });
      steps.push({ step: 'status(second flowId) after cancel', status: flowId(registry.status(second.flowId)) });
    } finally { registry.cancelAll(); globalThis.setTimeout = realSetTimeout; }
    add('daemon-owned-oauth-flows-expose-serializable-status-completion-and-cancellation', 15, { registry: 'createSessionOAuthFlowRegistry() defaults (ttl 10 min)', providers: ['anthropic-oauth', 'openai'] }, { steps, timersArmedDelaysMs: armed });
  }

  // test line 82
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    let scans = 0;
    const service = S.createSessionService({
      createSessionRuntime: async () => ({ ...S.createStubSessionRuntime(), renameSessionTitle() { return true; } }),
      listSessions() { scans += 1; return [{ id: 'catalog-row', updatedAt: scans }]; },
      getRemoteSessionState() { return { enabled: true, sessionId: 'catalog-row' }; },
    });
    const steps = [];
    const call = async (label, name, args) => { const out = await callOutcome(ids.norm, service.handleCall(name, args)); steps.push({ step: label, ...out, scans, hasSync: out.ok ? Object.hasOwn(out.ok, 'sync') : null }); return out.ok; };
    try {
      await call('session.list', 'session.list', {});
      const created = await service.handleCall('session.create', {});
      steps.push({ step: 'session.create', ...(await callOutcome(ids.norm, Promise.resolve(created))), scans, hasSync: Object.hasOwn(created, 'sync') });
      const read = await service.handleCall('session.read', { sessionId: created.sessionId, baseRevision: created.revision });
      steps.push({ step: 'session.read {sessionId, baseRevision: created.revision}', ...(await callOutcome(ids.norm, Promise.resolve(read))), scans, hasSync: Object.hasOwn(read, 'sync') });
      const configured = await service.handleCall('session.configure', { sessionId: created.sessionId, action: 'renameSessionTitle', args: ['renamed'], baseRevision: read.revision });
      steps.push({ step: "session.configure {action: renameSessionTitle, args: ['renamed'], baseRevision: read.revision}", ...(await callOutcome(ids.norm, Promise.resolve(configured))), scans, hasSync: Object.hasOwn(configured, 'sync') });
      await call('session.list again', 'session.list', {});
    } finally { await service.stop('recorder end'); }
    add('session-catalog-has-one-explicit-route-and-never-rides-session-responses', 82, { listSessions: 'rows [{id: catalog-row, updatedAt: <scan count>}]', getRemoteSessionState: { enabled: true, sessionId: 'catalog-row' } }, { steps });
  }

  // test line 130
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const messages = [{ role: 'user', content: 'worker brief' }, { role: 'assistant', content: 'worker handoff' }];
    const runtime = S.createStubSessionRuntime('agent_read_session');
    const storedCalls = [];
    const service = S.createSessionService({
      createSessionRuntime: async () => runtime,
      readStoredSession: async (sessionId, options = {}) => { storedCalls.push({ sessionId, options }); return { items: [], ...(options.includeMessages === true ? { messages } : {}) }; },
    });
    let out;
    try { out = await callOutcome(ids.norm, service.handleCall('session.read', { sessionId: 'agent_read_session', messageStart: 1 })); } finally { await service.stop('recorder end'); }
    add('canonical-session-read-returns-raw-agent-messages', 130, { call: ['session.read', { sessionId: 'agent_read_session', messageStart: 1 }], stored: { messages }, runtimeHasSessionProperty: Object.hasOwn(runtime, 'session') }, { outcome: out, readStoredSessionCalls: storedCalls });
  }

  // test line 156
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, calls }) => {
      const first = await S.attachSession({ discovery, cwd: process.cwd(), leadPid: process.pid });
      const second = await S.attachSession({ discovery, cwd: process.cwd(), leadPid: process.ppid });
      const { sessionId } = await first.call('session.create', { cwd: process.cwd() });
      const args = { sessionId, prompt: 'same payload' };
      const steps = [];
      steps.push({ step: 'first.submit callId same-process-local-id', ...(await callOutcome(ids.norm, first.call('session.submit', args, { callId: 'same-process-local-id' }))) });
      steps.push({ step: 'second.submit callId same-process-local-id (other leadPid)', ...(await callOutcome(ids.norm, second.call('session.submit', args, { callId: 'same-process-local-id' }))) });
      const read = await first.call('session.read', { sessionId });
      steps.push({ step: 'first.read', itemCount: read.full.items.length, items: ids.norm(read.full.items) });
      await second.close('recorder end');
      await first.close('recorder end');
      return { steps, serviceCalls: keep(calls) };
    });
    add('call-idempotency-is-isolated-per-client-process', 156, { clients: [{ leadPid: '<pid>' }, { leadPid: '<ppid>' }], callId: 'same-process-local-id' }, result);
  }

  // test line 243
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
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
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, service, signal, calls }) => {
      const terminalFrames = [];
      const terminal = await S.attachSession({ discovery, cwd: process.cwd(), onFrame: (frame) => { terminalFrames.push(frame); signal.notify(); } });
      const desktop = await S.attachSession({ discovery, cwd: process.cwd() });
      const steps = [];
      const created = await terminal.call('session.create', { cwd: process.cwd() });
      steps.push({ step: 'terminal session.create', sessionIdMatches: /^sess_daemon_/.test(created.sessionId), revisionIsEpoch: created.revision > 1_000_000_000_000, reservedOnly: created.reservedOnly, eagerSessionCreates: handle.eagerSessionCreates });
      const subscribed = await desktop.call('session.subscribe', { sessionId: created.sessionId });
      steps.push({ step: 'desktop session.subscribe', subscribed: subscribed.subscribed });
      const submitted = await terminal.call('session.submit', { sessionId: created.sessionId, prompt: 'keep running', options: { id: 'durable-submit' } }, { callId: 'session-submit:durable-session:durable-submit' });
      steps.push({ step: 'terminal session.submit (callId session-submit:durable-session:durable-submit)', accepted: submitted.accepted, reservedOnly: submitted.reservedOnly });
      await signal.until(() => S.sessionSnapshotFromFrames(terminalFrames, created.sessionId)?.busy === true, 'the session stream reports the accepted turn');
      steps.push({ step: 'terminal stream reports busy', finishWorkIsFunction: typeof handle.finishWork === 'function' });
      await desktop.call('session.unsubscribe', { sessionId: created.sessionId });
      await desktop.close('desktop closed');
      steps.push({ step: 'desktop unsubscribe + close', abortCalls: handle.abortCalls, serviceSize: service.size });
      handle.finishWork();
      const completed = await signal.until(() => { const snapshot = S.sessionSnapshotFromFrames(terminalFrames, created.sessionId); return snapshot?.items?.at(-1)?.text === 'completed after detach' ? snapshot : null; }, 'terminal observes completion after desktop detach');
      steps.push({ step: 'work finished; terminal snapshot', busy: completed.busy, lastItem: completed.items.at(-1), itemTexts: completed.items.map((i) => i.text), abortCalls: handle.abortCalls });
      await terminal.call('session.unsubscribe', { sessionId: created.sessionId });
      await terminal.close('recorder end');
      return { steps, serviceCalls: keep(calls) };
    }, { sessionFactory });
    add('session-protocol-acks-intake-and-unsubscribe-never-interrupts-execution', 243, { clients: ['terminal (frames)', 'desktop'], submit: { prompt: 'keep running', options: { id: 'durable-submit' }, callId: 'session-submit:durable-session:durable-submit' }, runtime: 'detachable: submit leaves it busy until the recorder calls finishWork' }, result);
  }

  // test line 299
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, calls }) => {
      const client = await S.attachSession({ discovery, cwd: process.cwd() });
      const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
      const steps = [];
      for (const action of ['getProfile', 'getOutputStyle', 'getTheme']) steps.push({ step: `session.read action ${action}`, ...(await callOutcome(ids.norm, client.call('session.read', { sessionId, action, args: [] }))) });
      await client.close('recorder end');
      return { steps, serviceCalls: keep(calls) };
    });
    add('session-faults-answer-as-call-errors-and-non-serializable-values-are-dropped', 299, { actions: ['getProfile (stub throws "stub failure")', 'getOutputStyle (not on the stub)', 'getTheme (returns {ok, callback: fn, when: Date(0)})'] }, result);
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
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const logs = [];
    const service = S.createSessionService({ createSessionRuntime: movingFactory('silently-rebound-session'), log: (line) => logs.push(line) });
    const steps = [];
    try {
      steps.push({ step: "session.create {sessionId: 'addressed-session'}", ...(await callOutcome(ids.norm, service.handleCall('session.create', { sessionId: 'addressed-session', cwd: process.cwd() }))) });
      steps.push({ step: 'session.configure setRoute (the runtime then reports another id)', ...(await callOutcome(ids.norm, service.handleCall('session.configure', { sessionId: 'addressed-session', action: 'setRoute', args: [{ model: 'test-model', applyToCurrentSession: true }] }))) });
      steps.push({ step: 'session.read', ...(await callOutcome(ids.norm, service.handleCall('session.read', { sessionId: 'addressed-session' }))) });
    } finally { await service.stop('recorder end'); }
    add('addressed-session-action-cannot-silently-move-to-another-id', 320, { create: { sessionId: 'addressed-session' }, configure: { action: 'setRoute', args: [{ model: 'test-model', applyToCurrentSession: true }] } }, { steps, logLines: ids.norm(logs) });
  }

  // test line 369
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const service = S.createSessionService({ createSessionRuntime: movingFactory('runtime-new-id'), log: () => {} });
    const steps = [];
    try {
      const created = await service.handleCall('session.create', { sessionId: 'addressed-a', cwd: process.cwd() });
      const other = await service.handleCall('session.create', { sessionId: 'addressed-b', cwd: process.cwd() });
      steps.push({ step: 'create addressed-a / addressed-b', createdSessionId: created.sessionId, otherSessionId: other.sessionId });
      const configured = await service.handleCall('session.configure', { sessionId: 'addressed-a', action: 'setRoute', args: [{ model: 'test-model', applyToCurrentSession: true }] });
      steps.push({ step: 'session.configure setRoute', ...(await callOutcome(ids.norm, Promise.resolve(configured))), sessionId: configured.sessionId, fullSessionId: configured.full.sessionId });
      const read = await service.handleCall('session.read', { sessionId: 'addressed-a' });
      steps.push({ step: 'session.read', sessionId: read.sessionId });
      const subscribed = await service.handleCall('session.subscribe', { sessionId: 'addressed-a' });
      steps.push({ step: 'session.subscribe', sessionId: subscribed.sessionId });
      const binding = { sessionId: 'addressed-a', attachment: {}, disposed: false };
      const moves = [];
      const transitions = createTransitions({
        binding,
        projection: { applyBody: () => true, baseRevisionFor: () => null },
        pool: { addView: (_a, id) => moves.push(id), removeView() {}, viewCount: () => 1 },
        sendCall: async () => ({}),
        resync() {}, openParams: {}, log() {}, getView: () => ({}),
      });
      await transitions.applyResult(configured, 'configure');
      steps.push({ step: "createTransitions(binding addressed-a).applyResult(configured, 'configure')", bindingSessionId: binding.sessionId, poolMoves: moves });
    } finally { await service.stop('recorder end'); }
    add('responses-after-an-address-mismatch-keep-the-addressed-id', 369, { runtime: 'setRoute rebinds the runtime to runtime-new-id', sessions: ['addressed-a', 'addressed-b'] }, { steps });
  }

  // test line 438
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, calls }) => {
      const client = await S.attachSession({ discovery, cwd: process.cwd() });
      const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
      const callId = 'stable-call-id';
      const steps = [];
      steps.push({ step: 'session.submit once (callId stable-call-id)', ...(await callOutcome(ids.norm, client.call('session.submit', { sessionId, prompt: 'once' }, { callId }))) });
      steps.push({ step: 'session.submit once again (same callId, same payload)', ...(await callOutcome(ids.norm, client.call('session.submit', { sessionId, prompt: 'once' }, { callId }))) });
      const read = await client.call('session.read', { sessionId });
      steps.push({ step: 'session.read', itemCount: read.full.items.length, items: ids.norm(read.full.items) });
      await client.close('recorder end');
      return { steps, serviceCalls: keep(calls) };
    });
    add('retried-call-with-the-same-id-runs-exactly-one-runtime-mutation', 438, { callId: 'stable-call-id', payload: { prompt: 'once' }, times: 2 }, result);
  }

  // test line 507
  {
    const ids = createNormaliser(S.RUNTIME_ROOT);
    const result = await withLoggedDaemon(S, ids.norm, ids, async ({ discovery, calls }) => {
      const client = await S.attachSession({ discovery, cwd: process.cwd() });
      const { sessionId } = await client.call('session.create', { cwd: process.cwd() });
      const callId = 'conflicting-call-id';
      const steps = [];
      steps.push({ step: 'session.submit prompt first (callId conflicting-call-id)', ...(await callOutcome(ids.norm, client.call('session.submit', { sessionId, prompt: 'first' }, { callId }))) });
      steps.push({ step: 'session.submit prompt second (same callId)', ...(await callOutcome(ids.norm, client.call('session.submit', { sessionId, prompt: 'second' }, { callId }))) });
      const read = await client.call('session.read', { sessionId });
      steps.push({ step: 'session.read', itemCount: read.full.items.length, firstText: read.full.items[0]?.text ?? null });
      await client.close('recorder end');
      return { steps, serviceCalls: keep(calls) };
    });
    add('reusing-a-mutation-callid-with-a-different-payload-fails-closed', 507, { callId: 'conflicting-call-id', payloads: ['first', 'second'] }, result);
  }

  const notRecorded = [
    { testLine: 48, name: 'session calls log only a bounded result summary, never the transcript body', reason: 'asserts the text of a Node daemon log line (`session action ... result=object items=200`); the Rust core has no per-call result log' },
    { testLine: 451, name: 'replay-safe session reads do not retain snapshots in the mutation cache', reason: 'asserts the Node transport\'s callCacheEntries counter (a health-probe metric of an in-memory cache that does not exist in Rust)' },
    { testLine: 465, name: 'the remote session projection keeps the store contract', reason: 'the Node TUI\'s remote runtime client (createSession proxy projection, subscribe/notify store contract); client code replaced by the app-server protocol' },
  ];
  return { cases, notRecorded };
});
process.exit(0);
