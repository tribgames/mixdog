// Records Node's `bindAgentOwner(tool)` (`tools/builtin/builtin-tools.mjs`) over every built-in
// tool: a delegated agent's session sees `git` without the Lead-only worktree operations and `task`
// with the agent wait default; every other tool is itself. The Rust `agent_variants` must turn each
// Lead definition into the same agent definition (text and schema, key order included).
//
//   node benchmarks/rust-core/recorders/record-agent-tool-variants.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/agent-tool-variants/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'agent-tool-variants-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'agent-tool-variants');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-agent-tool-variants.mjs';
const { BUILTIN_TOOLS, bindAgentOwner } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
const { AGENT_TASK_WAIT_DEFAULT_MS } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/wait-budgets.mjs');

const view = (tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
const tools = BUILTIN_TOOLS.map((lead) => {
  const agent = bindAgentOwner(lead);
  return { lead: view(lead), agent: view(agent), same: agent === lead };
});
writeJson(join(stage, 'golden.json'), { agentTaskWaitDefaultMs: AGENT_TASK_WAIT_DEFAULT_MS, tools });
writeSetManifest(stage, { set: 'agent-tool-variants', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
