// Records what Node's tool call does with a plugin's MCP tool once the session's cwd has left the plugin's project
// scope (`config.extensionScopes.plugins`): `executeTool` (`session/loop/tool-exec.mjs`) refreshes the session's MCP
// snapshot from the live registry filtered for the session's cwd as it is now (`call-prep.mjs:70` and `tool-exec.mjs:114`
// `refreshDeferredMcpToolCatalog` -> `scopedMcpToolsFor` -> `filterMcpToolsForSession`), and
// `prepareDeferredToolCallThrough` refuses a connector tool outside that snapshot (`isDeferredToolAvailable`) whatever the
// session's exposure. A session with no deferred provider mode keeps no snapshot, so its call runs.
//
// Each case is one session (`applyDeferredToolSurface` for its provider) and a list of steps: the cwd the session has
// moved to (in place, as the `cwd` tool's `_applyResolvedCwdForCaller` does), the tool called through `executeTool`, what
// it returned, whether the server was called, and the session's MCP snapshot (`deferredMcpToolNames`) after.
//
//   node benchmarks/rust-core/recorders/record-mcp-cwd-scope.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/mcp-cwd-scope/golden.json. The sandbox folder in every string becomes <SANDBOX>.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const { applyDeferredToolSurface } = await U('runtime-core/tool-catalog.mjs');
  const { executeTool } = await U('session/loop/tool-exec.mjs');
  const { _registerMcpServerForTest, disconnectAll } = await U('mcp/client.mjs');
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
  const session = (provider, after = () => {}) => {
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
    applyDeferredToolSurface(current, 'lead', [], { provider });
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
  ];
  const cases = [];
  for (const [name, current] of CASES) {
    const before = json(current);
    const steps = [];
    for (const [project, call] of STEPS) {
      current.cwd = project === 'a' ? projectA : projectB;
      ran.length = 0;
      const result = await executeTool(call, {}, current.cwd, current.id, current, {});
      steps.push({ cwd: current.cwd, call, result: json(result), ran: [...ran], mcpNames: json(current.deferredMcpToolNames ?? null) });
    }
    cases.push({ name, before, steps });
  }
  await disconnectAll({ scopeId: SCOPE });
  const placeholder = (value) =>
    JSON.parse(JSON.stringify(value), (_, v) => (typeof v === 'string' ? [sandbox, sandbox.replaceAll('\\', '/'), JSON.stringify(sandbox).slice(1, -1)].reduce((out, form) => out.replaceAll(form, '<SANDBOX>'), v) : v));
  const finalDir = join(FIXTURES_ROOT, 'mcp-cwd-scope');
  const stage = stageSet(finalDir);
  await writeJsonCompact(tree, join(stage, 'golden.json'), placeholder({ now: NOW, extensionScopes, registry: REGISTRY, cases }));
  writeSetManifest(stage, {
    set: 'mcp-cwd-scope',
    recorder,
    command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
    identity,
    extra: {
      nodeRuntime: process.version,
      recorderSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      syntheticInputs: [
        'the registry: `_registerMcpServerForTest` with the servers of `registry`, whose callTool only records the call and answers `ran <server> <tool>`',
        'the scopes: `saveConfig({ extensionScopes })` into the sandbox profile',
        'the session: a plain object as createSession leaves it, its surface built by `applyDeferredToolSurface(session, "lead", [], { provider })`; its cwd is moved in place between steps',
      ],
      normalisations: { sandboxPath: 'the sandbox folder (and its forward-slash form) in every string becomes <SANDBOX>' },
      keptWhole: 'per step: the cwd, the call, what executeTool returned, the server calls, the session MCP snapshot',
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
