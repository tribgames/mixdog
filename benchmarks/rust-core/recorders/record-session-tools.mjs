#!/usr/bin/env node
// Golden twin of a session's tool assembly (session/manager/tool-resolution.mjs): Node's real
// `resolveSessionTools` + `finalizeSessionToolList` over a fixed pool (the built-in tools, a set of
// internal tools, and two MCP servers registered through the client's test seam), for the Lead, an
// agent worker and the explorer, across tool specs, models and allow/deny lists. Each case records
// the tool names in the order the session sends them.
//
//   node benchmarks/rust-core/recorders/record-session-tools.mjs --tree <dir with node_modules>
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const cli = parseArgs();
const { nodeToolDefinitions } = await import('./lib/tool-definitions.mjs');
const tree = resolveTree(cli);
const orch = 'src/runtime/agent/orchestrator/';
const resolution = await importFrom(tree, `${orch}session/manager/tool-resolution.mjs`);
const internal = await importFrom(tree, `${orch}internal-tools.mjs`);
const mcp = await importFrom(tree, `${orch}mcp/client.mjs`);
const { BUILTIN_TOOLS } = await importFrom(tree, `${orch}tools/builtin/builtin-tools.mjs`);

// What the product registers as internal tools (boot/tools.mjs `collectStandaloneToolDefs`):
// everything the model sees that is neither a built-in nor `todo` / `call_tool`.
// The product's own definitions, as `collectStandaloneToolDefs` collects them (`internalToolDefs`, the
// `public:false` fetch tools stay registered: `_getMcpTools` leaves them out of every schema itself, and the
// pool lists only the public ones). `code_graph` is recorded under `pool.codeGraph`.
const { internalToolDefs } = await nodeToolDefinitions(tree);
const INTERNAL = internalToolDefs.filter((tool) => tool.public !== false).map((tool) => tool.name).filter((name) => name !== 'code_graph');
const MCP = { alpha: ['search_docs', 'zeta', 'Beta'], beta: ['fetch', 'web_search_extra'] };

internal.setInternalToolsProvider({
  scopeId: null,
  tools: internalToolDefs,
  executor: () => {},
});
for (const [server, tools] of Object.entries(MCP)) mcp._registerMcpServerForTest(null, server, tools.map((name) => ({ name })));

const names = (tools) => tools.map((t) => t.name);
const SPECS = {
  full: 'full',
  readonly: 'readonly',
  mcp: 'mcp',
  null: null,
  unknown: 'something-else',
  none: [],
  fullTag: ['full', 'tools:shell'],
  filesystem: ['tools:filesystem'],
  filesystemShell: ['tools:filesystem', ' tools:shell '],
  readonlyTag: ['tools:readonly'],
  git: ['tools:git'],
  analysis: ['tools:analysis', 'tools:mcp'],
  websearch: ['tools:websearch'],
  mixed: ['tools:websearch', 'tools:readonly', 'tools:bogus', 'tools:git'],
};
const cases = [];
const record = (name, spec, { agent = false, model = 'claude-sonnet-4', skills = false, allowed = null, denied = null } = {}) => {
  const base = resolution.resolveSessionTools(spec, skills ? [{ name: 's' }] : [], { ownerIsAgentSession: agent, modelName: model });
  const out = resolution.finalizeSessionToolList(base, { schemaAllowedTools: allowed, disallowedTools: denied, ownerIsAgent: agent });
  cases.push({ name, spec, agent, model, skills, allowed, denied, tools: names(out) });
};
for (const [label, spec] of Object.entries(SPECS)) {
  record(`lead ${label}`, spec);
  record(`lead ${label} gpt`, spec, { model: 'gpt-5' });
  record(`lead ${label} skills`, spec, { skills: true });
  record(`worker ${label}`, spec, { agent: true });
  record(`worker ${label} gpt`, spec, { agent: true, model: 'openai/GPT-5.1' });
}
record('lead allowlist', 'full', { allowed: ['Read', 'GREP', 'todo', 'shell', 'nope'] });
record('lead denylist', 'full', { denied: ['React', 'goal', 'mcp__alpha__zeta'] });
record('worker allow and deny', 'full', { agent: true, allowed: ['read', 'agent', 'session', 'git', 'task', 'todo'], denied: ['task'] });
record('empty allowlist', 'full', { allowed: [] });

const explorer = names(resolution.readOnlyFilesystemTools());
writeJson(join(FIXTURES_ROOT, '..', 'crates', 'mixdog-core', 'src', 'run_host', 'golden', 'session_tools.json'), {
  pool: { builtin: names(BUILTIN_TOOLS), patch: ['apply_patch'], codeGraph: ['code_graph'], internal: INTERNAL, mcp: Object.entries(MCP).flatMap(([s, t]) => t.map((n) => `mcp__${s}__${n}`)) },
  explorer,
  cases,
});
console.log(`session tools: ${cases.length} cases, explorer ${explorer.join(',')}`);
