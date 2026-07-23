import React from 'react';

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

function contextPercentLabel(value: unknown, total: unknown): string {
  const percent = contextPercent(value, total);
  if (percent === null) return finite(value) === 0 ? '0%' : 'N/A';
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.floor(percent)}%`;
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
  const used = finite(context.usedTokens ?? context.currentEstimatedTokens);
  const windowTokens = finite(context.contextWindow ?? state.contextWindow ?? context.rawContextWindow);
  const freeTokens = windowTokens ? Math.max(0, windowTokens - used) : finite(context.freeTokens);
  const usedPercent = contextPercent(used, windowTokens) || 0;
  const categories = [
    { key: 'messages', label: 'Messages', tokens: tokenBuckets(semantic, ['chat', 'assistant']) },
    { key: 'tools', label: 'Tools', tokens: tokenBuckets(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other', 'control', 'agents', 'session']) },
    { key: 'mcp', label: 'MCP', tokens: tokenBuckets(schema, ['mcp']) },
    { key: 'skills', label: 'Skills', tokens: tokenBuckets(schema, ['skills']) },
    { key: 'memory', label: 'Memory', tokens: tokenBuckets(semantic, ['memory']) + tokenBuckets(schema, ['memory']) },
    { key: 'session', label: 'Session', tokens: tokenBuckets(semantic, ['workspace', 'environment', 'other']) },
    { key: 'workflow', label: 'Workflow', tokens: tokenBuckets(semantic, ['workflow']) },
    { key: 'system', label: 'System', tokens: tokenBuckets(semantic, ['system']) },
    { key: 'tool-io', label: 'Tool I/O', tokens: tokenBuckets(semantic, ['toolResults']) },
  ];
  const categorizedTokens = categories.reduce((sum, category) => sum + category.tokens, 0);
  const requestOverheadTokens = Math.max(0, used - categorizedTokens);
  if (requestOverheadTokens > 0) {
    categories.push({ key: 'request', label: 'Overhead', tokens: requestOverheadTokens });
  }

  return <div className="context-view">
    <section className="context-usage-overview" aria-label="Context usage">
      <div className="context-usage-heading">
        <strong>{contextPercentLabel(used, windowTokens)} used</strong>
        <span>{compactTokens(used)} / {compactTokens(windowTokens)} · {compactTokens(freeTokens)} free</span>
      </div>
      <div className="context-main-bar" role="img"
        aria-label={`${contextPercentLabel(used, windowTokens)} context used`}>
        <span style={{ width: `${usedPercent}%` }} />
      </div>
    </section>
    <section className="context-mix" aria-labelledby="context-mix-title">
      <h3 id="context-mix-title">Context mix</h3>
      <div className="context-stack-bar" role="img" aria-label="Context composition">
        {categories.filter((category) => category.tokens > 0).map((category) => (
          <b key={category.key} data-context-key={category.key}
            style={{ width: `${Math.max(0.75, contextPercent(category.tokens, windowTokens) || 0)}%` }} />
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
  </div>;
}
