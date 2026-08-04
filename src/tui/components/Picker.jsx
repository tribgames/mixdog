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
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import { ConfirmBar, clampConfirmFocus } from './ConfirmBar.jsx';

/** Max items visible at once before scrolling kicks in. */
const MAX_VISIBLE = 8;
const DEFAULT_LABEL_WIDTH = 28;
const SELECT_HELP = '↑/↓ Select · Enter Choose · Esc Back';
const ADJUST_HELP = '↑/↓ Select · ←/→ Adjust · Enter Choose · Esc Back';
const CONFIRM_HELP = '↑/↓ Select · ←/→ Back/Next · Enter Choose · Esc Skip';

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
  onKey,
  onHighlight,
  title,
  description = '',
  footer = '',
  help,
  columns = 80,
  labelWidth: labelWidthOverride = null,
  metaWidth: metaWidthOverride = null,
  footerGapRows = 1,
  initialIndex = null,
  indexMode = 'auto',
  fillHeight = false,
  visibleCount = MAX_VISIBLE,
  // Onboarding confirm bar: { buttons:[{value,label}], onConfirm(button,index) }.
  // When present, ←/→ and Tab drive button focus (mutually exclusive with
  // onLeft/onRight), and Enter fires onConfirm while a button is focused.
  confirmBar = null,
  // Memo-busting epoch: ItemRow is React.memo and reads theme.* directly, so a
  // live /theme switch (or picker preview) must re-render every row. Threading
  // the epoch into each ItemRow breaks its shallow-equality on a theme change.
  themeEpoch = 0,
}) {
  const visibleLimit = Math.max(1, Math.floor(Number(visibleCount) || MAX_VISIBLE));
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, Math.min(Number(initialIndex) || 0, Math.max(0, items.length - 1))));
  const confirmButtons = Array.isArray(confirmBar?.buttons) ? confirmBar.buttons.filter(Boolean) : [];
  const hasConfirm = confirmButtons.length > 0;
  // -1 = list focus; 0..n-1 = confirm-bar button focus.
  const [confirmFocus, setConfirmFocus] = useState(-1);
  const lastTabAtRef = useRef(0);
  useEffect(() => {
    // Reset to list focus whenever the bar identity/shape changes (step switch).
    setConfirmFocus(-1);
  }, [confirmButtons.length, confirmBar]);

  // Selection stability across owner-driven reopens: command pickers
  // (settings/hooks/skills/channels toggles) rebuild their item list and call
  // setPicker() again on every ←/→ toggle. Follow the previously selected
  // item's `value` into the new list instead of snapping back to row 0.
  // (useState-backed ref: mutation must never trigger a re-render.)
  const [selectionMemo] = useState(() => ({ value: null, initialIndex }));
  useEffect(() => {
    const item = items[selectedIndex];
    if (item && item.value != null) selectionMemo.value = item.value;
  }, [items, selectedIndex, selectionMemo]);

  useEffect(() => {
    setSelectedIndex((i) => {
      if (selectionMemo.value != null) {
        const found = items.findIndex((entry) => entry && entry.value === selectionMemo.value);
        if (found >= 0) return found;
        // Previous selection no longer exists — this is a different picker
        // (or the row was removed). Start from the owner's initialIndex/top
        // instead of carrying a stale row number across picker transitions.
        selectionMemo.value = null;
        return Math.max(0, Math.min(Number(initialIndex) || 0, Math.max(0, items.length - 1)));
      }
      return Math.min(Math.max(0, i), Math.max(0, items.length - 1));
    });
  }, [items, selectionMemo, initialIndex]);

  useEffect(() => {
    // Explicit highlight target: honor initialIndex only when the owner
    // actually provides a *new* one. A reopen that drops initialIndex
    // (prop -> null default) must not reset the user's position to row 0.
    if (initialIndex == null) { selectionMemo.initialIndex = null; return; }
    if (selectionMemo.initialIndex === initialIndex) return;
    selectionMemo.initialIndex = initialIndex;
    setSelectedIndex(Math.max(0, Math.min(Number(initialIndex) || 0, Math.max(0, items.length - 1))));
  }, [initialIndex, items.length, selectionMemo]);

  // Live-preview hook: notify the owner whenever the highlighted row changes
  // (arrow keys, paging, initial mount). The /theme picker uses this to apply a
  // non-persisted palette preview as the selection moves. Kept side-effect-free
  // for pickers that do not pass onHighlight.
  useEffect(() => {
    if (typeof onHighlight !== 'function') return;
    const item = items[selectedIndex];
    if (item) onHighlight(item.value, item, selectedIndex);
  }, [onHighlight, items, selectedIndex]);

  const activeFooter = typeof footer === 'function' ? footer(items[selectedIndex], selectedIndex) : footer;
  const confirmInlineWidth = hasConfirm
    ? confirmButtons.reduce((sum, button, index) => sum + (index > 0 ? 1 : 0) + stringWidth(`[ ${button?.label || ''} ]`) + 2, 0)
    : 0;
  const footerLines = normalizeFooterLines(activeFooter, Math.max(0, columns - (hasConfirm ? confirmInlineWidth + 1 : 0)));
  const footerGap = footerLines.length > 0 ? Math.max(0, Math.floor(Number(footerGapRows) || 0)) : 0;
  const footerReserveRows = footerLines.length > 0 ? footerLines.length + footerGap : 0;
  const confirmReserveRows = hasConfirm && footerLines.length === 0 ? 2 : 0;
  const effectiveVisibleLimit = Math.max(1, visibleLimit - footerReserveRows - confirmReserveRows);
  const helpText = help || (hasConfirm ? CONFIRM_HELP : (onLeft || onRight || onTab ? ADJUST_HELP : SELECT_HELP));

  useInput(
    useCallback(
      (input, key) => {
        if (key.upArrow) {
          // Single vertical loop over [list items...] + [confirm buttons...].
          if (hasConfirm) {
            const last = items.length - 1;
            if (confirmFocus > 0) { setConfirmFocus((f) => f - 1); return; }
            if (confirmFocus === 0) { setConfirmFocus(-1); setSelectedIndex(Math.max(0, last)); return; }
            // list focus: first row ↑ → last confirm button.
            if (items.length === 0 || selectedIndex === 0) { setConfirmFocus(confirmButtons.length - 1); return; }
            setSelectedIndex((i) => i - 1);
            return;
          }
          setSelectedIndex((i) => {
            const total = items.length;
            return total > 0 ? (i - 1 + total) % total : 0;
          });
          return;
        }
        if (key.downArrow) {
          if (hasConfirm) {
            const last = items.length - 1;
            const lastBtn = confirmButtons.length - 1;
            if (confirmFocus >= 0) {
              if (confirmFocus < lastBtn) { setConfirmFocus((f) => f + 1); return; }
              // last button ↓ → first list row.
              setConfirmFocus(-1); setSelectedIndex(0); return;
            }
            // list focus: last row ↓ → first confirm button.
            if (items.length === 0 || selectedIndex === last) { setConfirmFocus(0); return; }
            setSelectedIndex((i) => i + 1);
            return;
          }
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
          if (hasConfirm) {
            setConfirmFocus((f) => (f <= 0 ? -1 : f - 1));
            return;
          }
          if (onLeft) onLeft(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.rightArrow) {
          if (hasConfirm) {
            setConfirmFocus((f) => (f < 0 ? 0 : Math.min(confirmButtons.length - 1, f + 1)));
            return;
          }
          if (onRight) onRight(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.tab || input === '\t') {
          const now = Date.now();
          if (now - lastTabAtRef.current < 120) return;
          lastTabAtRef.current = now;
          if (hasConfirm) {
            setConfirmFocus((f) => (f < 0 ? 0 : (f + 1 > confirmButtons.length - 1 ? -1 : f + 1)));
            return;
          }
          if (onTab) onTab(items[selectedIndex], selectedIndex);
          return;
        }
        if (key.return) {
          if (hasConfirm && confirmFocus >= 0) {
            const button = confirmButtons[confirmFocus];
            if (button && confirmBar?.onConfirm) confirmBar.onConfirm(button, confirmFocus);
            return;
          }
          const selected = items[selectedIndex];
          if (selected && onSelect) onSelect(selected.value, selected);
          return;
        }
        if (key.escape) {
          onCancel();
          return;
        }
        if (key.ctrl && (input === 'c' || input === 'C')) {
          return;
        }
        if (onKey) {
          onKey(input, key, items[selectedIndex], selectedIndex);
          return;
        }
      },
      [items, selectedIndex, onSelect, onCancel, onLeft, onRight, onTab, onKey, effectiveVisibleLimit, hasConfirm, confirmFocus, confirmButtons, confirmBar],
    ),
  );

  // Clamp selected index when items change length.
  if (items.length === 0) {
    const emptyLine = truncateText(String(description || '').replace(/\s+/g, ' ').trim(), Math.max(0, columns - 4));
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
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={theme.panelTitle}>{title || 'Picker'}</Text>
            <Text color={theme.subtle}>{helpText}</Text>
          </Box>
          {/* Standard rhythm: title, blank, description/hint (blank if none),
              blank, then the (empty) content row. */}
          <Text> </Text>
          <Text color={theme.text}>{emptyLine || ' '}</Text>
          <Text> </Text>
          <Text color={theme.inactive}>(empty)</Text>
          {hasConfirm ? (
            <>
              <Box flexGrow={1} />
              <Text> </Text>
              <ConfirmBar buttons={confirmButtons} focusedIndex={clampConfirmFocus(confirmFocus, confirmButtons.length)} />
            </>
          ) : null}
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
  // Standard panel rhythm: title row, blank, description/hint row, blank,
  // content. Description newlines are collapsed and width-truncated to a single
  // line so a multi-line description (e.g. ToolApproval) cannot push the title
  // off the top. The slot is always reserved so panel chrome is a constant 6
  // rows (title + blank + desc + blank + 2 border), matching PICKER_CHROME_ROWS.
  const panelDescription = truncateText(String(description || '').replace(/\s+/g, ' ').trim(), Math.max(0, columns - 4));

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
        <Box flexDirection="row" justifyContent="space-between">
          <Text color={theme.panelTitle}>{title}</Text>
          <Text color={theme.subtle}>{helpText}</Text>
        </Box>
        <Text> </Text>
        <Text color={theme.text}>{panelDescription || ' '}</Text>
        <Text> </Text>
        {visible.map((item, i) => {
          const idx = start + i;
          const isSelected = idx === selectedIndex && confirmFocus < 0;
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
              themeEpoch={themeEpoch}
            />
          );
        })}
        {footerLines.length > 0 ? (
          <>
            <Box flexGrow={1} />
            {footerLines.map((line, index) => {
              const attachConfirm = hasConfirm && index === footerLines.length - 1;
              return (
                <Box
                  key={`footer-${index}`}
                  flexDirection="row"
                  width="100%"
                  justifyContent={attachConfirm ? 'space-between' : 'flex-start'}
                  alignItems="center"
                >
                  <Text>
                    {line.glyph ? <Text color={line.color}>{line.glyph} </Text> : null}
                    <Text color={theme.text}>{line.text}</Text>
                  </Text>
                  {attachConfirm ? (
                    <ConfirmBar buttons={confirmButtons} focusedIndex={clampConfirmFocus(confirmFocus, confirmButtons.length)} />
                  ) : null}
                </Box>
              );
            })}
          </>
        ) : null}
        {hasConfirm && footerLines.length === 0 ? (
          <>
            <Box flexGrow={1} />
            <Text> </Text>
            <ConfirmBar buttons={confirmButtons} focusedIndex={clampConfirmFocus(confirmFocus, confirmButtons.length)} />
          </>
        ) : null}
      </Box>
    </Box>
  );
}

const ItemRow = React.memo(function ItemRow({ indexText, indexWidth, marker, markerColor, markerWidth, label, labelSuffix, labelSuffixColor, meta, metaParts, description, labelWidth, metaWidth, descriptionWidth, showMeta, isSelected, themeEpoch = 0 }) {
  const rowText = isSelected ? theme.selectionText : theme.text;
  const rowIndexColor = isSelected ? theme.selectionText : theme.subtle;
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
    <Box flexDirection="row" width="100%" backgroundColor={isSelected ? theme.selectionBackground : undefined}>
      {indexWidth > 0 ? (
        <Text color={rowIndexColor}>
          {padCells(indexText, indexWidth)}{' '}
        </Text>
      ) : null}
      {markerWidth > 0 ? (
        <Text color={isSelected ? theme.selectionText : (marker ? (markerColor || theme.success) : rowText)}>
          {padCells(displayMarker, markerWidth)}
        </Text>
      ) : null}
      <Text color={rowText}>{displayLabel}</Text>
      {suffix ? (
        <Text color={isSelected ? theme.selectionText : (labelSuffixColor || theme.success)}>
          {suffixGap}{suffix}
        </Text>
      ) : null}
      <Text color={rowText}>{labelPadding}</Text>
      {showMeta ? (
        <Text color={rowText}>
          {'  '}
          {parts
            ? padCells(parts.map((part) => padCells(truncateText(part?.text || '', Number(part?.width) || 1), Number(part?.width) || 1)).join('  '), metaWidth)
            : padCells(displayMeta, metaWidth)}
        </Text>
      ) : null}
      {displayDescription ? (
        <Text color={rowText}>
          {'  '}
          {displayDescription}
        </Text>
      ) : null}
    </Box>
  );
});
