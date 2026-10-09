import { presetLabels, provenanceText, strings } from '../design-tokens.mjs';
import { officeNumberFormat } from '../content-model.mjs';
import { addXlsxDecisionPanel, bandHeight, wrapWords } from './design-xlsx-components.mjs';
import { plainObject } from '../../shared/values.mjs';
import { columnLabel } from '../../portable/portable-cells.mjs';
import { displayWidth } from '../../portable/portable-sheet-xml.mjs';
import { provenanceCitation } from '../../portable/portable-opc.mjs';
import { koreanDesign } from '../docx/document-typography.mjs';

// A metric writes its notation the way a fact does (`format: 'percent'` as well
// as an explicit pattern), and its unit rides in the format so the cell keeps a
// number a formula can use while the sheet shows "12명".
function metricNumberFormat(metric) {
  const resolved = officeNumberFormat(metric);
  const unit = String(metric?.unit || '')
    .trim()
    .replace(/"/g, '');
  if (!unit) return resolved || 'General';
  const suffix = `${/^[A-Za-z(]/.test(unit) ? ' ' : ''}${unit}`;
  return `${resolved || '#,##0'}"${suffix}"`;
}

// A card's figure written as text ("+18%", "92.8%", "1,240") lands as the number it shows, in a format that shows it
// the same way: kept as text, a card one column wide (no merge to mark it a tile) read as a number that will not sum.
const FIGURE_TEXT = /^([+-])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?$/;

function figureMetric(metric) {
  if (!plainObject(metric) || typeof metric.value !== 'string' || metric.formula || metric.unit) return metric;
  if (officeNumberFormat(metric)) return metric;
  const match = FIGURE_TEXT.exec(metric.value.trim());
  if (!match) return metric;
  const [, sign, whole, fraction = '', percent] = match;
  const magnitude = Number(`${whole.replace(/,/g, '')}.${fraction || '0'}`);
  const pattern = `${whole.includes(',') ? '#,##0' : '0'}${fraction ? `.${'0'.repeat(fraction.length)}` : ''}${percent ? '%' : ''}`;
  // 92.8 / 100 is 0.9279999999999999 in binary; the stored figure has the places the text wrote.
  const scaled = Number(
    ((sign === '-' ? -magnitude : magnitude) / (percent ? 100 : 1)).toFixed(fraction.length + (percent ? 2 : 0))
  );
  return {
    ...metric,
    value: scaled,
    numberFormat: sign === '+' ? `+${pattern};-${pattern};${pattern}` : pattern,
  };
}

function safeTableName(value) {
  const normalized = String(value || 'MixdogTable').replace(/[^A-Za-z0-9_]/g, '');
  const leading = /^[A-Za-z_]/.test(normalized) ? normalized : `T${normalized}`;
  return (leading || 'MixdogTable').slice(0, 240);
}

// Bars share one value axis, so a series whose values are two orders of
// magnitude away from the first one is drawn as a flat line on the baseline. The
// chart keeps the run of columns that can be read together, starting at the
// first column of figures: a label column after the categories (a region beside
// each hub) is not a series, and taking it for one dropped the chart onto the
// whole table — every column in the legend, one thin bar per hub.
// A header's unit is its trailing parenthesis ("지출 (만 원)"); columns in two
// named units (만 원 beside 건) are two axes even when their magnitudes are close.
const headerUnit = (header) => /\(([^()]+)\)\s*$/.exec(String(header || ''))?.[1].replace(/\s+/g, '') || '';
function comparableSeriesColumns(rows, dataColumns, chartRows, headers = []) {
  const magnitude = (column) => {
    const values = rows
      .slice(0, chartRows)
      .map((row) => Number(Array.isArray(row) ? row[column - 1] : Number.NaN))
      .filter((entry) => Number.isFinite(entry) && entry !== 0)
      .map(Math.abs);
    return values.length ? Math.max(...values) : 0;
  };
  let first = 2;
  while (first <= dataColumns && !magnitude(first)) first += 1;
  if (first > dataColumns) return null;
  let last = first;
  const unit = headerUnit(headers[first - 1]);
  for (let column = first + 1; column <= dataColumns; column += 1) {
    const next = magnitude(column);
    if (!next) break;
    const nextUnit = headerUnit(headers[column - 1]);
    if (unit && nextUnit && unit !== nextUnit) break;
    if (Math.max(magnitude(first), next) / Math.min(magnitude(first), next) > 25) break;
    last = column;
  }
  return { first, last };
}

function isExcelTotalRow(row) {
  return /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(row?.[0] || '').trim());
}

// Everything the sheet's sections share: the composition's flags, the palette
// and type the design chose, and the column/point geometry of the canvas.
// The canvas is as wide as the table under it, because the table's columns are
// the canvas's columns: a strip two columns per metric made every band twice
// the width of the four-column table below, and the sheet read as an unfinished
// layout. The metric cards divide those same columns instead, and a chart is
// drawn to that same width rather than pulling the canvas out to 18 columns.
function canvasGeometry({ dashboard, dataColumns, columns, hasDecisionPanel }) {
  const canvasColumns = dashboard ? dataColumns : columns;
  // Fit-to-page only scales down, so a dashboard whose columns hold just their
  // text prints as a small block in the corner of the paper. The columns carry
  // the printed width instead. A decision panel already runs the sheet past the
  // page, so there the columns keep their fitted widths.
  // A two-column dashboard stretched across a landscape page turns each column
  // into four inches of empty cell; the page it belongs on is the narrow one.
  // A decision panel beside the table runs the sheet a dozen columns wide, so that sheet is landscape whatever the
  // table's width: kept portrait, the page printed as a strip across its top quarter.
  const portraitCanvas = dashboard && canvasColumns <= 3 && !hasDecisionPanel;
  const canvasWidthChars = portraitCanvas ? 78 : 120;
  const fillWidth = dashboard && !hasDecisionPanel ? Math.min(40, Math.floor(canvasWidthChars / canvasColumns)) : 0;
  const fills = fillWidth >= 12;
  // Excel stores a column width in characters; a printed point is what the chart
  // beside it is placed in.
  const columnPoints = fills ? (fillWidth * 7 + 5) * 0.75 : 48;
  return {
    canvasColumns,
    portraitCanvas,
    fillWidth,
    fills,
    columnPoints,
    canvasPoints: columnPoints * canvasColumns,
    lastColumn: columnLabel(canvasColumns),
  };
}

// The bands a sheet's header is made of (title, subtitle, insights) run over its table and, when the chart sits
// beside the table, over the chart too: held to the table's three columns, the title broke onto a second line
// while the chart's top stood bare beside it. Columns past the table keep Excel's default 48 pt.
function bandGeometry(layout, operation) {
  const { chart } = operation;
  const beside =
    !layout.dashboard &&
    plainObject(chart) &&
    !Number(chart.left) &&
    !Number(chart.top) &&
    (layout.headers.length > 0 || layout.rows.length > 0);
  if (!beside) return { bandLastColumn: layout.lastColumn, bandPoints: layout.canvasPoints };
  const chartColumns = Math.ceil((Number(chart.width) || chartDefaults(layout).width) / 48);
  let tablePoints = 0;
  for (let index = 0; index < layout.dataColumns; index += 1) tablePoints += fittedColumnPoints(layout, index);
  return {
    bandLastColumn: columnLabel(layout.dataColumns + 1 + chartColumns),
    bandPoints: tablePoints + 48 * (1 + chartColumns),
  };
}

function sheetLayout(operation, design, composition) {
  const base = baseSheetLayout(operation, design, composition);
  const layout = { ...base, ...panelGeometry(base) };
  return { ...layout, ...bandGeometry(layout, operation) };
}

// A dashboard's decision panel beside the table is as wide as the table: at a fixed thirteen columns it ran twice the
// table's width for a two-line decision, and the page's right half stood empty under it.
// The metric cards run over the panel's columns too, as every band under them does: held to the table, they left the
// page's top right bare above the panel. The table keeps the widths its card floors gave it (the page it fills), so
// only the strip changes; a figure that would not fit a card at those widths keeps the cards over the table.
function panelGeometry(layout) {
  if (!layout.dashboard || !layout.hasDecisionPanel) return { stripColumns: layout.canvasColumns };
  const panelColumns = Math.min(13, Math.max(6, Math.round(tableCanvasPoints(layout) / 48)));
  const stripColumns = layout.dataColumns + 1 + panelColumns;
  const across = layout.metrics.length > 0 && !layout.analysisSheet && cardsFitColumns(layout, stripColumns);
  return { panelColumns, stripColumns: across ? stripColumns : layout.canvasColumns };
}

// Whether every card holds its figure across the given columns: a table column at its printed width (its fit, or its
// card floor), a column past the table at Excel's default (8.43 characters).
function cardsFitColumns(layout, columns) {
  const size = metricValueStyle(layout, {}, false).fontSize;
  const floors = metricColumnFloors(layout);
  const chars = (column) => (column <= layout.dataColumns ? tableColumnChars(layout, column - 1, floors) : 8.43);
  return metricCardSpans(layout.metrics, columns).every((card) => {
    let width = 0;
    for (let column = card.startColumn; column <= card.endColumn; column += 1) width += chars(column);
    return width >= metricNeededChars(card.metric, layout, size);
  });
}

// The printed width of a table column once the metric cards above it have their floors, in Excel characters.
function tableColumnChars(layout, index, floors = metricColumnFloors(layout)) {
  return Math.max(fittedColumnChars(layout, index), floors.get(index + 1) || 0);
}

function tableCanvasPoints(layout) {
  const floors = metricColumnFloors(layout);
  let points = 0;
  for (let index = 0; index < layout.dataColumns; index += 1)
    points += (tableColumnChars(layout, index, floors) * 7 + 5) * 0.75;
  return points;
}

// Beside a decision panel every band over the table spans the panel too: the eyebrow, subtitle and insights held
// to the table left the page's right half bare above the panel.
function panelBandLayout(layout) {
  if (!layout.dashboard || !layout.hasDecisionPanel) return layout;
  const panelColumns = Math.max(4, layout.panelColumns);
  return {
    ...layout,
    bandLastColumn: columnLabel(layout.dataColumns + 1 + panelColumns),
    bandPoints: tableCanvasPoints(layout) + 48 * (1 + panelColumns),
  };
}

// The decision is a sentence, or { text, label } when the panel names it itself. Read as a string, an object put
// "[object Object]" on the sheet and, being no Korean, titled the panel "DECISION WINDOW".
function decisionField(value) {
  if (value === undefined || value === null || value === '') return { text: '', label: '' };
  if (typeof value === 'string') return { text: value.trim(), label: '' };
  if (plainObject(value) && typeof value.text === 'string') {
    return { text: value.text.trim(), label: typeof value.label === 'string' ? value.label.trim() : '' };
  }
  throw new Error('compose_sheet decision takes a sentence, or { text, label } to name the panel yourself');
}

function baseSheetLayout(operation, design, composition) {
  const compositionId = String(composition?.id || 'monitor-dashboard');
  const headers = strings(operation.headers);
  const rows = Array.isArray(operation.rows) ? operation.rows : [];
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 4).map(figureMetric) : [];
  const dashboard = String(operation.kind || '').toLowerCase() === 'dashboard' || metrics.length > 0;
  const dataColumns = Math.max(1, headers.length, ...rows.map((entry) => (Array.isArray(entry) ? entry.length : 1)));
  const columns = Math.max(dataColumns, dashboard ? metrics.length * 2 : 1);
  const decision = decisionField(operation.decision || design.content?.decision);
  const decisionText = decision.text;
  // Every sheet carries the decision it was given: beside the table on a dashboard, under it otherwise. Only the
  // dashboard drew one, and a report sheet's decision, gates, and actions were dropped without a word.
  const hasDecisionPanel = Boolean(decisionText);
  return {
    design,
    colors: design.tokens.colors,
    type: design.tokens.typography,
    format: design.format,
    // The accent-filled lead card is the dashboard compositions' look; the profile's format.accentHeadline
    // (or the operation's accentHeadline) turns it on or off for any other.
    accentHeadline: Boolean(
      operation.accentHeadline ??
        design.format?.accentHeadline ??
        (compositionId === 'monitor-dashboard' || compositionId === 'trend-dashboard')
    ),
    trendDashboard: compositionId === 'trend-dashboard',
    comparisonBoard: compositionId === 'comparison-board',
    analysisSheet: compositionId === 'analysis-sheet',
    narrativeScorecard: compositionId === 'narrative-scorecard',
    sheet: String(operation.sheet || 'Sheet1'),
    headers,
    rows,
    metrics,
    dashboard,
    dataColumns,
    columns,
    panelColumns: dashboard ? Math.max(6, 18 - dataColumns - 1) : dataColumns,
    decisionText,
    decisionLabel: decision.label,
    hasDecisionPanel,
    ...canvasGeometry({ dashboard, dataColumns, columns, hasDecisionPanel }),
    dataLastColumn: columnLabel(dataColumns),
  };
}

// One full-width band: the value in column A, merged across the bands' width
// when that is more than one column, styled as a unit.
function pushBand(output, layout, row, value, properties) {
  const { sheet, bandLastColumn } = layout;
  output.push({ op: 'set_cell', sheet, cell: `A${row}`, value });
  if (bandLastColumn !== 'A') output.push({ op: 'merge_cells', sheet, range: `A${row}:${bandLastColumn}${row}` });
  output.push({ op: 'set_style', sheet, range: `A${row}:${bandLastColumn}${row}`, properties });
}

// Eyebrow (dashboards), title and subtitle bands; returns the first free row.
function pushTitleBands(output, tableLayout, operation) {
  const layout = panelBandLayout(tableLayout);
  const { colors, type, format, dashboard, analysisSheet, narrativeScorecard, headers, rows } = layout;
  // The source of the sheet's figures, in the gap row under the bands, muted, across their width: a cell note alone
  // (A1's, which stays as the cell's provenance) never reached a printed or rendered page. Beside a table Excel takes
  // a written row into the table, and a merge there is refused, so it sits up here.
  const pushSource = (at) => {
    if (!operation.source) return false;
    pushBand(output, layout, at, provenanceText(operation.source) || String(operation.source), {
      fontName: type.body,
      fontSize: 8.5,
      color: colors.muted,
      verticalAlignment: 'center',
    });
    return true;
  };
  let row = 1;
  if (operation.title) {
    if (dashboard) {
      const eyebrow = operation.eyebrow || presetLabels([operation.title, operation.subtitle, headers, rows]).eyebrow;
      pushBand(output, layout, row, String(eyebrow), {
        fontName: type.data,
        fontSize: 9,
        bold: true,
        color: colors.accent,
        fillColor: colors.canvas,
        verticalAlignment: 'center',
      });
      row += 1;
    }
    let titleInk = colors.onInverse;
    let titleFill = colors.inverse;
    if (analysisSheet || dashboard) {
      titleInk = colors.ink;
      titleFill = colors.canvas;
    } else if (narrativeScorecard) {
      titleInk = colors.onAccent;
      titleFill = colors.accent;
    }
    const titleSize = Number(operation.titleSize) || format.title + (dashboard ? 2 : 0);
    // With the decision panel beside the table the title spans the panel too (panelBandLayout) — held to the table,
    // a one-line claim broke in two over a page whose right half stood empty. A widened title takes no fill: a tinted
    // canvas (F7F6F3) drew the long title band as a block of its own.
    const title = wrapWords(String(operation.title), titleSize, layout.bandPoints);
    pushBand(output, layout, row, title, {
      fontName: type.display,
      fontSize: titleSize,
      bold: true,
      color: titleInk,
      ...(layout === tableLayout ? { fillColor: titleFill } : {}),
      verticalAlignment: 'center',
      wrapText: true,
    });
    // A merged band never grows to its wrapped lines: the title cut at the default 15 pt row, its second line
    // under the subtitle. The band takes the lines the title needs across its width.
    const height = bandHeight(title, titleSize, layout.bandPoints);
    output.push({ op: 'set_row_height', sheet: layout.sheet, row, height });
    row += 1;
  }
  if (operation.subtitle) {
    pushBand(output, layout, row, String(operation.subtitle), {
      fontName: type.body,
      fontSize: dashboard ? Math.max(10.5, format.body) : format.body,
      // Hangul, kana, and Han have no italic: the renderer slants them synthetically and "2026년 9월" leaned off its
      // own baseline. Only a Latin subtitle takes the italic; the muted colour already sets it apart.
      italic: !/[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u9FFF\uAC00-\uD7AF]/.test(String(operation.subtitle)),
      color: colors.muted,
      fillColor: colors.surface,
      wrapText: true,
    });
    pushSource(row + 1);
    return row + 2;
  }
  if (operation.title) {
    pushSource(row);
    return row + 1;
  }
  return pushSource(row) ? row + 1 : row;
}
// One metric card: value over label over detail, merged across its span; the
// first card of the sheet is painted as the headline.
function pushMetricCard(output, layout, metric, { headline, startColumn, endColumn, stripRow }) {
  const { sheet } = layout;
  const start = columnLabel(startColumn);
  const end = columnLabel(endColumn);
  const valueRow = stripRow;
  const labelRow = stripRow + 1;
  const detailRow = stripRow + 2;
  const valueCell = `${start}${valueRow}`;
  if (metric?.formula) output.push({ op: 'set_formula', sheet, cell: valueCell, formula: String(metric.formula) });
  else output.push({ op: 'set_cell', sheet, cell: valueCell, value: metric?.value ?? '' });
  // A card one column wide needs no merge; writing one left A4:A4 in the sheet.
  const spans = endColumn > startColumn;
  if (spans) output.push({ op: 'merge_cells', sheet, range: `${start}${valueRow}:${end}${valueRow}` });
  output.push({ op: 'set_cell', sheet, cell: `${start}${labelRow}`, value: String(metric?.label || '') });
  if (spans) output.push({ op: 'merge_cells', sheet, range: `${start}${labelRow}:${end}${labelRow}` });
  output.push({ op: 'set_cell', sheet, cell: `${start}${detailRow}`, value: String(metric?.detail || '') });
  if (spans) output.push({ op: 'merge_cells', sheet, range: `${start}${detailRow}:${end}${detailRow}` });
  output.push({
    op: 'set_style',
    sheet,
    range: `${start}${valueRow}:${end}${valueRow}`,
    properties: metricValueStyle(layout, metric, headline),
  });
  output.push({
    op: 'set_style',
    sheet,
    range: `${start}${labelRow}:${end}${detailRow}`,
    properties: metricLabelStyle(layout),
  });
}

function metricValueStyle(
  { colors, type, dashboard, narrativeScorecard, comparisonBoard, trendDashboard },
  metric,
  headline
) {
  let valueSize = 22;
  if (narrativeScorecard) valueSize = 25;
  else if (dashboard) valueSize = 27;
  else if (comparisonBoard) valueSize = 20;
  const valueFill = trendDashboard ? colors.canvas : colors.surface;
  return {
    fontName: type.data,
    fontSize: valueSize,
    bold: true,
    color: headline ? colors.onAccent : colors.ink,
    fillColor: headline ? colors.accent : valueFill,
    numberFormat: metricNumberFormat(metric),
    horizontalAlignment: 'center',
    verticalAlignment: 'center',
  };
}

function metricLabelStyle({ colors, type, dashboard }) {
  return {
    fontName: type.body,
    fontSize: dashboard ? 10 : 9,
    bold: true,
    color: colors.muted,
    fillColor: colors.surface,
    horizontalAlignment: 'center',
    verticalAlignment: 'center',
    wrapText: true,
  };
}

// Columns the cards cannot divide evenly go to the leading card: the first
// metric is the one the strip paints as the headline, so the wider card reads
// as emphasis rather than as a card that ran out of room.
// More cards than columns wrap onto a second strip rather than pulling the
// canvas past the table: a three-metric strip over a two-column table used to
// make every band half again as wide as the table under it.
// The text a card's value shows under its number format ("47.0%" for 0.47 under 0.0%, "12명" for 12 under 0"명").
function metricDisplayText(metric) {
  const value = metric?.value;
  if (typeof value !== 'number') return String(value ?? '');
  const format = String(metricNumberFormat(metric) || '');
  const pattern = format.replace(/"[^"]*"/g, '');
  const places = /\.(0+)/.exec(pattern)?.[1].length || 0;
  const percent = pattern.includes('%');
  const shown = (percent ? value * 100 : value).toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
  const units = [...format.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join('');
  return `${shown}${percent ? '%' : ''}${units}`;
}

// A card that reads the table by name (=SUM(Hubs[처리량 (건)])) holds no value until the workbook calculates, and
// measured as empty text it floored nothing: the headline "204,300건" printed ###. Its aggregate over the rows this
// sheet writes stands in for the value when the formula is one aggregate of one table column.
const TABLE_AGGREGATES = {
  SUM: (values) => values.reduce((sum, value) => sum + value, 0),
  AVERAGE: (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
  MAX: (values) => Math.max(...values),
  MIN: (values) => Math.min(...values),
  COUNT: (values) => values.length,
};
function measuredMetric(metric, layout) {
  if (typeof metric?.value === 'number') return metric;
  const match = /^=\s*(SUM|AVERAGE|MAX|MIN|COUNT)\s*\(\s*[^[\]()]*\[([^\]]+)\]\s*\)\s*$/i.exec(
    String(metric?.formula || '')
  );
  const column = match ? layout.headers.indexOf(match[2].trim()) : -1;
  if (column < 0) return metric;
  const values = layout.rows
    .map((row) => Number(Array.isArray(row) ? row[column] : Number.NaN))
    .filter(Number.isFinite);
  return values.length ? { ...metric, value: TABLE_AGGREGATES[match[1].toUpperCase()](values) } : metric;
}

// Columns sized to the table's text are too narrow for a card's value at display size: a figure stored as a number
// ("47.0%" at 27 pt) then printed as ###. Each column under a card takes its share of the value's width as the
// autofit's floor, so the column is as wide as its own content or the card's value, whichever is wider. Returns the
// floor per column, in Excel characters.
// The cards of the strips, each with the columns it spans: a strip's columns shared out among its cards, the spare ones
// to the leading cards, the last card running to the strip's edge.
function metricCardSpans(metrics, columns) {
  const perRow = Math.max(1, Math.min(metrics.length, columns));
  const cards = [];
  for (let index = 0; index < metrics.length; index += perRow) {
    const strip = metrics.slice(index, index + perRow);
    const baseSpan = Math.floor(columns / strip.length);
    const spare = columns % strip.length;
    let startColumn = 1;
    strip.forEach((metric, cardIndex) => {
      const span = Math.max(1, baseSpan + (cardIndex < spare ? 1 : 0));
      const endColumn = cardIndex === strip.length - 1 ? columns : Math.min(columns, startColumn + span - 1);
      cards.push({ metric, index: index + cardIndex, strip: index / perRow, startColumn, endColumn });
      startColumn = endColumn + 1;
    });
  }
  return cards;
}

// The width a card's figure needs, in Excel characters. Two characters are the cell's own insets; the third keeps the
// figure off the card's edge. The value is bold, a fifth wider than the regular face the character count stands for
// (the audit's measure): "11,510건" came out one short and cut.
function metricNeededChars(metric, layout, size) {
  return Math.ceil((displayWidth(metricDisplayText(measuredMetric(metric, layout))) * size * 1.2) / 11) + 3;
}

// The floors are the table's: taken from the cards set over the table, they give it the width that fills the page,
// wherever the strip then runs (panelGeometry).
function metricColumnFloors(layout) {
  const { metrics, canvasColumns, analysisSheet, fills } = layout;
  if (!metrics.length || fills || analysisSheet) return new Map();
  const size = metricValueStyle(layout, {}, false).fontSize;
  const floors = new Map();
  for (const card of metricCardSpans(metrics, canvasColumns)) {
    const span = card.endColumn - card.startColumn + 1;
    const share = Math.ceil(metricNeededChars(card.metric, layout, size) / span);
    for (let column = card.startColumn; column <= card.endColumn; column += 1) {
      floors.set(column, Math.max(floors.get(column) || 0, share));
    }
  }
  // The figure columns under the cards read as one grid: floored card by card, the months under the widest card ran
  // three times as wide as the month beside them. The label column keeps its own width.
  let figureWidth = 0;
  for (let column = 2; column <= Math.min(canvasColumns, layout.dataColumns); column += 1) {
    figureWidth = Math.max(figureWidth, floors.get(column) || 0, fittedColumnChars(layout, column - 1));
  }
  for (let column = 2; column <= Math.min(canvasColumns, layout.dataColumns); column += 1)
    floors.set(column, figureWidth);
  return floors;
}

function pushMetricStrips(output, layout, row) {
  const { metrics, stripColumns, analysisSheet } = layout;
  if (!metrics.length) return row;
  // The headline is the card marked `emphasis: true`, else the first.
  const lead = Math.max(
    0,
    metrics.findIndex((metric) => metric?.emphasis === true)
  );
  const cards = metricCardSpans(metrics, stripColumns);
  for (const card of cards) {
    pushMetricCard(output, layout, card.metric, {
      headline: card.index === lead && !analysisSheet && layout.accentHeadline,
      startColumn: card.startColumn,
      endColumn: card.endColumn,
      stripRow: row + card.strip * 3,
    });
  }
  return row + (cards.at(-1).strip + 1) * 3 + 1;
}
function pushInsightBand(output, tableLayout, operation, row) {
  const layout = panelBandLayout(tableLayout);
  const insights = strings(operation.insights);
  if (!insights.length) return row;
  const { colors, type, format, dashboard, narrativeScorecard, trendDashboard } = layout;
  let insightFill = colors.surface2;
  if (narrativeScorecard) insightFill = colors.inverse;
  else if (trendDashboard) insightFill = colors.surface;
  // One insight per line: joined inline, the wrap left a separator dangling at
  // the end of the first line ("…낮습니다. •").
  const size = dashboard ? Math.max(10.5, format.body) : format.body;
  const text = wrapWords(
    insights.length > 1 ? insights.map((entry) => `• ${entry}`).join('\n') : insights[0],
    size,
    layout.bandPoints
  );
  pushBand(output, layout, row, text, {
    fontName: type.body,
    fontSize: size,
    bold: true,
    color: narrativeScorecard ? colors.onInverse : colors.ink,
    fillColor: insightFill,
    wrapText: true,
  });
  // A merged band never grows to its lines, and Excel sized this one by its first column when the wrap was set: two
  // insights stood in a band a hand tall there and two cramped lines in the portable file. The band takes each line
  // it holds, wrapped across its width, as the title band does.
  const height = text.split('\n').reduce((total, line) => total + bandHeight(line, size, layout.bandPoints) - 8, 8);
  output.push({ op: 'set_row_height', sheet: layout.sheet, row, height: Math.min(409, height) });
  return row + 2;
}

// A cell that lands on the grid as a number: a figure, an empty cell, or an ISO date, which both backends store as
// Excel's date serial and set right like any figure — read as a label, "2026-01-31" ran into "본사" beside it and
// its header sat left of its values.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const figureCell = (cell) => typeof cell === 'number' || cell === '' || cell == null || ISO_DATE.test(String(cell));

// The data block: values, a header band with a named table and frozen panes
// when headers were given, and the body type. Returns the block's last row.
function pushDataTable(output, layout, operation, values, startRow) {
  const { sheet, colors, type, format, headers, dataLastColumn } = layout;
  const endRow = startRow + values.length - 1;
  output.push({ op: 'set_range', sheet, range: `A${startRow}:${dataLastColumn}${endRow}`, values });
  if (headers.length) {
    output.push({
      op: 'set_style',
      sheet,
      range: `A${startRow}:${dataLastColumn}${startRow}`,
      properties: {
        fontName: type.body,
        fontSize: format.heading,
        bold: true,
        color: colors.onAccent,
        fillColor: colors.accent,
        // A header sits on the edge its column's text starts from: centred over a left-aligned column of names it
        // floated off "대전" and the column read as two alignments.
        horizontalAlignment: 'left',
        verticalAlignment: 'center',
        wrapText: true,
      },
    });
    // A header over a column of figures sits on the figures' right edge, where the eye reads them; centred over
    // a 30-character column it floated away from 128,400.
    values[0]?.forEach((_, index) => {
      const body = values.slice(1).map((row) => row?.[index]);
      if (!body.length || !body.every(figureCell)) return;
      const column = columnLabel(index + 1);
      output.push({
        op: 'set_style',
        sheet,
        range: `${column}${startRow}`,
        properties: { horizontalAlignment: 'right' },
      });
    });
    output.push({
      op: 'add_table',
      sheet,
      range: `A${startRow}:${dataLastColumn}${endRow}`,
      name: safeTableName(operation.tableName || `${sheet}Data`),
      // The composer paints this range from the document's palette. A
      // built-in table style bands it again from the file's own theme, which
      // is not that palette: a green sheet came back with orange rows. The
      // table keeps its filters and its name; the colours stay the ones the
      // design chose, unless the caller asks for a built-in style by name.
      style: operation.tableStyle || layout.format.tableStyle || 'none',
    });
    // A recomposed sheet may already hold this pane; freezing it again is the
    // composer's routine step, not a change the caller asked to see happen.
    output.push({ op: 'freeze_panes', sheet, row: startRow + 1, column: 1, allowNoChange: true });
  }
  output.push({
    op: 'set_style',
    sheet,
    range: `A${startRow + (headers.length ? 1 : 0)}:${dataLastColumn}${endRow}`,
    properties: {
      fontName: type.body,
      fontSize: format.body,
      color: colors.ink,
      verticalAlignment: 'center',
    },
  });
  // A column of labels after a column of figures starts one indent in, header and body: the figures end on their
  // column's right edge and the labels began on the next one's left, so "38" and "김서연" read as one cell.
  const figures = (index) => {
    const body = values.slice(headers.length ? 1 : 0).map((row) => row?.[index]);
    return body.length > 0 && body.every(figureCell);
  };
  (values[0] || []).forEach((_, index) => {
    if (index === 0 || figures(index) || !figures(index - 1)) return;
    const column = columnLabel(index + 1);
    const range = `${column}${startRow}:${column}${endRow}`;
    output.push({ op: 'set_style', sheet, range, properties: { indent: 1 } });
  });
  return endRow;
}

// columnFormats reads as the caller wrote it: one entry per column in order,
// or keyed by header name or column letter.
function columnFormatsGiven(formats) {
  if (Array.isArray(formats)) return formats.some(Boolean);
  return plainObject(formats) && Object.values(formats).some(Boolean);
}

// A column of numbers the caller named no format for shipped under General:
// the composer picks the type and the spacing and left the figures ragged,
// which is the sheet's own `numeric_column_unformatted`. The default is read
// off the values and claims nothing about them — integers take the
// thousands form, decimals keep the places they were written with — so a
// rate stays a rate and a caller's columnFormats still wins.
function columnDefaultFormat(rows, index) {
  const values = rows
    .map((row) => (Array.isArray(row) ? row[index] : undefined))
    .filter((entry) => typeof entry === 'number' && Number.isFinite(entry));
  if (!values.length || values.length < rows.length) return '';
  if (values.every((entry) => Number.isInteger(entry))) return '#,##0';
  const places = Math.min(3, Math.max(...values.map((entry) => (String(entry).split('.')[1] || '').length)));
  return places > 0 ? `#,##0.${'0'.repeat(places)}` : '#,##0';
}

// Number formats per data column. A format that lands nowhere is reported
// rather than dropped — the figures would ship unformatted.
function pushColumnFormats(output, layout, operation, { startRow, endRow }) {
  const { sheet, headers, rows, dataColumns } = layout;
  if (!rows.length) return;
  // The default scans every row of the column; each column is asked twice.
  const columnDefaults = new Map();
  const columnDefault = (index) => {
    if (!columnDefaults.has(index)) columnDefaults.set(index, columnDefaultFormat(rows, index));
    return columnDefaults.get(index);
  };
  const namedColumnFormat = (index) => {
    const formats = operation.columnFormats;
    if (Array.isArray(formats)) return formats[index];
    if (plainObject(formats)) return formats[headers[index]] || formats[columnLabel(index + 1)];
    return '';
  };
  const firstDataRow = startRow + (headers.length ? 1 : 0);
  let named = 0;
  for (let index = 0; index < Math.max(headers.length, dataColumns); index += 1) {
    const numberFormat = namedColumnFormat(index) || columnDefault(index);
    if (!numberFormat) continue;
    if (numberFormat !== columnDefault(index)) named += 1;
    output.push({
      op: 'set_style',
      sheet,
      range: `${columnLabel(index + 1)}${firstDataRow}:${columnLabel(index + 1)}${endRow}`,
      properties: { numberFormat: String(numberFormat) },
    });
  }
  // A format the caller wrote that landed nowhere is still reported: the
  // defaults above cannot answer for it.
  if (columnFormatsGiven(operation.columnFormats) && !named) {
    throw new Error(
      `compose_sheet columnFormats matched no column; give one entry per column in order, or key them by ${headers.length ? `header (${headers.join(', ')})` : 'column letter'}`
    );
  }
}

// The composition's default chart frame, in points.
function chartDefaults(layout) {
  const { dashboard, trendDashboard, comparisonBoard, analysisSheet, narrativeScorecard, canvasPoints } = layout;
  if (dashboard) return { left: 0, top: 0, width: canvasPoints, height: 360 };
  if (trendDashboard) return { left: 360, top: 172, width: 510, height: 286 };
  if (comparisonBoard) return { left: 390, top: 184, width: 480, height: 278 };
  if (!analysisSheet && narrativeScorecard) return { left: 430, top: 206, width: 450, height: 258 };
  return { left: 520, top: 40, width: 480, height: 280 };
}

// Where the chart sits: the composition's default frame, pushed right of the
// table and, on a dashboard, below it when the two would overlap.
function chartFrame(layout, chart, dataEndRow, startRow, { categories = 0, horizontal = false } = {}) {
  const { dashboard, dataColumns, columnPoints } = layout;
  const defaults = chartDefaults(layout);
  // Horizontal bars stack their categories down the frame: thirty stores in the 280 pt default drew hairline bars
  // and labelled every other one. Each bar gets about a label's height, plus the axis and the title. Beside the
  // table the frame stops where the table does (the print area counts 15 pt rows): run past it, it carried the print
  // area six rows down and a one-page sheet printed on two.
  if (horizontal) {
    const wanted = categories * 16 + 60;
    defaults.height = Math.max(defaults.height, dashboard ? wanted : Math.min(wanted, (categories + 1) * 15));
  }
  const requestedLeft = Number(chart.left) || defaults.left;
  const requestedTop = Number(chart.top) || defaults.top;
  const requestedWidth = Number(chart.width) || defaults.width;
  const left = Math.max(requestedLeft, dashboard ? 0 : dataColumns * 60 + 40);
  const width = Math.max(360, requestedWidth - (left - requestedLeft));
  const tableRightPoints = dataColumns * (dashboard ? columnPoints : 60);
  const overlapsTableHorizontally = left < tableRightPoints;
  const height = Number(chart.height) || defaults.height;
  // A dashboard chart under its table is anchored to the row after the table's gap, not placed in points: the
  // rows above it take their height from their type, and every fixed per-row estimate (20 pt) left an empty band
  // of a hundred points or more between the table and the chart. The print area still counts 15 pt rows, which
  // only reaches further than the chart does.
  // A frame that is to match the grid ends at a column rather than a width in points: a column's points depend on
  // the workbook's font, and on a Korean Excel (Malgun Gothic, a wider character) the chart under a dashboard's
  // table stopped at 88% of it.
  const sized = Boolean(Number(chart.width));
  if (dashboard && overlapsTableHorizontally && !Number(chart.left) && !Number(chart.top)) {
    // Beside a decision panel it runs under the panel too, to the bands' right edge: held to the table, the page's
    // right half stood empty below a two-line panel.
    const span = sized ? { width } : { toColumn: panelBandLayout(layout).bandLastColumn };
    return {
      placement: { cell: `A${dataEndRow + 2}`, ...span, height },
      bottom: (dataEndRow + 1) * 15 + height,
      right: width,
    };
  }
  // Any other sheet sets its chart beside the table, a column apart, its top on the header row: a fixed point
  // frame (360 pt across, 172 pt down) left a three-column table with a gap of its own width and the chart
  // starting a band below it. It ends where the header bands above it do.
  if (!dashboard && !Number(chart.left) && !Number(chart.top)) {
    const span = sized ? { width: requestedWidth } : { toColumn: layout.bandLastColumn };
    return {
      placement: { cell: `${columnLabel(dataColumns + 2)}${startRow}`, ...span, height },
      bottom: (startRow - 1) * 15 + height,
      right: (dataColumns + 1) * columnPoints + requestedWidth,
    };
  }
  const tableBottomPoints = (dataEndRow + 1) * (dashboard ? 20 : 15);
  const top = Math.max(requestedTop, dashboard && overlapsTableHorizontally ? tableBottomPoints + 24 : 0);
  return { placement: { left, top, width, height }, bottom: top + height, right: left + width };
}

// Adds the chart over the comparable series; returns its bottom and right
// edges in points so the print area can follow it.
function pushChart(output, layout, operation, { startRow, dataEndRow }) {
  const { sheet, colors, headers, rows, dataColumns, dashboard } = layout;
  const chart = operation.chart;
  let chartRows = rows.length;
  while (chartRows > 0 && isExcelTotalRow(rows[chartRows - 1])) chartRows -= 1;
  const chartEndRow = startRow + (headers.length ? 1 : 0) + chartRows - 1;
  // Every data column became a series, so a sheet holding a count (128,400),
  // a rate (0.928) and a tally (96) drew one visible bar and two series
  // flattened onto the axis - the legend named three, the chart showed one.
  // Series that cannot share an axis are left out of the picture.
  const series = comparableSeriesColumns(rows, dataColumns, chartRows, headers);
  const endRow = Math.max(startRow, chartEndRow);
  // Categories in column A; a run of series that does not start beside them joins it by comma, the way Excel reads it.
  let defaultRange = `A${startRow}:${columnLabel(series ? series.last : dataColumns)}${endRow}`;
  if (series && series.first > 2) {
    const seriesArea = `${columnLabel(series.first)}${startRow}:${columnLabel(series.last)}${endRow}`;
    defaultRange = `A${startRow}:A${endRow},${seriesArea}`;
  }
  const chartType = chart.type || 'column';
  const bars = ['column', 'bar'].includes(String(chartType).toLowerCase());
  const showValues = chart.showValues ?? (dashboard && chartRows <= 6);
  const dataLabelPosition = chart.dataLabelPosition || (showValues && bars ? 'inside_end' : '');
  const frame = chartFrame(layout, chart, dataEndRow, startRow, {
    categories: chartRows,
    horizontal: String(chartType).toLowerCase() === 'bar',
  });
  // Several series read as periods or groups against the last one, the current period: it takes the accent and the
  // rest stay muted. Two saturated hues (August red beside September orange) left the change the title names unmarked.
  const seriesCount = !chart.range && series ? series.last - series.first + 1 : 0;
  const defaultColors =
    seriesCount > 1
      ? [...Array.from({ length: seriesCount - 1 }, () => colors.muted), colors.accent]
      : [colors.accent, colors.accent2, colors.muted];
  output.push({
    op: 'add_chart',
    sheet,
    range: chart.range || defaultRange,
    chartType,
    title: chart.title || '',
    ...frame.placement,
    seriesColors: chart.seriesColors || defaultColors,
    showValues,
    ...(dataLabelPosition ? { dataLabelPosition } : {}),
    ...(dataLabelPosition === 'inside_end' ? { dataLabelColor: chart.dataLabelColor || colors.onAccent } : {}),
    zeroBaseline: chart.zeroBaseline ?? bars,
    ...(chart.showLegend == null ? {} : { showLegend: chart.showLegend }),
    ...(chart.valueNumberFormat ? { valueNumberFormat: chart.valueNumberFormat } : {}),
  });
  return { bottom: frame.bottom, right: frame.right };
}

// The printed width, in points, autofit_range gives a table column: its widest text two characters over, eight at
// least. A column past the table keeps Excel's default (48 pt).
function fittedColumnPoints(layout, index) {
  if (index >= layout.dataColumns) return 48;
  return (fittedColumnChars(layout, index) * 7 + 5) * 0.75;
}

function fittedColumnChars(layout, index) {
  const texts = [layout.headers, ...layout.rows].map((row) => String((Array.isArray(row) ? row[index] : '') ?? ''));
  return Math.max(8, ...texts.map((text) => displayWidth(text) + 2));
}

function pushDecisionPanel(output, layout, operation, { startRow, dataEndRow }) {
  const {
    sheet,
    design,
    dataColumns,
    panelColumns,
    hasDecisionPanel,
    decisionText,
    decisionLabel: label,
    dashboard,
  } = layout;
  if (!hasDecisionPanel) return { lastRow: dataEndRow, lastColumn: 0 };
  if (!dashboard) {
    // Under the table, a row apart, as wide as the table (four columns at least, the gate row's three spans).
    const columns = Math.max(4, dataColumns);
    const panel = addXlsxDecisionPanel(output, {
      sheet,
      row: dataEndRow + 2,
      startColumn: 1,
      columns,
      design,
      decision: decisionText,
      label,
      gates: operation.gates,
      actions: operation.actions,
      widthPoints: Array.from({ length: columns }, (_, index) => fittedColumnPoints(layout, index)).reduce(
        (total, points) => total + points,
        0
      ),
    });
    return { lastRow: panel.lastRow, lastColumn: columns };
  }
  const panel = addXlsxDecisionPanel(output, {
    sheet,
    row: startRow,
    startColumn: dataColumns + 2,
    columns: panelColumns,
    design,
    decision: decisionText,
    label,
    gates: operation.gates,
    actions: operation.actions,
    widthPoints: Math.max(4, panelColumns) * 48,
  });
  // The panel sits to the right of the data and may run past the canvas columns (a four-column
  // table puts its Stop gate in column R while the canvas ends at L): the print area follows it.
  return { lastRow: panel.lastRow, lastColumn: dataColumns + 2 + panelColumns - 1 };
}

// Fit-to-page only scales down, so a dashboard whose columns hold just their
// text prints as a small block in the corner of the sheet of paper. The
// columns carry the printed width instead: the canvas spreads across the page
// and the blocks keep the alignment the composition gave them. A chart is
// anchored in points against the default column width, so a sheet carrying one
// keeps the fitted widths.
function pushAutofit(output, layout, { lastRow, lastColumn }) {
  const { sheet, fills, fillWidth } = layout;
  output.push({
    op: 'autofit_range',
    sheet,
    range: `A:${columnLabel(lastColumn)}`,
    ...(fills ? { minWidth: fillWidth } : {}),
  });
  output.push({ op: 'autofit_range', sheet, range: `1:${lastRow}`, rows: true });
}

// A chart is anchored in points, past the data block. Print and PDF export clip
// to the print area, so cell extents that stopped at the data dropped the chart
// from every exported copy while it still looked correct on screen. Convert the
// chart edges back into cells with a small margin instead of guessing.
function pushPrintSetup(output, layout, operation, { row, startRow, valueCount, decision, chart }) {
  const { sheet, canvasColumns, columnPoints, dashboard, portraitCanvas, analysisSheet, trendDashboard } = layout;
  const chartLastRow = chart.bottom > 0 ? Math.ceil(chart.bottom / 15) + 1 : 0;
  const chartLastColumn = chart.right > 0 ? Math.ceil(chart.right / columnPoints) + 2 : 0;
  const printColumns = Math.max(canvasColumns, chartLastColumn, decision.lastColumn);
  const landscape = dashboard ? !portraitCanvas : plainObject(operation.chart);
  output.push({
    op: 'set_page_setup',
    sheet,
    // The print area is what the sheet actually carries. A fixed 40-row floor for
    // a dashboard printed two thirds of a page of blank rows, and fit-to-one-page
    // then shrank the composition to make room for them.
    printArea: `A1:${columnLabel(printColumns)}${Math.max(row, decision.lastRow + 1, startRow + valueCount + 1, chartLastRow)}`,
    fitToContent: true,
    // A table that runs past the page keeps naming its columns: its header row repeats on every printed page.
    ...(layout.headers.length ? { printTitleRows: String(startRow) } : {}),
    orientation: landscape ? 'landscape' : 'portrait',
    fitToPagesWide: 1,
    fitToPagesTall: dashboard ? 1 : 0,
    centerHorizontally: true,
    centerVertically: false,
    topMargin: dashboard ? 0.25 : 0.5,
    bottomMargin: dashboard ? 0.25 : 0.5,
    leftMargin: dashboard ? 0.25 : 0.5,
    rightMargin: dashboard ? 0.25 : 0.5,
  });
  let zoom = 100;
  if (!analysisSheet && dashboard) zoom = 120;
  else if (!analysisSheet && trendDashboard) zoom = 95;
  output.push({ op: 'set_sheet_view', sheet, showGridlines: false, zoom });
}

export function expandXlsxSheet(operation, sourceDesign, composition) {
  const output = [];
  // A cell holds one face: a Korean sheet sets the preset's Latin roles in Korean faces.
  const design = koreanDesign(sourceDesign, JSON.stringify(operation));
  const layout = sheetLayout(operation, design, composition);
  const { headers, rows, canvasColumns } = layout;
  let row = pushTitleBands(output, layout, operation);
  row = pushMetricStrips(output, layout, row);
  row = pushInsightBand(output, layout, operation, row);
  const startRow = row;
  const values = headers.length ? [headers, ...rows] : rows;
  let dataEndRow = startRow;
  let chart = { bottom: 0, right: 0 };
  if (values.length) {
    dataEndRow = pushDataTable(output, layout, operation, values, startRow);
    pushColumnFormats(output, layout, operation, { startRow, endRow: dataEndRow });
    if (plainObject(operation.chart)) chart = pushChart(output, layout, operation, { startRow, dataEndRow });
  }
  // A metric card's formula reads the data table ("=SUM(Hubs[처리량 (건)])"), and Microsoft Excel checks a formula
  // the moment it is written: set before add_table named Hubs, it was refused (0x800A03EC) and the whole composed
  // sheet failed on Excel while the portable file, which stores the text, went through. The formulas land once the
  // table exists; the cards keep their place and style.
  const formulas = output.filter((entry) => entry.op === 'set_formula');
  if (formulas.length) {
    const kept = output.filter((entry) => entry.op !== 'set_formula');
    output.length = 0;
    output.push(...kept, ...formulas);
  }
  const decision = pushDecisionPanel(output, layout, operation, { startRow, dataEndRow });
  // The citation reads as add_provenance writes one, in the copy's language: "Source: 자료: 운영관리시스템…" put an English
  // label the caller never wrote in front of the one they did.
  const citation = provenanceCitation(operation.source);
  if (citation) output.push({ op: 'add_note', sheet: layout.sheet, cell: 'A1', text: citation });
  pushAutofit(output, layout, {
    lastRow: Math.max(decision.lastRow, dataEndRow, row),
    lastColumn: Math.max(canvasColumns, decision.lastColumn),
  });
  for (const [column, minWidth] of metricColumnFloors(layout)) {
    const letter = columnLabel(column);
    output.push({ op: 'autofit_range', sheet: layout.sheet, range: `${letter}:${letter}`, minWidth });
  }
  // The chart lands once the columns have their widths: sized in points, it then moves and sizes with its cells,
  // so a chart added before the autofit stretched with the columns under it and ended five columns past the table.
  const charts = output.filter((entry) => entry.op === 'add_chart');
  if (charts.length) {
    const rest = output.filter((entry) => entry.op !== 'add_chart');
    output.length = 0;
    output.push(...rest, ...charts);
  }
  pushPrintSetup(output, layout, operation, { row, startRow, valueCount: values.length, decision, chart });
  return output;
}
