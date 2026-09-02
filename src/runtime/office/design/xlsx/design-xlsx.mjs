import { provenanceText, strings } from '../design-tokens.mjs';
import { addXlsxDecisionPanel } from './design-xlsx-components.mjs';
import { plainObject } from '../../shared/values.mjs';
import { columnLabel } from '../../portable/portable-cells.mjs';

function safeTableName(value) {
  const normalized = String(value || 'MixdogTable').replace(/[^A-Za-z0-9_]/g, '');
  const leading = /^[A-Za-z_]/.test(normalized) ? normalized : `T${normalized}`;
  return (leading || 'MixdogTable').slice(0, 240);
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
  const canvasColumns = dashboard
    ? Math.max(columns, plainObject(operation.chart) ? 18 : 12)
    : columns;
  const lastColumn = columnLabel(canvasColumns);
  const dataLastColumn = columnLabel(dataColumns);
  let row = 1;
  if (operation.title) {
    if (dashboard) {
      output.push({
        op: 'set_cell',
        sheet,
        cell: 'A1',
        value: String(operation.eyebrow || 'EXECUTIVE DECISION DASHBOARD'),
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
    metrics.forEach((metric, index) => {
      const span = canvasColumns / metrics.length;
      const startColumn = Math.floor(index * span) + 1;
      const endColumn = index === metrics.length - 1
        ? canvasColumns
        : Math.floor((index + 1) * span);
      const start = columnLabel(startColumn);
      const end = columnLabel(endColumn);
      const valueRow = row;
      const labelRow = row + 1;
      const detailRow = row + 2;
      const valueCell = `${start}${valueRow}`;
      if (metric?.formula) output.push({ op: 'set_formula', sheet, cell: valueCell, formula: String(metric.formula) });
      else output.push({ op: 'set_cell', sheet, cell: valueCell, value: metric?.value ?? '' });
      output.push({ op: 'merge_cells', sheet, range: `${start}${valueRow}:${end}${valueRow}` });
      output.push({ op: 'set_cell', sheet, cell: `${start}${labelRow}`, value: String(metric?.label || '') });
      output.push({ op: 'merge_cells', sheet, range: `${start}${labelRow}:${end}${labelRow}` });
      output.push({ op: 'set_cell', sheet, cell: `${start}${detailRow}`, value: String(metric?.detail || '') });
      output.push({ op: 'merge_cells', sheet, range: `${start}${detailRow}:${end}${detailRow}` });
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
          numberFormat: metric?.numberFormat || 'General',
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
    row += 4;
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
        style: operation.tableStyle || format.tableStyle,
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
    if (rows.length) {
      const latestDataOffset = Math.max(
        0,
        rows.length - (isExcelTotalRow(rows.at(-1)) ? 2 : 1),
      );
      const latestRow = startRow + (headers.length ? 1 : 0) + latestDataOffset;
      output.push({
        op: 'set_style',
        sheet,
        range: `A${latestRow}:${dataLastColumn}${latestRow}`,
        properties: {
          fontName: type.body,
          fontSize: format.body,
          bold: true,
          color: colors.ink,
          fillColor: colors.surface,
          verticalAlignment: 'center',
        },
      });
    }
    if (plainObject(operation.columnFormats) && headers.length) {
      headers.forEach((header, index) => {
        const numberFormat = operation.columnFormats[header] || operation.columnFormats[columnLabel(index + 1)];
        if (!numberFormat || rows.length === 0) return;
        output.push({
          op: 'set_style',
          sheet,
          range: `${columnLabel(index + 1)}${startRow + 1}:${columnLabel(index + 1)}${endRow}`,
          properties: { numberFormat: String(numberFormat) },
        });
      });
    }
    if (plainObject(operation.chart)) {
      let chartRows = rows.length;
      while (chartRows > 0 && isExcelTotalRow(rows[chartRows - 1])) chartRows -= 1;
      const chartEndRow = startRow + (headers.length ? 1 : 0) + chartRows - 1;
      const chartRange = operation.chart.range
        || `A${startRow}:${dataLastColumn}${Math.max(startRow, chartEndRow)}`;
      const chartType = operation.chart.type || 'column';
      const showValues = operation.chart.showValues ?? (dashboard && chartRows <= 6);
      const dataLabelPosition = operation.chart.dataLabelPosition
        || (showValues && ['column', 'bar'].includes(String(chartType).toLowerCase()) ? 'inside_end' : '');
      const chartDefaults = dashboard
        ? { left: 20, top: 286, width: 880, height: 440 }
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
      const tableRightPoints = dataColumns * 60;
      const overlapsTableHorizontally = chartLeft < tableRightPoints;
      const tableBottomPoints = (dataEndRow + 1) * 15;
      const minimumChartTop = dashboard && overlapsTableHorizontally
        ? Math.max(300, tableBottomPoints + 24)
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
  const decision = String(operation.decision || design.content?.decision || '').trim();
  if (dashboard && decision) {
    const panel = addXlsxDecisionPanel(output, {
      sheet,
      row: startRow,
      startColumn: dataColumns + 2,
      columns: panelColumns,
      design,
      decision,
      gates: operation.gates,
      actions: operation.actions || operation.insights,
    });
    decisionLastRow = panel.lastRow;
  }
  if (operation.source) {
    output.push({
      op: 'add_note',
      sheet,
      cell: 'A1',
      text: `Source: ${provenanceText(operation.source) || String(operation.source)}`,
    });
  }
  output.push({ op: 'autofit_range', sheet, range: `A:${lastColumn}` });
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
  const defaultColumnPoints = 48;
  const chartLastRow = chartBottomPoints > 0
    ? Math.ceil(chartBottomPoints / defaultRowPoints) + 1
    : 0;
  const chartLastColumn = chartRightPoints > 0
    ? Math.ceil(chartRightPoints / defaultColumnPoints) + 2
    : 0;
  const printColumns = Math.max(canvasColumns, chartLastColumn);
  output.push({
    op: 'set_page_setup',
    sheet,
    printArea: `A1:${columnLabel(printColumns)}${Math.max(row, decisionLastRow + 1, startRow + values.length + 1, dashboard ? 40 : 1, chartLastRow)}`,
    fitToContent: true,
    orientation: dashboard || plainObject(operation.chart) ? 'landscape' : 'portrait',
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
