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
  const unit = String(metric?.unit || '').trim().replace(/"/g, '');
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
    const values = rows.slice(0, chartRows)
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


export function expandXlsxSheet(operation, design, composition) {
  const output = [];
  const colors = design.tokens.colors;
  const type = design.tokens.typography;
  const format = design.format;
  const compositionId = String(composition?.id || 'monitor-dashboard');
  const trendDashboard = compositionId === 'trend-dashboard';
  const comparisonBoard = compositionId === 'comparison-board';
  const analysisSheet = compositionId === 'analysis-sheet';
  const narrativeScorecard = compositionId === 'narrative-scorecard';
  const sheet = String(operation.sheet || 'Sheet1');
  const headers = strings(operation.headers);
  const rows = Array.isArray(operation.rows) ? operation.rows : [];
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 4) : [];
  const dashboard = String(operation.kind || '').toLowerCase() === 'dashboard' || metrics.length > 0;
  const dataColumns = Math.max(
    1,
    headers.length,
    ...rows.map((entry) => Array.isArray(entry) ? entry.length : 1),
  );
  const columns = Math.max(
    dataColumns,
    dashboard ? metrics.length * 2 : 1,
  );
  const panelColumns = dashboard ? Math.max(6, 18 - dataColumns - 1) : dataColumns;
  // The canvas is as wide as the table under it, because the table's columns are
  // the canvas's columns: a strip two columns per metric made every band twice
  // the width of the four-column table below, and the sheet read as an unfinished
  // layout. The metric cards divide those same columns instead, and a chart is
  // drawn to that same width rather than pulling the canvas out to 18 columns.
  const canvasColumns = dashboard ? dataColumns : columns;
  const decisionText = String(operation.decision || design.content?.decision || '').trim();
  const hasDecisionPanel = dashboard && Boolean(decisionText);
  // Fit-to-page only scales down, so a dashboard whose columns hold just their
  // text prints as a small block in the corner of the paper. The columns carry
  // the printed width instead. A decision panel already runs the sheet past the
  // page, so there the columns keep their fitted widths.
  // A two-column dashboard stretched across a landscape page turns each column
  // into four inches of empty cell; the page it belongs on is the narrow one.
  const portraitCanvas = dashboard && canvasColumns <= 3;
  const fillWidth = dashboard && !hasDecisionPanel
    ? Math.min(40, Math.floor((portraitCanvas ? 78 : 120) / canvasColumns))
    : 0;
  const fills = fillWidth >= 12;
  // Excel stores a column width in characters; a printed point is what the chart
  // beside it is placed in.
  const columnPoints = fills ? ((fillWidth * 7) + 5) * 0.75 : 48;
  const canvasPoints = columnPoints * canvasColumns;
  const lastColumn = columnLabel(canvasColumns);
  const dataLastColumn = columnLabel(dataColumns);
  let row = 1;
  if (operation.title) {
    if (dashboard) {
      output.push({
        op: 'set_cell',
        sheet,
        cell: 'A1',
        value: String(operation.eyebrow || presetLabels([operation.title, operation.subtitle, headers, rows]).eyebrow),
      });
      if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A1:${lastColumn}1` });
      output.push({
        op: 'set_style',
        sheet,
        range: `A1:${lastColumn}1`,
        properties: {
          fontName: type.data,
          fontSize: 9,
          bold: true,
          color: colors.accent,
          fillColor: colors.canvas,
          verticalAlignment: 'center',
        },
      });
      row += 1;
    }
    output.push({ op: 'set_cell', sheet, cell: `A${row}`, value: String(operation.title) });
    if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A${row}:${lastColumn}${row}` });
    output.push({
      op: 'set_style',
      sheet,
      range: `A${row}:${lastColumn}${row}`,
      properties: {
        fontName: type.display,
        fontSize: Number(operation.titleSize) || format.title + (dashboard ? 2 : 0),
        bold: true,
        color: analysisSheet || dashboard ? colors.ink : narrativeScorecard ? colors.onAccent : colors.onInverse,
        fillColor: analysisSheet || dashboard ? colors.canvas : narrativeScorecard ? colors.accent : colors.inverse,
        verticalAlignment: 'center',
        wrapText: true,
      },
    });
    row += 1;
  }
  if (operation.subtitle) {
    output.push({ op: 'set_cell', sheet, cell: `A${row}`, value: String(operation.subtitle) });
    if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A${row}:${lastColumn}${row}` });
    output.push({
      op: 'set_style',
      sheet,
      range: `A${row}:${lastColumn}${row}`,
      properties: {
        fontName: type.body,
        fontSize: dashboard ? Math.max(10.5, format.body) : format.body,
        italic: true,
        color: colors.muted,
        fillColor: colors.surface,
        wrapText: true,
      },
    });
    row += 2;
  } else if (operation.title) {
    row += 1;
  }
  if (metrics.length) {
    // Columns the cards cannot divide evenly go to the leading card: the first
    // metric is the one the strip paints as the headline, so the wider card reads
    // as emphasis rather than as a card that ran out of room.
    // More cards than columns wrap onto a second strip rather than pulling the
    // canvas past the table: a three-metric strip over a two-column table used to
    // make every band half again as wide as the table under it.
    const perRow = Math.max(1, Math.min(metrics.length, canvasColumns));
    const strips = [];
    for (let index = 0; index < metrics.length; index += perRow) {
      strips.push(metrics.slice(index, index + perRow));
    }
    strips.forEach((strip, stripIndex) => {
      const baseSpan = Math.floor(canvasColumns / strip.length);
      const spare = canvasColumns % strip.length;
      const cardSpans = strip.map((_, index) => Math.max(1, baseSpan + (index < spare ? 1 : 0)));
      const stripRow = row + (stripIndex * 3);
      strip.forEach((metric, cardIndex) => {
      const index = (stripIndex * perRow) + cardIndex;
      const startColumn = cardSpans.slice(0, cardIndex).reduce((total, width) => total + width, 1);
      const endColumn = cardIndex === strip.length - 1
        ? canvasColumns
        : Math.min(canvasColumns, startColumn + cardSpans[cardIndex] - 1);
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
        properties: {
          fontName: type.data,
          fontSize: narrativeScorecard ? 25 : dashboard ? 27 : comparisonBoard ? 20 : 22,
          bold: true,
          color: index === 0 && !analysisSheet ? colors.onAccent : colors.ink,
          fillColor: index === 0 && !analysisSheet ? colors.accent : trendDashboard ? colors.canvas : colors.surface,
          numberFormat: metricNumberFormat(metric),
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
        },
      });
      output.push({
        op: 'set_style',
        sheet,
        range: `${start}${labelRow}:${end}${detailRow}`,
        properties: {
          fontName: type.body,
          fontSize: dashboard ? 10 : 9,
          bold: true,
          color: colors.muted,
          fillColor: colors.surface,
          horizontalAlignment: 'center',
          verticalAlignment: 'center',
          wrapText: true,
        },
      });
      });
    });
    row += (strips.length * 3) + 1;
  }
  const insights = strings(operation.insights);
  if (insights.length) {
    output.push({ op: 'set_cell', sheet, cell: `A${row}`, value: insights.join(' • ') });
    if (columns > 1) output.push({ op: 'merge_cells', sheet, range: `A${row}:${lastColumn}${row}` });
    output.push({
      op: 'set_style',
      sheet,
      range: `A${row}:${lastColumn}${row}`,
      properties: {
        fontName: type.body,
        fontSize: dashboard ? Math.max(10.5, format.body) : format.body,
        bold: true,
        color: narrativeScorecard ? colors.onInverse : colors.ink,
        fillColor: narrativeScorecard ? colors.inverse : trendDashboard ? colors.surface : colors.surface2,
        wrapText: true,
      },
    });
    row += 2;
  }
  const startRow = row;
  const values = headers.length ? [headers, ...rows] : rows;
  let chartBottomPoints = 0;
  let chartRightPoints = 0;
  let dataEndRow = startRow;
  if (values.length) {
    const endRow = startRow + values.length - 1;
    dataEndRow = endRow;
    output.push({
      op: 'set_range',
      sheet,
      range: `A${startRow}:${dataLastColumn}${endRow}`,
      values,
    });
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
    // columnFormats reads as the caller wrote it: one entry per column in order,
    // or keyed by header name or column letter. A format that lands nowhere is
    // reported rather than dropped — the figures would ship unformatted.
    const formatsGiven = Array.isArray(operation.columnFormats)
      ? operation.columnFormats.some(Boolean)
      : plainObject(operation.columnFormats) && Object.values(operation.columnFormats).some(Boolean);
    if (formatsGiven && rows.length) {
      const columnFormat = (index) => (Array.isArray(operation.columnFormats)
        ? operation.columnFormats[index]
        : operation.columnFormats[headers[index]] || operation.columnFormats[columnLabel(index + 1)]);
      let applied = 0;
      for (let index = 0; index < Math.max(headers.length, dataColumns); index += 1) {
        const numberFormat = columnFormat(index);
        if (!numberFormat) continue;
        applied += 1;
        output.push({
          op: 'set_style',
          sheet,
          range: `${columnLabel(index + 1)}${startRow + (headers.length ? 1 : 0)}:${columnLabel(index + 1)}${endRow}`,
          properties: { numberFormat: String(numberFormat) },
        });
      }
      if (!applied) {
        throw new Error(`compose_sheet columnFormats matched no column; give one entry per column in order, or key them by ${headers.length ? `header (${headers.join(', ')})` : 'column letter'}`);
      }
    }
    if (plainObject(operation.chart)) {
      let chartRows = rows.length;
      while (chartRows > 0 && isExcelTotalRow(rows[chartRows - 1])) chartRows -= 1;
      const chartEndRow = startRow + (headers.length ? 1 : 0) + chartRows - 1;
      // Every data column became a series, so a sheet holding a count (128,400),
      // a rate (0.928) and a tally (96) drew one visible bar and two series
      // flattened onto the axis - the legend named three, the chart showed one.
      // Series that cannot share an axis are left out of the picture.
      const seriesLastColumn = comparableSeriesColumn(rows, dataColumns, chartRows);
      const chartRange = operation.chart.range
        || `A${startRow}:${columnLabel(seriesLastColumn)}${Math.max(startRow, chartEndRow)}`;
      const chartType = operation.chart.type || 'column';
      const showValues = operation.chart.showValues ?? (dashboard && chartRows <= 6);
      const dataLabelPosition = operation.chart.dataLabelPosition
        || (showValues && ['column', 'bar'].includes(String(chartType).toLowerCase()) ? 'inside_end' : '');
      const chartDefaults = dashboard
        ? { left: 0, top: 0, width: canvasPoints, height: 360 }
        : trendDashboard
          ? { left: 360, top: 172, width: 510, height: 286 }
          : comparisonBoard
            ? { left: 390, top: 184, width: 480, height: 278 }
            : analysisSheet
              ? { left: 520, top: 40, width: 480, height: 280 }
              : narrativeScorecard
                ? { left: 430, top: 206, width: 450, height: 258 }
                : { left: 520, top: 40, width: 480, height: 280 };
      const requestedChartLeft = Number(operation.chart.left) || chartDefaults.left;
      const requestedChartTop = Number(operation.chart.top) || chartDefaults.top;
      const requestedChartWidth = Number(operation.chart.width) || chartDefaults.width;
      const minimumChartLeft = dashboard ? 0 : (dataColumns * 60) + 40;
      const chartLeft = Math.max(requestedChartLeft, minimumChartLeft);
      const chartWidth = Math.max(360, requestedChartWidth - (chartLeft - requestedChartLeft));
      const tableRightPoints = dataColumns * (dashboard ? columnPoints : 60);
      const overlapsTableHorizontally = chartLeft < tableRightPoints;
      // A dashboard row is taller than the default 15 points - the metric strip
      // alone sets 27 point type - so the estimate that placed the chart used a
      // fixed 300 point floor and left an empty band between the table and the
      // chart. The band heights are what the chart clears.
      const tableBottomPoints = (dataEndRow + 1) * (dashboard ? 20 : 15);
      const minimumChartTop = dashboard && overlapsTableHorizontally
        ? tableBottomPoints + 24
        : 0;
      const chartTop = Math.max(requestedChartTop, minimumChartTop);
      const chartHeight = Number(operation.chart.height) || chartDefaults.height;
      chartBottomPoints = chartTop + chartHeight;
      chartRightPoints = chartLeft + chartWidth;
      output.push({
        op: 'add_chart',
        sheet,
        range: chartRange,
        chartType,
        title: operation.chart.title || '',
        left: chartLeft,
        top: chartTop,
        width: chartWidth,
        height: chartHeight,
        seriesColors: operation.chart.seriesColors || [colors.accent, colors.accent2, colors.muted],
        showValues,
        ...(dataLabelPosition ? { dataLabelPosition } : {}),
        ...(dataLabelPosition === 'inside_end' ? {
          dataLabelColor: operation.chart.dataLabelColor || colors.onAccent,
        } : {}),
        zeroBaseline: operation.chart.zeroBaseline ?? ['column', 'bar'].includes(String(chartType).toLowerCase()),
        ...(operation.chart.showLegend == null ? {} : { showLegend: operation.chart.showLegend }),
        ...(operation.chart.valueNumberFormat ? { valueNumberFormat: operation.chart.valueNumberFormat } : {}),
      });
    }
  }
  let decisionLastRow = dataEndRow;
  let decisionLastColumn = 0;
  const decision = decisionText;
  if (hasDecisionPanel) {
    const panel = addXlsxDecisionPanel(output, {
      sheet,
      row: startRow,
      startColumn: dataColumns + 2,
      columns: panelColumns,
      design,
      decision,
      gates: operation.gates,
      actions: operation.actions,
    });
    decisionLastRow = panel.lastRow;
    // The panel sits to the right of the data and may run past the canvas columns (a four-column
    // table puts its Stop gate in column R while the canvas ends at L): the print area follows it.
    decisionLastColumn = dataColumns + 2 + panelColumns - 1;
  }
  if (operation.source) {
    output.push({
      op: 'add_note',
      sheet,
      cell: 'A1',
      text: `Source: ${provenanceText(operation.source) || String(operation.source)}`,
    });
  }
  // Fit-to-page only scales down, so a dashboard whose columns hold just their
  // text prints as a small block in the corner of the sheet of paper. The
  // columns carry the printed width instead: the canvas spreads across the page
  // and the blocks keep the alignment the composition gave them. A chart is
  // anchored in points against the default column width, so a sheet carrying one
  // keeps the fitted widths.
  output.push({
    op: 'autofit_range',
    sheet,
    range: `A:${columnLabel(Math.max(canvasColumns, decisionLastColumn))}`,
    ...(fills ? { minWidth: fillWidth } : {}),
  });
  output.push({
    op: 'autofit_range',
    sheet,
    range: `1:${Math.max(decisionLastRow, dataEndRow, row)}`,
    rows: true,
  });
  // A chart is anchored in points, past the data block. Print and PDF export clip
  // to the print area, so cell extents that stopped at the data dropped the chart
  // from every exported copy while it still looked correct on screen. Convert the
  // chart edges back into cells with a small margin instead of guessing.
  const defaultRowPoints = 15;
  const defaultColumnPoints = columnPoints;
  const chartLastRow = chartBottomPoints > 0
    ? Math.ceil(chartBottomPoints / defaultRowPoints) + 1
    : 0;
  const chartLastColumn = chartRightPoints > 0
    ? Math.ceil(chartRightPoints / defaultColumnPoints) + 2
    : 0;
  const printColumns = Math.max(canvasColumns, chartLastColumn, decisionLastColumn);
  output.push({
    op: 'set_page_setup',
    sheet,
    // The print area is what the sheet actually carries. A fixed 40-row floor for
    // a dashboard printed two thirds of a page of blank rows, and fit-to-one-page
    // then shrank the composition to make room for them.
    printArea: `A1:${columnLabel(printColumns)}${Math.max(row, decisionLastRow + 1, startRow + values.length + 1, chartLastRow)}`,
    fitToContent: true,
    orientation: (dashboard ? !portraitCanvas : plainObject(operation.chart)) ? 'landscape' : 'portrait',
    fitToPagesWide: 1,
    fitToPagesTall: dashboard ? 1 : 0,
    centerHorizontally: true,
    centerVertically: false,
    topMargin: dashboard ? 0.25 : 0.5,
    bottomMargin: dashboard ? 0.25 : 0.5,
    leftMargin: dashboard ? 0.25 : 0.5,
    rightMargin: dashboard ? 0.25 : 0.5,
  });
  output.push({
    op: 'set_sheet_view',
    sheet,
    showGridlines: false,
    zoom: analysisSheet ? 100 : dashboard ? 120 : trendDashboard ? 95 : 100,
  });
  return output;
}
