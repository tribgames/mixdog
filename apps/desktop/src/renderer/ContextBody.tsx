import type { ReactNode } from 'react';
import { nonNegativeNumber, resolveContextDisplayUsage } from './context-usage';
import { t } from './i18n';
import { record } from './record-utils';
import { ContextInspector, type ContextInspection, type ContextRequest } from './ContextInspector';
import {
  floorFigure,
  floorNote,
  hitRateNote,
  statsCount,
  statsMoney,
  statsNumber,
  statsPercent,
  statsSpeed,
  statsTokens,
  unpricedTurns,
  usageFloor,
} from './usage-stats-model';
// biome-ignore format: @ts-expect-error must precede the specifier
// @ts-expect-error Shared presentation contract has no separate declaration file.
import { contextMeasurementStats, contextMeasurementLabel } from '../../../../packages/protocol-client/src/rows/context-measurement.mjs';
import { emptyStateHost } from './empty-state-host';
import { agentRouteProvider } from './provider-display';

type Row = Record<string, unknown>;

export function compactTokens(value: unknown): string {
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
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow || context.effectiveContextWindow || context.contextWindow,
  });
}

/** The session runs on an external agent's route, which keeps its own context. */
export function isAgentSession(snapshot: unknown): boolean {
  return agentRouteProvider(String(record(snapshot).provider || ''));
}

/** What a reading is: an agent's report is the prompt and output of its last model call, not an input. */
function readingLabel(source: string, agent: boolean): string {
  return t(agent && source === 'last_api_request' ? 'Last call, prompt and output' : contextMeasurementLabel(source));
}

/** The reading on one line: what it is, then used / window and the share. */
export function ContextReading({ status, snapshot }: { status: unknown; snapshot: unknown }) {
  const usage = contextDisplayUsage(status, snapshot);
  return (
    <span className="context-reading">
      <b>{readingLabel(usage.source, isAgentSession(snapshot))}</b>
      <span>
        {usage.used == null ? '—' : compactTokens(usage.used)} / {compactTokens(usage.limit)}
        {usage.percent != null ? ` · ${usage.percent}%` : ''}
      </span>
    </span>
  );
}

/** What this session has spent from its first request, compactions included,
 *  in the statistics surface's terms. One quiet line: spacing and text tone
 *  separate the figures, no rules or dots. */
function SessionUsageFooter({ usage, compactions }: { usage: unknown; compactions: number }) {
  const totals = record(usage);
  if (!(statsNumber(totals.turns) > 0)) return null;
  const floor = usageFloor(totals);
  const prompt = statsNumber(totals.input) + statsNumber(totals.cacheRead) + statsNumber(totals.cacheWrite);
  // The ledger leaves the rate out once any call went unmeasured; it is still the measured calls' rate.
  const hitRate = totals.cacheHitRate ?? (floor && prompt > 0 ? statsNumber(totals.cacheRead) / prompt : null);
  const marked = (label: string, value: string, isFloor = floor): [string, string, string | undefined] =>
    isFloor && value !== '—' ? [label, floorFigure(value, true), floorNote()] : [label, value, undefined];
  const hit = statsPercent(hitRate);
  const costFloor = floor || unpricedTurns(totals) > 0;
  // A floor of nothing is no figure, as for the tokens.
  const cost = costFloor && !(statsNumber(totals.costUsd) > 0) ? '—' : statsMoney(totals);
  const figures: [string, string, string | undefined][] = [
    marked(t('Est. value'), cost, costFloor),
    [t('Cache hit rate'), hit, floor && hit !== '—' ? hitRateNote() : undefined],
    marked(t('Input'), statsTokens(totals.input, floor)),
    marked(t('Output'), statsTokens(totals.output, floor)),
    marked(t('Cache read'), statsTokens(totals.cacheRead, floor)),
    marked(t('Cache write'), statsTokens(totals.cacheWrite, floor)),
  ];
  // Only once a timed request produced output: an unknown speed is no figure.
  if (totals.outputTokensPerSecond != null)
    figures.push([t('Speed'), `${statsSpeed(totals.outputTokensPerSecond)} tok/s`, undefined]);
  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the footer keeps its tag; the label names the session usage summary
    <footer className="context-session-usage" aria-label={t('Session usage')}>
      {figures.map(([label, value, note]) => (
        <span key={label} title={note}>
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

type EstimatedCategory = { key: string; label: string; tokens: number };

function estimatedCategories(semantic: Row, schema: Row, request: Row): EstimatedCategory[] {
  return [
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
}

/** What Mixdog itself puts in an external agent's context: the system prompt it appends, its tools (which reach the
 *  agent as the `mixdog` MCP server), its memory and the conversation it keeps. */
function agentSessionCategories(semantic: Row, schema: Row): EstimatedCategory[] {
  return [
    {
      key: 'system',
      label: t('System prompt'),
      tokens: tokenBuckets(semantic, ['system', 'workflow', 'workspace', 'environment', 'other']),
    },
    {
      key: 'mcp',
      label: t('MCP tools'),
      tokens: tokenBuckets(schema, [
        'code',
        'web',
        'mutation',
        'channels',
        'setup',
        'other',
        'control',
        'session',
        'mcp',
        'agents',
        'memory',
        'skills',
      ]),
    },
    { key: 'memory', label: t('Memory files'), tokens: tokenBuckets(semantic, ['memory']) },
    { key: 'messages', label: t('Messages'), tokens: tokenBuckets(semantic, ['chat', 'assistant', 'toolResults']) },
    { key: 'reasoning', label: t('Reasoning tokens'), tokens: tokenBuckets(semantic, ['reasoning']) },
  ];
}

/** `total` divided among the categories in their estimated proportions, in whole tokens that add up to it. */
function dividedAmong(estimated: EstimatedCategory[], total: number, categorized: number): EstimatedCategory[] {
  const exact = estimated.map((category) => (category.tokens / categorized) * total);
  const whole = exact.map(Math.floor);
  let left = Math.round(total) - whole.reduce((sum, tokens) => sum + tokens, 0);
  const byFraction = exact.map((tokens, index) => ({ index, fraction: tokens - whole[index] }));
  for (const { index } of byFraction.sort((a, b) => b.fraction - a.fraction)) {
    if (left <= 0) break;
    whole[index] += 1;
    left -= 1;
  }
  return estimated.map((category, index) => ({ ...category, tokens: whole[index] }));
}

/** The estimated composition of a context status: each category's tokens,
 *  their sum, the free space left in a window of `windowTokens`, and the
 *  window the shares are of (never less than what is held). With the
 *  window's measured total (`used`) the estimates say only how the
 *  measurement divides: each category takes its estimated share of it, so
 *  the parts add up to the reading beside them, and the free space is what
 *  the measurement leaves. An external agent's session (`agent`) shows Mixdog's own parts as they are, never rescaled,
 *  and what the agent reports beyond them as one row for what it holds that Mixdog cannot see. Where Mixdog's own
 *  estimate is above the agent's own count, the agent's count is the measurement and the estimate only says how it
 *  divides: the parts are divided within it, so parts and free space never pass the window. */
export function contextMix(status: unknown, windowTokens: number, used: number | null = null, agent = false) {
  const context = record(status);
  const request = record(context.request);
  if (agent) {
    const estimated = agentSessionCategories(record(record(context.messages).semantic), record(request.toolSchemaBreakdown));
    const estimate = estimated.reduce((sum, category) => sum + category.tokens, 0);
    const parts = used !== null && estimate > used ? dividedAmong(estimated, used, estimate) : estimated;
    const shown = parts.reduce((sum, category) => sum + category.tokens, 0);
    const host = used === null ? 0 : Math.max(0, used - shown);
    const held = shown + host;
    return {
      categories: [...parts, { key: 'host', label: t('Held by the agent'), tokens: host }],
      categorized: held,
      held,
      free: Math.max(0, windowTokens - held),
      windowTokens: Math.max(windowTokens, held),
    };
  }
  const estimated = estimatedCategories(
    record(record(context.messages).semantic),
    record(request.toolSchemaBreakdown),
    request
  );
  const categorized = estimated.reduce((sum, category) => sum + category.tokens, 0);
  const held = used ?? categorized;
  return {
    categories: used !== null && categorized > 0 ? dividedAmong(estimated, used, categorized) : estimated,
    categorized,
    held,
    free: Math.max(0, windowTokens - held),
    windowTokens: Math.max(windowTokens, held),
  };
}

function EstimatedMix({ categories, windowTokens }: { categories: EstimatedCategory[]; windowTokens: number }) {
  return (
    <section className="context-mix" aria-labelledby="context-mix-title">
      <h3 id="context-mix-title">{t('Estimated usage by category')}</h3>
      <div className="context-stack-bar" role="img" aria-label={t('Context composition')}>
        {categories
          .filter((category) => category.tokens > 0)
          .map((category) => (
            <b
              key={category.key}
              data-context-key={category.key}
              style={{ width: `${Math.max(0.75, contextPercent(category.tokens, windowTokens) || 0)}%` }}
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
   *  headline. */
  readingInHeader?: boolean;
}) {
  const context = record(status);
  const agent = isAgentSession(snapshot);
  // An agent's session shows the composition the session panel shows: what the request inspection lists is a provider's
  // request, which an agent's context is not.
  const inspection = agent ? undefined : (context.inspection as ContextInspection | undefined);
  const usage = contextDisplayUsage(status, snapshot);
  const used = usage.used;
  const windowTokens = usage.limit;
  const usedPercent = contextPercent(used, windowTokens) || 0;
  const label = readingLabel(usage.source, agent);
  const mix = contextMix(status, windowTokens, agent ? used : null, agent);
  const { categories, categorized: categorizedTokens } = mix;
  const measuredCategories = (inspection?.categories ?? categories).filter((category) => category.tokens > 0);
  const measuredCategoryTotal = measuredCategories.reduce((sum, category) => sum + category.tokens, 0);
  const measuredBarDescription =
    used != null && measuredCategoryTotal > 0
      ? t('Measured total; category colors show estimated proportions.')
      : label;
  const categoryWindowTokens = mix.windowTokens;
  categories.push({ key: 'free', label: t('Free space'), tokens: mix.free });
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
        <p className="settings-loading mx-empty-state" ref={emptyStateHost} role="status">
          {t('Loading…')}
        </p>
      </section>
    );
  } else {
    breakdown = <EstimatedMix categories={categories} windowTokens={categoryWindowTokens} />;
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
              <strong>{label}</strong>
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
