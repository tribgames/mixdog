import { nonNegativeNumber, resolveContextDisplayUsage } from './context-usage';
import { t } from './i18n';
import { record } from './record-utils';
// @ts-expect-error Shared presentation contract has no separate declaration file.
import { contextMeasurementStats, contextMeasurementLabel } from '../../../../src/ui/context-measurement.mjs';

type Row = Record<string, unknown>;

function compactTokens(value: unknown): string {
  const number = nonNegativeNumber(value);
  if (number <= 0) return '0';
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 10_000) return `${Math.round(number / 1_000)}k`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
  return `${Math.round(number)}`;
}

function contextPercent(value: unknown, total: unknown): number | null {
  const denominator = nonNegativeNumber(total);
  if (!denominator) return null;
  return Math.max(0, Math.min(100, (nonNegativeNumber(value) / denominator) * 100));
}

function tokenBuckets(source: Row, names: string[]): number {
  return names.reduce((sum, name) => sum + nonNegativeNumber(record(source[name]).tokens), 0);
}

export function ContextBody({ status, snapshot }: { status: unknown; snapshot: unknown }) {
  const context = record(status);
  const state = record(snapshot);
  const messages = record(context.messages);
  const semantic = record(messages.semantic);
  const request = record(context.request);
  const schema = record(request.toolSchemaBreakdown);
  const compaction = record(context.compaction);
  // The headline is measured input. Category estimates stay separate and are
  // never rescaled to look like provider-measured per-category token counts.
  const usage = resolveContextDisplayUsage({
    sessionId: state.sessionId || context.sessionId || (context.contextWindow ? 'context' : ''),
    stats: Object.hasOwn(record(state.stats), 'currentContextSource')
      || Object.hasOwn(record(state.stats), 'currentContextTokens')
      ? state.stats : contextMeasurementStats(context),
    autoCompactTokenLimit: state.autoCompactTokenLimit || compaction.triggerTokens,
    displayContextWindow: state.displayContextWindow || context.contextWindow,
    contextWindow: state.contextWindow || context.effectiveContextWindow || context.contextWindow,
  });
  const used = usage.used;
  const windowTokens = usage.limit;
  const rawWindowTokens = nonNegativeNumber(context.rawContextWindow || state.contextWindow || context.contextWindow || windowTokens);
  const usedPercent = contextPercent(used, windowTokens) || 0;
  const rawCategories = [
    { key: 'system', label: t('System prompt'), tokens: tokenBuckets(semantic, ['system', 'workflow', 'workspace', 'environment', 'other']) },
    { key: 'tools', label: t('System tools'), tokens: tokenBuckets(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other', 'control', 'session']) + nonNegativeNumber(request.requestOverheadTokens) },
    { key: 'mcp', label: t('MCP tools'), tokens: tokenBuckets(schema, ['mcp']) },
    { key: 'agents', label: t('Custom agents'), tokens: tokenBuckets(schema, ['agents']) },
    { key: 'memory', label: t('Memory files'), tokens: tokenBuckets(semantic, ['memory']) + tokenBuckets(schema, ['memory']) },
    { key: 'skills', label: t('Skills'), tokens: tokenBuckets(schema, ['skills']) },
    { key: 'messages', label: t('Messages'), tokens: tokenBuckets(semantic, ['chat', 'assistant', 'toolResults']) },
  ];
  const categories = rawCategories;
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
          <strong>{t(contextMeasurementLabel(usage.source))}</strong>
          <span>{used == null ? '—' : compactTokens(used)} / {compactTokens(windowTokens)}
            {usage.percent != null ? ` · ${usage.percent}%` : ''}</span>
        </div>
        <div className="context-main-bar" role="img"
          aria-label={t('{{percent}}% context used', { percent: usage.percent })}>
          <span style={{ width: `${usedPercent}%` }} />
        </div>
      </section>
      <p>{t('Input includes cached tokens. Output appears in the next measured request.')}</p>
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
