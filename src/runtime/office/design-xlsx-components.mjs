import { columnLabel, strings } from './design-tokens.mjs';


function mergedBlock(output, {
  sheet,
  startColumn,
  endColumn,
  row,
  value,
  properties,
}) {
  const start = columnLabel(startColumn);
  const end = columnLabel(endColumn);
  output.push({ op: 'set_cell', sheet, cell: `${start}${row}`, value: String(value || '') });
  if (endColumn > startColumn) {
    output.push({ op: 'merge_cells', sheet, range: `${start}${row}:${end}${row}` });
  }
  output.push({
    op: 'set_style',
    sheet,
    range: `${start}${row}:${end}${row}`,
    properties,
  });
}


function normalizedGates(value) {
  return (Array.isArray(value) ? value : []).map((entry) => {
    if (Array.isArray(entry)) return entry.slice(0, 3).map((cell) => String(cell ?? ''));
    if (!entry || typeof entry !== 'object') return [];
    return [
      String(entry.track || entry.label || entry.title || ''),
      String(entry.release || entry.go || ''),
      String(entry.stop || entry.hold || ''),
    ];
  }).filter((row) => row.length === 3 && row.some(Boolean));
}


export function addXlsxDecisionPanel(output, {
  sheet,
  row,
  startColumn = 1,
  columns,
  design,
  decision,
  gates,
  actions,
}) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const firstColumn = Math.max(1, Number(startColumn) || 1);
  const width = Math.max(6, Number(columns) || 6);
  const finalColumn = firstColumn + width - 1;
  const lastColumn = columnLabel(finalColumn);
  let cursor = row;
  mergedBlock(output, {
    sheet,
    startColumn: firstColumn,
    endColumn: finalColumn,
    row: cursor,
    value: 'DECISION WINDOW',
    properties: {
      fontName: type.data,
      fontSize: 10,
      bold: true,
      color: colors.onInverse,
      fillColor: colors.inverse,
      verticalAlignment: 'center',
    },
  });
  cursor += 1;
  mergedBlock(output, {
    sheet,
    startColumn: firstColumn,
    endColumn: finalColumn,
    row: cursor,
    value: decision,
    properties: {
      fontName: type.display,
      fontSize: 15,
      bold: true,
      color: colors.ink,
      fillColor: colors.surface,
      verticalAlignment: 'center',
      wrapText: true,
    },
  });
  cursor += 2;
  const gateRows = normalizedGates(gates);
  if (gateRows.length) {
    const relativeSpans = [
      [1, Math.max(1, Math.floor(width / 3))],
      [Math.max(2, Math.floor(width / 3) + 1), Math.max(3, Math.floor((width * 2) / 3))],
      [Math.max(4, Math.floor((width * 2) / 3) + 1), width],
    ];
    const spans = relativeSpans.map(([start, end]) => [
      firstColumn + start - 1,
      firstColumn + end - 1,
    ]);
    ['트랙', 'Release', 'Stop'].forEach((label, index) => {
      mergedBlock(output, {
        sheet,
        startColumn: spans[index][0],
        endColumn: spans[index][1],
        row: cursor,
        value: label,
        properties: {
          fontName: type.body,
          fontSize: 10,
          bold: true,
          color: colors.onInverse,
          fillColor: colors.inverse,
          horizontalAlignment: 'left',
          verticalAlignment: 'center',
        },
      });
    });
    cursor += 1;
    gateRows.forEach((values, rowIndex) => {
      values.forEach((value, columnIndex) => {
        mergedBlock(output, {
          sheet,
          startColumn: spans[columnIndex][0],
          endColumn: spans[columnIndex][1],
          row: cursor,
          value,
          properties: {
            fontName: type.body,
            fontSize: 10,
            bold: columnIndex === 0,
            color: columnIndex === 1 ? colors.accent : columnIndex === 2 ? colors.accent2 : colors.ink,
            fillColor: columnIndex === 1
              ? colors.surface
              : columnIndex === 2
                ? 'FFF4E5'
                : rowIndex % 2 === 0
                  ? colors.canvas
                  : colors.surface2,
            verticalAlignment: 'center',
            wrapText: true,
          },
        });
      });
      cursor += 1;
    });
  } else {
    for (const action of strings(actions).slice(0, 4)) {
      mergedBlock(output, {
        sheet,
        startColumn: firstColumn,
        endColumn: finalColumn,
        row: cursor,
        value: `• ${action}`,
        properties: {
          fontName: type.body,
          fontSize: 10,
          color: colors.ink,
          fillColor: cursor % 2 === 0 ? colors.canvas : colors.surface,
          verticalAlignment: 'center',
          wrapText: true,
        },
      });
      cursor += 1;
    }
  }
  return {
    lastRow: cursor,
    lastColumn,
  };
}
