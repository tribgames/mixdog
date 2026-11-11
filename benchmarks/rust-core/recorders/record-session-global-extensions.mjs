#!/usr/bin/env node
// Golden twin of `src/session-runtime/global-extensions.test.mjs`: the in-process fan-out of machine-global extension
// changes (`publishGlobalExtensionChange`, `subscribeGlobalExtensionChanges`) and the MCP sync a runtime does around it
// (`createExtensionSync`: reconnectMcpAndAnnounce, scheduleMcpToggle). The MCP connector, the login cancel and the
// surface invalidation are scripted endpoints that append to one ordered event list per case.
//
//   node benchmarks/rust-core/recorders/record-session-global-extensions.mjs --tree <dir>
import { runSessionRecorder } from './lib/session-rec.mjs';

await runSessionRecorder(import.meta.url, {
  set: 'session-global-extensions',
  testFile: 'src/session-runtime/global-extensions.test.mjs',
  entry: 'Ran global-extensions.mjs (publish/subscribe) and resource-extension-sync.mjs (createExtensionSync) with scripted connectConfiguredMcp / cancelMcpLogin / invalidatePreSessionToolSurface. Did not run the real MCP manager (connectConfiguredMcp is the scripted endpoint) nor reloadFullConfig/invalidateSkills (not given in the test).',
  replay: 'mixdog-mcp mcp_glue.rs scoped apply / toggle (crate mixdog-mcp) and the thread-extension fan-out: drive the same calls (reconnect with {only,enabled,drop}, none, scheduleMcpToggle true/false, publish kind with an origin, unsubscribe) against the scripted connector and compare the ordered `events` of every case.',
  exclusions: ['subscriber ids come from a process counter; recorded as `writer`/`peer` labels'],
}, async ({ imp }) => {
  const { publishGlobalExtensionChange, subscribeGlobalExtensionChanges } = await imp('src/session-runtime/global-extensions.mjs');
  const { createExtensionSync } = await imp('src/session-runtime/resource-extension-sync.mjs');

  const cases = [];
  const syncRuntime = (label, events) => createExtensionSync({
    connectConfiguredMcp: async (options) => { events.push({ runtime: label, connect: options }); return { servers: [] }; },
    invalidatePreSessionToolSurface() { events.push({ runtime: label, invalidatePreSessionToolSurface: true }); },
  });

  // test line 17
  {
    const events = [];
    const writer = syncRuntime('writer', events);
    const peer = syncRuntime('peer', events);
    const steps = [
      { call: 'reconnectMcpAndAnnounce', args: { only: 'rea', enabled: true, drop: ['old'] } },
      { call: 'reconnectMcpAndAnnounce', args: null },
    ];
    const results = [];
    try {
      results.push(await writer.reconnectMcpAndAnnounce(steps[0].args));
      results.push(await writer.reconnectMcpAndAnnounce());
    } finally { writer.dispose(); peer.dispose(); }
    cases.push({ name: 'named-mcp-reconnect-reaches-peers-as-a-scoped-change', testLine: 17, input: { runtimes: ['writer', 'peer'], steps }, result: { results, events } });
  }

  // test line 39
  {
    const events = [];
    const runtime = syncRuntime('only', events);
    const steps = [{ call: 'scheduleMcpToggle', args: ['server', true] }, { call: 'scheduleMcpToggle', args: ['server', false] }, { call: 'reconnectMcpAndAnnounce', args: { only: 'server', enabled: true } }];
    const results = [];
    try {
      results.push(await runtime.scheduleMcpToggle('server', true));
      results.push(await runtime.scheduleMcpToggle('server', false));
      results.push(await runtime.reconnectMcpAndAnnounce({ only: 'server', enabled: true }));
    } finally { runtime.dispose(); }
    cases.push({ name: 'enable-disable-reconnect-never-request-an-interactive-login', testLine: 39, input: { steps }, result: { results, events } });
  }

  // test line 57: the pending login is a scripted promise the cancel resolves
  {
    const events = [];
    let finishLogin;
    const runtime = createExtensionSync({
      connectConfiguredMcp: async (options) => {
        events.push({ connect: options });
        if (options.enabled) await new Promise((resolve) => { finishLogin = resolve; });
        events.push({ connectDone: options });
        return { servers: [] };
      },
      cancelMcpLogin: (name) => { events.push({ cancelMcpLogin: name }); finishLogin(); },
      invalidatePreSessionToolSurface() { events.push({ invalidatePreSessionToolSurface: true }); },
    });
    let results;
    try {
      const enable = runtime.scheduleMcpToggle('server', true);
      const disable = runtime.scheduleMcpToggle('server', false);
      results = await Promise.all([enable, disable]);
    } finally { runtime.dispose(); }
    cases.push({
      name: 'disable-during-a-pending-enable-cancels-its-login',
      testLine: 57,
      input: { steps: [{ call: 'scheduleMcpToggle', args: ['server', true] }, { call: 'scheduleMcpToggle', args: ['server', false] }], connector: 'an enabled connect stays pending until cancelMcpLogin resolves it' },
      result: { results, events },
    });
  }

  // test line 86
  {
    const events = [];
    const label = new Map();
    const writer = subscribeGlobalExtensionChanges((kind, detail) => events.push({ to: 'writer', kind, detail }));
    const peer = subscribeGlobalExtensionChanges((kind, detail) => events.push({ to: 'peer', kind, detail }));
    label.set(writer.id, 'writer');
    label.set(peer.id, 'peer');
    let published;
    try { published = await publishGlobalExtensionChange('mcp', writer.id); } finally { writer.unsubscribe(); peer.unsubscribe(); }
    cases.push({ name: 'changes-fan-out-to-every-runtime-except-the-writer', testLine: 86, input: { subscribers: ['writer', 'peer'], publish: { kind: 'mcp', origin: 'writer' } }, result: { published: published ?? null, events } });
  }

  // test line 99
  {
    const events = [];
    const runtime = subscribeGlobalExtensionChanges((kind) => events.push({ to: 'runtime', kind }));
    runtime.unsubscribe();
    const published = await publishGlobalExtensionChange('skills');
    cases.push({ name: 'unsubscribed-runtimes-stop-receiving-changes', testLine: 99, input: { subscribers: ['runtime (unsubscribed)'], publish: { kind: 'skills', origin: null } }, result: { published: published ?? null, events } });
  }

  return { cases };
});
