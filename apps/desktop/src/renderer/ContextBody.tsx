import { resolveContextDisplayUsage } from './context-usage';
import { t } from './i18n';

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function compactTokens(value: unknown): string {
  const number = finite(value);
  if (number <= 0) return '0';
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 10_000) return `${Math.round(number / 1_000)}k`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return `${Math.round(number)}`;
}

function contextPercent(value: unknown, total: unknown): number | null {
  const denominator = finite(total);
  if (!denominator) return null;
  return Math.max(0, Math.min(100, (finite(value) / denominator) * 100));
}

function tokenBuckets(source: Row, names: string[]): number {
  return names.reduce((sum, name) => sum + finite(record(source[name]).tokens), 0);
}

export function ContextBody({ status, snapshot }: { status: unknown; snapshot: unknown }) {
  const context = record(status);
  const state = record(snapshot);
  const messages = record(context.messages);
  const semantic = record(messages.semantic);
  const request = record(context.request);
  const schema = record(request.toolSchemaBreakdown);
  const compaction = record(context.compaction);
  // Keep the expanded surface byte-for-byte aligned with the header hover:
  // provider-reported usage wins over the live estimate, and the resolved
  // auto-compact trigger is the denominator before the full context window.
  const usage = resolveContextDisplayUsage({
    sessionId: state.sessionId || context.sessionId || (context.contextWindow ? 'context' : ''),
    stats: state.stats,
    fallbackUsedTokens: context.usedTokens ?? context.currentEstimatedTokens,
    autoCompactTokenLimit: state.autoCompactTokenLimit || compaction.triggerTokens,
    displayContextWindow: state.displayContextWindow || context.contextWindow,
    contextWindow: state.contextWindow || context.rawContextWindow,
  });
  const used = usage.used;
  const windowTokens = usage.limit;
  const rawWindowTokens = finite(context.rawContextWindow || state.contextWindow || context.contextWindow || windowTokens);
  const freeTokens = windowTokens ? Math.max(0, windowTokens - used) : 0;
  const usedPercent = contextPercent(used, windowTokens) || 0;
  const rawCategories = [
    { key: 'system', label: t('System prompt'), tokens: tokenBuckets(semantic, ['system', 'workflow', 'workspace', 'environment', 'other']) },
    { key: 'tools', label: t('System tools'), tokens: tokenBuckets(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other', 'control', 'session']) + finite(request.requestOverheadTokens) },
    { key: 'mcp', label: t('MCP tools'), tokens: tokenBuckets(schema, ['mcp']) },
    { key: 'agents', label: t('Custom agents'), tokens: tokenBuckets(schema, ['agents']) },
    { key: 'memory', label: t('Memory files'), tokens: tokenBuckets(semantic, ['memory']) + tokenBuckets(schema, ['memory']) },
    { key: 'skills', label: t('Skills'), tokens: tokenBuckets(schema, ['skills']) },
    { key: 'messages', label: t('Messages'), tokens: tokenBuckets(semantic, ['chat', 'assistant', 'toolResults']) },
  ];
  // ONE scale for the whole panel. The header meters provider-reported usage
  // (baseline-backed, provider-calibrated) while the buckets are raw o200k
  // estimates of the same projection, so the two disagree by the calibration
  // factor. Project the buckets onto the header total: rows + free space then
  // always add up to the window instead of leaving a phantom gap.
  const rawCategorizedTokens = rawCategories.reduce((sum, category) => sum + category.tokens, 0);
  const categoryScale = rawCategorizedTokens > 0 && used > 0 ? used / rawCategorizedTokens : 1;
  const categories = rawCategories.map((category) => ({
    ...category,
    tokens: Math.round(category.tokens * categoryScale),
  }));
  const categorizedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const autoCompactBufferTokens = Math.max(0, rawWindowTokens - windowTokens);
  const estimatedFreeTokens = Math.max(0, windowTokens - categorizedTokens);
  const categoryWindowTokens = Math.max(rawWindowTokens, categorizedTokens + autoCompactBufferTokens);
  categories.push(
    { key: 'free', label: t('Free space'), tokens: estimatedFreeTokens },
    { key: 'autocompact', label: t('Autocompact buffer'), tokens: autoCompactBufferTokens },
  );

  return <div className="context-surface-view">
    <div className="context-card">
      <section className="context-usage-overview" aria-label={t('Context usage')}>
        <div className="context-usage-heading">
          <strong>{usage.percent}% used</strong>
          <span>{compactTokens(used)} / {compactTokens(windowTokens)} · {compactTokens(freeTokens)} free</span>
        </div>
        <div className="context-main-bar" role="img"
          aria-label={t('{{percent}}% context used', { percent: usage.percent })}>
          <span style={{ width: `${usedPercent}%` }} />
        </div>
      </section>
      <section className="context-mix" aria-labelledby="context-mix-title">
        <h3 id="context-mix-title">{t('Estimated usage by category')}</h3>
        <div className="context-stack-bar" role="img" aria-label={t('Context composition')}>
          {categories.filter((category) => category.tokens > 0).map((category) => (
            <b key={category.key} data-context-key={category.key}
              style={{ width: `${Math.max(0.75, contextPercent(category.tokens, categoryWindowTokens) || 0)}%` }} />
          ))}
        </div>
        <div className="context-mix-grid">
          {categories.map((category) => <div className="context-mix-row" key={category.key}
            data-context-key={category.key}>
            <i aria-hidden="true" />
            <span>{category.label}</span>
            <strong>{compactTokens(category.tokens)}</strong>
          </div>)}
        </div>
      </section>
    </div>
  </div>;
}
