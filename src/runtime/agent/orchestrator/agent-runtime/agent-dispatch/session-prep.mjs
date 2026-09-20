// Session preparation for a dispatch: the agent's filesystem scope, its
// hidden-role tool schema and permission, and the ephemeral session built
// from the resolved preset.
import { getHiddenAgent, resolveAgentSessionPermission } from '../../internal-agents.mjs';

// Unified-shard policy — most agent sessions (Pool B + Pool C) share the
// same tool schema so BP_1 is bit-identical across roles and one provider-side
// cache shard serves every caller. Per-role behaviour is steered by:
//   1. role-scoped BP2 instructions from agents/<role>.md and
//      rules/agent/<role>.md
//   2. call-time guards (loop.mjs write-block + ai-wrapped-dispatch
//      recursion break)
// Hidden-agent exceptions are declarative: defaults/agents.json may set
// toolSchemaProfile when first-turn routing quality is worth a separate tool
// prefix. Standard profiles are none/read/full.
// See manager.mjs resolveSessionTools for the single source of truth;
// agent visibility is declared via annotations.agentHidden on each tool def.
const HIDDEN_ROLE_TOOL_SCHEMA_PROFILES = Object.freeze({
  full: null,
  none: Object.freeze([]),
  read: Object.freeze(['code_graph', 'find', 'glob', 'list', 'grep', 'read']),
});

export function resolveHiddenRoleSchemaAllowedTools(hidden) {
  if (!hidden) return null;
  if (Array.isArray(hidden.schemaAllowedTools)) {
    return hidden.schemaAllowedTools.map((name) => String(name || '').trim()).filter(Boolean);
  }
  const profile = String(hidden.toolSchemaProfile || 'full').trim() || 'full';
  if (Object.hasOwn(HIDDEN_ROLE_TOOL_SCHEMA_PROFILES, profile)) {
    return HIDDEN_ROLE_TOOL_SCHEMA_PROFILES[profile];
  }
  process.stderr.write(
    `[agent-dispatch] unknown hidden-agent toolSchemaProfile="${profile}" agent="${hidden.agent || 'unknown'}"; using full schema\n`
  );
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : null;
}

export function prepareDispatchSession({
  agent,
  opts,
  callCwd,
  sourceNameArg,
  preset,
  presetName,
  runtimeSpec,
  prepare,
}) {
  // Callers may pass an explicit
  // `cwd` to scope the agent's filesystem view. Absolute path expected
  // (aiWrapped already expands `~` and resolves relatives). When unset
  // we pass `null` through instead of falling back to `process.cwd()`
  // — the MCP server's launch dir is not deterministic across callers,
  // and the downstream skill-discovery path tolerates null. Combined
  // with the frozen agent skill meta-tools (collect.mjs) this keeps
  // every caller on the same provider cache shard.
  const cwd = nonEmptyString(callCwd) || nonEmptyString(opts.cwd);

  // Unified dispatch: Pool B/C share bit-identical tools + system prompt
  // unless a hidden role declares a narrow toolSchemaProfile. Per-role
  // differentiation lives in scoped role rules / stable session context;
  // raw role and permission labels are not repeated in the prompt.
  // Runtime permission enforcement was removed (every tool call is
  // trusted); schema profiles remain a routing-efficiency layer that
  // narrows the advertised tool list, not a runtime safety gate.
  const hidden = getHiddenAgent(agent);
  const isPoolC = Boolean(hidden);
  // Permission: read-declared hidden roles are locked in
  // resolveAgentSessionPermission (prepareAgentSession applies the same).
  const permission = resolveAgentSessionPermission(
    agent,
    opts.permission ?? (isPoolC ? hidden?.permission || 'read' : null)
  );
  // Pool C hidden-role instructions live in BP2 role-scoped context
  // (loaded by loadScopedRoleInstructions from rules/agent/*.md).
  //
  // User message = pure query. Stable role rules ride in BP2; stable
  // memory/meta rides in BP3; only the query varies per call, so
  // provider cache reuses the shared prefix.
  //
  // Stateless ephemeral session — created fresh per call, never
  // pooled or resumed. Cache prefix matching happens at the provider
  // layer (account-level), not the session level.
  const { session } = prepare({
    agent,
    presetName,
    preset,
    runtimeSpec,
    permission,
    cwd,
    sourceType: opts.sourceType,
    sourceName: sourceNameArg || opts.sourceName,
    parentSessionId: opts.parentSessionId || null,
    ownerSessionId: opts.ownerSessionId === undefined ? opts.parentSessionId || null : opts.ownerSessionId,
    clientHostPid: opts.clientHostPid,
    skipRoleReminder: isPoolC,
    schemaAllowedTools: resolveHiddenRoleSchemaAllowedTools(hidden),
    taskType: opts.taskType,
  });
  // Diagnostic — dump the actual tool names exposed to this LLM call,
  // visible from the worker log instead of being hidden behind a
  // count-only "tools=N" line.
  try {
    const _toolNames = (session.tools || []).map((t) => t?.name).filter(Boolean);
    process.stderr.write(`[agent-dispatch] agent=${agent} tool-list (${_toolNames.length}): ${_toolNames.join(',')}\n`);
  } catch {
    /* best-effort diagnostic */
  }
  return { session, cwd };
}
