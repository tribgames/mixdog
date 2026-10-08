import type { ReactNode } from 'react';
import { nonNegativeNumber, resolveContextDisplayUsage } from './context-usage';
import { t } from './i18n';
import { record } from './record-utils';
import { ContextInspector, type ContextInspection, type ContextRequest } from './ContextInspector';
import { statsCount, statsMoney, statsNumber, statsPercent, statsSpeed, statsTokens } from './usage-stats-model';
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

/** The headline is measured input. Category estimates stay separate and are
 *  never rescaled to look like provider-measured per-category token counts. */
function contextDisplayUsage(status: unknown, snapshot: unknown) {
  const context = record(status);
  const state = record(snapshot);
  const compaction = record(context.compaction);
  return resolveContextDisplayUsage({
    sessionId: state.sessionId || context.sessionId || (context.contextWindow ? 'context' : ''),
    stats:
      Object.hasOwn(record(state.stats), 'currentContextSource') ||
      Object.hasOwn(record(state.stats), 'currentContextTokens')
        ? state.stats
        : contextMeasurementStats(context),
    autoCompactTokenLimit: state.autoCompactTokenLimit || compaction.triggerTokens,
    displayContextWindow: state.displayContextWindow || context.contextWindow,
    contextWindow: state.contextWindow || context.effectiveContextWindow || context.contextWindow,
  });
}

/** The reading on one line: what it is, then used / window and the share. */
export function ContextReading({ status, snapshot }: { status: unknown; snapshot: unknown }) {
  const usage = contextDisplayUsage(status, snapshot);
  return (
    <span className="context-reading">
      <b>{t(contextMeasurementLabel(usage.source))}</b>
      <span>
        {usage.used == null ? '—' : compactTokens(usage.used)} / {compactTokens(usage.limit)}
        {usage.percent != null ? ` · ${usage.percent}%` : ''}
      </span>
    </span>
  );
}

/** What this session has spent from its first request, compactions included,
 *  in the statistics surface's terms. One quiet line: spacing and text tone
 *  separate the figures, no rules or dots (user: 구분선들이 있는게 맘에 안 듦). */
function SessionUsageFooter({ usage, compactions }: { usage: unknown; compactions: number }) {
  const totals = record(usage);
  if (!(statsNumber(totals.turns) > 0)) return null;
  const figures: [string, string][] = [
    [t('Est. value'), statsMoney(totals)],
    [t('Cache hit rate'), statsPercent(totals.cacheHitRate)],
    [t('Input'), statsTokens(totals.input)],
    [t('Output'), statsTokens(totals.output)],
    [t('Cache read'), statsTokens(totals.cacheRead)],
    [t('Cache write'), statsTokens(totals.cacheWrite)],
  ];
  // Only once a timed request produced output: an unknown speed is no figure.
  if (totals.outputTokensPerSecond != null)
    figures.push([t('Speed'), `${statsSpeed(totals.outputTokensPerSecond)} tok/s`]);
  return (
    <footer className="context-session-usage" aria-label={t('Session usage')}>
      {figures.map(([label, value]) => (
        <span key={label}>
          {label} <strong>{value}</strong>
        </span>
      ))}
      <span className="context-session-usage-end">
        <span>
          {t('Turns')} <strong>{statsCount(totals.turns)}</strong>
        </span>
        {compactions > 0 && (
          <span>
            {t('Compactions')} <strong>{statsCount(compactions)}</strong>
          </span>
        )}
      </span>
    </footer>
  );
}

export function ContextBody({
  status,
  snapshot,
  sessionUsage,
  request: inspectRequest,
  loading = false,
  readingInHeader = false,
}: {
  status: unknown;
  snapshot: unknown;
  /** getSessionUsage: the session's lifetime spend from the usage ledger. */
  sessionUsage?: unknown;
  request?: ContextRequest;
  /** The measured breakdown is still in flight. The headline comes from the
   *  gauge's own snapshot, so only the category list waits. */
  loading?: boolean;
  /** The dialog's title bar carries the reading (ContextReading), so the body
   *  opens straight on the bar: one header, not a title over a second
   *  headline (user: 헤더가 하나만 있으면 되지, 헤더 아래는 막대만). */
  readingInHeader?: boolean;
}) {
  const context = record(status);
  const messages = record(context.messages);
  const semantic = record(messages.semantic);
  const request = record(context.request);
  const schema = record(request.toolSchemaBreakdown);
  const inspection = context.inspection as ContextInspection | undefined;
  const usage = contextDisplayUsage(status, snapshot);
  const used = usage.used;
  const windowTokens = usage.limit;
  const usedPercent = contextPercent(used, windowTokens) || 0;
  const categories = [
    {
      key: 'system',
      label: t('System prompt'),
      tokens: tokenBuckets(semantic, ['system', 'workflow', 'workspace', 'environment', 'other']),
    },
    {
      key: 'tools',
      label: t('System tools'),
      tokens:
        tokenBuckets(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other', 'control', 'session']) +
        nonNegativeNumber(request.requestOverheadTokens),
    },
    { key: 'mcp', label: t('MCP tools'), tokens: tokenBuckets(schema, ['mcp']) },
    { key: 'agents', label: t('Custom agents'), tokens: tokenBuckets(schema, ['agents']) },
    {
      key: 'memory',
      label: t('Memory files'),
      tokens: tokenBuckets(semantic, ['memory']) + tokenBuckets(schema, ['memory']),
    },
    { key: 'skills', label: t('Skills'), tokens: tokenBuckets(schema, ['skills']) },
    { key: 'messages', label: t('Messages'), tokens: tokenBuckets(semantic, ['chat', 'assistant', 'toolResults']) },
    { key: 'reasoning', label: t('Reasoning tokens'), tokens: tokenBuckets(semantic, ['reasoning']) },
  ];
  const measuredCategories = (inspection?.categories ?? categories).filter((category) => category.tokens > 0);
  const measuredCategoryTotal = measuredCategories.reduce((sum, category) => sum + category.tokens, 0);
  const measuredBarDescription =
    used != null && measuredCategoryTotal > 0
      ? t('Measured total; category colors show estimated proportions.')
      : t(contextMeasurementLabel(usage.source));
  const categorizedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const estimatedFreeTokens = Math.max(0, windowTokens - categorizedTokens);
  const categoryWindowTokens = Math.max(windowTokens, categorizedTokens);
  categories.push({ key: 'free', label: t('Free space'), tokens: estimatedFreeTokens });
  // Without a reading, every category is 0 and the window reads as free space.
  // Say the breakdown is still being measured instead of showing that as fact.
  const measuring = loading && !inspection && categorizedTokens <= 0;

  let breakdown: ReactNode;
  if (inspection) {
    breakdown = <ContextInspector inspection={inspection} windowTokens={windowTokens} request={inspectRequest} />;
  } else if (measuring) {
    breakdown = (
      <section className="context-mix" aria-labelledby="context-mix-title">
        <h3 id="context-mix-title">{t('Estimated usage by category')}</h3>
        <p className="settings-loading" role="status">
          {t('Loading…')}
        </p>
      </section>
    );
  } else {
    breakdown = (
      <section className="context-mix" aria-labelledby="context-mix-title">
        <h3 id="context-mix-title">{t('Estimated usage by category')}</h3>
        <div className="context-stack-bar" role="img" aria-label={t('Context composition')}>
          {categories
            .filter((category) => category.tokens > 0)
            .map((category) => (
              <b
                key={category.key}
                data-context-key={category.key}
                style={{ width: `${Math.max(0.75, contextPercent(category.tokens, categoryWindowTokens) || 0)}%` }}
              />
            ))}
        </div>
        <div className="context-mix-grid">
          {categories.map((category) => (
            <div className="context-mix-row" key={category.key} data-context-key={category.key}>
              <i aria-hidden="true" />
              <span>{category.label}</span>
              <strong>{compactTokens(category.tokens)}</strong>
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="context-surface-view">
      <div className="context-card">
        <section
          className="context-usage-overview"
          aria-label={t('Context usage')}
          data-reading={readingInHeader ? 'header' : undefined}
        >
          {!readingInHeader && (
            <div className="context-usage-heading">
              <strong>{t(contextMeasurementLabel(usage.source))}</strong>
              <span>
                {used == null ? '—' : compactTokens(used)} / {compactTokens(windowTokens)}
                {usage.percent != null ? ` · ${usage.percent}%` : ''}
              </span>
            </div>
          )}
          <div
            className="context-main-bar"
            role="img"
            aria-label={
              usage.percent == null
                ? measuredBarDescription
                : `${t('{{percent}}% context used', { percent: usage.percent })} ${measuredBarDescription}`
            }
            title={measuredBarDescription}
          >
            <span style={{ width: `${usedPercent}%` }}>
              {used != null &&
                measuredCategoryTotal > 0 &&
                measuredCategories.map((category) => (
                  <b
                    key={category.key}
                    data-context-key={category.key}
                    style={{ width: `${(category.tokens / measuredCategoryTotal) * 100}%` }}
                    title={`${category.label} · ${t('Estimated share: {{percent}}%', {
                      percent: Math.round((category.tokens / measuredCategoryTotal) * 1000) / 10,
                    })}`}
                  />
                ))}
            </span>
          </div>
        </section>
        {breakdown}
        <SessionUsageFooter
          usage={sessionUsage}
          compactions={nonNegativeNumber(record(context.compaction).compactCount)}
        />
      </div>
    </div>
  );
}
