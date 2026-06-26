/**
 * components/UsagePanel.jsx - global provider quota / balance dashboard.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';

const PROVIDER_LABEL_WIDTH = 28;
const CREDIT_LABEL = 'Credit';
const STATUS_SEPARATOR = ' │ ';

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (n === 0) return '$0';
  if (n >= 10) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function truncate(value, width) {
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

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  if (Math.abs(n) >= 10) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function resetLabel(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const now = Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (at - now < 24 * 60 * 60_000) return time;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function isLocalEstimateWindow(w) {
  const source = String(w?.source || '').trim().toLowerCase();
  return !source || source.includes('local') || source.includes('config');
}

function hasFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function pctColor(value) {
  const pct = Number(value);
  if (!Number.isFinite(pct)) return theme.text;
  if (pct >= 95) return theme.error;
  if (pct >= 80) return theme.warning;
  return theme.success;
}

function remainingUsdColor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return theme.text;
  if (n <= 1) return theme.error;
  if (n <= 5) return theme.warning;
  return theme.success;
}

function creditsColor(w) {
  if (hasFiniteNumber(w?.usedPct)) return pctColor(w.usedPct);
  return theme.success;
}

function windowResetText(w) {
  if (isLocalEstimateWindow(w)) return '';
  const reset = resetLabel(w?.resetAt);
  if (!reset) return '';
  return `↻ ${reset}`;
}

function windowValue(w) {
  const estimated = isLocalEstimateWindow(w);
  const remainingUsd = Number(w?.remainingUsd);
  const usedUsd = Number(w?.usedUsd);
  const limitUsd = Number(w?.limitUsd);
  const remainingCredits = Number(w?.remainingCredits);
  const usedCredits = Number(w?.usedCredits);
  const limitCredits = Number(w?.limitCredits);
  const usedPct = Number(w?.usedPct);
  const prefix = estimated ? 'est ' : '';
  if (hasFiniteNumber(w?.remainingUsd)) {
    return { text: `${prefix}${money(remainingUsd)}`, color: estimated ? theme.warning : remainingUsdColor(remainingUsd) };
  }
  if (hasFiniteNumber(w?.usedUsd) && hasFiniteNumber(w?.limitUsd)) {
    return { text: `${prefix}${money(usedUsd)}/${money(limitUsd)}`, color: estimated ? theme.warning : theme.success };
  }
  if (hasFiniteNumber(w?.remainingCredits) && hasFiniteNumber(w?.limitCredits)) {
    return { text: `${prefix}${compactNumber(remainingCredits)}/${compactNumber(limitCredits)}`, color: estimated ? theme.warning : creditsColor(w) };
  }
  if (hasFiniteNumber(w?.remainingCredits)) {
    return { text: `${prefix}${compactNumber(remainingCredits)}`, color: estimated ? theme.warning : creditsColor(w) };
  }
  if (hasFiniteNumber(w?.usedCredits) && hasFiniteNumber(w?.limitCredits)) {
    return { text: `${prefix}${compactNumber(usedCredits)}/${compactNumber(limitCredits)}`, color: estimated ? theme.warning : creditsColor(w) };
  }
  if (hasFiniteNumber(w?.usedPct)) {
    return { text: `${prefix}${Math.round(usedPct)}%`, color: estimated ? theme.warning : pctColor(usedPct) };
  }
  return { text: '', color: theme.subtle };
}

function pushStatusSeparator(parts) {
  if (parts.length) parts.push({ text: STATUS_SEPARATOR, color: theme.inactive });
}

function windowSegmentParts(w) {
  const label = String(w?.label || 'USE').toUpperCase();
  const value = windowValue(w);
  const reset = windowResetText(w);
  const parts = [];
  parts.push({ text: label, color: theme.subtle });
  if (value.text) {
    parts.push({ text: ' ', color: theme.inactive });
    parts.push({ text: value.text, color: value.color });
  }
  if (reset) parts.push({ text: ` ${reset}`, color: theme.inactive });
  return parts;
}

function creditSegmentParts(value) {
  return [
    { text: CREDIT_LABEL, color: theme.subtle },
    { text: ' ', color: theme.inactive },
    { text: money(value), color: remainingUsdColor(value) },
  ];
}

function maxStatusWindows(columns = 80, statusWidth = 0, showCredit = false) {
  const reserveForCredit = showCredit ? 16 : 0;
  const available = Math.max(0, statusWidth - reserveForCredit);
  if (columns >= 120 && available >= 44) return 3;
  if (columns >= 80 && available >= 28) return 2;
  return 1;
}

function rowStatusParts(row, columns = 80, statusWidth = 0) {
  const windows = Array.isArray(row?.windows) ? row.windows : [];
  const parts = [];
  const hasCredit = hasFiniteNumber(row?.remainingUsd);
  const showCredit = hasCredit && (columns >= 80 || windows.length === 0);
  if (windows.length || showCredit) {
    const maxWindows = windows.length ? maxStatusWindows(columns, statusWidth, showCredit) : 0;
    const visibleWindows = windows.slice(0, maxWindows);
    for (const window of visibleWindows) {
      pushStatusSeparator(parts);
      parts.push(...windowSegmentParts(window));
    }
    if (showCredit) {
      pushStatusSeparator(parts);
      parts.push(...creditSegmentParts(row.remainingUsd));
    }
    return parts;
  }
  switch (row?.status) {
    case 'checking':
      return [{ text: 'checking...', color: theme.inactive }];
    case 'hidden':
      return row?.detail ? [{ text: row.detail, color: theme.inactive }] : [];
    case 'missing':
      return row?.primary && row.primary !== 'not configured' ? [{ text: row.primary, color: theme.inactive }] : [];
    case 'local':
      return row?.primary ? [{ text: row.primary, color: theme.inactive }] : [];
    case 'error':
      return row?.primary ? [{ text: row.primary, color: theme.error }] : [];
    default:
      return row?.primary ? [{ text: row.primary, color: theme.text }] : [];
  }
}

function fitParts(parts, width) {
  if (!(width > 0)) return [];
  const out = [];
  let used = 0;
  for (const part of parts || []) {
    const text = String(part?.text || '');
    if (!text) continue;
    const remaining = width - used;
    if (remaining <= 0) break;
    const w = stringWidth(text);
    if (w <= remaining) {
      out.push(part);
      used += w;
    } else {
      if (/^\s+$/.test(text)) {
        out.push({ ...part, text: ' '.repeat(remaining) });
        break;
      }
      const clipped = truncate(text, remaining);
      if (clipped) out.push({ ...part, text: clipped });
      break;
    }
  }
  return out;
}

export function UsagePanel({ dashboard, loading = false, columns = 80, fillHeight = false, panelRows = 0 }) {
  const isLoading = loading || dashboard?.loading === true;
  const isChecking = dashboard?.checking === true;
  const rows = Array.isArray(dashboard?.rows) ? dashboard.rows : [];
  const indexWidth = rows.length > 0 ? stringWidth(`${rows.length}.`) : 0;
  const labelWidth = Math.max(12, Math.min(PROVIDER_LABEL_WIDTH, Math.max(12, Math.floor(columns * 0.45))));
  const statusWidth = Math.max(0, columns - indexWidth - labelWidth - 8);
  const panelTitle = dashboard?.title || 'Provider Quotas';
  const panelDescription = truncate(dashboard?.subtitle || 'Statusline-style provider quota windows.', Math.max(0, columns - 4));
  const hasMeasuredRows = Number(panelRows) > 0;
  const maxProviderRows = hasMeasuredRows ? Math.max(1, Math.floor(panelRows) - 6) : rows.length;
  const maxScrollOffset = Math.max(0, rows.length - maxProviderRows);
  const [scrollOffset, setScrollOffset] = useState(0);
  const visibleRows = hasMeasuredRows
    ? rows.slice(scrollOffset, scrollOffset + maxProviderRows)
    : rows;
  const scrollable = rows.length > maxProviderRows;
  const helpText = `${scrollable || isLoading || isChecking ? '↑/↓ Scroll · PgUp/PgDn Page · ' : ''}Esc Back · /usage refresh`;

  useEffect(() => {
    setScrollOffset((offset) => Math.min(Math.max(0, offset), maxScrollOffset));
  }, [maxScrollOffset]);

  useInput((input, key) => {
    if (isLoading || !scrollable) return;
    if (key.upArrow) {
      setScrollOffset((offset) => Math.max(0, offset - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((offset) => Math.min(maxScrollOffset, offset + 1));
      return;
    }
    if (key.pageUp) {
      setScrollOffset((offset) => Math.max(0, offset - maxProviderRows));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((offset) => Math.min(maxScrollOffset, offset + maxProviderRows));
      return;
    }
    if (key.home) {
      setScrollOffset(0);
      return;
    }
    if (key.end) {
      setScrollOffset(maxScrollOffset);
    }
  });

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
        <Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
          <Text color={theme.panelTitle}>{panelTitle}</Text>
          <Text color={theme.subtle}>{helpText}</Text>
        </Box>

        {(isLoading || isChecking) && rows.length === 0 ? (
          <>
            <Text> </Text>
            <Text color={theme.statusSubtle}>Checking providers...</Text>
            <Text> </Text>
          </>
        ) : (
          <>
            <Text> </Text>
            <Text color={theme.text}>{panelDescription}</Text>
            <Text> </Text>

            {visibleRows.map((row, idx) => {
              const provider = padCells(truncate(row.label || row.id, labelWidth), labelWidth);
              const index = padCells(`${scrollOffset + idx + 1}.`, indexWidth);
              const statusParts = fitParts(rowStatusParts(row, columns, statusWidth), statusWidth);
              return (
                <Box key={row.id} flexDirection="row" width="100%">
                  <Text color={theme.subtle}>{index}{indexWidth > 0 ? ' ' : ''}</Text>
                  <Text color={theme.text}>{provider}</Text>
                  <Text color={theme.inactive}>  </Text>
                  <Box flexDirection="row" width={statusWidth}>
                    {statusParts.map((part, partIdx) => (
                      part.color
                        ? <Text key={partIdx} color={part.color}>{part.text}</Text>
                        : <Text key={partIdx}>{part.text}</Text>
                    ))}
                  </Box>
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
