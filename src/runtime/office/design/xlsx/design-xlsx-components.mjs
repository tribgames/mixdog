import { presetLabels, strings } from '../design-tokens.mjs';
import { columnLabel } from '../../portable/portable-cells.mjs';
import { withoutRunt, wrapUnits } from '../../shared/line-breaks.mjs';

function mergedBlock(output, { sheet, startColumn, endColumn, row, rows = 1, value, properties }) {
  const start = columnLabel(startColumn);
  const end = columnLabel(endColumn);
  const last = row + Math.max(1, rows) - 1;
  // The value goes into the merged block, not the lone cell before it: Excel fits a row to a lone cell's broken
  // lines the moment they are written, and the table's first record stood four lines tall beside the decision. A
  // merged cell never fits its row.
  if (endColumn > startColumn || last > row) {
    output.push({ op: 'merge_cells', sheet, range: `${start}${row}:${end}${last}` });
  }
  output.push({ op: 'set_cell', sheet, cell: `${start}${row}`, value: String(value || '') });
  output.push({
    op: 'set_style',
    sheet,
    range: `${start}${row}:${end}${last}`,
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

// Bold display type runs wider than the regular em, and the merged band loses its cell insets: the estimate leans
// long, since a band a line too tall reads as air and one a line short cuts the title. Hangul and CJK run about one
// em a character, Latin about half.
const textEms = (text) =>
  [...String(text)].reduce(
    (total, char) =>
      total + (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u3040-\u30FF\u4E00-\u9FFF]/.test(char) ? 1.1 : 0.6),
    0
  );
const lineRoom = (canvasPoints) => Math.max(1, (Number(canvasPoints) || 480) * 0.8);

// The height a wrapped band needs: its lines — each line the text breaks itself (wrapWords) and each wrap of one
// over the canvas — at 1.3 × the size, with the band's own inset.
export function bandHeight(text, size, canvasPoints) {
  const lines = String(text)
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil((textEms(line) * size) / lineRoom(canvasPoints))), 0);
  return Math.min(409, Math.round(lines * size * 1.3 + 8));
}

// Korean breaks between words, never inside one: Excel wraps Hangul at any syllable, and a decision panel read
// "…승인해 주십 / 시오." (LibreOffice broke it between words). The text is broken at its spaces into lines of the
// width bandHeight measures, so neither backend has a line of its own to break; words that read as one ("10월 14일",
// "24억 원") stay together (wrapUnits), and a band never ends on one word alone under a full line (withoutRunt).
export function wrapWords(text, size, canvasPoints) {
  const measure = (line) => textEms(line) * size;
  return String(text)
    .split('\n')
    .map((paragraph) => {
      const lines = [];
      let line = '';
      for (const word of wrapUnits(paragraph.split(' '))) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && measure(candidate) > lineRoom(canvasPoints)) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      lines.push(line);
      return withoutRunt(lines, measure, lineRoom(canvasPoints)).join('\n');
    })
    .join('\n');
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
  // Beside a table the panel shares the table's rows: a taller decision row made the table's first record taller
  // than the rest. There the decision spans as many 15 pt rows as its lines need instead of growing one.
  const besideTable = firstColumn > 1;
  const decisionText = widthPoints > 0 ? wrapWords(decision, 15, widthPoints) : String(decision);
  const decisionRows =
    besideTable && widthPoints > 0 ? Math.max(1, Math.ceil(bandHeight(decisionText, 15, widthPoints) / 15)) : 1;
  mergedBlock(output, {
    sheet,
    startColumn: firstColumn,
    endColumn: finalColumn,
    row: cursor,
    rows: decisionRows,
    value: decisionText,
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
  if (widthPoints > 0 && !besideTable) {
    output.push({ op: 'set_row_height', sheet, row: cursor, height: bandHeight(decisionText, 15, widthPoints) });
  }
  cursor += decisionRows + 1;
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
  // The actions follow the gates rather than stand in for them: given both, the actions would be dropped.
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
