// /usage and /context panel builders, extracted from App.jsx. Follows the
// createRoutePickers factory pattern: called each render with the current
// store/state and the panel surface; opening either surface closes every other
// prompt/picker first so exactly one bottom surface owns the screen.
export function createUsageContextPanels({
  store,
  state,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  closeUsagePanel,
}) {
  const openUsagePanel = (arg = '') => {
    const refresh = /(?:^|\s)(?:refresh|--refresh|-r|true)(?:\s|$)/i.test(String(arg || ''));
    const own = surface.claim();
    // The dashboard streams updates for seconds: they paint through a usage
    // claim, which closeUsagePanel (Esc) and any newer /usage invalidate.
    const dashboardOwn = surface.claimUsage();
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint(null);
    own.context(null);
    dashboardOwn.paint({
      title: 'Provider Quotas',
      subtitle: 'Statusline-style provider quota windows.',
      checking: true,
      refresh,
      rows: [],
      total: null,
    });
    setTimeout(() => {
      if (!dashboardOwn.owns()) return;
      void store.getUsageDashboard?.({
        refresh,
        onUpdate: (dashboard) => {
          if (dashboard) dashboardOwn.paint(dashboard);
        },
      })
        .then((dashboard) => {
          if (!dashboardOwn.owns()) return;
          if (!dashboard) {
            closeUsagePanel();
            store.pushNotice('usage dashboard unavailable', 'warn');
            return;
          }
          dashboardOwn.paint(dashboard);
        })
        .catch((e) => {
          if (!dashboardOwn.owns()) return;
          closeUsagePanel();
          store.pushNotice(`usage failed: ${e?.message || e}`, 'error');
        });
    }, 0);
  };

  // Async because a daemon-backed store answers every status getter over the
  // wire: read synchronously they resolved to promises and the panel rendered
  // all-zero rows.
  const openContextPicker = async () => {
    // Surface claim (panel-surface.mjs): five daemon reads run before the first
    // paint, so Esc during the pending open must leave the surface (picker AND
    // context panel) untouched.
    const own = surface.claim();
    const [toolsStatus, mcpStatus, skillsStatus, pluginsStatus, contextStatusValue] = await Promise.all([
      Promise.resolve(store.toolsStatus?.()).catch(() => null),
      Promise.resolve(store.mcpStatus?.()).catch(() => null),
      Promise.resolve(store.skillsStatus?.()).catch(() => null),
      Promise.resolve(store.pluginsStatus?.()).catch(() => null),
      Promise.resolve(store.contextStatus?.()).catch(() => null),
    ]);
    const tools = toolsStatus || {
      activeCount: 0,
      count: 0,
      mcpToolCount: 0,
      activeMcpToolCount: 0,
      activeTools: [],
    };
    const mcp = mcpStatus || { connectedCount: 0, configuredCount: 0, failedCount: 0 };
    const skills = skillsStatus || { count: 0 };
    const plugins = pluginsStatus || { count: 0 };
    const context = contextStatusValue || {};
    const usage = context.usage || {};
    const messages = context.messages || {};
    const request = context.request || {};
    const schemaBreakdown = request.toolSchemaBreakdown || {};
    const schemaTokensFor = (buckets) => buckets.reduce(
      (sum, bucket) => sum + Number(schemaBreakdown?.[bucket]?.tokens || 0),
      0,
    );
    const builtInToolSchemaTokens = schemaTokensFor(['code', 'web', 'mutation', 'channels', 'setup', 'other']);
    const mcpToolSchemaTokens = schemaTokensFor(['mcp']);
    const compaction = context.compaction || {};
    const windowTokens = Number(context.contextWindow || state.contextWindow || context.rawContextWindow || state.rawContextWindow || 0);
    const rawWindowTokens = Number(context.rawContextWindow || state.rawContextWindow || windowTokens || 0);
    // Compaction boundary/trigger are sourced from the runtime contextStatus
    // (context.compaction). Fall back to the visible window for the boundary
    // and to the boundary for the trigger so /context still renders on a
    // fresh/resumed session before any compaction telemetry exists.
    const compactBoundary = Number(compaction.boundaryTokens || windowTokens || 0);
    const compactTrigger = Number(compaction.triggerTokens || compactBoundary || 0);
    const usedTokens = Number(context.usedTokens || context.currentEstimatedTokens || usage.lastContextTokens || 0);
    const freeTokens = windowTokens ? Math.max(0, windowTokens - usedTokens) : Number(context.freeTokens || 0);
    const pct = (value, total = windowTokens) => {
      const n = Number(value || 0);
      const d = Number(total || 0);
      if (!d) return 'N/A';
      const p = Math.max(0, Math.min(100, (n / d) * 100));
      return `${p > 0 && p < 1 ? p.toFixed(1) : Math.floor(p)}%`;
    };
    const fmt = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '0';
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
      if (n >= 10_000) return `${Math.round(n / 1000)}k`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return `${Math.round(n)}`;
    };
    const cachedRead = Number(usage.lastCachedReadTokens || 0);
    const cacheWrite = Number(usage.lastCacheWriteTokens || 0);
    const freshInput = Number(
      usage.lastUncachedInputTokens != null
        ? usage.lastUncachedInputTokens
        : Math.max(Number(usage.lastInputTokens || 0) - cachedRead - cacheWrite, 0)
    );
    const cacheDenom = Number(usage.lastContextTokens || 0) || (cachedRead + freshInput + cacheWrite);
    const cacheHitRate = cacheDenom > 0
      ? `${((cachedRead / cacheDenom) * 100).toFixed(0)}%`
      : 'N/A';
    const cacheWriteLabel = cacheWrite > 0 ? ` · ${fmt(cacheWrite)} write` : '';
    const contextSource = context.usedSource === 'last_api_request' ? 'last API request' : 'estimated';
    const lastApiLabel = context.lastApiRequestStale ? 'last API request (pre-compact)' : 'last API request';
    const compactElapsed = (value) => {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '';
      return `${Math.max(1, Math.ceil(n / 1000))}s`;
    };
    const compactRunning = compaction.inProgress === true || compaction.lastStage === 'compacting';
    const autoClearFailed = compaction.lastStage === 'auto_clear_failed' || !!compaction.lastClearCompactError;
    const autoClearStage = compaction.lastStage === 'auto_clear' || compaction.lastClearAt;
    const compactDuration = compactElapsed(compaction.lastDurationMs);
    const compactInterrupted = compaction.lastStage === 'interrupted';
    const compactReactive = String(compaction.lastTrigger || '').toLowerCase() === 'reactive';
    const compactState = compactRunning
      ? 'Compacting conversation'
      : compactInterrupted
      ? 'Compact interrupted'
      : autoClearFailed
      ? `auto-clear skipped${compaction.lastClearCompactError ? `: ${compaction.lastClearCompactError}` : ''}`
      : autoClearStage
      ? 'Auto-clear complete'
      : compaction.lastChanged
      ? (compactReactive ? 'Compact complete (overflow recovery)' : 'Compact complete')
      : 'Compact checked';
    const compactDescription = compactDuration
      ? `${compactState} · ${compactDuration}`
      : compactState;
    const compactPressure = Number(compaction.pressureTokens || compaction.currentEstimatedTokens || 0);
    const compactReserve = Number(compaction.reserveTokens || 0);
    const contextRows = [
      {
        value: 'summary',
        label: 'Context Usage',
        description: `${fmt(usedTokens)}/${fmt(windowTokens)} (${pct(usedTokens)}) · ${fmt(freeTokens)} free · ${contextSource} · effective`,
        _action: 'summary',
      },
      {
        value: 'compaction',
        label: 'Compaction',
        description: `${compactDescription} · ${fmt(compactPressure)} pressure · ${fmt(compactReserve)} reserve`,
        _action: 'compaction',
      },
      {
        value: 'messages',
        label: 'Messages',
        description: `${fmt(messages.estimatedTokens)} tokens (${pct(messages.estimatedTokens)}) · ${messages.count || 0} messages`,
        _action: 'messages',
      },
      {
        value: 'tools',
        label: 'Tools',
        description: `${fmt(builtInToolSchemaTokens)} schema tokens (${pct(builtInToolSchemaTokens)}) · ${tools.activeCount || 0}/${tools.count || 0} active`,
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
        description: `${fmt(usage.lastContextTokens)} context · ${fmt(freshInput)} uncached input · ${fmt(usage.lastOutputTokens)} output · ${lastApiLabel}`,
        _action: 'last-api',
      },
      {
        value: 'cache',
        label: 'Prompt cache',
        description: `${cacheHitRate} hit · ${fmt(usage.lastCachedReadTokens)} read${cacheWriteLabel} · ${fmt(freshInput)} new (last request)`,
        _action: 'cache',
      },
      {
        value: 'free',
        label: 'Free space',
        description: `${fmt(freeTokens)} tokens (${pct(freeTokens)}) · raw window ${fmt(rawWindowTokens)}`,
        _action: 'free',
      },
      {
        value: 'extensions',
        label: 'Skills/plugins',
        description: `${skills.count || 0} skills · ${plugins.count || 0} plugins`,
        _action: 'extensions',
      },
    ];
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint(null);
    own.context({
      kind: 'context',
      title: 'Context Usage',
      detail: {
        type: 'context',
        usage: {
          usedTokens,
          windowTokens,
          freeTokens,
          rawWindowTokens,
          source: contextSource,
          effective: true,
        },
        compaction: {
          stage: compaction.lastStage || 'pending',
          state: compactState,
          triggerTokens: compactTrigger,
          boundaryTokens: compactBoundary,
          bufferTokens: (() => {
            const raw = Number(compaction.bufferTokens);
            if (Number.isFinite(raw)) return Math.max(0, raw);
            if (compactBoundary && compactTrigger) return Math.max(0, compactBoundary - compactTrigger);
            return null;
          })(),
          pressureTokens: Number(compaction.lastPressureTokens || compaction.pressureTokens || compaction.currentEstimatedTokens || 0) || null,
          reserveTokens: Number(compaction.reserveTokens || 0) || null,
          lastChanged: compaction.lastChanged === true,
        },
        messages: {
          tokens: messages.estimatedTokens,
          count: messages.count,
          semantic: messages.semantic,
        },
        tools: {
          schemaTokens: builtInToolSchemaTokens,
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
          inputTokens: freshInput,
          rawInputTokens: usage.lastInputTokens,
          outputTokens: usage.lastOutputTokens,
        },
        cache: {
          hitRate: cacheHitRate,
          readTokens: usage.lastCachedReadTokens,
          writeTokens: cacheWrite,
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
          schemaTokens: mcpToolSchemaTokens,
        },
      },
      rows: contextRows,
    });
  };

  return { openUsagePanel, openContextPicker };
}
