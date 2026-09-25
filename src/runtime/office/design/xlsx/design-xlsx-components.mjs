import { presetLabels, strings } from '../design-tokens.mjs';
import { columnLabel } from '../../portable/portable-cells.mjs';

function mergedBlock(output, { sheet, startColumn, endColumn, row, value, properties }) {
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
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (Array.isArray(entry)) return entry.slice(0, 3).map((cell) => String(cell ?? ''));
      if (!entry || typeof entry !== 'object') return [];
      return [
        String(entry.track || entry.label || entry.title || ''),
        String(entry.release || entry.go || ''),
        String(entry.stop || entry.hold || ''),
      ];
    })
    .filter((row) => row.length === 3 && row.some(Boolean));
}

// The height a wrapped band needs: Hangul and CJK run about one em a character, Latin about half; the lines are
// the text's width over the canvas, each at 1.3 × the size, with the band's own inset.
export function bandHeight(text, size, canvasPoints) {
  // Bold display type runs wider than the regular em, and the merged band loses its cell insets: the estimate
  // leans long, since a band a line too tall reads as air and one a line short cuts the title.
  const ems = [...String(text)].reduce((total, char) => total + (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/.test(char) ? 1.1 : 0.6), 0);
  const lines = Math.max(1, Math.ceil((ems * size) / Math.max(1, (Number(canvasPoints) || 480) * 0.8)));
  return Math.min(409, Math.round(lines * size * 1.3 + 8));
}

// widthPoints: the panel's printed width, from which the decision's merged row takes its height — a merged cell
// never grows to its lines, and a two-sentence decision showed its first line and hid the rest in Excel.
export function addXlsxDecisionPanel(
  output,
  { sheet, row, startColumn = 1, columns, design, decision, gates, actions, label = '', widthPoints = 0 }
) {
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const firstColumn = Math.max(1, Number(startColumn) || 1);
  // Four columns hold the gate row's three spans; a panel under a four-column table keeps the table's width.
  const width = Math.max(4, Number(columns) || 6);
  const finalColumn = firstColumn + width - 1;
  const lastColumn = columnLabel(finalColumn);
  let cursor = row;
  mergedBlock(output, {
    sheet,
    startColumn: firstColumn,
    endColumn: finalColumn,
    row: cursor,
    value: label || presetLabels([decision, gates, actions]).decision,
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
  if (widthPoints > 0) {
    output.push({ op: 'set_row_height', sheet, row: cursor, height: bandHeight(decision, 15, widthPoints) });
  }
  cursor += 2;
  const gateRows = normalizedGates(gates);
  if (gateRows.length) {
    const relativeSpans = [
      [1, Math.max(1, Math.floor(width / 3))],
      [Math.max(2, Math.floor(width / 3) + 1), Math.max(3, Math.floor((width * 2) / 3))],
      [Math.max(4, Math.floor((width * 2) / 3) + 1), width],
    ];
    const spans = relativeSpans.map(([start, end]) => [firstColumn + start - 1, firstColumn + end - 1]);
    // The gate columns are named in the copy's language: "트랙 / Release / Stop" put two English words the caller
    // never wrote into a Korean sheet.
    presetLabels([decision, gates, actions]).gate.forEach((label, index) => {
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
        // Release is a positive state, Stop a critical one: the state fields and words, never a literal tint.
        let color = colors.ink;
        let fillColor = rowIndex % 2 === 0 ? colors.canvas : colors.surface2;
        if (columnIndex === 1) {
          color = colors.positiveText || colors.accent;
          fillColor = colors.positiveWeak || colors.surface;
        } else if (columnIndex === 2) {
          color = colors.criticalText || colors.accent2;
          fillColor = colors.criticalWeak || colors.surface2;
        }
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
            color,
            fillColor,
            verticalAlignment: 'center',
            wrapText: true,
          },
        });
      });
      cursor += 1;
    });
  }
  // The actions follow the gates rather than stand in for them: given both, the actions used to be dropped.
  if (gateRows.length && strings(actions).length) cursor += 1;
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
  return {
    lastRow: cursor,
    lastColumn,
  };
}
