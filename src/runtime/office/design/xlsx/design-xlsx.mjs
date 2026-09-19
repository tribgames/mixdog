import { presetLabels, provenanceText, strings } from '../design-tokens.mjs';
import { officeNumberFormat } from '../content-model.mjs';
import { addXlsxDecisionPanel } from './design-xlsx-components.mjs';
import { plainObject } from '../../shared/values.mjs';
import { columnLabel } from '../../portable/portable-cells.mjs';

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

function safeTableName(value) {
  const normalized = String(value || 'MixdogTable').replace(/[^A-Za-z0-9_]/g, '');
  const leading = /^[A-Za-z_]/.test(normalized) ? normalized : `T${normalized}`;
  return (leading || 'MixdogTable').slice(0, 240);
}

// Bars share one value axis, so a series whose values are two orders of
// magnitude away from the first one is drawn as a flat line on the baseline. The
// chart keeps the run of columns that can be read together, starting at the
// first series column.
function comparableSeriesColumn(rows, dataColumns, chartRows) {
  const magnitude = (column) => {
    const values = rows
      .slice(0, chartRows)
      .map((row) => Number(Array.isArray(row) ? row[column - 1] : Number.NaN))
      .filter((entry) => Number.isFinite(entry) && entry !== 0)
      .map(Math.abs);
    return values.length ? Math.max(...values) : 0;
  };
  const first = magnitude(2);
  if (!first) return dataColumns;
  let last = 2;
  for (let column = 3; column <= dataColumns; column += 1) {
    const next = magnitude(column);
    if (!next) break;
    if (Math.max(first, next) / Math.min(first, next) > 25) break;
    last = column;
  }
  return last;
}

function isExcelTotalRow(row) {
  return /^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))/i.test(String(row?.[0] || '').trim());
}

// Everything the sheet's sections share: the composition's flags, the palette
// and type the design chose, and the column/point geometry of the canvas.
// The column/point geometry of the canvas.
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
  const portraitCanvas = dashboard && canvasColumns <= 3;
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

function sheetLayout(operation, design, composition) {
  const compositionId = String(composition?.id || 'monitor-dashboard');
  const headers = strings(operation.headers);
  const rows = Array.isArray(operation.rows) ? operation.rows : [];
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 4) : [];
  const dashboard = String(operation.kind || '').toLowerCase() === 'dashboard' || metrics.length > 0;
  const dataColumns = Math.max(1, headers.length, ...rows.map((entry) => (Array.isArray(entry) ? entry.length : 1)));
  const columns = Math.max(dataColumns, dashboard ? metrics.length * 2 : 1);
  const decisionText = String(operation.decision || design.content?.decision || '').trim();
  const hasDecisionPanel = dashboard && Boolean(decisionText);
  return {
    design,
    colors: design.tokens.colors,
    type: design.tokens.typography,
    format: design.format,
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
    hasDecisionPanel,
    ...canvasGeometry({ dashboard, dataColumns, columns, hasDecisionPanel }),
    dataLastColumn: columnLabel(dataColumns),
  };
}

// One full-width band: the value in column A, merged across the canvas when
// there is more than one column, styled as a unit.
function pushBand(output, layout, row, value, properties) {
  const { sheet, columns, lastColumn } = layout;
  output.push({ op: 'set_cell', sheet, cell: `A${row}`, value });
  if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A${row}:${lastColumn}${row}` });
  output.push({ op: 'set_style', sheet, range: `A${row}:${lastColumn}${row}`, properties });
}

// Eyebrow (dashboards), title and subtitle bands; returns the first free row.
function pushTitleBands(output, layout, operation) {
  const { colors, type, format, dashboard, analysisSheet, narrativeScorecard, headers, rows } = layout;
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
    pushBand(output, layout, row, String(operation.title), {
      fontName: type.display,
      fontSize: Number(operation.titleSize) || format.title + (dashboard ? 2 : 0),
      bold: true,
      color: titleInk,
      fillColor: titleFill,
      verticalAlignment: 'center',
      wrapText: true,
    });
    row += 1;
  }
  if (operation.subtitle) {
    pushBand(output, layout, row, String(operation.subtitle), {
      fontName: type.body,
      fontSize: dashboard ? Math.max(10.5, format.body) : format.body,
      italic: true,
      color: colors.muted,
      fillColor: colors.surface,
      wrapText: true,
    });
    return row + 2;
  }
  return operation.title ? row + 1 : row;
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
function pushMetricStrips(output, layout, row) {
  const { metrics, canvasColumns, analysisSheet } = layout;
  if (!metrics.length) return row;
  const perRow = Math.max(1, Math.min(metrics.length, canvasColumns));
  const strips = [];
  for (let index = 0; index < metrics.length; index += perRow) {
    strips.push(metrics.slice(index, index + perRow));
  }
  strips.forEach((strip, stripIndex) => {
    const baseSpan = Math.floor(canvasColumns / strip.length);
    const spare = canvasColumns % strip.length;
    const cardSpans = strip.map((_, index) => Math.max(1, baseSpan + (index < spare ? 1 : 0)));
    const stripRow = row + stripIndex * 3;
    strip.forEach((metric, cardIndex) => {
      const startColumn = cardSpans.slice(0, cardIndex).reduce((total, width) => total + width, 1);
      const endColumn =
        cardIndex === strip.length - 1
          ? canvasColumns
          : Math.min(canvasColumns, startColumn + cardSpans[cardIndex] - 1);
      pushMetricCard(output, layout, metric, {
        headline: stripIndex === 0 && cardIndex === 0 && !analysisSheet,
        startColumn,
        endColumn,
        stripRow,
      });
    });
  });
  return row + strips.length * 3 + 1;
}
function pushInsightBand(output, layout, operation, row) {
  const insights = strings(operation.insights);
  if (!insights.length) return row;
  const { colors, type, format, dashboard, narrativeScorecard, trendDashboard } = layout;
  let insightFill = colors.surface2;
  if (narrativeScorecard) insightFill = colors.inverse;
  else if (trendDashboard) insightFill = colors.surface;
  pushBand(output, layout, row, insights.join(' • '), {
    fontName: type.body,
    fontSize: dashboard ? Math.max(10.5, format.body) : format.body,
    bold: true,
    color: narrativeScorecard ? colors.onInverse : colors.ink,
    fillColor: insightFill,
    wrapText: true,
  });
  return row + 2;
}

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
        horizontalAlignment: 'center',
        verticalAlignment: 'center',
        wrapText: true,
      },
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
      style: operation.tableStyle || 'none',
    });
    output.push({ op: 'freeze_panes', sheet, row: startRow + 1, column: 1 });
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

// Where the chart sits: the composition's default frame, pushed right of the
// table and, on a dashboard, below it when the two would overlap.
function chartFrame(layout, chart, dataEndRow) {
  const { dashboard, trendDashboard, comparisonBoard, analysisSheet, narrativeScorecard } = layout;
  const { canvasPoints, dataColumns, columnPoints } = layout;
  let defaults = { left: 520, top: 40, width: 480, height: 280 };
  if (dashboard) defaults = { left: 0, top: 0, width: canvasPoints, height: 360 };
  else if (trendDashboard) defaults = { left: 360, top: 172, width: 510, height: 286 };
  else if (comparisonBoard) defaults = { left: 390, top: 184, width: 480, height: 278 };
  else if (!analysisSheet && narrativeScorecard) defaults = { left: 430, top: 206, width: 450, height: 258 };
  const requestedLeft = Number(chart.left) || defaults.left;
  const requestedTop = Number(chart.top) || defaults.top;
  const requestedWidth = Number(chart.width) || defaults.width;
  const left = Math.max(requestedLeft, dashboard ? 0 : dataColumns * 60 + 40);
  const width = Math.max(360, requestedWidth - (left - requestedLeft));
  const tableRightPoints = dataColumns * (dashboard ? columnPoints : 60);
  const overlapsTableHorizontally = left < tableRightPoints;
  // A dashboard row is taller than the default 15 points - the metric strip
  // alone sets 27 point type - so the estimate that placed the chart used a
  // fixed 300 point floor and left an empty band between the table and the
  // chart. The band heights are what the chart clears.
  const tableBottomPoints = (dataEndRow + 1) * (dashboard ? 20 : 15);
  const top = Math.max(requestedTop, dashboard && overlapsTableHorizontally ? tableBottomPoints + 24 : 0);
  return { left, top, width, height: Number(chart.height) || defaults.height };
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
  const seriesLastColumn = comparableSeriesColumn(rows, dataColumns, chartRows);
  const chartType = chart.type || 'column';
  const bars = ['column', 'bar'].includes(String(chartType).toLowerCase());
  const showValues = chart.showValues ?? (dashboard && chartRows <= 6);
  const dataLabelPosition = chart.dataLabelPosition || (showValues && bars ? 'inside_end' : '');
  const frame = chartFrame(layout, chart, dataEndRow);
  output.push({
    op: 'add_chart',
    sheet,
    range: chart.range || `A${startRow}:${columnLabel(seriesLastColumn)}${Math.max(startRow, chartEndRow)}`,
    chartType,
    title: chart.title || '',
    ...frame,
    seriesColors: chart.seriesColors || [colors.accent, colors.accent2, colors.muted],
    showValues,
    ...(dataLabelPosition ? { dataLabelPosition } : {}),
    ...(dataLabelPosition === 'inside_end' ? { dataLabelColor: chart.dataLabelColor || colors.onAccent } : {}),
    zeroBaseline: chart.zeroBaseline ?? bars,
    ...(chart.showLegend == null ? {} : { showLegend: chart.showLegend }),
    ...(chart.valueNumberFormat ? { valueNumberFormat: chart.valueNumberFormat } : {}),
  });
  return { bottom: frame.top + frame.height, right: frame.left + frame.width };
}

function pushDecisionPanel(output, layout, operation, { startRow, dataEndRow }) {
  const { sheet, design, dataColumns, panelColumns, hasDecisionPanel, decisionText } = layout;
  if (!hasDecisionPanel) return { lastRow: dataEndRow, lastColumn: 0 };
  const panel = addXlsxDecisionPanel(output, {
    sheet,
    row: startRow,
    startColumn: dataColumns + 2,
    columns: panelColumns,
    design,
    decision: decisionText,
    gates: operation.gates,
    actions: operation.actions,
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

export function expandXlsxSheet(operation, design, composition) {
  const output = [];
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
  const decision = pushDecisionPanel(output, layout, operation, { startRow, dataEndRow });
  if (operation.source) {
    output.push({
      op: 'add_note',
      sheet: layout.sheet,
      cell: 'A1',
      text: `Source: ${provenanceText(operation.source) || String(operation.source)}`,
    });
  }
  pushAutofit(output, layout, {
    lastRow: Math.max(decision.lastRow, dataEndRow, row),
    lastColumn: Math.max(canvasColumns, decision.lastColumn),
  });
  pushPrintSetup(output, layout, operation, { row, startRow, valueCount: values.length, decision, chart });
  return output;
}
