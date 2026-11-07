// The product's own tool definition objects, as the runtime holds them: the built-in tools, the
// standalone tools `wireToolSurface` (`session-runtime/boot/tools.mjs`) collects (every definition
// module that loads without a running runtime, and the agent tool), and the definitions the
// session surface adds (`call_tool`, `apply_patch`, `todo`, `goal`). Node tree under test: `tree`.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importFrom } from './common.mjs';

const RC = 'src/runtime/agent/orchestrator/runtime-core/';

export async function nodeToolDefinitions(tree) {
  const at = (rel) => importFrom(tree, rel);
  const defsOf = async (rel, key) => (await at(rel))[key];
  const { collectStandaloneToolDefs, CALL_TOOL_TOOL } = await at(`${RC}tool-defs.mjs`);
  const { AGENT_TOOL } = await at('src/session-runtime/services/agent-tool/tool-def.mjs');
  const { BUILTIN_TOOLS } = await at('src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
  const { standaloneTools, internalToolDefs, agentToolNames } = collectStandaloneToolDefs({
    webSearchToolDefs: await at('src/runtime/web-search/tool-defs.mjs'),
    memoryToolDefs: await at('src/runtime/memory/tool-defs.mjs'),
    codeGraphToolDefs: await at('src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs'),
    browserToolDefs: await defsOf('src/runtime/browser-bridge/tool-defs.mjs', 'TOOL_DEFS'),
    computerToolDefs: await defsOf('src/runtime/computer-bridge/tool-defs.mjs', 'TOOL_DEFS'),
    terminalToolDefs: await defsOf('src/runtime/terminal-bridge/tool-defs.mjs', 'TOOL_DEFS'),
    officeToolDefs: await defsOf('src/runtime/office/tool-defs.mjs', 'TOOL_DEFS'),
    mediaToolDefs: await defsOf('src/runtime/media/tool-defs.mjs', 'TOOL_DEFS'),
    tidyToolDefs: await defsOf('src/runtime/tidy/tool-defs.mjs', 'TOOL_DEFS'),
    visualizeToolDefs: await defsOf('src/runtime/visualize-bridge/tool-defs.mjs', 'TOOL_DEFS'),
    exploreToolDefs: await defsOf('src/runtime/explore/tool-defs.mjs', 'TOOL_DEFS'),
    setupToolDefs: await defsOf('src/session-runtime/setup-tool/tool-defs.mjs', 'SETUP_TOOL_DEFS'),
    askUserToolDefs: await defsOf(`${RC}ask-user-tool-defs.mjs`, 'ASK_USER_TOOL_DEFS'),
    handoffUserToolDefs: await defsOf(`${RC}ask-user-tool-defs.mjs`, 'HANDOFF_USER_TOOL_DEFS'),
    reactionToolDefs: await defsOf(`${RC}reaction-tool-defs.mjs`, 'REACTION_TOOL_DEFS'),
    agentTools: [AGENT_TOOL],
  });
  const patch = await defsOf('src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs', 'PATCH_TOOL_DEFS');
  const named = (module) => Object.values(module).flat().filter((tool) => tool?.name && tool.inputSchema);
  const todo = named(await at(`${RC}todo-tool-defs.mjs`));
  const goal = named(await at(`${RC}goal-tool-defs.mjs`));
  const all = new Map();
  // The `public: false` web tools are dispatched for other tools and never listed to a model.
  const unlisted = internalToolDefs.filter((tool) => tool.public === false);
  for (const tool of [...BUILTIN_TOOLS, ...standaloneTools, CALL_TOOL_TOOL, ...patch, ...todo, ...goal, ...unlisted]) {
    if (!all.has(tool.name)) all.set(tool.name, tool);
  }
  return { standaloneTools, internalToolDefs, agentToolNames, definitions: [...all.values()] };
}

/**
 * The definitions a session is actually sent where they differ from the static ones: `shell` in the
 * text of each shell kind (`bindShellKind`) and the delegated agent's `git` and `task`
 * (`bindAgentOwner`). Each row: `{ name, surface: 'lead' | 'agent', shellKind?, definition }`.
 */
export async function nodeToolVariants(tree) {
  const { BUILTIN_TOOLS, bindAgentOwner, bindShellKind } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
  const builtin = (name) => BUILTIN_TOOLS.find((tool) => tool.name === name);
  const rows = [];
  for (const shellKind of ['posix', 'powershell']) {
    rows.push({ name: 'shell', surface: 'lead', shellKind, definition: bindShellKind(builtin('shell'), shellKind) });
  }
  for (const name of ['git', 'task']) {
    rows.push({ name, surface: 'agent', definition: bindAgentOwner(builtin(name)) });
  }
  return [...rows, ...foregroundShellVariants(tree)];
}

// `MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS` is read once when the module loads, so the shell texts of a
// foreground-only runtime come from a process started with it set.
function foregroundShellVariants(tree) {
  const module = pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs')).href;
  const script = `
const m = await import(${JSON.stringify(module)});
const shell = m.BUILTIN_TOOLS.find((tool) => tool.name === 'shell');
process.stdout.write(JSON.stringify(['posix', 'powershell'].map((shellKind) => ({ name: 'shell', surface: 'lead', shellKind, foreground: true, definition: m.bindShellKind(shell, shellKind) }))));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, MIXDOG_SHELL_DISABLE_BACKGROUND_TASKS: '1' },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
