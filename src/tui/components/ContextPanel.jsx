/**
 * components/ContextPanel.jsx - read-only context usage dashboard.
 */
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';

function truncateText(value, width) {
  const text = String(value || '');
  if (!(width > 0)) return '';
  if (stringWidth(text) <= width) return text;
  if (width <= 1) return '…'.repeat(Math.max(0, width));
  let out = '';
  for (const ch of text) {
    if (stringWidth(`${out}${ch}…`) > width) break;
    out += ch;
  }
  return `${out}…`;
}

function padCells(value, width) {
  const text = String(value || '');
  return `${text}${' '.repeat(Math.max(0, width - stringWidth(text)))}`;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatTokens(value) {
  const n = finiteNumber(value);
  if (n <= 0) return '0';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (Math.abs(n) >= 10_000) return `${Math.round(n / 1000)}k`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function percent(value, total) {
  const n = finiteNumber(value);
  const d = finiteNumber(total);
  if (d <= 0) return null;
  return Math.max(0, Math.min(100, (n / d) * 100));
}

function percentLabel(value, total) {
  const pct = percent(value, total);
  if (pct === null) return 'n/a';
  return `${pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
}

function usageColor(pct) {
  if (!Number.isFinite(Number(pct))) return theme.text;
  if (pct >= 95) return theme.error;
  if (pct >= 80) return theme.warning;
  return theme.success;
}

function ProgressBar({ value = 0, total = 0, width = 24 }) {
  const pct = percent(value, total) ?? 0;
  const safeWidth = Math.max(8, Math.floor(width));
  const filled = Math.max(0, Math.min(safeWidth, Math.round((pct / 100) * safeWidth)));
  const empty = safeWidth - filled;
  return (
    <Box flexDirection="row" width={safeWidth}>
      {filled > 0 ? <Text color={usageColor(pct)}>{'█'.repeat(filled)}</Text> : null}
      {empty > 0 ? <Text color={theme.inactive}>{'░'.repeat(empty)}</Text> : null}
    </Box>
  );
}

function metricValue(parts) {
  return parts.filter(Boolean).join(' · ');
}

function DetailLine({ label, value, columns }) {
  const innerWidth = Math.max(24, Math.floor(columns || 80) - 4);
  const labelWidth = 10;
  const valueWidth = Math.max(0, innerWidth - labelWidth - 2);
  return (
    <Box flexDirection="row" width="100%">
      <Text color={theme.subtle}>{padCells(truncateText(label, labelWidth), labelWidth)}</Text>
      <Text color={theme.inactive}>  </Text>
      <Text color={theme.text}>{truncateText(value, valueWidth)}</Text>
    </Box>
  );
}

function bucketTokens(map, names) {
  return names.reduce((sum, name) => sum + finiteNumber(map?.[name]?.tokens), 0);
}

function bucketCount(map, names) {
  return names.reduce((sum, name) => sum + finiteNumber(map?.[name]?.count), 0);
}

function semanticTokens(semantic, names) {
  return names.reduce((sum, name) => sum + finiteNumber(semantic?.[name]?.tokens), 0);
}

function CategoryItem({ label, tokens, total, width }) {
  const labelWidth = Math.min(11, Math.max(7, Math.floor(width * 0.22)));
  const pctWidth = 6;
  const tokenWidth = 7;
  const barWidth = Math.max(6, Math.min(20, width - labelWidth - pctWidth - tokenWidth - 4));
  const pct = percent(tokens, total);
  return (
    <Box flexDirection="row" width={width}>
      <Text color={theme.subtle}>{padCells(truncateText(label, labelWidth), labelWidth)}</Text>
      <Text color={theme.inactive}> </Text>
      <Text color={usageColor(pct)}>{padCells(percentLabel(tokens, total), pctWidth)}</Text>
      <ProgressBar value={tokens} total={total} width={barWidth} />
      <Text color={theme.inactive}> </Text>
      <Text color={theme.text}>{padCells(formatTokens(tokens), tokenWidth)}</Text>
    </Box>
  );
}

function CategoryGrid({ categories, columns, total }) {
  const innerWidth = Math.max(24, Math.floor(columns || 80) - 4);
  const twoColumns = innerWidth >= 84;
  if (!twoColumns) {
    return (
      <Box flexDirection="column" width="100%">
        {categories.map((category) => (
          <CategoryItem key={category.label} {...category} total={total} width={innerWidth} />
        ))}
      </Box>
    );
  }
  const gap = 4;
  const leftWidth = Math.floor((innerWidth - gap) / 2);
  const rightWidth = innerWidth - gap - leftWidth;
  const pairs = [];
  for (let i = 0; i < categories.length; i += 2) pairs.push(categories.slice(i, i + 2));
  return (
    <Box flexDirection="column" width="100%">
      {pairs.map((pair, index) => (
        <Box key={index} flexDirection="row" width="100%">
          <CategoryItem {...pair[0]} total={total} width={leftWidth} />
          <Text>{' '.repeat(gap)}</Text>
          {pair[1] ? <CategoryItem {...pair[1]} total={total} width={rightWidth} /> : null}
        </Box>
      ))}
    </Box>
  );
}

function ContextUsageView({ detail, columns }) {
  const innerWidth = Math.max(24, Math.floor(columns || 80) - 4);
  const usage = detail?.usage || {};
  const compaction = detail?.compaction || {};
  const messages = detail?.messages || {};
  const tools = detail?.tools || {};
  const toolIo = detail?.toolIo || {};
  const request = detail?.request || {};
  const lastApi = detail?.lastApi || {};
  const cache = detail?.cache || {};
  const extensions = detail?.extensions || {};
  const mcp = detail?.mcp || {};
  const semantic = messages.semantic || {};
  const schema = request.toolSchemaBreakdown || {};
  const usedTokens = finiteNumber(usage.usedTokens);
  const windowTokens = finiteNumber(usage.windowTokens);
  const freeTokens = windowTokens ? Math.max(0, windowTokens - usedTokens) : finiteNumber(usage.freeTokens);
  const usedPct = percent(usedTokens, windowTokens);
  const summaryText = `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)} · ${formatTokens(freeTokens)} free`;
  const pctText = `${percentLabel(usedTokens, windowTokens)} used`;
  const barWidth = Math.max(12, Math.min(34, innerWidth - stringWidth(summaryText) - stringWidth(pctText) - 5));
  const builtInToolTokens = bucketTokens(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other']);
  const builtInToolCount = bucketCount(schema, ['code', 'web', 'mutation', 'channels', 'setup', 'other']);
  const sessionTokens = semanticTokens(semantic, ['workspace', 'environment', 'other']);
  const compactionLine = metricValue([
    compaction.stage && compaction.stage !== 'pending' ? compaction.stage : '',
    compaction.state,
    compaction.type ? `type ${compaction.type}` : '',
    compaction.triggerTokens ? `trigger ${formatTokens(compaction.triggerTokens)}` : '',
    compaction.boundaryTokens ? `boundary ${formatTokens(compaction.boundaryTokens)}` : '',
  ]);
  const sourceLine = metricValue([
    usage.effective ? `effective ${formatTokens(windowTokens)}` : `window ${formatTokens(windowTokens)}`,
    usage.rawWindowTokens && usage.rawWindowTokens !== usage.windowTokens ? `raw ${formatTokens(usage.rawWindowTokens)}` : '',
  ]);
  const apiLine = metricValue([
    `last ctx ${formatTokens(lastApi.contextTokens)}`,
    `in/out ${formatTokens(lastApi.inputTokens)}/${formatTokens(lastApi.outputTokens)}`,
    `cache ${cache.hitRate || 'n/a'}`,
  ]);
  const categories = [
    { label: 'Messages', tokens: semanticTokens(semantic, ['chat', 'assistant']), meta: '' },
    { label: 'Tools', tokens: builtInToolTokens, meta: `${tools.active || 0}/${tools.count || 0} active${builtInToolCount ? ` · ${builtInToolCount} defs` : ''}` },
    { label: 'MCP', tokens: bucketTokens(schema, ['mcp']), meta: `${mcp.connected || 0}/${mcp.configured || 0} servers` },
    { label: 'Skills', tokens: bucketTokens(schema, ['skills']), meta: `${extensions.skills || 0} skills` },
    { label: 'Memory', tokens: semanticTokens(semantic, ['memory']) + bucketTokens(schema, ['memory']), meta: 'core + recall tools' },
    { label: 'Session', tokens: sessionTokens, meta: 'workspace · environment' },
    { label: 'Workflow', tokens: semanticTokens(semantic, ['workflow']) + bucketTokens(schema, ['agents']), meta: 'workflow · agents' },
    { label: 'System', tokens: semanticTokens(semantic, ['system']), meta: 'rules · role catalog' },
    { label: 'Overhead', tokens: finiteNumber(request.overheadTokens), meta: 'request frame' },
    { label: 'Tool I/O', tokens: semanticTokens(semantic, ['toolResults']), meta: `${toolIo.calls || 0} calls · ${toolIo.results || 0} results` },
  ];

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Text color={usageColor(usedPct)} bold>{padCells(pctText, Math.min(10, innerWidth))}</Text>
        <Text color={theme.inactive}> </Text>
        <ProgressBar value={usedTokens} total={windowTokens} width={barWidth} />
        <Text color={theme.inactive}>  </Text>
        <Text color={theme.text}>{truncateText(summaryText, Math.max(0, innerWidth - Math.min(10, innerWidth) - barWidth - 3))}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" width="100%">
        <DetailLine label="Source" value={sourceLine} columns={columns} />
        <DetailLine label="Compaction" value={compactionLine} columns={columns} />
        <DetailLine label="API/cache" value={apiLine} columns={columns} />
      </Box>
      <Box marginTop={1} flexDirection="column" width="100%">
        <Text color={theme.subtle}>Context mix</Text>
        <Box marginTop={1} flexDirection="column" width="100%">
          <CategoryGrid categories={categories} columns={columns} total={windowTokens} />
        </Box>
      </Box>
    </Box>
  );
}

export function ContextPanel({ rows, title = 'Context Usage', columns = 80, fillHeight = false, detail = null }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const labelWidth = Math.min(
    safeRows.reduce((w, row) => Math.max(w, String(row.label || '').length), 0),
    Math.max(12, Math.floor(columns * 0.24)),
  );
  const valueWidth = Math.max(0, columns - labelWidth - 8);
  const isContextUsage = detail?.type === 'context';

  return (
    <Box flexDirection="column" flexShrink={0} width="100%" height={fillHeight ? '100%' : undefined}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.promptBorder}
        paddingX={1}
        width="100%"
        height={fillHeight ? '100%' : undefined}
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>Esc back</Text>
        </Box>
        {isContextUsage ? (
          <ContextUsageView detail={detail} columns={columns} />
        ) : (
          safeRows.map((row) => (
            <Box key={row.value || row.label} flexDirection="row" width="100%">
              <Text color={theme.inactive}>{padCells(truncateText(row.label, labelWidth), labelWidth)}</Text>
              <Text color={theme.text}>
                {'  '}
                {truncateText(row.description, valueWidth)}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
