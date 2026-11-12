#!/usr/bin/env node
// Golden twin of `src/session-runtime/global-extensions.test.mjs`: the in-process fan-out of machine-global extension
// changes (`publishGlobalExtensionChange`, `subscribeGlobalExtensionChanges`) and the MCP sync a runtime does around it
// (`createExtensionSync`: reconnectMcpAndAnnounce, scheduleMcpToggle). The MCP connector, the login cancel and the
// surface invalidation are scripted endpoints that append to one ordered event list per case.
//
//   node benchmarks/rust-core/recorders/record-session-global-extensions.mjs --tree <dir>
import { exact, exactArgs } from './lib/exact.mjs';
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-global-extensions',
  testFile: 'src/session-runtime/global-extensions.test.mjs',
  entry: 'Ran global-extensions.mjs (publish/subscribe) and resource-extension-sync.mjs (createExtensionSync) with scripted connectConfiguredMcp / cancelMcpLogin / invalidatePreSessionToolSurface. Did not run the real MCP manager (connectConfiguredMcp is the scripted endpoint) nor reloadFullConfig/invalidateSkills (not given in the test).',
  replay: 'mixdog-mcp tests/it/global_extensions_suite.rs, one test per case: the real GlueHost over the real McpGlue and its scope runtime in a scratch data dir with no server configured (reconnect_mcp_and_announce with only/enabled/drop, reconnect_all_mcp_and_announce, schedule_mcp_toggle, announce). Node\'s runtimes are the core\'s MCP scopes: the runtime scope is the runtime the calls are made in (writer / only), an open session scope a peer, a released one an unsubscribed runtime. The connector\'s events are each scope\'s operations as the scope runtime\'s test watch (scope_runtime.rs OpWatch, feature test-support) sees them, invalidatePreSessionToolSurface is McpSurface::refresh_surface; results are the statuses the calls answer.',
  values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
  exclusions: [
    'subscriber ids come from a process counter and are not recorded: the recorder labels each subscriber writer/peer itself (the label is the recorder\'s, not a Node value)',
    'replay line 17: the order across runtimes is not compared, each runtime\'s events are compared whole and in order: Node\'s writer applies the change and then publishes it to its peers, the core runs the operation on every open scope at once, each scope behind its own queue (scope_runtime.rs ScopeRuntime::fan_out)',
    'replay line 17: the peer\'s invalidatePreSessionToolSurface is not compared: the core has one runtime per process and one pre-session tool surface, refreshed once by the runtime that made the change',
    'replay lines 39, 57: connectDone and cancelMcpLogin are recorded only by line 57\'s scripted connector (an enabled connect stays pending until cancelMcpLogin resolves it) and the overlapping-enables connector; the replay records them, and holds the enabled connect, for those cases only',
    'case overlapping-enables-connect-once (testLine null) is not a test of the file: the recorder adds it to pin scheduleMcpToggle (resource-extension-sync.mjs:56) for two enables of one server asked while the first connect is pending',
    'replay lines 86, 99: the core has no in-process change bus (one runtime per process): a change reaches the other runtimes as the operation the scope runtime runs on every open scope. Line 86 is the writer\'s full reconnect, and each scope other than the writer\'s that ran it is a receipt {to, kind: "mcp", detail: null}; line 99 is a session scope released, then an announce of the published kind: no operation reaches the released scope. published is the announce\'s answer (undefined: Node\'s publish resolves to nothing)',
    'replay lines 17, 39, 57: results are the status the scripted connectConfiguredMcp returned ({servers: []}), passed through; only servers is compared: the core\'s connector answers its real status of an empty server set, whose other fields (counts, warnings, declarationErrors, googleClient) the script has no counterpart for',
  ],
}, async ({ imp }) => {
  const { publishGlobalExtensionChange, subscribeGlobalExtensionChanges } = await imp('src/session-runtime/global-extensions.mjs');
  const { createExtensionSync } = await imp('src/session-runtime/resource-extension-sync.mjs');

  const cases = [];
  const syncRuntime = (label, events) => createExtensionSync({
    connectConfiguredMcp: async (options) => { events.push({ runtime: label, connect: exact(options) }); return { servers: [] }; },
    invalidatePreSessionToolSurface() { events.push({ runtime: label, invalidatePreSessionToolSurface: true }); },
  });

  // test line 17
  {
    const events = [];
    const writer = syncRuntime('writer', events);
    const peer = syncRuntime('peer', events);
    const steps = [
      { call: 'reconnectMcpAndAnnounce', args: exactArgs([{ only: 'rea', enabled: true, drop: ['old'] }]) },
      { call: 'reconnectMcpAndAnnounce', args: exactArgs([]) },
    ];
    const results = [];
    try {
      results.push(exact(await writer.reconnectMcpAndAnnounce({ only: 'rea', enabled: true, drop: ['old'] })));
      results.push(exact(await writer.reconnectMcpAndAnnounce()));
    } finally { writer.dispose(); peer.dispose(); }
    cases.push({ name: 'named-mcp-reconnect-reaches-peers-as-a-scoped-change', testLine: 17, input: { runtimes: ['writer', 'peer'], steps }, result: { results, events } });
  }

  // test line 39
  {
    const events = [];
    const runtime = syncRuntime('only', events);
    const steps = [{ call: 'scheduleMcpToggle', args: exactArgs(['server', true]) }, { call: 'scheduleMcpToggle', args: exactArgs(['server', false]) }, { call: 'reconnectMcpAndAnnounce', args: exactArgs([{ only: 'server', enabled: true }]) }];
    const results = [];
    try {
      results.push(exact(await runtime.scheduleMcpToggle('server', true)));
      results.push(exact(await runtime.scheduleMcpToggle('server', false)));
      results.push(exact(await runtime.reconnectMcpAndAnnounce({ only: 'server', enabled: true })));
    } finally { runtime.dispose(); }
    cases.push({ name: 'enable-disable-reconnect-never-request-an-interactive-login', testLine: 39, input: { steps }, result: { results, events } });
  }

  // test line 57: the pending login is a scripted promise the cancel resolves
  {
    const events = [];
    let finishLogin;
    const runtime = createExtensionSync({
      connectConfiguredMcp: async (options) => {
        events.push({ connect: exact(options) });
        if (options.enabled) await new Promise((resolve) => { finishLogin = resolve; });
        events.push({ connectDone: exact(options) });
        return { servers: [] };
      },
      cancelMcpLogin: (name) => { events.push({ cancelMcpLogin: name }); finishLogin(); },
      invalidatePreSessionToolSurface() { events.push({ invalidatePreSessionToolSurface: true }); },
    });
    let results;
    try {
      const enable = runtime.scheduleMcpToggle('server', true);
      const disable = runtime.scheduleMcpToggle('server', false);
      results = exact(await Promise.all([enable, disable]));
    } finally { runtime.dispose(); }
    cases.push({
      name: 'disable-during-a-pending-enable-cancels-its-login',
      testLine: 57,
      input: { steps: [{ call: 'scheduleMcpToggle', args: exactArgs(['server', true]) }, { call: 'scheduleMcpToggle', args: exactArgs(['server', false]) }], connector: 'an enabled connect stays pending until cancelMcpLogin resolves it' },
      result: { results, events },
    });
  }

  // Not a test of the file (added by this recorder): an enable asked while the server's enable connect is pending rides
  // the running chain; the desired state did not change, so the chain connects once. The recorder releases the pending
  // connect once both toggles were asked.
  {
    const events = [];
    let finishConnect;
    const runtime = createExtensionSync({
      connectConfiguredMcp: async (options) => {
        events.push({ connect: exact(options) });
        if (options.enabled && !finishConnect) await new Promise((resolve) => { finishConnect = resolve; });
        events.push({ connectDone: exact(options) });
        return { servers: [] };
      },
      invalidatePreSessionToolSurface() { events.push({ invalidatePreSessionToolSurface: true }); },
    });
    let results;
    try {
      const first = runtime.scheduleMcpToggle('server', true);
      const second = runtime.scheduleMcpToggle('server', true);
      finishConnect();
      results = exact(await Promise.all([first, second]));
    } finally { runtime.dispose(); }
    cases.push({
      name: 'overlapping-enables-connect-once',
      testLine: null,
      input: { steps: [{ call: 'scheduleMcpToggle', args: exactArgs(['server', true]) }, { call: 'scheduleMcpToggle', args: exactArgs(['server', true]) }], connector: 'the first enabled connect stays pending until both toggles were asked, then the recorder releases it' },
      result: { results, events },
    });
  }

  // test line 86
  {
    const events = [];
    const label = new Map();
    const writer = subscribeGlobalExtensionChanges((kind, detail) => events.push({ to: 'writer', kind: exact(kind), detail: exact(detail) }));
    const peer = subscribeGlobalExtensionChanges((kind, detail) => events.push({ to: 'peer', kind: exact(kind), detail: exact(detail) }));
    label.set(writer.id, 'writer');
    label.set(peer.id, 'peer');
    let published;
    try { published = exact(await publishGlobalExtensionChange('mcp', writer.id)); } finally { writer.unsubscribe(); peer.unsubscribe(); }
    cases.push({ name: 'changes-fan-out-to-every-runtime-except-the-writer', testLine: 86, input: { subscribers: ['writer', 'peer'], publish: { call: 'publishGlobalExtensionChange', args: exactArgs(['mcp', 'writer']), originIs: 'the writer subscriber id (a process counter, not recorded)' } }, result: { published, events } });
  }

  // test line 99
  {
    const events = [];
    const runtime = subscribeGlobalExtensionChanges((kind) => events.push({ to: 'runtime', kind: exact(kind) }));
    runtime.unsubscribe();
    const published = exact(await publishGlobalExtensionChange('skills'));
    cases.push({ name: 'unsubscribed-runtimes-stop-receiving-changes', testLine: 99, input: { subscribers: ['runtime (unsubscribed)'], publish: { call: 'publishGlobalExtensionChange', args: exactArgs(['skills']) } }, result: { published, events } });
  }

  return { cases };
});
