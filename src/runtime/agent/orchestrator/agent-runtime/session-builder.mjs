/**
 * Agent Runtime — shared session builder.
 *
 * Single source of truth for agent session creation + role/preset
 * telemetry. Both entry points route through this helper:
 *
 *   - `agent-runtime/agent-dispatch.mjs` — internal callers
 *     (memory-cycle, scheduler, webhook) dispatching via
 *     `makeAgentDispatch`.
 *   - Lead-originated agent dispatches into configured workflow agents.
 *
 * Before this helper, the two paths carried separate `createSession` +
 * `traceAgentPreset` blocks. Lead-direct dispatches silently skipped
 * the trace so cache-hit analysis missed every public agent call.
 *
 * Preset resolution stays with each caller since they read from
 * different sources. The helper takes already-resolved primitives.
 */

import { createSession } from '../session/manager.mjs';
import { traceAgentPreset } from '../agent-trace.mjs';
import { resolveAgentSessionPermission } from '../internal-agents.mjs';
import { getConfigSnapshot } from '../config.mjs';
import { RETIRED_COMPACTION_FIELDS } from '../config-storage.mjs';
import {
  liveFeatureDisallowedTools,
  stageConnectorAvailability,
  stageToolAvailability,
} from '../runtime-core/tool-availability.mjs';
import { COMPACTION_CONFIG_KEYS } from '../runtime-core/compaction-config-keys.mjs';
import { stagePromptSettingsNotice } from '../session/manager/prompt-settings.mjs';
import { loadInstructionFilesContext } from '../context/instruction-files.mjs';
import { normalizeInstructionFilesMode } from '../../../shared/instruction-files-mode.mjs';
import { finalizeSessionToolList, previewSessionTools } from '../session/manager/tool-resolution.mjs';

function normalizeAgentCompactionConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const next = { ...raw };
  if (!next.summaryModel && raw.semanticModel) next.summaryModel = raw.semanticModel;
  if (!next.memoryTimeoutMs && raw.recallMemoryTimeoutMs) next.memoryTimeoutMs = raw.recallMemoryTimeoutMs;
  for (const key of RETIRED_COMPACTION_FIELDS) delete next[key];
  return {
    ...next,
    auto: raw.auto !== false && raw.enabled !== false,
  };
}

/**
 * @param {object} opts
 * @param {string}  opts.agent         — canonical agent name ('worker', 'reviewer', ...)
 * @param {string}  opts.presetName    — resolved preset identifier
 * @param {object}  opts.preset        — resolved preset object from agent-config
 * @param {object}  opts.runtimeSpec   — resolveRuntimeSpec output; must carry .scopeKey / .lane
 * @param {string}  [opts.permission]  — 'none' | 'read' | 'read-write' | 'mcp' | 'full' | null
 * @param {string|null} [opts.cwd]     — absolute working dir; null is the fixed agent sentinel meaning "no caller workspace context"
 * @param {string}  [opts.owner='agent']
 * @param {string}  [opts.permissionMode] — permissionMode forwarded from the MCP payload ('bypassPermissions', 'acceptEdits', 'plan', 'dontAsk', 'default')
 * @param {string[]} [opts.schemaAllowedTools] — schema-level allowlist from a hidden-agent toolSchemaProfile
 * @param {string}  [opts.sourceType]
 * @param {string}  [opts.sourceName]
 * @param {string}  [opts.taskType]
 * @param {string}  [opts.parentSessionId]
 * @param {string|null} [opts.ownerSessionId] - owning Mixdog MCP instance id for statusline isolation
 * @param {string|null} [opts.visibility] - catalog visibility scope
 * @param {string|null} [opts.mcpScopeId] - owning session-runtime MCP registry scope
 * @returns {{ session: object, effectiveCwd: string|null }}
 */
export function prepareAgentSession({
  agent,
  presetName,
  preset,
  runtimeSpec,
  permission,
  cwd,
  owner = 'agent',
  permissionMode,
  sourceType,
  sourceName,
  taskType,
  parentSessionId,
  ownerSessionId,
  visibility,
  clientHostPid,
  agentTag,
  cacheKeyOverride,
  schemaAllowedTools,
  sessionId,
  mcpScopeId,
  contextPercent,
  contextTokens,
  selectedContextWindow,
}) {
  const effectivePermission = resolveAgentSessionPermission(agent, permission);
  // Pass cwd through verbatim — null is the fixed agent sentinel meaning
  // "no caller workspace context" (cycle1 agents, etc). Upgrading
  // null → process.cwd() here would defeat cache-key fork suppression.
  // Downstream collectors (collect.mjs) handle null as "no project cwd".
  const effectiveCwd = cwd == null ? null : cwd;
  const effectiveOwnerSessionId =
    ownerSessionId === undefined ? process.env.MIXDOG_OWNER_SESSION_ID || null : ownerSessionId;
  let compaction = null;
  // The settings gates as they stand: a disabled feature (git and github
  // included) never reaches the agent's schema or dispatch.
  let featureDenied = [];
  try {
    const cfg = getConfigSnapshot({ secrets: false });
    featureDenied = liveFeatureDisallowedTools(cfg);
    if (cfg?.compaction && typeof cfg.compaction === 'object') {
      compaction = normalizeAgentCompactionConfig(cfg.compaction);
    }
  } catch {
    /* config is best-effort for agent compaction policy */
  }
  const sessionOpts = {
    ...(sessionId ? { id: sessionId } : {}),
    preset,
    owner,
    scopeKey: runtimeSpec.scopeKey,
    lane: runtimeSpec.lane,
    cwd: effectiveCwd,
    agent: agent || undefined,
    taskType: taskType || undefined,
    sourceType: sourceType || undefined,
    sourceName: sourceName || undefined,
    parentSessionId: parentSessionId || null,
    ownerSessionId: effectiveOwnerSessionId || null,
    visibility: visibility || null,
    clientHostPid: clientHostPid || null,
    compaction: compaction || undefined,
    mcpScopeId: mcpScopeId || null,
    callerDisallowedTools: [],
    disallowedTools: featureDenied,
  };
  if (contextPercent) sessionOpts.contextPercent = contextPercent;
  if (contextTokens) sessionOpts.contextTokens = contextTokens;
  if (selectedContextWindow) sessionOpts.selectedContextWindow = selectedContextWindow;
  if (agentTag) sessionOpts.agentTag = agentTag;
  if (effectivePermission) sessionOpts.permission = effectivePermission;
  if (permissionMode) sessionOpts.permissionMode = permissionMode;
  if (cacheKeyOverride) sessionOpts.cacheKeyOverride = cacheKeyOverride;
  if (Array.isArray(schemaAllowedTools)) {
    sessionOpts.schemaAllowedTools = schemaAllowedTools;
  }
  const session = createSession(sessionOpts);
  try {
    traceAgentPreset({
      sessionId: session.id,
      agent: agent || null,
      presetName: presetName || null,
      // runtimeSpec carries scopeKey/lane but resolveRuntimeSpec does not
      // populate model/provider — fall back to preset fields.
      model: runtimeSpec?.model || preset?.model || null,
      provider: runtimeSpec?.provider || preset?.provider || null,
      parentSessionId: parentSessionId || null,
    });
  } catch {
    /* telemetry best-effort */
  }
  return { session, effectiveCwd };
}

/**
 * An in-process agent session reused for another turn (no session runtime
 * turn start reconciles it): bring it to the settings as they stand without
 * touching its request prefix — its settings-gated tools
 * (stageToolAvailability), its connectors (stageConnectorAvailability) and
 * its compaction settings. Returns the tool change, or null.
 */
export function reconcileAgentSession(session) {
  if (!session?.id) return null;
  let cfg;
  try {
    cfg = getConfigSnapshot({ secrets: false });
  } catch {
    return null;
  }
  if (cfg?.compaction && typeof cfg.compaction === 'object') {
    // Config-owned keys follow the settings; the session's own state stays.
    const own = { ...(session.compaction || {}) };
    for (const key of COMPACTION_CONFIG_KEYS) delete own[key];
    session.compaction = { ...own, ...normalizeAgentCompactionConfig(cfg.compaction) };
  }
  const connectors = stageConnectorAvailability(session);
  // The prompt settings a delegated worker's prompt carries: its instruction
  // files (the rest are a Lead's). Told once, like a session runtime's turn start.
  if (session.promptSettings && session.skipInstructionFiles !== true && session.cwd) {
    const toolFree = Array.isArray(session.schemaAllowedTools) && session.schemaAllowedTools.length === 0;
    const skip = toolFree || session.promptIdentity?.profileSkip?.claudemd;
    stagePromptSettingsNotice(session, {
      only: ['instructionFiles'],
      instructionFiles: skip ? '' : loadInstructionFilesContext({ mode: cfg?.instructionFiles, cwd: session.cwd }),
      instructionFilesMode: normalizeInstructionFilesMode(cfg?.instructionFiles),
    });
  }
  const tools = stageToolAvailability(session, liveFeatureDisallowedTools(cfg), (names) =>
    finalizeSessionToolList(
      previewSessionTools('full', [], {
        ownerIsAgentSession: true,
        mcpScopeId: session.mcpScopeId || null,
        modelName: session.model,
        cwd: session.cwd || null,
      }).filter((tool) => names.includes(tool?.name)),
      { ownerIsAgent: true }
    )
  );
  if (!tools && !connectors) return null;
  return {
    added: [...(tools?.added || []), ...(connectors?.added || [])],
    removed: [...(tools?.removed || []), ...(connectors?.removed || [])],
  };
}
