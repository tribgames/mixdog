// The add_chart operation: the block of the sheet a chart reads, the
// categories and series it projects out of that block, the sheet references
// the chart part cites, and the graphic frame the drawing anchors.
import { posix } from 'node:path';
import { chartXml } from './portable-chart.mjs';
import { fitDrawingSheetOnePageWide } from './portable-sheet-page.mjs';
import { toEmu } from './portable-slide-shapes.mjs';
import { columnLabel } from './portable-cells.mjs';
import {
  CHART_CONTENT_TYPE,
  addPackageRelationship,
  ensureContentTypeOverride,
  partRelationshipPath,
  zipText,
} from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE } from './portable-xml.mjs';
import { ensureWorksheetDrawing } from './portable-sheet-parts.mjs';
import { parseAreaRange, quoteSheetName } from './portable-sheet-xml.mjs';
import { cellAnchorPoints, countDrawingAnchors } from './portable-xlsx-drawings.mjs';
import { sheetCellReader } from './portable-xlsx-cell-values.mjs';

// The block a chart reads. One bounded area, or several joined by commas the
// way Excel's own Range("A7:A12,D7:D12") reads them: the first column of the
// first area holds the categories, every other column of every area is a
// series, so a chart can skip the columns between its category and its value.
// plotBy:'rows' reads the same block turned a quarter: the first row holds
// the categories and every other row is one series, which is how a sheet
// that grows a column per period is already written.
function chartDataBlock(op) {
  const plotByRows = String(op.plotBy ?? 'columns').toLowerCase() === 'rows';
  const areas = String(op.range ?? '')
    .split(',')
    .map((part) => parseAreaRange(part.trim()));
  const area = areas[0];
  const seriesColumns = areas.flatMap((entry, index) => {
    const from = index === 0 ? entry.startCol + 1 : entry.startCol;
    return Array.from({ length: Math.max(0, entry.endCol - from + 1) }, (_, offset) => from + offset);
  });
  const seriesRows = area
    ? Array.from({ length: Math.max(0, area.endRow - area.startRow) }, (_, offset) => area.startRow + 1 + offset)
    : [];
  const wholeBlock = plotByRows
    ? areas.length === 1 && area?.endCol > area?.startCol
    : areas.every(
        (entry) => entry.startRow && entry.startCol && entry.startRow === area.startRow && entry.endRow === area.endRow
      );
  const lanes = plotByRows ? seriesRows : seriesColumns;
  if (!area?.startRow || !area.startCol || !lanes.length || !wholeBlock) {
    throw new Error(
      plotByRows
        ? "add_chart plotBy:'rows' requires one bounded range whose first row holds the categories and whose first column names each series"
        : 'add_chart requires a bounded range whose first column holds categories (comma-joined areas must share the same rows)'
    );
  }
  return { plotByRows, area, lanes };
}

// The category labels along the header row (plotted by rows) or the first column.
function chartCategories(cellValue, area, plotByRows) {
  const categories = [];
  if (plotByRows) {
    for (let column = area.startCol + 1; column <= area.endCol; column += 1) {
      categories.push(String(cellValue(column, area.startRow) ?? ''));
    }
  } else {
    for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
      categories.push(String(cellValue(area.startCol, row) ?? ''));
    }
  }
  return categories;
}

// One series' numbers: the lane's row (plotted by rows) or its column.
function laneValues(cellValue, area, plotByRows, lane) {
  const numbers = [];
  if (plotByRows) {
    for (let column = area.startCol + 1; column <= area.endCol; column += 1) {
      numbers.push(Number(cellValue(column, lane)));
    }
  } else {
    for (let row = area.startRow + 1; row <= area.endRow; row += 1) {
      numbers.push(Number(cellValue(lane, row)));
    }
  }
  return numbers;
}

// Categories, series values and the sheet references the chart part cites.
async function readChartData(zip, xml, sheet, op, { plotByRows, area, lanes }) {
  const cellValue = await sheetCellReader(zip, xml);
  const categories = chartCategories(cellValue, area, plotByRows);
  const palette = Array.isArray(op.seriesColors) ? op.seriesColors : [];
  const pointColors = ['pie', 'doughnut', 'donut'].includes(String(op.chartType).toLowerCase()) && palette.length;
  const sheetReference = quoteSheetName(sheet.name);
  const series = [];
  const names = [];
  const values = [];
  for (const [index, lane] of lanes.entries()) {
    const label = columnLabel(plotByRows ? area.startCol : lane);
    const numbers = laneValues(cellValue, area, plotByRows, lane);
    series.push({
      name: String(
        (plotByRows ? cellValue(area.startCol, lane) : cellValue(lane, area.startRow)) ?? `Series ${index + 1}`
      ),
      values: numbers,
      ...(palette.length ? { color: palette[index % palette.length] } : {}),
      ...(pointColors ? { pointColors: categories.map((_, point) => palette[point % palette.length]) } : {}),
    });
    names.push(plotByRows ? `${sheetReference}!$${label}$${lane}` : `${sheetReference}!$${label}$${area.startRow}`);
    values.push(
      plotByRows
        ? `${sheetReference}!$${columnLabel(area.startCol + 1)}$${lane}:$${columnLabel(area.endCol)}$${lane}`
        : `${sheetReference}!$${label}$${area.startRow + 1}:$${label}$${area.endRow}`
    );
  }
  const categoryLabel = columnLabel(area.startCol);
  const category = plotByRows
    ? `${sheetReference}!$${columnLabel(area.startCol + 1)}$${area.startRow}:$${columnLabel(area.endCol)}$${area.startRow}`
    : `${sheetReference}!$${categoryLabel}$${area.startRow + 1}:$${categoryLabel}$${area.endRow}`;
  return { categories, series, references: { sheet: sheetReference, category, names, values } };
}

function nextChartPart(zip) {
  let chartOrdinal = 1;
  while (zip.file(`xl/charts/chart${chartOrdinal}.xml`)) chartOrdinal += 1;
  return `xl/charts/chart${chartOrdinal}.xml`;
}

function chartFrameAnchor(op, framePlacement, anchorCount, chartRelationshipId) {
  return (
    '<xdr:absoluteAnchor>' +
    `<xdr:pos x="${toEmu(op.left ?? framePlacement.left)}" y="${toEmu(op.top ?? framePlacement.top)}"/>` +
    `<xdr:ext cx="${Math.max(1, toEmu(op.width ?? 480))}" cy="${Math.max(1, toEmu(op.height ?? 280))}"/>` +
    '<xdr:graphicFrame macro="">' +
    `<xdr:nvGraphicFramePr><xdr:cNvPr id="${anchorCount + 2}" name="Chart ${anchorCount + 1}"/>` +
    '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
    '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
    ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}" r:id="${chartRelationshipId}"/>` +
    '</a:graphicData></a:graphic></xdr:graphicFrame>' +
    '<xdr:clientData/></xdr:absoluteAnchor>'
  );
}

/** A chart part, its drawing anchor, and the series read out of the sheet. */
export async function addWorksheetChart(zip, sheet, xml, op) {
  const block = chartDataBlock(op);
  const { categories, series, references } = await readChartData(zip, xml, sheet, op, block);
  const chartPart = nextChartPart(zip);
  zip.file(
    chartPart,
    chartXml({
      chartType: op.chartType,
      title: op.title,
      categories,
      series,
      references,
      showValues: op.showValues === true,
      dataLabelPosition: op.dataLabelPosition,
      dataLabelColor: op.dataLabelColor,
      valueNumberFormat: op.valueNumberFormat,
      showLegend: op.showLegend,
      zeroBaseline: op.zeroBaseline,
    })
  );
  await ensureContentTypeOverride(zip, `/${chartPart}`, CHART_CONTENT_TYPE);
  const drawing = await ensureWorksheetDrawing(zip, sheet, xml);
  const drawingPart = drawing.part;
  const chartFit = fitDrawingSheetOnePageWide(drawing.worksheet);
  xml = chartFit.xml;
  zip.file(sheet.path, xml);
  const chartRelationshipId = await addPackageRelationship(
    zip,
    partRelationshipPath(drawingPart),
    `${OFFICE_RELATIONSHIP_BASE}/chart`,
    posix.relative(posix.dirname(drawingPart), chartPart)
  );
  const drawingXml = await zipText(zip, drawingPart);
  const anchorCount = countDrawingAnchors(drawingXml);
  const framePlacement = op.cell ? cellAnchorPoints(xml, op.cell) : { left: 300, top: 20 };
  const anchor = chartFrameAnchor(op, framePlacement, anchorCount, chartRelationshipId);
  zip.file(drawingPart, drawingXml.replace('</xdr:wsDr>', `${anchor}</xdr:wsDr>`));
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    chart: chartPart,
    series: series.length,
    ...(chartFit.applied ? { pageFit: 'one-page-wide' } : {}),
  };
}
