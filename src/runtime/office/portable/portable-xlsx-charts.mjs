// The add_chart operation: the block of the sheet a chart reads, the
// categories and series it projects out of that block, the sheet references
// the chart part cites, and the graphic frame the drawing anchors.
import { posix } from 'node:path';
import { DEFAULT_SERIES_COLORS, chartXml } from './portable-chart.mjs';
import { fitDrawingSheetOnePageWide, workbookDigitWidth, worksheetGeometry } from './portable-sheet-page.mjs';
import { columnLabel, columnNumber, parseCellRef, workbookSheets } from './portable-cells.mjs';
import {
  CHART_CONTENT_TYPE,
  addPackageRelationship,
  ensureContentTypeOverride,
  partRelationshipPath,
  zipText,
} from './portable-opc.mjs';
import { OFFICE_RELATIONSHIP_BASE, xmlDecode, xmlEncode } from './portable-xml.mjs';
import { ensureWorksheetDrawing } from './portable-sheet-parts.mjs';
import { parseAreaRange, quoteSheetName, sheetQualifiedAreas } from './portable-sheet-xml.mjs';
import { countDrawingAnchors, frameAnchorXml } from './portable-xlsx-drawings.mjs';
import { sheetCellLabelReader, sheetCellReader } from './portable-xlsx-cell-values.mjs';

// The block a chart reads. One bounded area, or several joined by commas the
// way Excel's own Range("A7:A12,D7:D12") reads them: the first column of the
// first area holds the categories, every other column of every area is a
// series, so a chart can skip the columns between its category and its value.
// plotBy:'rows' reads the same block turned a quarter: the first row holds
// the categories and every other row is one series, which is how a sheet
// that grows a column per period is already written.
function chartDataBlock(op) {
  const plotByRows = String(op.plotBy ?? 'columns').toLowerCase() === 'rows';
  const sourced = sheetQualifiedAreas(op.range);
  const areas = sourced.map((entry) => parseAreaRange(entry.area));
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
  return { plotByRows, area, lanes, sourceSheet: sourced[0].sheet };
}

// The sheet the source names, or the one the chart stands on; a summary sheet charts the calculation behind it.
async function chartSourceSheet(zip, sheet, xml, sheets, name) {
  if (!name || name.toLowerCase() === sheet.name.toLowerCase()) return { sheet, xml };
  const source = (sheets || []).find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (!source) {
    throw new Error(
      `XLSX add_chart reads sheet "${name}", which the workbook does not hold; it has ${(sheets || []).map((entry) => `"${entry.name}"`).join(', ')}`
    );
  }
  return { sheet: source, xml: await zipText(zip, source.path) };
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
  const labels = await sheetCellLabelReader(zip, xml);
  const categories = chartCategories(labels.label, area, plotByRows);
  // A column of dated categories in one format is written as dates in that format (portable-chart categoryDates).
  let categoryDates = null;
  if (!plotByRows) {
    const dates = [];
    for (let row = area.startRow + 1; row <= area.endRow; row += 1) dates.push(labels.dated(area.startCol, row));
    if (dates.length && dates.every((date) => date && date.format === dates[0].format)) {
      categoryDates = { values: dates.map((date) => date.serial), format: dates[0].format };
    }
  }
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
  return { categories, categoryDates, series, references: { sheet: sheetReference, category, names, values } };
}

// A chart part carries a copy of the cells it reads, and a viewer that draws from the copy (a mail or phone preview)
// shows the chart as it was written: a column of formulas written before it had values stood there as zeros. Once
// the workbook is calculated each copy is taken again from its cells.
export async function refreshChartCaches(zip) {
  const sheets = await workbookSheets(zip);
  const readers = new Map();
  // A number cache takes the cells' values; a text cache what they show (a dated label as its date text).
  const cellReader = async (name, kind) => {
    const sheet = sheets.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    if (!sheet) return null;
    if (!readers.has(sheet.path)) {
      const xml = await zipText(zip, sheet.path);
      readers.set(sheet.path, {
        num: await sheetCellReader(zip, xml),
        str: (await sheetCellLabelReader(zip, xml)).label,
      });
    }
    return readers.get(sheet.path)[kind];
  };
  // The cells a reference reads, in order; null for one that names no sheet here or no bounded block of cells.
  const referenced = async (formula, kind) => {
    const values = [];
    for (const { sheet, area } of sheetQualifiedAreas(xmlDecode(formula))) {
      const cellValue = sheet ? await cellReader(sheet, kind) : null;
      const bounds = /^[A-Z]+\d+(?::[A-Z]+\d+)?$/i.test(area) ? parseAreaRange(area) : null;
      if (!cellValue || !bounds) return null;
      for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
        for (let column = bounds.startCol; column <= bounds.endCol; column += 1) values.push(cellValue(column, row));
      }
    }
    return values;
  };
  const reference = /<c:(num|str)Ref>\s*(<c:f>([^<]*)<\/c:f>)\s*<c:\1Cache>([\s\S]*?)<\/c:\1Cache>\s*<\/c:\1Ref>/g;
  for (const name of Object.keys(zip.files).filter((entry) => /^xl\/charts\/chart\d+\.xml$/i.test(entry))) {
    const xml = await zipText(zip, name);
    let next = '';
    let last = 0;
    for (const match of xml.matchAll(reference)) {
      const [, kind, formula, , cache] = match;
      const values = await referenced(match[3], kind);
      if (!values) continue;
      const formatCode = kind === 'num' ? /<c:formatCode>[\s\S]*?<\/c:formatCode>/.exec(cache)?.[0] || '' : '';
      const points = values
        .map((value, index) => {
          if (kind === 'str') return `<c:pt idx="${index}"><c:v>${xmlEncode(String(value ?? ''))}</c:v></c:pt>`;
          const number = value === '' || value == null ? Number.NaN : Number(value);
          return Number.isFinite(number) ? `<c:pt idx="${index}"><c:v>${number}</c:v></c:pt>` : '';
        })
        .join('');
      next +=
        xml.slice(last, match.index) +
        `<c:${kind}Ref>${formula}<c:${kind}Cache>${formatCode}<c:ptCount val="${values.length}"/>${points}` +
        `</c:${kind}Cache></c:${kind}Ref>`;
      last = match.index + match[0].length;
    }
    if (last && `${next}${xml.slice(last)}` !== xml) zip.file(name, `${next}${xml.slice(last)}`);
  }
}

function nextChartPart(zip) {
  let chartOrdinal = 1;
  while (zip.file(`xl/charts/chart${chartOrdinal}.xml`)) chartOrdinal += 1;
  return `xl/charts/chart${chartOrdinal}.xml`;
}

// A frame placed at cell and ended at toColumn takes the width of the columns it spans, as the sheet has them now.
function spannedWidth(xml, op, digitWidth) {
  if (!op.toColumn) return null;
  if (!op.cell) throw new Error('XLSX add_chart toColumn ends a frame placed at cell; give cell as well');
  const first = columnNumber(parseCellRef(op.cell).col);
  const last = columnNumber(String(op.toColumn).trim().toUpperCase());
  if (!(last >= first)) throw new Error(`XLSX add_chart toColumn ${op.toColumn} lies left of ${op.cell}`);
  const { columnPoints } = worksheetGeometry(xml, digitWidth);
  let width = 0;
  for (let column = first; column <= last; column += 1) width += columnPoints(column);
  return width;
}

function chartFrameAnchor(op, anchorCount, chartRelationshipId) {
  // Without a cell or a point position the frame keeps its old default spot beside A1.
  const placed = op.cell || op.left !== undefined || op.top !== undefined;
  return frameAnchorXml(
    {
      cell: op.cell,
      left: placed ? op.left : 300,
      top: placed ? op.top : 20,
      width: op.width ?? 480,
      height: op.height ?? 280,
    },
    '<xdr:graphicFrame macro="">' +
      `<xdr:nvGraphicFramePr><xdr:cNvPr id="${anchorCount + 2}" name="Chart ${anchorCount + 1}"/>` +
      '<xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"' +
      ` xmlns:r="${OFFICE_RELATIONSHIP_BASE}" r:id="${chartRelationshipId}"/>` +
      '</a:graphicData></a:graphic></xdr:graphicFrame>'
  );
}

// The bar the chart is about (highlight: a 0-based index or a category's text) takes the series colour and the rest
// recede, as the Word and PDF charts draw it; -1 for none.
const HIGHLIGHT_MUTED = 'C9CED6';
function chartHighlightIndex(highlight, categories) {
  if (highlight === undefined || highlight === null || highlight === '') return -1;
  if (typeof highlight === 'number')
    return Number.isInteger(highlight) && highlight < categories.length ? highlight : -1;
  return categories.findIndex((category) => String(category ?? '') === String(highlight));
}

// The workbook's own face: the first font, the one the Normal style and every unstyled cell use.
async function workbookFontName(zip) {
  const first = /<font\b[^>]*>[\s\S]*?<\/font>/.exec((await zipText(zip, 'xl/styles.xml')) || '')?.[0] || '';
  return xmlDecode(/<name\s+val="([^"]*)"/.exec(first)?.[1] || '');
}

/** A chart part, its drawing anchor, and the series read out of the sheet. */
export async function addWorksheetChart(zip, sheet, xml, op, sheets) {
  const block = chartDataBlock(op);
  const source = await chartSourceSheet(zip, sheet, xml, sheets, block.sourceSheet);
  const { categories, categoryDates, series, references } = await readChartData(
    zip,
    source.xml,
    source.sheet,
    op,
    block
  );
  const lit = chartHighlightIndex(op.highlight, categories);
  if (lit >= 0 && series.length === 1) {
    const accent = series[0].color || DEFAULT_SERIES_COLORS[0];
    const muted = op.mutedColor || HIGHLIGHT_MUTED;
    series[0] = { ...series[0], pointColors: categories.map((_, point) => (point === lit ? accent : muted)) };
  }
  const chartPart = nextChartPart(zip);
  zip.file(
    chartPart,
    chartXml({
      chartType: op.chartType,
      title: op.title,
      categories,
      categoryDates,
      series,
      references,
      showValues: op.showValues === true,
      dataLabelPosition: op.dataLabelPosition,
      dataLabelColor: op.dataLabelColor,
      valueNumberFormat: op.valueNumberFormat,
      showLegend: op.showLegend,
      zeroBaseline: op.zeroBaseline,
      // The quiet plot a labelled chart wants: no gridlines, no value axis, when asked.
      axis: { gridlines: op.gridlines !== false, hideValueAxis: op.valueAxis === false },
      font: op.fontName || (await workbookFontName(zip)),
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
  const width = spannedWidth(xml, op, await workbookDigitWidth(zip)) ?? op.width;
  const anchor = chartFrameAnchor({ ...op, width }, anchorCount, chartRelationshipId);
  zip.file(
    drawingPart,
    drawingXml.replace('</xdr:wsDr>', () => `${anchor}</xdr:wsDr>`)
  );
  return {
    op: op.op,
    changed: true,
    sheet: sheet.name,
    chart: chartPart,
    series: series.length,
    ...(chartFit.applied ? { pageFit: 'one-page-wide' } : {}),
  };
}
