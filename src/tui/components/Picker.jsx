/**
 * components/Picker.jsx — selectable list picker for slash commands.
 *
 * Renders a bordered, scrollable list of items with up/down navigation,
 * Enter confirms and Escape backs out. Used by /model and /resume to let the
 * user pick from available presets or saved sessions.
 *
 * Keyboard:
 *   ↑ / ↓      — move selection (wraps at ends)
 *   ← / →      — optional picker-specific adjustment
 *   Tab         — optional picker-specific toggle
 *   Enter       — choose/apply the selected row
 *   Escape      — back/cancel
 *   Ctrl+C      — handled globally for selection copy
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';

/** Max items visible at once before scrolling kicks in. */
const MAX_VISIBLE = 8;
const DEFAULT_LABEL_WIDTH = 28;
const SELECT_HELP = '↑/↓ Select · Enter Choose · Esc Back';
const ADJUST_HELP = '↑/↓ Select · ←/→ Adjust · Enter Choose · Esc Back';

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
  const gap = Math.max(0, width - stringWidth(text));
  return `${text}${' '.repeat(gap)}`;
}

function clampLabelWidth(value, columns) {
  const maxWidth = Math.max(12, Math.floor(columns * 0.45));
  return Math.max(1, Math.min(Number(value) || DEFAULT_LABEL_WIDTH, maxWidth));
}

function clampMetaWidth(value, columns, labelWidth) {
  const available = Math.max(0, columns - labelWidth - 16);
  const requested = Number(value) || 24;
  return Math.max(0, Math.min(requested, available));
}

function normalizeFooterLines(activeFooter, columns) {
  const rawLines = Array.isArray(activeFooter)
    ? activeFooter
    : (activeFooter ? [activeFooter] : []);
  return rawLines.map((line) => {
    const isObject = line && typeof line === 'object';
    const glyph = isObject ? String(line.glyph || '') : '';
    const color = isObject ? line.color || theme.panelTitle : theme.text;
    const text = isObject ? String(line.text || '') : String(line || '');
    return {
      glyph,
      color,
      text: truncateText(text, Math.max(0, columns - (glyph ? 7 : 4))),
    };
  }).filter((line) => line.glyph || line.text);
}

export function Picker({
  items,
  onSelect,
  onCancel,
  onLeft,
  onRight,
  onTab,
  title,
  description = '',
  footer = '',
  help,
  columns = 80,
  labelWidth: labelWidthOverride = null,
  metaWidth: metaWidthOverride = null,
  footerGapRows = 1,
  initialIndex = 0,
  indexMode = 'auto',
  fillHeight = false,
  visibleCount = MAX_VISIBLE,
}) {
  const visibleLimit = Math.max(1, Math.floor(Number(visibleCount) || MAX_VISIBLE));
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, Math.min(Number(initialIndex) || 0, Math.max(0, items.length - 1))));

  useEffect(() => {
    setSelectedIndex((i) => Math.min(Math.max(0, i), Math.max(0, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    setSelectedIndex(Math.max(0, Math.min(Number(initialIndex) || 0, Math.max(0, items.length - 1))));
  }, [initialIndex, items.length]);

  const activeFooter = typeof footer === 'function' ? footer(items[selectedIndex], selectedIndex) : footer;
  const footerLines = normalizeFooterLines(activeFooter, columns);
  const footerGap = footerLines.length > 0 ? Math.max(0, Math.floor(Number(footerGapRows) || 0)) : 0;
  const footerReserveRows = footerLines.length > 0 ? footerLines.length + footerGap : 0;
  const effectiveVisibleLimit = Math.max(1, visibleLimit - footerReserveRows);
  const helpText = help || (onLeft || onRight || onTab ? ADJUST_HELP : SELECT_HELP);

  useInput(
    useCallback(
      (input, key) => {
        if (key.upArrow) {
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i - 1 + total) % total : 0;
          });
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i + 1) % total : 0;
          });
          return;
        }
        if (key.pageUp) {
          setSelectedIndex((i) => Math.max(0, i - effectiveVisibleLimit));
          return;
        }
        if (key.pageDown) {
          setSelectedIndex((i) => Math.min(items.length - 1, i + effectiveVisibleLimit));
          return;
        }
        if (key.home) {
          setSelectedIndex(0);
          return;
        }
        if (key.end) {
          setSelectedIndex(items.length - 1);
          return;
        }
        if (key.leftArrow) {
          if (onLeft) onLeft(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.rightArrow) {
          if (onRight) onRight(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.tab || input === '\t') {
          if (onTab) onTab(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.return) {
          const selected = items[selectedIndex];
          if (selected && onSelect) onSelect(selected.value, selected);
          return;
        }
        if (key.escape) {
          onCancel();
          return;
        }
      },
      [items, selectedIndex, onSelect, onCancel, onLeft, onRight, onTab, effectiveVisibleLimit],
    ),
  );

  // Clamp selected index when items change length.
  if (items.length === 0) {
    const emptyDescription = truncateText(description, Math.max(0, columns - 4));
    return (
      <Box flexDirection="column" flexShrink={0} height={fillHeight ? '100%' : undefined}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.promptBorder}
          paddingX={1}
          height={fillHeight ? '100%' : undefined}
          width="100%"
        >
          <Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
            <Text color={theme.panelTitle}>{title || 'Picker'}</Text>
            <Text color={theme.subtle}>{helpText}</Text>
          </Box>
          {emptyDescription ? (
            <>
              <Text> </Text>
              <Text color={theme.text}>{emptyDescription}</Text>
              <Text> </Text>
            </>
          ) : (
            <>
              <Text> </Text>
              <Text color={theme.inactive}>(empty)</Text>
            </>
          )}
        </Box>
      </Box>
    );
  }

  // Scroll window centered on the selected item.
  const total = items.length;
  const half = Math.floor(effectiveVisibleLimit / 2);
  let start = Math.max(0, selectedIndex - half);
  let end = Math.min(total, start + effectiveVisibleLimit);
  if (end - start < effectiveVisibleLimit && start > 0) {
    start = Math.max(0, end - effectiveVisibleLimit);
  }
  const visible = items.slice(start, end);
  const showIndex = indexMode === 'always'
    ? total > 0
    : indexMode === 'never'
      ? false
      : total > effectiveVisibleLimit;
  const indexWidth = showIndex ? stringWidth(`${total}.`) : 0;
  const indexOffset = showIndex ? indexWidth + 1 : 0;

  // Keep the label column fixed across menus. Per-picker overrides are still
  // allowed for intentionally compact surfaces such as providers/resume.
  const labelWidth = clampLabelWidth(labelWidthOverride ?? DEFAULT_LABEL_WIDTH, columns);
  const hasMarker = items.some((item) => item.marker || item.checked === true || item.checked === false);
  const markerWidth = hasMarker ? 2 : 0;
  const hasMeta = metaWidthOverride != null || items.some((item) => item.meta || item.modelProfile || item.metaParts);
  const metaWidth = hasMeta ? clampMetaWidth(metaWidthOverride, columns, labelWidth) : 0;
  const descriptionWidth = Math.max(0, columns - indexOffset - markerWidth - labelWidth - (hasMeta ? metaWidth + 14 : 12));
  const panelDescription = truncateText(description, Math.max(0, columns - 4));

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
        <Box flexDirection="row" justifyContent="space-between" marginBottom={panelDescription ? 0 : 1}>
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>{helpText}</Text>
        </Box>
        {panelDescription ? (
          <>
            <Text> </Text>
            <Text color={theme.text}>{panelDescription}</Text>
            <Text> </Text>
          </>
        ) : null}
        {visible.map((item, i) => {
          const idx = start + i;
          const isSelected = idx === selectedIndex;
          return (
            <ItemRow
              key={item.value}
              indexText={showIndex ? `${idx + 1}.` : ''}
              indexWidth={indexWidth}
              marker={item.marker || (item.checked === true ? '✓' : item.checked === false ? ' ' : '')}
              markerColor={item.markerColor}
              markerWidth={markerWidth}
              label={item.label}
              labelSuffix={item.labelSuffix}
              labelSuffixColor={item.labelSuffixColor}
              meta={item.meta || item.modelProfile || ''}
              metaParts={item.metaParts}
              description={item.description}
              labelWidth={labelWidth}
              metaWidth={metaWidth}
              descriptionWidth={descriptionWidth}
              showMeta={hasMeta}
              isSelected={isSelected}
            />
          );
        })}
        {footerLines.length > 0 ? (
          <>
            <Box flexGrow={1} />
            {footerLines.map((line, index) => (
              <Text key={`footer-${index}`}>
                {line.glyph ? <Text color={line.color}>{line.glyph} </Text> : null}
                <Text color={theme.text}>{line.text}</Text>
              </Text>
            ))}
          </>
        ) : null}
      </Box>
    </Box>
  );
}

const ItemRow = React.memo(function ItemRow({ indexText, indexWidth, marker, markerColor, markerWidth, label, labelSuffix, labelSuffixColor, meta, metaParts, description, labelWidth, metaWidth, descriptionWidth, showMeta, isSelected }) {
  const rawSuffix = String(labelSuffix || '');
  const suffix = rawSuffix ? truncateText(rawSuffix, labelWidth) : '';
  const suffixGap = suffix && stringWidth(suffix) < labelWidth ? ' ' : '';
  const suffixWidth = suffix ? stringWidth(suffixGap) + stringWidth(suffix) : 0;
  const displayMarker = truncateText(marker, markerWidth);
  const displayLabel = truncateText(label, Math.max(0, labelWidth - suffixWidth));
  const labelPadding = ' '.repeat(Math.max(0, labelWidth - stringWidth(displayLabel) - suffixWidth));
  const displayMeta = truncateText(meta, metaWidth);
  const displayDescription = truncateText(description, descriptionWidth);
  const parts = Array.isArray(metaParts) ? metaParts : null;

  return (
    <Box flexDirection="row" width="100%" backgroundColor={isSelected ? theme.userMessageBackground : undefined}>
      {indexWidth > 0 ? (
        <Text color={theme.subtle}>
          {padCells(indexText, indexWidth)}{' '}
        </Text>
      ) : null}
      {markerWidth > 0 ? (
        <Text color={marker ? (markerColor || theme.success) : theme.text}>
          {padCells(displayMarker, markerWidth)}
        </Text>
      ) : null}
      <Text color={theme.text}>{displayLabel}</Text>
      {suffix ? <Text color={labelSuffixColor || theme.success}>{suffixGap}{suffix}</Text> : null}
      <Text color={theme.text}>{labelPadding}</Text>
      {showMeta ? (
        <Text color={theme.text}>
          {'  '}
          {parts
            ? padCells(parts.map((part) => padCells(truncateText(part?.text || '', Number(part?.width) || 1), Number(part?.width) || 1)).join('  '), metaWidth)
            : padCells(displayMeta, metaWidth)}
        </Text>
      ) : null}
      {displayDescription ? (
        <Text color={theme.text}>
          {'  '}
          {displayDescription}
        </Text>
      ) : null}
    </Box>
  );
});
