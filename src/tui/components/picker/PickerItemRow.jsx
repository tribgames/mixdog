/*
 * components/picker/PickerItemRow.jsx — one memoized Picker list row.
 */
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../../theme.mjs';
import { truncatePanelText as truncateText, padPanelCells as padCells } from '../panel-cell-text.mjs';

export const PickerItemRow = React.memo(function PickerItemRow({
  indexText,
  indexWidth,
  marker,
  markerColor,
  markerWidth,
  label,
  labelSuffix,
  labelSuffixColor,
  meta,
  metaParts,
  description,
  labelWidth,
  metaWidth,
  descriptionWidth,
  showMeta,
  isSelected,
  themeEpoch: _themeEpoch = 0,
}) {
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
  let rowMarkerColor = rowText;
  if (markerWidth > 0) {
    if (isSelected) rowMarkerColor = theme.selectionText;
    else if (marker) rowMarkerColor = markerColor || theme.success;
  }
  const suffixColor = isSelected ? theme.selectionText : labelSuffixColor || theme.success;
  let metaText = '';
  if (showMeta) {
    metaText = parts
      ? padCells(
          parts
            .map((part) => padCells(truncateText(part?.text || '', Number(part?.width) || 1), Number(part?.width) || 1))
            .join('  '),
          metaWidth
        )
      : padCells(displayMeta, metaWidth);
  }

  return (
    <Box flexDirection="row" width="100%" backgroundColor={isSelected ? theme.selectionBackground : undefined}>
      {indexWidth > 0 ? <Text color={rowIndexColor}>{padCells(indexText, indexWidth)} </Text> : null}
      {markerWidth > 0 ? <Text color={rowMarkerColor}>{padCells(displayMarker, markerWidth)}</Text> : null}
      <Text color={rowText}>{displayLabel}</Text>
      {suffix ? (
        <Text color={suffixColor}>
          {suffixGap}
          {suffix}
        </Text>
      ) : null}
      <Text color={rowText}>{labelPadding}</Text>
      {showMeta ? (
        <Text color={rowText}>
          {'  '}
          {metaText}
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
