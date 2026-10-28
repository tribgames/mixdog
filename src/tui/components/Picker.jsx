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
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../theme.mjs';
import { ConfirmBar, clampConfirmFocus } from './ConfirmBar.jsx';
import { truncatePanelText as truncateText } from './panel-cell-text.mjs';
import { PickerItemRow } from './picker/PickerItemRow.jsx';
import { SignInUrl, signInUrlNote, useCopyUrl } from './SignInUrl.jsx';
import { signInUrlLayout } from './sign-in-url-layout.mjs';
import {
  ADJUST_HELP,
  CONFIRM_HELP,
  DEFAULT_LABEL_WIDTH,
  MAX_VISIBLE,
  SELECT_HELP,
  clampLabelWidth,
  clampMetaWidth,
  normalizeFooterLines,
} from './picker/picker-layout.mjs';
import { usePickerInput } from './picker/use-picker-input.mjs';
import { usePickerSelection } from './picker/use-picker-selection.mjs';

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
  // Optional sign-in URL, drawn complete and borderless under the panel (never
  // truncated like `description`); `c` copies it. `copyText` overrides the clipboard.
  detail = '',
  copyText,
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
  // Loading panels reserve the same content-row geometry as the real list.
  // This prevents an `(empty)` row from being replaced by a multi-row menu in
  // one commit, which reads as the option items jumping into place.
  loading = false,
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
  const confirmButtons = Array.isArray(confirmBar?.buttons) ? confirmBar.buttons.filter(Boolean) : [];
  const hasConfirm = confirmButtons.length > 0;
  const { selectedIndex, setSelectedIndex, confirmFocus, setConfirmFocus, lastTabAtRef } = usePickerSelection({
    items,
    initialIndex,
    onHighlight,
    confirmButtons,
    confirmBar,
  });

  const activeFooter = typeof footer === 'function' ? footer(items[selectedIndex], selectedIndex) : footer;
  const confirmInlineWidth = confirmButtons.reduce(
    (sum, button, index) => sum + (index > 0 ? 1 : 0) + stringWidth(`[ ${button?.label || ''} ]`) + 2,
    0
  );
  const footerLines = normalizeFooterLines(
    activeFooter,
    Math.max(0, columns - (hasConfirm ? confirmInlineWidth + 1 : 0))
  );
  const footerGap = footerLines.length > 0 ? Math.max(0, Math.floor(Number(footerGapRows) || 0)) : 0;
  const footerReserveRows = footerLines.length > 0 ? footerLines.length + footerGap : 0;
  const confirmReserveRows = hasConfirm && footerLines.length === 0 ? 2 : 0;
  const detailText = String(detail || '').trim();
  // The URL is drawn under the panel (no border). Its rows (wrapped URL + copy
  // hint) come out of the list so the total height is unchanged. It gets the
  // rows left beside up to two list rows (one, if that leaves nothing) and
  // degrades step by step (see sign-in-url-layout.mjs) until it fits.
  const rowsAfterChrome = visibleLimit - footerReserveRows - confirmReserveRows;
  const keptListRows = rowsAfterChrome - Math.min(items.length, 2) >= 1 ? Math.min(items.length, 2) : 1;
  const urlLayout = signInUrlLayout(detailText, columns, rowsAfterChrome - keptListRows);
  const detailRows = urlLayout.rows;
  const copyUrl = useCopyUrl(detailText, copyText);
  const handleKey = (input, key, item, index) => {
    if (detailText && input === 'c' && !key.ctrl && !key.meta) copyUrl.copy();
    else onKey?.(input, key, item, index);
  };
  const effectiveVisibleLimit = Math.max(1, visibleLimit - footerReserveRows - confirmReserveRows - detailRows);
  let helpText = help;
  if (!helpText) {
    if (hasConfirm) helpText = CONFIRM_HELP;
    else helpText = onLeft || onRight || onTab ? ADJUST_HELP : SELECT_HELP;
  }
  // One bar instance for every placement below (empty list, footer row, no-footer row).
  const confirmBarNode = hasConfirm ? (
    <ConfirmBar buttons={confirmButtons} focusedIndex={clampConfirmFocus(confirmFocus, confirmButtons.length)} />
  ) : null;

  usePickerInput({
    items,
    selectedIndex,
    setSelectedIndex,
    confirmFocus,
    setConfirmFocus,
    lastTabAtRef,
    onSelect,
    onCancel,
    onLeft,
    onRight,
    onTab,
    onKey: handleKey,
    effectiveVisibleLimit,
    hasConfirm,
    confirmButtons,
    confirmBar,
  });

  // Standard panel rhythm: title row, blank, description/hint row, blank,
  // content. Description newlines are collapsed and width-truncated to a single
  // line so a multi-line description (e.g. ToolApproval) cannot push the title
  // off the top. The slot is always reserved so panel chrome is a constant 6
  // rows (title + blank + desc + blank + 2 border), matching PICKER_CHROME_ROWS.
  // With no hint row under the URL, the description row carries the copy note.
  const panelDescription = truncateText(
    String(!urlLayout.hint && detailText ? signInUrlNote('c', copyUrl.status) : description || '')
      .replace(/\s+/g, ' ')
      .trim(),
    Math.max(0, columns - 4)
  );

  if (items.length === 0) {
    const loadingRows = loading
      ? Array.from({ length: visibleLimit }, (_, index) => (
          <Text key={`loading-${index}`} color={theme.inactive}>
            {' '}
          </Text>
        ))
      : null;
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
          <Text color={theme.text}>{panelDescription || ' '}</Text>
          <Text> </Text>
          {loading ? loadingRows : <Text color={theme.inactive}>(empty)</Text>}
          {hasConfirm ? (
            <>
              <Box flexGrow={1} />
              <Text> </Text>
              {confirmBarNode}
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
  const end = Math.min(total, start + effectiveVisibleLimit);
  if (end - start < effectiveVisibleLimit && start > 0) {
    start = Math.max(0, end - effectiveVisibleLimit);
  }
  const visible = items.slice(start, end);
  let showIndex = total > effectiveVisibleLimit;
  if (indexMode === 'always') showIndex = total > 0;
  else if (indexMode === 'never') showIndex = false;
  const indexWidth = showIndex ? stringWidth(`${total}.`) : 0;
  const indexOffset = showIndex ? indexWidth + 1 : 0;

  // Keep the label column fixed across menus. Per-picker overrides are still
  // allowed for intentionally compact surfaces such as providers/resume.
  const labelWidth = clampLabelWidth(labelWidthOverride ?? DEFAULT_LABEL_WIDTH, columns);
  const hasMarker = items.some((item) => item.marker || item.checked === true || item.checked === false);
  const markerWidth = hasMarker ? 2 : 0;
  const hasMeta = metaWidthOverride != null || items.some((item) => item.meta || item.modelProfile || item.metaParts);
  const metaWidth = hasMeta ? clampMetaWidth(metaWidthOverride, columns, labelWidth) : 0;
  const descriptionWidth = Math.max(
    0,
    columns - indexOffset - markerWidth - labelWidth - (hasMeta ? metaWidth + 14 : 12)
  );

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
          let marker = item.marker;
          if (!marker) {
            if (item.checked === true) marker = '✓';
            else marker = item.checked === false ? ' ' : '';
          }
          return (
            <PickerItemRow
              key={item.value}
              indexText={showIndex ? `${idx + 1}.` : ''}
              indexWidth={indexWidth}
              marker={marker}
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
        {footerLines.length > 0 && (
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
                  {attachConfirm ? confirmBarNode : null}
                </Box>
              );
            })}
          </>
        )}
        {hasConfirm && footerLines.length === 0 ? (
          <>
            <Box flexGrow={1} />
            <Text> </Text>
            {confirmBarNode}
          </>
        ) : null}
      </Box>
      <SignInUrl url={detailText} layout={urlLayout} copyKey="c" status={copyUrl.status} />
    </Box>
  );
}
