/**
 * components/UsagePanel.jsx - global provider quota / balance dashboard.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.mjs';
import { terminalSafeText } from '../safe-text.mjs';

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function truncate(value, width) {
  const text = terminalSafeText(value || '');
  if (!(width > 0)) return '';
  if (text.length <= width) return text;
  return width <= 3 ? '.'.repeat(Math.max(0, width)) : `${text.slice(0, Math.max(1, width - 3))}...`;
}

function age(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return 'cache';
  const ms = Math.max(0, Date.now() - at);
  if (ms < 1000) return 'now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function toneColor(tone) {
  switch (tone) {
    case 'danger':
    case 'error': return theme.error;
    case 'warn': return theme.warning;
    case 'ok': return theme.success;
    case 'missing': return theme.inactive;
    case 'local': return theme.statusSubtle;
    default: return theme.text;
  }
}

function statusGlyph(row) {
  switch (row?.status) {
    case 'ok': return '*';
    case 'estimated': return '~';
    case 'partial': return '~';
    case 'error': return 'x';
    case 'missing': return 'o';
    case 'local': return '*';
    default: return 'o';
  }
}

function SummaryBadge({ label, value, color = theme.text }) {
  return (
    <Box flexDirection="row" marginRight={3}>
      <Text color={theme.inactive}>{label} </Text>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

export function UsagePanel({ dashboard, loading = false, columns = 80 }) {
  const isLoading = loading || dashboard?.loading === true;
  const rows = Array.isArray(dashboard?.rows) ? dashboard.rows : [];
  const total = dashboard?.total || {};
  const providerWidth = Math.min(18, Math.max(10, Math.floor(columns * 0.18)));
  const amountWidth = Math.min(28, Math.max(16, Math.floor(columns * 0.26)));
  const sourceWidth = Math.min(14, Math.max(8, Math.floor(columns * 0.13)));
  const detailWidth = Math.max(10, columns - providerWidth - amountWidth - sourceWidth - 18);

  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.promptBorder}
        paddingX={1}
        width="100%"
      >
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={theme.panelTitle}>Usage - Total Provider Quota</Text>
          <Text color={theme.subtle}>{isLoading ? 'checking...' : 'Esc close - /usage refresh'}</Text>
        </Box>

        {isLoading ? (
          <Box marginBottom={1}><Text color={theme.statusSubtle}>Checking configured providers...</Text></Box>
        ) : (
          <>
            <Box flexDirection="row" marginBottom={1} flexWrap="wrap">
              <SummaryBadge label="Known" value={`${money(total.knownRemainingUsd)} left`} color={theme.success} />
              <SummaryBadge label="API" value={money(total.apiVerifiedRemainingUsd)} color={theme.text} />
              <SummaryBadge label="Local" value={money(total.localEstimatedRemainingUsd)} color={theme.warning} />
              <SummaryBadge label="Hidden" value={String(total.hiddenCount || 0)} color={theme.inactive} />
              <SummaryBadge label="Errors" value={String(total.errorCount || 0)} color={(total.errorCount || 0) ? theme.error : theme.inactive} />
            </Box>

            <Box flexDirection="row" marginBottom={0}>
              <Text color={theme.inactive}>{'  '}{'Provider'.padEnd(providerWidth)}</Text>
              <Text color={theme.inactive}>{'Balance / quota'.padEnd(amountWidth)}</Text>
              <Text color={theme.inactive}>{'Source'.padEnd(sourceWidth)}</Text>
              <Text color={theme.inactive}>Detail</Text>
            </Box>

            {rows.map((row) => {
              const color = toneColor(row.tone || row.status);
              const provider = truncate(row.label || row.id, providerWidth).padEnd(providerWidth);
              const primary = truncate(row.primary || 'hidden', amountWidth).padEnd(amountWidth);
              const source = truncate(row.sourceLabel || row.source || '', sourceWidth).padEnd(sourceWidth);
              const updated = row.updatedAt ? ` - ${age(row.updatedAt)} ago` : '';
              const detail = truncate(`${row.detail || ''}${updated}`, detailWidth);
              return (
                <Box key={row.id} flexDirection="row" width="100%">
                  <Text color={color}>{statusGlyph(row)} </Text>
                  <Text color={theme.text}>{provider}</Text>
                  <Text color={color}>{primary}</Text>
                  <Text color={theme.statusSubtle}>{source}</Text>
                  <Text color={theme.subtle}>{detail}</Text>
                </Box>
              );
            })}

            {rows.length === 0 ? (
              <Box marginTop={1}><Text color={theme.inactive}>No providers configured.</Text></Box>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}
