// Pure derivation of the /context panel: the runtime status getters become
// one metrics object, and that object renders as the panel rows plus the
// detail block. No surface or store access happens here.
import {
  contextMeasurementStats,
  measuredContextUsage,
  contextMeasurementLabel,
} from '../../../ui/context-measurement.mjs';

const EMPTY_TOOLS = { activeCount: 0, count: 0, mcpToolCount: 0, activeMcpToolCount: 0, activeTools: [] };
const EMPTY_MCP = { connectedCount: 0, configuredCount: 0, failedCount: 0 };

function fmt(value) {
  if (value == null) return '—';
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function pct(value, total) {
  if (value == null) return '—';
  const n = Number(value || 0);
  const d = Number(total || 0);
  if (!d) return 'N/A';
  const p = Math.max(0, Math.min(100, (n / d) * 100));
  return `${Math.round(p * 10) / 10}%`;
}

function compactElapsed(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.max(1, Math.ceil(n / 1000))}s`;
}

function compactionState(compaction) {
  const compactRunning = compaction.inProgress === true || compaction.lastStage === 'compacting';
  const autoClearFailed = compaction.lastStage === 'auto_clear_failed' || !!compaction.lastClearCompactError;
  const autoClearStage = compaction.lastStage === 'auto_clear' || compaction.lastClearAt;
  const compactInterrupted = compaction.lastStage === 'interrupted';
  const compactReactive = String(compaction.lastTrigger || '').toLowerCase() === 'reactive';
  if (compactRunning) return 'Compacting conversation';
  if (compactInterrupted) return 'Compact interrupted';
  if (autoClearFailed) {
    const error = compaction.lastClearCompactError ? `: ${compaction.lastClearCompactError}` : '';
    return `auto-clear skipped${error}`;
  }
  if (autoClearStage) return 'Auto-clear complete';
  if (compaction.lastChanged) return compactReactive ? 'Compact complete (overflow recovery)' : 'Compact complete';
  return 'Compact checked';
}

function compactBufferTokens(compaction, compactBoundary, compactTrigger) {
  const raw = Number(compaction.bufferTokens);
  if (Number.isFinite(raw)) return Math.max(0, raw);
  if (compactBoundary && compactTrigger) return Math.max(0, compactBoundary - compactTrigger);
  return null;
}

function contextMetrics({ toolsStatus, mcpStatus, skillsStatus, pluginsStatus, contextStatus, state }) {
  const tools = toolsStatus || EMPTY_TOOLS;
  const mcp = mcpStatus || EMPTY_MCP;
  const skills = skillsStatus || { count: 0 };
  const plugins = pluginsStatus || { count: 0 };
  const context = contextStatus || {};
  const usage = context.usage || {};
  const messages = context.messages || {};
  const request = context.request || {};
  const schemaBreakdown = request.toolSchemaBreakdown || {};
  const schemaTokensFor = (buckets) =>
    buckets.reduce((sum, bucket) => sum + Number(schemaBreakdown?.[bucket]?.tokens || 0), 0);
  const compaction = context.compaction || {};
  const windowTokens = Number(
    context.effectiveContextWindow ||
      context.contextWindow ||
      state.contextWindow ||
      context.rawContextWindow ||
      state.rawContextWindow ||
      0
  );
  const rawWindowTokens = Number(context.rawContextWindow || state.rawContextWindow || windowTokens || 0);
  // Compaction boundary/trigger are sourced from the runtime contextStatus
  // (context.compaction). Fall back to the visible window for the boundary
  // and to the boundary for the trigger so /context still renders on a
  // fresh/resumed session before any compaction telemetry exists.
  const compactBoundary = Number(compaction.boundaryTokens || windowTokens || 0);
  const compactTrigger = Number(compaction.triggerTokens || compactBoundary || 0);
  const measured = measuredContextUsage({ stats: contextMeasurementStats(context), contextWindow: windowTokens });
  const usedTokens = measured.used;
  const freeTokens = usedTokens != null && windowTokens ? Math.max(0, windowTokens - usedTokens) : null;
  const cachedRead = Number(usage.lastCachedReadTokens || 0);
  const cacheWrite = Number(usage.lastCacheWriteTokens || 0);
  const freshInput = Number(
    usage.lastUncachedInputTokens != null
      ? usage.lastUncachedInputTokens
      : Math.max(Number(usage.lastInputTokens || 0) - cachedRead - cacheWrite, 0)
  );
  const cacheDenom = Number(usage.lastContextTokens || 0) || cachedRead + freshInput + cacheWrite;
  const compactState = compactionState(compaction);
  const compactDuration = compactElapsed(compaction.lastDurationMs);
  return {
    tools,
    mcp,
    skills,
    plugins,
    context,
    usage,
    messages,
    request,
    compaction,
    windowTokens,
    rawWindowTokens,
    compactBoundary,
    compactTrigger,
    measured,
    usedTokens,
    freeTokens,
    builtInToolSchemaTokens: schemaTokensFor(['code', 'web', 'mutation', 'channels', 'setup', 'other']),
    mcpToolSchemaTokens: schemaTokensFor(['mcp']),
    freshInput,
    cacheWrite,
    cacheHitRate: cacheDenom > 0 ? `${((cachedRead / cacheDenom) * 100).toFixed(0)}%` : 'N/A',
    cacheWriteLabel: cacheWrite > 0 ? ` · ${fmt(cacheWrite)} write` : '',
    contextSource: contextMeasurementLabel(measured.source),
    lastApiLabel: context.lastApiRequestStale ? 'last API request (pre-compact)' : 'last API request',
    compactState,
    compactDescription: compactDuration ? `${compactState} · ${compactDuration}` : compactState,
    compactPressure: Number(compaction.pressureTokens || compaction.currentEstimatedTokens || 0),
    compactReserve: Number(compaction.reserveTokens || 0),
  };
}

function contextRows(m) {
  const { tools, skills, plugins, usage, messages, request, windowTokens } = m;
  return [
    {
      value: 'summary',
      label: 'Context Usage',
      description: `${fmt(m.usedTokens)}/${fmt(windowTokens)} (${pct(m.usedTokens, windowTokens)}) · ${fmt(m.freeTokens)} free · ${m.contextSource} · effective`,
      _action: 'summary',
    },
    {
      value: 'compaction',
      label: 'Compaction',
      description: `${m.compactDescription} · ${fmt(m.compactPressure)} pressure · ${fmt(m.compactReserve)} reserve`,
      _action: 'compaction',
    },
    {
      value: 'messages',
      label: 'Messages',
      description: `${fmt(messages.estimatedTokens)} tokens (${pct(messages.estimatedTokens, windowTokens)}) · ${messages.count || 0} messages`,
      _action: 'messages',
    },
    {
      value: 'tools',
      label: 'Tools',
      description: `${fmt(m.builtInToolSchemaTokens)} schema tokens (${pct(m.builtInToolSchemaTokens, windowTokens)}) · ${tools.activeCount || 0}/${tools.count || 0} active`,
      _action: 'tools',
    },
    {
      value: 'tool-io',
      label: 'Tool calls/results',
      description: `${messages.toolCallCount || 0} calls (${fmt(messages.toolCallTokens)}) · ${messages.toolResultCount || 0} results (${fmt(messages.toolResultTokens)})`,
      _action: 'tool-io',
    },
    {
      value: 'request',
      label: 'Request overhead',
      description: `${fmt(request.requestOverheadTokens)} framing · ${fmt(request.reserveTokens)} reserve incl. tools`,
      _action: 'request',
    },
    {
      value: 'last-api',
      label: 'Last API usage',
      description: `${fmt(usage.lastContextTokens)} context · ${fmt(m.freshInput)} uncached input · ${fmt(usage.lastOutputTokens)} output · ${m.lastApiLabel}`,
      _action: 'last-api',
    },
    {
      value: 'reasoning',
      label: 'Reasoning tokens',
      description: `≈${fmt(messages.semantic?.reasoning?.tokens || 0)} tokens (${pct(messages.semantic?.reasoning?.tokens || 0, windowTokens)}) · current context estimate`,
      _action: 'reasoning',
    },
    {
      value: 'cache',
      label: 'Prompt cache',
      description: `${m.cacheHitRate} hit · ${fmt(usage.lastCachedReadTokens)} read${m.cacheWriteLabel} · ${fmt(m.freshInput)} new (last request)`,
      _action: 'cache',
    },
    {
      value: 'free',
      label: 'Free space',
      description: `${fmt(m.freeTokens)} tokens (${pct(m.freeTokens, windowTokens)}) · raw window ${fmt(m.rawWindowTokens)}`,
      _action: 'free',
    },
    {
      value: 'extensions',
      label: 'Skills/plugins',
      description: `${skills.count || 0} skills · ${plugins.count || 0} plugins`,
      _action: 'extensions',
    },
  ];
}

function contextDetail(m) {
  const { tools, mcp, skills, plugins, context, usage, messages, request, compaction } = m;
  return {
    type: 'context',
    inspection: context.inspection,
    usage: {
      usedTokens: m.usedTokens,
      windowTokens: m.windowTokens,
      freeTokens: m.freeTokens,
      rawWindowTokens: m.rawWindowTokens,
      source: m.contextSource,
      measurementSource: m.measured.source,
      measuredAt: m.measured.updatedAt,
      effective: true,
    },
    compaction: {
      stage: compaction.lastStage || 'pending',
      state: m.compactState,
      triggerTokens: m.compactTrigger,
      boundaryTokens: m.compactBoundary,
      bufferTokens: compactBufferTokens(compaction, m.compactBoundary, m.compactTrigger),
      pressureTokens:
        Number(compaction.lastPressureTokens || compaction.pressureTokens || compaction.currentEstimatedTokens || 0) ||
        null,
      reserveTokens: Number(compaction.reserveTokens || 0) || null,
      lastChanged: compaction.lastChanged === true,
    },
    messages: {
      tokens: messages.estimatedTokens,
      count: messages.count,
      semantic: messages.semantic,
    },
    tools: {
      schemaTokens: m.builtInToolSchemaTokens,
      active: tools.activeCount,
      count: tools.count,
    },
    toolIo: {
      calls: messages.toolCallCount,
      results: messages.toolResultCount,
    },
    request: {
      toolSchemaBreakdown: request.toolSchemaBreakdown,
      overheadTokens: request.requestOverheadTokens,
      reserveTokens: request.reserveTokens,
    },
    lastApi: {
      contextTokens: usage.lastContextTokens,
      inputTokens: m.freshInput,
      rawInputTokens: usage.lastInputTokens,
      outputTokens: usage.lastOutputTokens,
    },
    cache: {
      hitRate: m.cacheHitRate,
      readTokens: usage.lastCachedReadTokens,
      writeTokens: m.cacheWrite,
    },
    extensions: {
      skills: skills.count,
      plugins: plugins.count,
    },
    mcp: {
      connected: mcp.connectedCount,
      configured: mcp.configuredCount,
      failed: mcp.failedCount,
      tools: tools.mcpToolCount,
      activeTools: tools.activeMcpToolCount,
      schemaTokens: m.mcpToolSchemaTokens,
    },
  };
}

export function buildContextPanelModel(input) {
  const metrics = contextMetrics(input);
  return { rows: contextRows(metrics), detail: contextDetail(metrics) };
}
