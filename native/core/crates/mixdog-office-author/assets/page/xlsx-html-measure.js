const PT = 0.75;
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'system-ui', 'cursive', 'fantasy']);

// The notes of what was left out, the pictures to photograph, and the sheet being read with its box (the origin
// of every position).
let reading;

const n = (value) => parseFloat(value) || 0;

function hex(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!match) return null;
  const parts = match[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(parseFloat);
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (!(alpha > 0.04)) return null;
  return [0, 1, 2]
    .map((index) =>
      Math.round(parts[index] * alpha + 255 * (1 - alpha))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')
    .toUpperCase();
}

function face(cs) {
  const first = String(cs.fontFamily || '')
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');
  return GENERIC.has(first.toLowerCase()) ? '' : first;
}

function visible(el) {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

function side(cs, name) {
  const width = n(cs[`border${name}Width`]);
  const style = cs[`border${name}Style`];
  const color = hex(cs[`border${name}Color`]);
  if (!(width > 0) || ['none', 'hidden'].includes(style) || !color) return null;
  return {
    style: width >= 2.5 ? 'medium' : style === 'dashed' ? 'dashed' : style === 'dotted' ? 'dotted' : 'thin',
    color,
  };
}

function bordersOf(cs) {
  const sides = {
    top: side(cs, 'Top'),
    right: side(cs, 'Right'),
    bottom: side(cs, 'Bottom'),
    left: side(cs, 'Left'),
  };
  return Object.values(sides).some(Boolean) ? sides : null;
}

function describe(el) {
  return `<${el.localName}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}>`;
}

function alignOf(cs) {
  const value = String(cs.textAlign || '');
  if (value === 'center') return 'center';
  if (value === 'right' || value === 'end') return 'right';
  return 'left';
}

function typeOf(cs) {
  const weight = Number(cs.fontWeight) || (cs.fontWeight === 'bold' ? 700 : 400);
  return {
    font: face(cs),
    size: Math.round(n(cs.fontSize) * PT * 2) / 2,
    bold: weight >= 600,
    italic: cs.fontStyle === 'italic',
    color: hex(cs.color) || '000000',
  };
}

function textOf(el) {
  return (el.innerText || el.textContent || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function hasBlockChildren(el) {
  return [...el.children].some(
    (child) =>
      visible(child) &&
      !['inline', 'inline-block', 'contents'].includes(getComputedStyle(child).display) &&
      child.localName !== 'br'
  );
}

function hasOwnText(el) {
  return [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
}

// Lines counted from the text's own height: a cell stretched by its row (a table that is a grid item stretches to
// the tallest item beside it) holds one line in a tall box.
function lines(el, cs) {
  const line = cs.lineHeight === 'normal' ? n(cs.fontSize) * 1.25 : n(cs.lineHeight);
  const range = document.createRange();
  range.selectNodeContents(el);
  const tops = new Set(
    [...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top / Math.max(1, line / 2)))
  );
  const height = range.getBoundingClientRect().height;
  return Math.max(1, tops.size > 1 ? Math.round(height / Math.max(1, line)) : 1);
}

function rel(r) {
  const { origin } = reading;
  return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
}

function indentOf(cs) {
  return alignOf(cs) === 'left' && n(cs.paddingLeft) >= 6 ? 1 : 0;
}

function cellValue(el) {
  const value = { text: textOf(el), ...(el.id ? { id: el.id } : {}) };
  if (el.dataset.formula) value.formula = el.dataset.formula;
  if (el.dataset.value !== undefined) value.value = el.dataset.value;
  if (el.dataset.format) value.format = el.dataset.format;
  if (el.dataset.note) value.note = el.dataset.note;
  return value;
}

function textItem(el, cs) {
  reading.sheet.texts.push({
    rect: rel(el.getBoundingClientRect()),
    ...cellValue(el),
    ...typeOf(cs),
    align: alignOf(cs),
    lines: lines(el, cs),
    indent: indentOf(cs),
  });
}

function boxItem(el, cs) {
  const fill = hex(cs.backgroundColor);
  const borders = bordersOf(cs);
  if (fill || borders)
    reading.sheet.boxes.push({
      rect: rel(el.getBoundingClientRect()),
      ...(fill ? { fill } : {}),
      ...(borders ? { borders } : {}),
    });
}

function chartItem(el, cs) {
  const { sheet, notes } = reading;
  let spec = null;
  try {
    spec = JSON.parse(el.dataset.chart);
  } catch (error) {
    notes.push(`${sheet.name} ${describe(el)}: data-chart is not valid JSON (${error.message})`);
  }
  if (spec)
    sheet.charts.push({
      rect: rel(el.getBoundingClientRect()),
      spec,
      range: el.dataset.range || '',
      title: el.dataset.title || spec.title || '',
      font: face(cs),
      alt: el.dataset.alt || '',
    });
}

function pictureItem(el) {
  reading.captures += 1;
  el.setAttribute('data-xlsx-capture', String(reading.captures));
  reading.sheet.pictures.push({
    rect: rel(el.getBoundingClientRect()),
    capture: reading.captures,
    alt: el.getAttribute('alt') || el.getAttribute('aria-label') || el.dataset.alt || '',
  });
}

function tableItem(el) {
  const { sheet, notes } = reading;
  const table = {
    name: el.dataset.table || '',
    style: el.dataset.tableStyle || '',
    rect: rel(el.getBoundingClientRect()),
    freezeHeader: el.dataset.freeze === 'header',
    rows: [],
  };
  for (const row of el.rows) {
    if (!visible(row)) continue;
    const cells = [];
    for (const cell of row.cells) {
      if (!visible(cell)) continue;
      const ccs = getComputedStyle(cell);
      const fill = hex(ccs.backgroundColor) || hex(getComputedStyle(row).backgroundColor);
      const rect = rel(cell.getBoundingClientRect());
      const valign = { top: 'top', bottom: 'bottom' }[ccs.verticalAlign] || '';
      cells.push({
        rect,
        ...cellValue(cell),
        ...typeOf(ccs),
        align: alignOf(ccs),
        ...(valign ? { valign } : {}),
        lines: lines(cell, ccs),
        header: cell.localName === 'th' || row.parentElement === el.tHead,
        ...(fill ? { fill } : {}),
        ...(bordersOf(ccs) ? { borders: bordersOf(ccs) } : {}),
        indent: indentOf(ccs),
      });
      // A spanning cell merges across the rows its box covers; an Excel table (data-table) holds no merges.
      if ((cell.rowSpan > 1 || cell.colSpan > 1) && el.dataset.table)
        notes.push(`${sheet.name}: a data-table cannot merge; the spanning cell keeps its first cell`);
    }
    table.rows.push(cells);
  }
  sheet.tables.push(table);
}

function walk(el) {
  const { sheet, notes } = reading;
  for (const child of el.children) {
    if (!visible(child)) continue;
    const cs = getComputedStyle(child);
    const tag = child.localName;
    if (['absolute', 'fixed'].includes(cs.position))
      notes.push(
        `${sheet.name} ${describe(child)}: position ${cs.position} is placed where it lies; check the cell it lands on`
      );
    if (child.hasAttribute('data-chart')) {
      chartItem(child, cs);
      continue;
    }
    if (tag === 'img' || tag === 'svg' || tag === 'canvas') {
      pictureItem(child);
      continue;
    }
    if (tag === 'table') {
      tableItem(child);
      continue;
    }
    boxItem(child, cs);
    if (hasBlockChildren(child)) walk(child);
    else if (textOf(child)) textItem(child, cs);
    if (hasOwnText(child) && hasBlockChildren(child))
      notes.push(`${sheet.name} ${describe(child)}: text beside blocks is left out; wrap it in its own element`);
  }
}

// An empty sheet with the settings its section declares.
function sheetOf(section, origin) {
  const sectionPadding = getComputedStyle(section);
  const sheet = {
    name: section.dataset.sheet,
    width: origin.width,
    height: origin.height,
    padRight: n(sectionPadding.paddingRight),
    padBottom: n(sectionPadding.paddingBottom),
    gridlines: section.dataset.gridlines === 'show',
    freeze: section.dataset.freeze || '',
    fit: section.dataset.fit || '',
    orientation: section.dataset.orientation || '',
    hidden: section.dataset.hidden === 'true',
    texts: [],
    boxes: [],
    tables: [],
    charts: [],
    pictures: [],
  };
  sheet.font = face(getComputedStyle(section));
  return sheet;
}
/**
 * Runs inside the page (page.evaluate): self-contained.
 * @returns {{ sheets: object[], notes: string[], captures: number }}
 */
function extractXlsxSheets() {
  reading = { notes: [], captures: 0, origin: null, sheet: null };
  const sheets = [];
  for (const section of document.querySelectorAll('section[data-sheet]')) {
    if (!visible(section)) continue;
    const origin = section.getBoundingClientRect();
    reading.origin = origin;
    reading.sheet = sheetOf(section, origin);
    walk(section);
    sheets.push(reading.sheet);
  }
  return { sheets, notes: reading.notes, captures: reading.captures };
}