// The Excel HTML route, second half: each measured sheet becomes a worksheet on a column grid cut at every edge the
// browser drew — a card's border and its text's, a table's cells, a chart's frame — so the layout lands on columns and
// rows of the widths and heights it had. Texts become values (numbers where a table cell holds a figure, formulas
// where data-formula names one) in their type and alignment, merged across the cells they span; boxes become fills
// and rules; charts become native charts over their data; and the page is set to print as one sheet. Everything is
// written through the portable writer's own operations, so the workbook is ordinary, editable Excel.
import { createPortableOoxmlDocument } from '../portable/portable-package.mjs';
import { applyPortableOoxmlBatch } from '../portable/portable-ooxml.mjs';
import { typedNumber } from '../portable/portable-xlsx-sheet-edits.mjs';

const PX_TO_PT = 0.75;
const SNAP = 2;
const CHART_DATA_SHEET = '차트 데이터';

const columnLabel = (number) => {
  let value = number;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
};
const quoted = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${String(name).replaceAll("'", "''")}'`);

// Excel's column width is in characters of the workbook's digit (7 px for the default Calibri 11): px = 7w + 5 from
// one character up, 12 px per character under it.
const columnCharacters = (px) => (px >= 12 ? (px - 5) / 7 : Math.max(0.08, px / 12));

// The distinct edges of every box, snapped: within two pixels is one edge.
function edges(values, extent) {
  const sorted = [0, ...values, extent].filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const out = [];
  for (const value of sorted) if (!out.length || value - out.at(-1) > SNAP) out.push(value);
  return out;
}
const indexOf = (list, value) => {
  let best = 0;
  for (let index = 1; index < list.length; index += 1)
    if (Math.abs(list[index] - value) < Math.abs(list[best] - value)) best = index;
  return best;
};

// A table cell's text as a value: a figure is a number in the format it was written in ("184,200" → #,##0, "+12.0%"
// → +0.0%), an ISO date is a date; data-value and data-format override, data-formula writes a formula.
function cellContent(item, { figures = false } = {}) {
  if (item.formula)
    return { formula: item.formula.startsWith('=') ? item.formula : `=${item.formula}`, format: item.format };
  if (item.value !== undefined) {
    return { value: item.value, format: item.format };
  }
  const text = String(item.text || '');
  if (figures) {
    const figure = typedNumber(text.trim().replace(/^−/, '-'));
    if (figure) {
      const numberText = text.trim();
      const percent = numberText.endsWith('%');
      const [whole, decimals = ''] = numberText.replace(/%$/, '').split('.');
      const { value } = figure;
      const fraction = decimals ? `.${'0'.repeat(decimals.length)}` : '';
      const grouped = whole.includes(',') || Math.abs(value) >= 1000 ? '#,##0' : '0';
      let format = `${percent ? '0' : grouped}${fraction}${percent ? '%' : ''}`;
      if (numberText.startsWith('+')) format = `+${format};-${format};${format}`;
      return { value, format: item.format || format };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { value: text, format: item.format || 'yyyy-mm-dd' };
  }
  return { value: text, format: item.format };
}

// A chart's data-chart spec as add_chart reads it. One series with one colour set apart is a highlight.
function chartOperation(chart, sheet, anchor, range) {
  const spec = chart.spec || {};
  const type =
    { col: 'column', column: 'column', bar: 'bar', line: 'line', area: 'area', pie: 'pie', doughnut: 'doughnut' }[
      String(spec.type || 'col').toLowerCase()
    ] || 'column';
  const colors = Array.isArray(spec.colors) ? spec.colors.map((color) => String(color).replace(/^#/, '')) : [];
  const single = !Array.isArray(spec.series);
  let palette = colors;
  let highlight;
  let muted;
  if (single && colors.length > 1 && !['pie', 'doughnut'].includes(type)) {
    const counts = new Map();
    for (const color of colors) counts.set(color, (counts.get(color) || 0) + 1);
    const odd = colors.findIndex((color) => counts.get(color) === 1);
    if (counts.size === 2 && odd >= 0) {
      highlight = odd;
      palette = [colors[odd]];
      muted = colors.find((color) => color !== colors[odd]);
    }
  }
  return {
    op: 'add_chart',
    sheet,
    range,
    cell: anchor.cell,
    toColumn: anchor.toColumn,
    height: Math.round(chart.rect.bottom - chart.rect.top) * PX_TO_PT,
    chartType: type,
    ...(chart.title ? { title: chart.title } : {}),
    ...(palette.length ? { seriesColors: palette } : {}),
    ...(highlight !== undefined ? { highlight, mutedColor: muted } : {}),
    showValues: spec.showValues !== false,
    showLegend: Boolean(spec.legend),
    gridlines: Boolean(spec.grid),
    valueAxis: spec.valueAxis === true,
    zeroBaseline: true,
    ...(spec.format ? { valueNumberFormat: spec.format } : {}),
    ...(chart.font ? { fontName: chart.font } : {}),
  };
}

// `{id}` in a formula or a chart's data-range is the cell the element with that id landed on — qualified with its
// sheet when the formula stands on another — so the HTML names its cells without knowing the grid they land on.
const PLACEHOLDER = /\{([A-Za-z][\w-]*)\}/g;
function resolvePlaceholders(text, sheet, cells, notes) {
  return String(text).replace(PLACEHOLDER, (whole, id) => {
    const cell = cells.get(id);
    if (!cell) {
      notes.push(`{${id}} names no element with that id; it was left as written`);
      return whole;
    }
    return cell.sheet === sheet ? cell.cell : `${quoted(cell.sheet)}!${cell.cell}`;
  });
}

// A chart's range, area by area: an area named by placeholders takes its sheet once, at its front ('보고'!B14:B18).
function resolveRange(text, cells, notes) {
  return String(text)
    .split(',')
    .map((area) => {
      const ids = [...area.matchAll(PLACEHOLDER)].map((match) => match[1]);
      const sheet = ids.map((id) => cells.get(id)?.sheet).find(Boolean);
      if (!ids.length || !sheet) return resolvePlaceholders(area, '', cells, notes);
      return `${quoted(sheet)}!${resolvePlaceholders(area, sheet, cells, notes).trim()}`;
    })
    .join(',');
}

/** The operations that write one measured workbook; formulas and charts come after every sheet's values. */
function xlsxOperationsFromSheets(sheets, { captures = new Map(), notes = [] } = {}) {
  const first = [];
  const later = [];
  const chartData = [];
  const placed = new Map();
  sheets.forEach((sheet, sheetIndex) => {
    const name = sheet.name;
    first.push(sheetIndex === 0 ? { op: 'rename_sheet', sheet: 'Sheet1', name } : { op: 'add_sheet', name });
    const cells = sheet.tables.flatMap((table) => table.rows.flat());
    const rects = [...sheet.texts, ...sheet.boxes, ...cells, ...sheet.charts, ...sheet.pictures].map(
      (item) => item.rect
    );
    // The sheet ends where its content does, plus the section's own right and bottom padding: a section left at the
    // page's width (a data sheet) gave its last column the rest of the browser window.
    const right = Math.max(...rects.map((rect) => rect.right), 1);
    const bottom = Math.max(...rects.map((rect) => rect.bottom), 1);
    const xs = edges(
      rects.flatMap((rect) => [rect.left, rect.right]),
      right + (sheet.padRight || 0)
    );
    const ys = edges(
      rects.flatMap((rect) => [rect.top, rect.bottom]),
      bottom + (sheet.padBottom || 0)
    );
    const span = (rect) => {
      const c0 = indexOf(xs, rect.left);
      const c1 = Math.max(c0 + 1, indexOf(xs, rect.right));
      const r0 = indexOf(ys, rect.top);
      const r1 = Math.max(r0 + 1, indexOf(ys, rect.bottom));
      return {
        c0,
        c1,
        r0,
        r1,
        range: `${columnLabel(c0 + 1)}${r0 + 1}:${columnLabel(c1)}${r1}`,
        cell: `${columnLabel(c0 + 1)}${r0 + 1}`,
      };
    };
    // Columns and rows at the widths and heights the browser drew.
    for (let index = 0; index < xs.length - 1; index += 1) {
      first.push({
        op: 'set_column_width',
        sheet: name,
        column: columnLabel(index + 1),
        width: Math.round(columnCharacters(xs[index + 1] - xs[index]) * 100) / 100,
      });
    }
    for (let index = 0; index < ys.length - 1; index += 1) {
      first.push({
        op: 'set_row_height',
        sheet: name,
        row: index + 1,
        height: Math.round((ys[index + 1] - ys[index]) * PX_TO_PT * 100) / 100,
      });
    }
    first.push({
      op: 'set_style',
      sheet: name,
      range: `A1:${columnLabel(xs.length - 1)}${ys.length - 1}`,
      properties: { ...(sheet.font ? { fontName: sheet.font } : {}) },
    });
    // Boxes, outer first so a card's fill sits over its panel's: the fill on every cell, each rule on its edge.
    const sideRanges = (s) => ({
      top: `${columnLabel(s.c0 + 1)}${s.r0 + 1}:${columnLabel(s.c1)}${s.r0 + 1}`,
      bottom: `${columnLabel(s.c0 + 1)}${s.r1}:${columnLabel(s.c1)}${s.r1}`,
      left: `${columnLabel(s.c0 + 1)}${s.r0 + 1}:${columnLabel(s.c0 + 1)}${s.r1}`,
      right: `${columnLabel(s.c1)}${s.r0 + 1}:${columnLabel(s.c1)}${s.r1}`,
    });
    const decorate = (item) => {
      const s = span(item.rect);
      if (item.fill) first.push({ op: 'set_style', sheet: name, range: s.range, properties: { fillColor: item.fill } });
      if (item.borders) {
        const ranges = sideRanges(s);
        for (const [edge, border] of Object.entries(item.borders)) {
          if (border)
            first.push({
              op: 'set_style',
              sheet: name,
              range: ranges[edge],
              properties: { borders: { [edge]: border } },
            });
        }
      }
    };
    const area = (rect) => (rect.right - rect.left) * (rect.bottom - rect.top);
    for (const box of [...sheet.boxes].sort((a, b) => area(b.rect) - area(a.rect))) decorate(box);
    // Texts and table cells: the value at the top-left, merged across the cells the text spans, in its own type.
    const write = (item, { figures = false, merge = true } = {}) => {
      const s = span(item.rect);
      if (item.id) placed.set(item.id, { sheet: name, cell: s.cell });
      if (item.fill || item.borders) decorate(item);
      if (merge && (s.c1 - s.c0 > 1 || s.r1 - s.r0 > 1)) first.push({ op: 'merge_cells', sheet: name, range: s.range });
      const content = cellContent(item, { figures });
      if (content.formula) later.push({ op: 'set_formula', sheet: name, cell: s.cell, formula: content.formula });
      else if (content.value !== '' && content.value !== undefined)
        first.push({ op: 'set_range', sheet: name, range: s.cell, values: [[content.value]] });
      // data-note: the figure's source or assumption, as the cell's note.
      if (item.note) later.push({ op: 'add_note', sheet: name, cell: s.cell, text: item.note });
      const wrap = item.lines > 1;
      first.push({
        op: 'set_style',
        sheet: name,
        range: merge ? s.range : s.cell,
        properties: {
          ...(item.font ? { fontName: item.font } : {}),
          fontSize: item.size,
          bold: item.bold,
          italic: item.italic,
          color: item.color,
          horizontalAlignment: item.align,
          verticalAlignment: item.valign || (wrap ? 'top' : 'center'),
          ...(wrap ? { wrapText: true } : {}),
          ...(item.indent ? { indent: item.indent } : {}),
          ...(content.format ? { numberFormat: content.format } : {}),
        },
      });
    };
    for (const text of sheet.texts) write(text);
    for (const table of sheet.tables) {
      const named = Boolean(table.name);
      for (const row of table.rows) for (const cell of row) write(cell, { figures: !cell.header, merge: !named });
      if (!table.rows.length) continue;
      const corners = span(table.rect);
      const tableRange = `${columnLabel(corners.c0 + 1)}${corners.r0 + 1}:${columnLabel(corners.c1)}${corners.r1}`;
      if (named)
        first.push({
          op: 'add_table',
          sheet: name,
          range: tableRange,
          name: table.name,
          style: table.style || 'TableStyleLight1',
        });
      if (table.freezeHeader) later.push({ op: 'freeze_panes', sheet: name, row: corners.r0 + 2 });
      if (table.rows[0]?.some((cell) => cell.header) && !sheet.charts.length && !sheet.boxes.length) {
        later.push({ op: 'set_page_setup', sheet: name, printTitleRows: `${corners.r0 + 1}` });
      }
    }
    // Charts over their data: the data-range given, else the spec's labels and values in the hidden data sheet.
    for (const chart of sheet.charts) {
      const s = span(chart.rect);
      let range = chart.range;
      if (!range) {
        const spec = chart.spec || {};
        const series = Array.isArray(spec.series)
          ? spec.series
          : [{ name: spec.name || chart.title || '값', values: spec.values || [] }];
        const labels = Array.isArray(spec.labels) ? spec.labels : [];
        const start = chartData.reduce((row, block) => row + block.length + 1, 1);
        const block = [
          ['', ...series.map((entry) => entry.name || '')],
          ...labels.map((label, index) => [
            String(label),
            ...series.map((entry) => Number(entry.values?.[index] ?? 0)),
          ]),
        ];
        chartData.push(block);
        range = `${quoted(CHART_DATA_SHEET)}!A${start}:${columnLabel(series.length + 1)}${start + block.length - 1}`;
      }
      later.push(chartOperation(chart, name, { cell: s.cell, toColumn: columnLabel(s.c1) }, range));
    }
    for (const picture of sheet.pictures) {
      const path = captures.get(picture.capture);
      if (!path) continue;
      const s = span(picture.rect);
      later.push({
        op: 'add_image',
        sheet: name,
        path,
        cell: s.cell,
        width: (picture.rect.right - picture.rect.left) * PX_TO_PT,
        height: (picture.rect.bottom - picture.rect.top) * PX_TO_PT,
        altText: picture.alt || 'picture',
      });
    }
    // The sheet as the HTML showed it: no gridlines unless asked, printed one page wide (one page for a report).
    later.push({ op: 'set_sheet_view', sheet: name, showGridlines: Boolean(sheet.gridlines) });
    const report = sheet.charts.length || sheet.boxes.length || sheet.texts.length;
    later.push({
      op: 'set_page_setup',
      sheet: name,
      printArea: `A1:${columnLabel(xs.length - 1)}${ys.length - 1}`,
      orientation: sheet.orientation || ((xs.at(-1) || 0) > (ys.at(-1) || 0) ? 'landscape' : 'portrait'),
      fitToPagesWide: 1,
      ...(report || sheet.fit === 'page' ? { fitToPagesTall: 1 } : {}),
    });
    if (sheet.freeze) later.push({ op: 'freeze_panes', sheet: name, row: Number(sheet.freeze) });
    if (sheet.hidden) later.push({ op: 'set_sheet_visibility', sheet: name, visible: false });
  });
  if (chartData.length) {
    first.push({ op: 'add_sheet', name: CHART_DATA_SHEET });
    let row = 1;
    for (const block of chartData) {
      first.push({
        op: 'set_range',
        sheet: CHART_DATA_SHEET,
        range: `A${row}:${columnLabel(block[0].length)}${row + block.length - 1}`,
        values: block,
      });
      row += block.length + 1;
    }
    later.push({ op: 'set_sheet_visibility', sheet: CHART_DATA_SHEET, visible: false });
  }
  for (const operation of later) {
    if (operation.op === 'set_formula')
      operation.formula = resolvePlaceholders(operation.formula, operation.sheet, placed, notes);
    if (operation.op === 'add_chart') operation.range = resolveRange(operation.range, placed, notes);
  }
  return [...first, ...later];
}

/** Writes the measured sheets to `output` as an .xlsx. */
export async function buildXlsxFromSheets(measure, output, { captures = new Map(), title = '' } = {}) {
  if (!measure.sheets.length) {
    throw new Error(
      'The HTML holds no <section data-sheet="이름">; every worksheet is one section with its sheet name.'
    );
  }
  await createPortableOoxmlDocument(output, { fileKind: 'xlsx', title, sheetName: 'Sheet1' });
  const notes = [];
  const operations = xlsxOperationsFromSheets(measure.sheets, { captures, notes });
  await applyPortableOoxmlBatch(output, 'xlsx', operations);
  return { operations: operations.length, notes };
}
