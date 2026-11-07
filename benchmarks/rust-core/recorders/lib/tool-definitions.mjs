// The product's own tool definition objects, as the runtime holds them: the built-in tools, the
// standalone tools `wireToolSurface` (`session-runtime/boot/tools.mjs`) collects (every definition
// module that loads without a running runtime, and the agent tool), and the definitions the
// session surface adds (`call_tool`, `apply_patch`, `todo`, `goal`). Node tree under test: `tree`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/**
 * `real(name)`: a copy of the product's own definition of the tool `name` (built-in, standalone, bridge, patch,
 * `todo` or `goal`), for recorders that need a tool the runtime really holds. An unknown name is an error:
 * a connector's tools (`mcp__...`) and deliberately broken ones are the recorder's own inputs, not Node's.
 */
export async function nodeRealTool(tree) {
  const { definitions } = await nodeToolDefinitions(tree);
  const byName = new Map(definitions.map((tool) => [tool.name, tool]));
  return (name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`the product holds no tool named ${name}`);
    return structuredClone(tool);
  };
}

// ---- shared tool-definition fixture and the references goldens carry instead of inlined definitions ----
//
// `native/core/fixtures/tool-definitions/definitions.json` holds each real definition once, keyed by name and
// variant (`name`, `name@agent`, `shell@posix`, `memory@internal`, `edit@claude`...), with the content hash of its
// canonical JSON. A golden carries `{ "$tool": name, "variant"?: v, "hash": h, "override"?: {..}, "unset"?: [..] }`
// where a definition would be: the loader (`mixdog_js::fixture_tools::parse_golden`) resolves it from the fixture,
// checks the hash, applies the overridden fields over it and drops the unset ones.

/** JSON with every object's keys sorted: the text a content hash is taken of (the Rust loader writes the same). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The first 16 hex digits of the sha-256 of the canonical JSON. */
export const contentHash = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);

const isDefinition = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) && typeof value.name === 'string' && typeof value.description === 'string' && value.inputSchema && typeof value.inputSchema === 'object';

/**
 * Every real definition by `name` or `name@variant`: the product's tools (`nodeToolDefinitions`), the delegated
 * agent's `git`/`task` and the `shell` texts (`nodeToolVariants`), the internal tools as `_getMcpTools` projects them
 * (`@internal`: name, description, inputSchema, annotations) and the edit dialects a Claude / GPT model is sent
 * (`@claude`, `@gpt`, only where they differ).
 */
export async function nodeToolRegistry(tree) {
  const { definitions, internalToolDefs } = await nodeToolDefinitions(tree);
  const entries = new Map();
  const add = (key, name, variant, definition) => {
    if (!entries.has(key)) entries.set(key, { name, variant, definition: JSON.parse(JSON.stringify(definition)) });
  };
  for (const tool of definitions) add(tool.name, tool.name, null, tool);
  for (const row of await nodeToolVariants(tree)) {
    const variant = [row.surface === 'agent' ? 'agent' : null, row.shellKind ?? null, row.foreground ? 'foreground' : null].filter(Boolean).join('-');
    add(`${row.name}@${variant}`, row.name, variant, row.definition);
  }
  for (const tool of internalToolDefs.filter((t) => t.public !== false)) {
    add(`${tool.name}@internal`, tool.name, 'internal', {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      annotations: tool.annotations || {},
    });
  }
  // The dialect a Claude / GPT model is sent: `filterModelEditTools` over the base definitions (never over a
  // session preview, which also holds whatever internal tools the process registered).
  const { filterModelEditTools } = await importFrom(tree, 'src/runtime/shared/edit-tool-dialect.mjs');
  for (const [variant, modelName] of [['claude', 'claude-opus-4-6'], ['gpt', 'gpt-5']]) {
    for (const tool of filterModelEditTools(definitions, modelName)) {
      if (canonicalJson(entries.get(tool.name).definition) === canonicalJson(tool)) continue;
      add(`${tool.name}@${variant}`, tool.name, variant, tool);
    }
  }
  return entries;
}

/** The fixture body: `{ tree, definitions: { key: { hash, definition } } }`, keys sorted. */
export async function toolDefinitionsFixture(tree, identity) {
  const entries = await nodeToolRegistry(tree);
  const definitions = {};
  for (const key of [...entries.keys()].sort()) {
    const { definition } = entries.get(key);
    definitions[key] = { hash: contentHash(definition), definition };
  }
  return { tree: identity, definitions };
}

/**
 * `value` with every definition of the registry replaced by a reference: the whole object when it is one, else the
 * nearest entry of its name with the fields that differ (`override`) and the ones it lacks (`unset`). An object
 * that is not near any entry (a case's own invented tool) stays inline.
 */
export async function compactTools(tree, value) {
  const entries = await nodeToolRegistry(tree);
  const byName = new Map();
  for (const [key, entry] of entries) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push({ key, ...entry, canonical: canonicalJson(entry.definition), hash: contentHash(entry.definition) });
  }
  const refOf = (candidate, override, unset) => ({
    $tool: candidate.name,
    ...(candidate.variant ? { variant: candidate.variant } : {}),
    hash: candidate.hash,
    ...(Object.keys(override).length ? { override } : {}),
    ...(unset.length ? { unset } : {}),
  });
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    if (isDefinition(node) && byName.has(node.name)) {
      const text = canonicalJson(node);
      let best = null;
      for (const candidate of byName.get(node.name)) {
        if (candidate.canonical === text) return refOf(candidate, {}, []);
        const override = {};
        for (const [field, fieldValue] of Object.entries(node)) {
          if (fieldValue !== undefined && canonicalJson(fieldValue) !== canonicalJson(candidate.definition[field])) override[field] = fieldValue;
        }
        const unset = Object.keys(candidate.definition).filter((field) => !(field in node) || node[field] === undefined);
        const size = canonicalJson(override).length + unset.join('').length;
        if (!best || size < best.size) best = { candidate, override, unset, size };
      }
      // Near an entry: the overridden fields are small next to the definition. Else it is another tool of that name.
      if (best && best.size * 2 < text.length) return refOf(best.candidate, Object.fromEntries(Object.entries(best.override).map(([k, v]) => [k, v])), best.unset);
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
  };
  return walk(value);
}

/** `writeJson` of `value` with its definitions replaced by references (`compactTools`). */
export async function writeJsonCompact(tree, path, value) {
  const { writeJson } = await import('./common.mjs');
  writeJson(path, await compactTools(tree, value));
}

/**
 * `value` with its references resolved from the shared fixture `fixture` (the parsed `definitions.json`): the
 * JavaScript twin of the Rust loader, used to check a recorder's output. Throws on a reference that does not
 * resolve or whose hash is not the entry's, or whose entry's own hash is not its content's.
 */
export function resolveToolRefs(value, fixture) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$tool === 'string') {
      const key = node.variant ? `${node.$tool}@${node.variant}` : node.$tool;
      const entry = fixture.definitions[key];
      if (!entry) throw new Error(`the tool reference ${key} is not in the shared fixture`);
      if (contentHash(entry.definition) !== entry.hash) throw new Error(`${key}: the fixture entry does not hash to its own hash`);
      if (entry.hash !== node.hash) throw new Error(`${key}: the reference hash ${node.hash} is not the entry's ${entry.hash}`);
      const out = JSON.parse(JSON.stringify(entry.definition));
      for (const [field, fieldValue] of Object.entries(node.override ?? {})) out[field] = walk(fieldValue);
      for (const field of node.unset ?? []) delete out[field];
      return out;
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
  };
  return walk(value);
}