// Records what Node's tool call does with a plugin's MCP tool once the session's cwd has left the plugin's project
// scope (`config.extensionScopes.plugins`): `executeTool` (`session/loop/tool-exec.mjs`) refreshes the session's MCP
// snapshot from the live registry filtered for the session's cwd as it is now (`call-prep.mjs:70` and `tool-exec.mjs:114`
// `refreshDeferredMcpToolCatalog` -> `scopedMcpToolsFor` -> `filterMcpToolsForSession`), and
// `prepareDeferredToolCallThrough` refuses a connector tool outside that snapshot (`isDeferredToolAvailable`) whatever the
// session's exposure. A session with no deferred provider mode keeps no snapshot, so its call runs.
//
// Each case is one session (`applyDeferredToolSurface` for its provider), one turn started in project A (the fold of
// `turn-prepare.mjs` `foldMcpSurface` for a session past its first fold: `reconcileDeferredMcpToolCatalog` over the
// cwd's servers, whatever its provider mode) and the turn's steps: the cwd the session has moved to (in place, as the
// `cwd` tool's `_applyResolvedCwdForCaller` does mid-turn), the tool called through `executeTool`, what it returned,
// whether the server was called, and the session's MCP snapshot (`deferredMcpToolNames`) at the next request, after the
// refresh every request boundary runs (`request-boundary.mjs:77`).
//
// The other routes an MCP call can take: a sub-agent's session (`owner: 'agent'`) runs the same loop; a bridge session's
// deferred call is a wire `call_tool` projected onto its target (`tool-call-resolution.mjs` `resolveExecutionToolCall`)
// and then run with its wire call (`bridgeWireCall`); a channel client's `channel/call` names a tool to the channels
// worker's dispatch (`channels/lib/tool-dispatch.mjs` `handleToolCall`, reached from `daemon-channels-loader.mjs:57`); an
// `mcp_tool` hook runs `executeMcpTool(name, args, { scopeId: rt.mcpScopeId, ownerKey })` (`boot/infrastructure.mjs:93-101`)
// from a session whose cwd is outside the plugin's scope.
//
//   node benchmarks/rust-core/recorders/record-mcp-cwd-scope.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/mcp-cwd-scope/golden.json. The sandbox folder in every string becomes <SANDBOX>.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'mcp-cwd-scope-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.TZ = 'UTC';
const NOW = 1_700_000_000_000;
Date.now = () => NOW;
let exitCode = 0;
try {
  const { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeSetManifest } = await import('./lib/common.mjs');
  const { writeJsonCompact } = await import('./lib/tool-definitions.mjs');
  const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
  const tree = resolveTree(parseArgs());
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const recorder = 'benchmarks/rust-core/recorders/record-mcp-cwd-scope.mjs';
  const U = (rel) => importFrom(tree, `src/runtime/agent/orchestrator/${rel}`);
  const { applyDeferredToolSurface, reconcileDeferredMcpToolCatalog, refreshDeferredMcpToolCatalog, scopedMcpToolsFor } = await U('runtime-core/tool-catalog.mjs');
  const { executeTool } = await U('session/loop/tool-exec.mjs');
  const { resolveExecutionToolCall } = await U('session/loop/tool-call-resolution.mjs');
  const { preDispatchDenyForSession } = await U('session/loop/pre-dispatch-deny.mjs');
  const { _registerMcpServerForTest, disconnectAll, executeMcpTool } = await U('mcp/client.mjs');
  const { createToolDispatch } = await importFrom(tree, 'src/runtime/channels/lib/tool-dispatch.mjs');
  const { saveConfig } = await U('config.mjs');

  const projectA = join(sandbox, 'project-a');
  const projectB = join(sandbox, 'project-b');
  for (const dir of [projectA, projectB]) mkdirSync(dir, { recursive: true });
  // The plugin `unity` is limited to project A; its server carries the plugin's marker as a plugin server's catalog
  // entry does (`_mixdogPlugin`, which `_registerMcpServerForTest` turns into each tool's `mcpPluginId`). `demo` is global.
  const extensionScopes = { skills: {}, mcp: {}, plugins: { unity: [projectA] } };
  saveConfig({ extensionScopes }, { baseConfig: {} });
  const tool = (name) => ({ name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } });
  const REGISTRY = [
    { server: 'plugin-unity-tools', pluginId: 'unity', tools: [tool('build')] },
    { server: 'demo', pluginId: null, tools: [tool('ping')] },
  ];
  const ran = [];
  const json = (value) => JSON.parse(JSON.stringify(value));
  const SCOPE = 'cwd-scope';
  for (const { server, pluginId, tools } of REGISTRY) {
    _registerMcpServerForTest(SCOPE, server, tools, {
      ...(pluginId ? { cfg: { _mixdogPlugin: { id: pluginId } } } : {}),
      callTool: async (params) => {
        ran.push(`mcp__${server}__${params.name}`);
        return { content: [{ type: 'text', text: `ran ${server} ${params.name}` }] };
      },
    });
  }
  const session = (provider, after = () => {}, mode = 'lead') => {
    const current = {
      id: `sess_${provider}`,
      provider,
      model: 'model-x',
      cwd: projectA,
      mcpScopeId: SCOPE,
      tools: [tool('read')],
      messages: [
        { role: 'system', content: '# Base rules' },
        { role: 'system', content: '# Profile' },
        { role: 'system', cacheTier: 'tier3', content: '# Core' },
        { role: 'system', cacheTier: 'env', content: '# Env' },
      ],
      toolSpec: 'full',
      disallowedTools: [],
    };
    applyDeferredToolSurface(current, mode, [], { provider });
    after(current);
    return current;
  };
  const BUILD = 'mcp__plugin-unity-tools__build';
  const PING = 'mcp__demo__ping';
  const STEPS = [
    ['a', BUILD],
    ['b', BUILD],
    ['b', PING],
    ['a', BUILD],
  ];
  const CASES = [
    ['a native session', session('anthropic-oauth')],
    ['a bridge session', session('openrouter')],
    ['a session with no deferred provider mode', session('anthropic-oauth', (current) => delete current.deferredProviderMode)],
    [
      'a sub-agent session',
      session(
        'anthropic-oauth',
        (current) => {
          current.id = 'sess_worker';
          current.owner = 'agent';
          current.agent = 'worker';
        },
        'full'
      ),
    ],
    ['a bridge session calling through call_tool', session('openrouter', (current) => (current.id = 'sess_call_tool')), true],
  ];
  const cases = [];
  for (const [name, current, viaCallTool = false] of CASES) {
    const before = json(current);
    // The turn start (`foldMcpSurface`, `turn-prepare.mjs:63`).
    reconcileDeferredMcpToolCatalog(current, scopedMcpToolsFor(current));
    const turnStart = { cwd: current.cwd, mcpNames: json(current.deferredMcpToolNames ?? null) };
    const steps = [];
    // Each request the loop sends first refreshes the snapshot for the cwd as it then is (`request-boundary.mjs:77`); the
    // model's next call moves the cwd after that.
    refreshDeferredMcpToolCatalog(current);
    for (const [n, [project, call]] of STEPS.entries()) {
      current.cwd = project === 'a' ? projectA : projectB;
      ran.length = 0;
      let result;
      let wire;
      if (viaCallTool) {
        wire = { name: 'call_tool', arguments: { name: call, arguments: {} } };
        const wireCall = { id: `c${n}`, ...wire };
        const run = (projected) => executeTool(projected.name, projected.arguments, current.cwd, current.id, current, { bridgeWireCall: projected.wireCall });
        // The streamed call is projected and its target started at once (`eager-dispatch.mjs:63`); the run refreshes the
        // snapshot for the cwd as it is now.
        const eager = resolveExecutionToolCall(wireCall, current);
        const eagerResult = eager.bridgeError ? undefined : await run(eager);
        // The tool phase projects the batch again (`tool-phase.mjs:45`), and a projection error answers the wire call
        // before any eager result is consumed (`pre-dispatch-deny.mjs:110`).
        const projected = resolveExecutionToolCall(wireCall, current);
        result = preDispatchDenyForSession(current, projected) ?? eagerResult ?? (await run(projected));
      } else {
        result = await executeTool(call, {}, current.cwd, current.id, current, {});
      }
      refreshDeferredMcpToolCatalog(current);
      steps.push({ cwd: current.cwd, call, ...(wire ? { wire } : {}), result: json(result), ran: [...ran], mcpNames: json(current.deferredMcpToolNames ?? null) });
    }
    cases.push({ name, before, turnStart, steps });
  }
  // `channel/call` naming the plugin's tool: the channels worker's dispatch, which hosts only its lifecycle tools.
  ran.length = 0;
  const { handleToolCall } = createToolDispatch({ isChannelsDegraded: () => false, lifecycle: {} });
  const channelCall = { name: BUILD, args: {}, result: json(await handleToolCall(BUILD, {})), ran: [...ran] };
  // An `mcp_tool` hook of a session whose cwd is project B (outside the plugin's scope).
  ran.length = 0;
  const hook = {
    cwd: projectB,
    name: BUILD,
    result: json(await executeMcpTool(BUILD, {}, { scopeId: SCOPE, ownerKey: `hook:${BUILD}` })),
    ran: [...ran],
  };
  await disconnectAll({ scopeId: SCOPE });
  const placeholder = (value) =>
    JSON.parse(JSON.stringify(value), (_, v) => (typeof v === 'string' ? [sandbox, sandbox.replaceAll('\\', '/'), JSON.stringify(sandbox).slice(1, -1)].reduce((out, form) => out.replaceAll(form, '<SANDBOX>'), v) : v));
  const finalDir = join(FIXTURES_ROOT, 'mcp-cwd-scope');
  const stage = stageSet(finalDir);
  await writeJsonCompact(tree, join(stage, 'golden.json'), placeholder({ now: NOW, extensionScopes, registry: REGISTRY, cases, channelCall, hook }));
  writeSetManifest(stage, {
    set: 'mcp-cwd-scope',
    recorder,
    command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url),
      syntheticInputs: [
        'the registry: `_registerMcpServerForTest` with the servers of `registry`, whose callTool only records the call and answers `ran <server> <tool>`',
        'the scopes: `saveConfig({ extensionScopes })` into the sandbox profile',
        'the session: a plain object as createSession leaves it, its surface built by `applyDeferredToolSurface(session, mode, [], { provider })` ("full" for the sub-agent, which also carries owner "agent" and agent "worker"); its cwd is moved in place between steps',
        'the call_tool case: each wire call `{ id, name: "call_tool", arguments: { name, arguments: {} } }` as the loop takes a streamed call: projected by `resolveExecutionToolCall` and run with `bridgeWireCall` at once (the eager dispatch), then projected again for the tool phase, whose `preDispatchDenyForSession` answers a projection error before the eager result is used',
        'channelCall: `createToolDispatch({ isChannelsDegraded: () => false, lifecycle: {} }).handleToolCall(name, {})`',
        'hook: `executeMcpTool(name, {}, { scopeId, ownerKey: "hook:<name>" })`, the call `boot/infrastructure.mjs` mcpToolRunner makes',
      ],
      normalisations: { sandboxPath: 'the sandbox folder (and its forward-slash form) in every string becomes <SANDBOX>' },
      keptWhole: 'per step: the cwd, the call, what executeTool returned, the server calls, the session MCP snapshot at the next request (after its boundary refresh, `request-boundary.mjs:77`, before the next call moves the cwd)',
    },
  });
  commitStage(stage, finalDir);
  console.log(`mcp cwd scope: ${cases.length} cases`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
// Open handles of the product's modules (its pools, timers) would keep the process alive.
process.exit(exitCode);
