// Rows or columns inserted into or deleted from one worksheet, with everything in the workbook that names them
// rewritten as Excel rewrites it. The portable writer used to move the cells and nothing that named them: a Report
// total kept SUM(Data!D2:D6) over a region inserted at Data row 6 and read 72,200 where Excel, which wrote
// SUM(Data!D2:D7), read 74,700. Formulas on every sheet, names (the print area among them), conditional formats,
// validations, chart series, pivot sources, filters, links, merges, tables and drawings follow the cells. As Excel 16
// writes them: a range the insert lands inside grows, one that starts at or past it moves; a deleted reference becomes
// #REF! (Data!#REF! from another sheet) and a range that loses part of itself closes up; the inserted cells take the
// formatting of the row above or the column to the left, its height or width included. Whatever this cannot rewrite
// refuses the edit, listed, before anything is changed.
import { posix } from 'node:path';
import { columnLabel, columnNumber, iterateSheetCells, parseCellRef } from './portable-cells.mjs';
import { partRelationshipPath, relationshipTarget, relationshipTargetsByType, zipText } from './portable-opc.mjs';
import { quoteSheetName, shiftWorksheetColumns, shiftWorksheetRows } from './portable-sheet-xml.mjs';
import { setXmlAttribute, xmlDecode, xmlEncode } from './portable-xml.mjs';
import { UnsupportedFormula, formulaReferences, translateSharedFormula } from './xlsx-formula-engine.mjs';

const LIMITS = { rows: 1_048_576, columns: 16_384 };
const REFERENCE_PART = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?$/;

// Excel's rule for one span [start, end] of rows (columns): an insert moves every index at or past `from` on by
// `amount`, so a span that starts there moves whole and one that crosses it grows; a delete takes its indices out and
// closes the rest up, and a span with nothing left is null.
function movedSpan(start, end, move) {
  const { from, amount } = move;
  if (move.insert) {
    const first = start >= from ? start + amount : start;
    if (first > move.limit) return null;
    return [first, Math.min(end >= from ? end + amount : end, move.limit)];
  }
  const last = from + amount - 1;
  const closedUp = (index, fallback) => (index > last ? index - amount : fallback);
  const first = start < from ? start : closedUp(start, from);
  const final = end < from ? end : closedUp(end, from - 1);
  return final < first ? null : [first, final];
}

// Where one row (column) lands; a deleted one is null.
function movedIndex(index, move) {
  const span = movedSpan(index, index, move);
  return span ? span[0] : null;
}

// The rows (columns) a reference body spans, in the direction the edit moves; null for one it cannot reach (a whole
// column under a row edit) or text that is no reference.
function referenceSpan(body, move) {
  const parts = body.split(':');
  const matched = parts.map((part) => REFERENCE_PART.exec(part));
  if (parts.length > 2 || matched.some((match) => !match || (!match[2] && !match[4]))) return null;
  const indices = matched.map((match) =>
    move.rows ? match[4] && Number(match[4]) : match[2] && columnNumber(match[2])
  );
  if (indices.some((index) => !index)) return null;
  return { parts, indices, start: Math.min(...indices), end: Math.max(...indices) };
}

/** One reference body (A1, $A$1:B2, 3:5, C:C) moved; null when its cells are all deleted, the same text when unmoved. */
function movedReference(body, move) {
  const span = referenceSpan(body, move);
  if (!span) return body;
  const moved = movedSpan(span.start, span.end, move);
  if (!moved) return null;
  if (moved[0] === span.start && moved[1] === span.end) return body;
  const reversed = span.indices.length === 2 && span.indices[0] > span.indices[1];
  let values = moved;
  if (span.parts.length === 1) values = [moved[0]];
  else if (reversed) values = [moved[1], moved[0]];
  return span.parts
    .map((part, index) =>
      move.rows
        ? part.replace(/\d+$/, String(values[index]))
        : part.replace(/[A-Za-z]{1,3}/, columnLabel(values[index]))
    )
    .join(':');
}

// Whether the edit cuts through a block (an array formula, a table's columns) rather than moving or removing it whole.
function cutsThrough(body, move) {
  const span = referenceSpan(body, move);
  if (!span) return false;
  if (move.insert) return span.start < move.from && move.from <= span.end;
  const last = move.from + move.amount - 1;
  return Math.max(span.start, move.from) <= Math.min(span.end, last) && !(move.from <= span.start && span.end <= last);
}

const movedAreaList = (list, move) =>
  String(list)
    .split(/\s+/)
    .filter(Boolean)
    .map((area) => movedReference(area, move))
    .filter(Boolean)
    .join(' ');

const unquoted = (name) => (name.startsWith("'") ? name.slice(1, -1).replaceAll("''", "'") : name);
const sameSheet = (name, sheet) => typeof name === 'string' && name.toLowerCase() === sheet.toLowerCase();

// A reference token split into the sheet it names ('My Data'!, Data!, or none) and the cells after it.
function referenceParts(text) {
  const prefix = text.startsWith("'") ? /^'(?:[^']|'')+'!/.exec(text)?.[0] : /^[^!#]+!/.exec(text)?.[0];
  return prefix
    ? { sheet: unquoted(prefix.slice(0, -1)), prefix, body: text.slice(prefix.length) }
    : { sheet: null, prefix: '', body: text };
}

function mentionsSheet(text, sheet) {
  const lower = text.toLowerCase();
  const name = sheet.toLowerCase();
  return lower.includes(name) || lower.includes(name.replaceAll("'", "''"));
}

/**
 * A formula with its references to the moved sheet moved. `home` is the sheet an unqualified reference names — the
 * sheet a cell or rule sits on; none for a workbook name or a chart series.
 * @throws {UnsupportedFormula} when the formula may name the sheet and cannot be read.
 */
function movedFormula(formula, home, move) {
  const text = String(formula ?? '');
  if (!sameSheet(home, move.sheet) && !mentionsSheet(text, move.sheet)) return text;
  let moved = '';
  let at = 0;
  for (const token of formulaReferences(text)) {
    const { sheet, prefix, body } = referenceParts(token.text);
    if (!sameSheet(prefix ? sheet : home, move.sheet)) continue;
    const next = movedReference(body, move);
    if (next === body) continue;
    moved += `${text.slice(at, token.start)}${prefix}${next ?? '#REF!'}`;
    at = token.start + token.text.length;
  }
  return at ? moved + text.slice(at) : text;
}

/**
 * A formula a sort moved `rowDelta` rows, as Excel 16 moves it: a reference on the formula's own sheet follows the
 * row where it is relative (=C6/B6-1 moved to row 2 reads =C2/B2-1, $B6 reads $B2) and stays where it is pinned
 * (B$2, $C$2:$C$6); a reference that names a sheet, its own included (Report!C6, Data!C6), keeps naming the same cell.
 * @throws {UnsupportedFormula} when the formula cannot be read or a reference would move off the sheet.
 */
export function sortedFormula(formula, rowDelta) {
  const text = String(formula ?? '');
  if (!rowDelta) return text;
  let moved = '';
  let at = 0;
  for (const token of formulaReferences(text)) {
    if (referenceParts(token.text).prefix) continue;
    moved += text.slice(at, token.start) + translateSharedFormula(token.text, rowDelta, 0);
    at = token.start + token.text.length;
  }
  return at ? moved + text.slice(at) : text;
}

// A formula with the sheet its references name replaced — by the sheet's new name, or, where the sheet was deleted,
// the whole reference by #REF!. Excel shows SUM(#REF!B2:B4) while the workbook is open but saves SUM(#REF!), and a
// file holding #REF!B2:B4 is one Excel will not open.
function renamedFormula(formula, name, replacement) {
  const text = String(formula ?? '');
  if (!mentionsSheet(text, name)) return text;
  let renamed = '';
  let at = 0;
  for (const token of formulaReferences(text)) {
    const { sheet, prefix, body } = referenceParts(token.text);
    if (!prefix || !sameSheet(sheet, name)) continue;
    renamed += `${text.slice(at, token.start)}${replacement === '#REF!' ? '#REF!' : replacement + body}`;
    at = token.start + token.text.length;
  }
  return at ? renamed + text.slice(at) : text;
}

const FORMULA_ELEMENT = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/;

// Every cell formula of one sheet moved. A shared formula is stored once, in its first cell, with the others holding
// its id; a group any of whose cells would change is written out cell by cell, as the plain formulas Excel shows.
function movedCellFormulas(xml, home, own, move, rewrite, refused) {
  if (!/<f[\s>/]/.test(xml)) return xml;
  const groups = new Map();
  for (const cell of iterateSheetCells(xml)) {
    const element = FORMULA_ELEMENT.exec(cell.body);
    const id = element && /\bt="shared"/.test(element[1]) ? /\bsi="([^"]+)"/.exec(element[1])?.[1] : undefined;
    if (id === undefined) continue;
    const group = groups.get(id) || { cells: [] };
    group.cells.push(cell.ref);
    if (element[2])
      Object.assign(group, {
        master: cell.ref,
        text: xmlDecode(element[2]),
        block: /\bref="([^"]+)"/.exec(element[1])?.[1],
      });
    groups.set(id, group);
  }
  const unshared = new Map();
  for (const group of groups.values()) {
    if (!group.master || (!own && !mentionsSheet(group.text, move.sheet))) continue;
    const origin = parseCellRef(group.master);
    const texts = new Map();
    let changed = own && Boolean(group.block) && movedReference(group.block, move) !== group.block;
    for (const ref of group.cells) {
      const at = parseCellRef(ref);
      let text;
      try {
        text = translateSharedFormula(group.text, at.row - origin.row, columnNumber(at.col) - columnNumber(origin.col));
      } catch (error) {
        if (!(error instanceof UnsupportedFormula)) throw error;
        refused.push(`${home}!${ref} (a shared formula: ${error.reason})`);
        continue;
      }
      const next = rewrite(`${home}!${ref}`, text, home);
      changed ||= next !== text;
      texts.set(ref, next);
    }
    if (changed) for (const [ref, text] of texts) unshared.set(ref, text);
  }
  // A cell written <c .../> holds no formula, and must not be read as opening the cell after it.
  return xml.replace(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g, (whole, attributes, ref, body) => {
    const element = FORMULA_ELEMENT.exec(body);
    if (!element) return whole;
    let replacement;
    if (unshared.has(ref)) replacement = `<f>${xmlEncode(unshared.get(ref))}</f>`;
    else if (/\bt="shared"/.test(element[1])) return whole;
    else if (/\bt="dataTable"/.test(element[1])) {
      if (own) refused.push(`${home}!${ref} (a what-if data table)`);
      return whole;
    } else {
      let elementAttributes = element[1];
      if (own && /\bt="array"/.test(elementAttributes)) {
        const block = /\bref="([^"]+)"/.exec(elementAttributes)?.[1] || ref;
        if (cutsThrough(block, move)) {
          refused.push(`${home}!${block} (an array formula the edit would split)`);
          return whole;
        }
        const movedBlock = movedReference(block, move);
        if (movedBlock) elementAttributes = setXmlAttribute(elementAttributes, 'ref', movedBlock);
      }
      const text = xmlDecode(element[2] || '');
      const next = element[2] === undefined ? text : rewrite(`${home}!${ref}`, text, home);
      if (next === text && elementAttributes === element[1]) return whole;
      replacement =
        element[2] === undefined ? `<f${elementAttributes}/>` : `<f${elementAttributes}>${xmlEncode(next)}</f>`;
    }
    return `<c${attributes}>${body.replace(element[0], () => replacement)}</c>`;
  });
}

// The formulas of a sheet's conditional formats and validations, and of its Excel 2010 extensions (a validation list
// on another sheet, a sparkline's data), which read unqualified references on that sheet.
function movedRuleFormulas(xml, home, rewrite) {
  return xml.replace(/<(formula[12]?|xm:f)>([\s\S]*?)<\/\1>/g, (whole, tag, text) => {
    const decoded = xmlDecode(text);
    const kinds = { formula: 'conditional format', 'xm:f': 'rule' };
    const next = rewrite(`${home} ${kinds[tag] ?? 'validation'}`, decoded, home);
    return next === decoded ? whole : `<${tag}>${xmlEncode(next)}</${tag}>`;
  });
}

const recounted = (xml, container, child) =>
  xml.replace(new RegExp(`<${container}\\b([^>]*)>([\\s\\S]*?)<\\/${container}>`), (_whole, attributes, body) => {
    const count = (body.match(new RegExp(`<${child}\\b(?![\\w:])`, 'g')) || []).length;
    if (!count) return '';
    return `<${container}${/\bcount="/.test(attributes) ? setXmlAttribute(attributes, 'count', count) : attributes}>${body}</${container}>`;
  });

// The moved sheet's own lists of areas: each area moves, one whose cells are all deleted drops out, and an element
// left with none goes, as Excel drops a rule, validation, merge or link whose cells it deleted.
function movedSheetRanges(xml, move, refused) {
  let next = xml;
  for (const tag of ['conditionalFormatting', 'dataValidation', 'ignoredError', 'protectedRange']) {
    next = next.replace(
      new RegExp(`<${tag}\\b([^>]*?)(\\/>|>[\\s\\S]*?<\\/${tag}>)`, 'g'),
      (whole, attributes, rest) => {
        const list = /\bsqref="([^"]*)"/.exec(attributes)?.[1];
        if (list === undefined) return whole;
        const moved = movedAreaList(list, move);
        if (moved === list) return whole;
        return moved ? `<${tag}${setXmlAttribute(attributes, 'sqref', moved)}${rest}` : '';
      }
    );
  }
  next = recounted(next, 'dataValidations', 'dataValidation');
  next = recounted(next, 'ignoredErrors', 'ignoredError');
  next = recounted(next, 'protectedRanges', 'protectedRange');
  next = next.replace(/<xm:sqref>([^<]*)<\/xm:sqref>/g, (whole, list) => {
    const moved = movedAreaList(list, move);
    if (moved === list) return whole;
    if (!moved) refused.push(`${move.sheet} extension rule on ${list} (its cells are all deleted)`);
    return moved ? `<xm:sqref>${moved}</xm:sqref>` : whole;
  });
  // A merge left over one cell is no merge, and Excel drops it.
  const referenced = (tag, dropSingleCell) => (whole, attributes, rest) => {
    const ref = /\bref="([^"]+)"/.exec(attributes)?.[1];
    const moved = ref && movedReference(ref, move);
    if (!ref || moved === ref) return whole;
    if (!moved || (dropSingleCell && /^([^:]+):\1$/.test(moved.replaceAll('$', '')))) return '';
    return `<${tag}${setXmlAttribute(attributes, 'ref', moved)}${rest}`;
  };
  next = next.replace(/<mergeCell\b([^>]*?)(\/>)/g, referenced('mergeCell', true));
  next = recounted(next, 'mergeCells', 'mergeCell');
  next = next.replace(/<hyperlink\b([^>]*?)(\/>|>[\s\S]*?<\/hyperlink>)/g, referenced('hyperlink', false));
  next = next.replace(/<hyperlinks>\s*<\/hyperlinks>/, '');
  next = next.replace(/<sortCondition\b([^>]*?)(\/>)/g, referenced('sortCondition', false));
  next = next.replace(/<sortState\b([^>]*?)(\/>|>[\s\S]*?<\/sortState>)/g, referenced('sortState', false));
  next = next.replace(/<autoFilter\b([^>]*?)(\/>|>[\s\S]*?<\/autoFilter>)/, (whole, attributes, rest) => {
    const ref = /\bref="([^"]+)"/.exec(attributes)?.[1];
    if (ref && !move.rows && /<filterColumn\b/.test(rest) && cutsThrough(ref, move)) {
      refused.push(`${move.sheet} filter criteria on ${ref} (their column numbers would change)`);
      return whole;
    }
    return referenced('autoFilter', false)(whole, attributes, rest);
  });
  next = next.replace(/<dimension\b([^>]*?)\/>/, (whole, attributes) => {
    const ref = /\bref="([^"]+)"/.exec(attributes)?.[1];
    const moved = ref ? movedReference(ref, move) : ref;
    return moved === ref ? whole : `<dimension${setXmlAttribute(attributes, 'ref', moved || 'A1')}/>`;
  });
  // A page break sits above the row (left of the column) its zero-based id names, and moves with it.
  const breaks = move.rows ? 'rowBreaks' : 'colBreaks';
  next = next.replace(new RegExp(`<${breaks}\\b([^>]*)>([\\s\\S]*?)<\\/${breaks}>`), (_whole, attributes, body) => {
    const kept = body.replace(/<brk\b([^>]*?)\/>/g, (brk, brkAttributes) => {
      const id = Number(/\bid="(\d+)"/.exec(brkAttributes)?.[1]);
      const moved = movedIndex(id + 1, move);
      if (moved === id + 1) return brk;
      return moved ? `<brk${setXmlAttribute(brkAttributes, 'id', moved - 1)}/>` : '';
    });
    const count = (kept.match(/<brk\b/g) || []).length;
    if (!count) return '';
    const manual = (kept.match(/<brk\b[^>]*\bman="(?:1|true)"/g) || []).length;
    let breakAttributes = attributes.replace(/\bcount="\d+"/, () => `count="${count}"`);
    breakAttributes = breakAttributes.replace(/\bmanualBreakCount="\d+"/, () => `manualBreakCount="${manual}"`);
    return `<${breaks}${breakAttributes}>${kept}</${breaks}>`;
  });
  return next;
}

// A drawing's corners, zero-based in the file: a frame that moves and sizes with its cells (a two-cell anchor, Excel's
// default) has each corner follow its own row, so an insert inside it makes it taller; one that only moves keeps its
// size; an absolute one stays. A corner on a deleted row lands at the top of the row after the deletion.
function movedAnchors(drawing, move) {
  const tag = move.rows ? 'row' : 'col';
  const indexPattern = new RegExp(`<xdr:${tag}>(\\d+)<\\/xdr:${tag}>`);
  const offsetPattern = new RegExp(`<xdr:${tag}Off>-?\\d+<\\/xdr:${tag}Off>`);
  const place = (block) => {
    const index = Number(indexPattern.exec(block)?.[1]);
    const moved = movedIndex(index + 1, move);
    return { index, next: moved ? moved - 1 : move.from - 1, reset: !moved };
  };
  const written = (block, index, reset) => {
    const moved = block.replace(indexPattern, () => `<xdr:${tag}>${index}</xdr:${tag}>`);
    return reset ? moved.replace(offsetPattern, () => `<xdr:${tag}Off>0</xdr:${tag}Off>`) : moved;
  };
  return drawing.replace(
    /<xdr:(oneCellAnchor|twoCellAnchor)\b([^>]*)>([\s\S]*?)<\/xdr:\1>/g,
    (whole, kind, attributes, body) => {
      const editAs = kind === 'oneCellAnchor' ? 'oneCell' : /\beditAs="([^"]+)"/.exec(attributes)?.[1] || 'twoCell';
      const from = /<xdr:from>([\s\S]*?)<\/xdr:from>/.exec(body);
      if (editAs === 'absolute' || !from) return whole;
      const start = place(from[1]);
      let next = body.replace(from[0], () => `<xdr:from>${written(from[1], start.next, start.reset)}</xdr:from>`);
      const to = kind === 'twoCellAnchor' && /<xdr:to>([\s\S]*?)<\/xdr:to>/.exec(body);
      if (to) {
        const end = place(to[1]);
        const index = editAs === 'oneCell' ? end.index + start.next - start.index : end.next;
        next = next.replace(
          to[0],
          () => `<xdr:to>${written(to[1], index, editAs !== 'oneCell' && end.reset)}</xdr:to>`
        );
      }
      return next === body ? whole : `<xdr:${kind}${attributes}>${next}</xdr:${kind}>`;
    }
  );
}

// A note's box in the sheet's legacy drawing: its cell (zero-based x:Row and x:Column) and the box's corners (x:Anchor:
// left column, offset, top row, offset, right column, offset, bottom row, offset) move by as much as the cell moved;
// a note whose cell is deleted goes.
function movedNoteShape(shape, move) {
  if (!/<x:ClientData\b[^>]*\bObjectType="Note"/.test(shape)) return shape;
  const tag = move.rows ? 'Row' : 'Column';
  const pattern = new RegExp(`<x:${tag}>(\\d+)<\\/x:${tag}>`);
  const index = Number(pattern.exec(shape)?.[1]);
  if (!Number.isFinite(index)) return shape;
  const moved = movedIndex(index + 1, move);
  if (moved === index + 1) return shape;
  if (moved === null) return '';
  const delta = moved - 1 - index;
  return shape
    .replace(pattern, () => `<x:${tag}>${moved - 1}</x:${tag}>`)
    .replace(/<x:Anchor>([^<]*)<\/x:Anchor>/, (_whole, anchor) => {
      const corners = anchor.split(',').map((value) => value.trim());
      for (const position of move.rows ? [2, 6] : [0, 4]) corners[position] = String(Number(corners[position]) + delta);
      return `<x:Anchor>${corners.join(', ')}</x:Anchor>`;
    });
}

// An inserted row takes the row above's formatting — each cell's style, the row's own style and height — and an
// inserted column the column on its left's, as Excel's default insert does; the first row or column takes none.
export function inheritedRows(xml, from, amount) {
  if (from <= 1) return xml;
  const above = new RegExp(`<row\\b([^>]*?\\br="${from - 1}"[^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/row>)`).exec(xml);
  if (!above) return xml;
  const attributes = above[1].replace(/\s+(?:hidden|collapsed)="[^"]*"/g, '');
  const styled = [...iterateSheetCells(above[2] || '')]
    .map((cell) => ({ column: parseCellRef(cell.ref).col, style: /\bs="(\d+)"/.exec(cell.attributes)?.[1] }))
    .filter((cell) => cell.style && cell.style !== '0');
  if (!styled.length && !/\b(?:ht|s)="/.test(attributes)) return xml;
  const rows = Array.from({ length: amount }, (_, offset) => {
    const index = from + offset;
    const cells = styled.map((cell) => `<c r="${cell.column}${index}" s="${cell.style}"/>`).join('');
    return `<row${setXmlAttribute(attributes, 'r', index)}${cells ? `>${cells}</row>` : '/>'}`;
  });
  const end = above.index + above[0].length;
  return `${xml.slice(0, end)}${rows.join('')}${xml.slice(end)}`;
}

function inheritedColumns(xml, from, amount) {
  if (from <= 1) return xml;
  const left = columnLabel(from - 1);
  return xml.replace(
    new RegExp(`<c\\b([^>]*?\\br="${left}(\\d+)"[^>]*?)(\\/>|>[\\s\\S]*?<\\/c>)`, 'g'),
    (whole, attributes, row) => {
      const style = /\bs="(\d+)"/.exec(attributes)?.[1];
      if (!style || style === '0') return whole;
      return (
        whole +
        Array.from({ length: amount }, (_, offset) => `<c r="${columnLabel(from + offset)}${row}" s="${style}"/>`).join(
          ''
        )
      );
    }
  );
}

// Column widths follow their columns; the columns an insert adds join the span of the column on their left.
function movedColumnWidths(xml, move) {
  return xml
    .replace(/<col\b([^>]*?)\/>/g, (whole, attributes) => {
      const min = Number(/\bmin="(\d+)"/.exec(attributes)?.[1]);
      const max = Number(/\bmax="(\d+)"/.exec(attributes)?.[1]);
      if (!min || !max) return whole;
      let span;
      if (!move.insert) span = movedSpan(min, max, move);
      else if (min >= move.from)
        span = min + move.amount > move.limit ? null : [min + move.amount, Math.min(max + move.amount, move.limit)];
      else span = [min, max >= move.from - 1 ? Math.min(max + move.amount, move.limit) : max];
      if (!span) return '';
      if (span[0] === min && span[1] === max) return whole;
      return `<col${setXmlAttribute(setXmlAttribute(attributes, 'min', span[0]), 'max', span[1])}/>`;
    })
    .replace(/<cols>\s*<\/cols>/, '');
}

// The workbook's names (the print area and titles among them) and every chart series, each rewritten by
// `rewrite(where, text, home)` — a local name reads unqualified references on its own sheet — into `writes`.
async function rewriteNamesAndCharts(zip, sheets, rewrite, writes) {
  const workbookPath = 'xl/workbook.xml';
  const workbook = writes.get(workbookPath) ?? ((await zipText(zip, workbookPath)) || '');
  const names = workbook.replace(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g, (whole, attributes, body) => {
    const local = /\blocalSheetId="(\d+)"/.exec(attributes)?.[1];
    const text = xmlDecode(body);
    const where = `name ${xmlDecode(/\bname="([^"]*)"/.exec(attributes)?.[1] || '')}`;
    const next = rewrite(where, text, local === undefined ? null : (sheets[Number(local)]?.name ?? null));
    return next === text ? whole : `<definedName${attributes}>${xmlEncode(next)}</definedName>`;
  });
  if (names !== workbook) writes.set(workbookPath, names);
  for (const part of Object.keys(zip.files).filter((entry) => /^xl\/charts\/chart\d+\.xml$/i.test(entry))) {
    const chart = (await zipText(zip, part)) || '';
    const next = chart.replace(/<(c|c15):f>([\s\S]*?)<\/\1:f>/g, (whole, tag, text) => {
      const decoded = xmlDecode(text);
      const rewritten = rewrite('chart series', decoded, null);
      return rewritten === decoded ? whole : `<${tag}:f>${xmlEncode(rewritten)}</${tag}:f>`;
    });
    if (next !== chart) writes.set(part, next);
  }
}

// The pivot caches that read one sheet, as [part, its XML, the worksheetSource match].
async function pivotSources(zip, sheetName) {
  const found = [];
  for (const part of Object.keys(zip.files).filter((entry) =>
    /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/i.test(entry)
  )) {
    const cache = (await zipText(zip, part)) || '';
    const source = /<worksheetSource\b([^>]*?)\/>/.exec(cache);
    if (source && sameSheet(xmlDecode(/\bsheet="([^"]+)"/.exec(source[1])?.[1] || ''), sheetName))
      found.push([part, cache, source]);
  }
  return found;
}

// Every formula of a sheet rewritten where it stands. A rename reads the same from every cell a shared formula
// reaches, so the group keeps its one stored formula.
function renamedCellFormulas(xml, home, rewrite) {
  if (!/<f[\s>/]/.test(xml)) return xml;
  return xml.replace(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g, (whole, attributes, ref, body) => {
    const element = /<f\b([^>]*?)(?<!\/)>([\s\S]*?)<\/f>/.exec(body);
    if (!element) return whole;
    const text = xmlDecode(element[2]);
    const next = rewrite(`${home}!${ref}`, text, home);
    return next === text
      ? whole
      : `<c${attributes}>${body.replace(element[0], () => `<f${element[1]}>${xmlEncode(next)}</f>`)}</c>`;
  });
}

/**
 * Every reference to one worksheet rewritten for its new name, or for its deletion (`to` null), as Excel saves them:
 * SUM(Data!B2:B4) becomes SUM('자료 2026'!B2:B4), or SUM(#REF!) once Data is gone. Formulas on every sheet, rules,
 * validations, names, chart series and (on a rename) pivot sources follow.
 * @returns {Promise<number>} how many formulas, names and chart series were rewritten.
 * @throws {Error} when a formula naming the sheet cannot be read; nothing is changed then.
 */
export async function renameSheetReferences(zip, sheets, sheet, to, op) {
  const replacement = to == null ? '#REF!' : `${quoteSheetName(to)}!`;
  const refused = [];
  const writes = new Map();
  let rewritten = 0;
  const rewrite = (where, text) => {
    try {
      const next = renamedFormula(text, sheet.name, replacement);
      if (next !== text) rewritten += 1;
      return next;
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      refused.push(`${where} =${text} (${error.reason})`);
      return text;
    }
  };
  for (const other of sheets) {
    if (to == null && other.path === sheet.path) continue;
    const source = await zipText(zip, other.path);
    if (!source) continue;
    const next = movedRuleFormulas(renamedCellFormulas(source, other.name, rewrite), other.name, rewrite);
    if (next !== source) writes.set(other.path, next);
  }
  await rewriteNamesAndCharts(zip, sheets, rewrite, writes);
  if (to != null) {
    for (const [part, cache, source] of await pivotSources(zip, sheet.name)) {
      writes.set(
        part,
        cache.replace(source[0], () => `<worksheetSource${setXmlAttribute(source[1], 'sheet', xmlEncode(to))}/>`)
      );
    }
  }
  if (refused.length) {
    throw new Error(
      `Portable ${op} of ${sheet.name} cannot rewrite ${refused.length} formula(s) that name it: ` +
        `${refused.slice(0, 4).join('; ')}${refused.length > 4 ? '; …' : ''}. Run it on the Office backend ` +
        "(mode:'background'), where Excel rewrites them itself, or change those first."
    );
  }
  for (const [part, text] of writes) zip.file(part, text);
  return rewritten;
}

/**
 * A copied sheet's own references pointed at the copy, as Excel's copy points them: Report!A5 in the copy of Report
 * reads the copy's A5 ('Report 사본'!A5), in its cells, rules and validations.
 * @throws {Error} when a formula naming the sheet cannot be read.
 */
export function copiedSheetXml(xml, source, name) {
  const replacement = `${quoteSheetName(name)}!`;
  const refused = [];
  const rewrite = (where, text) => {
    try {
      return renamedFormula(text, source, replacement);
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      refused.push(`${where} =${text} (${error.reason})`);
      return text;
    }
  };
  const next = movedRuleFormulas(renamedCellFormulas(xml, source, rewrite), source, rewrite);
  if (refused.length) {
    throw new Error(
      `Portable copy_sheet of ${source} cannot point ${refused.length} formula(s) at the copy: ` +
        `${refused.slice(0, 4).join('; ')}${refused.length > 4 ? '; …' : ''}. Run it on the Office backend ` +
        "(mode:'background'), where Excel copies them itself, or change those first."
    );
  }
  return next;
}

// The relationships a sheet owns outright, which a copy needs its own of: two sheets drawing through one drawing part
// is a package Excel will not open. Pictures, printer settings and pivot caches stay shared.
const OWNED_RELATIONSHIP =
  /\/(?:drawing|chart|chartUserShapes|comments|vmlDrawing|chartStyle|chartColorStyle|pivotTable)$/;

async function freePartName(zip, part) {
  const [, stem, extension] = /^(.*?)\d*(\.\w+)$/.exec(part);
  let index = 1;
  while (zip.file(`${stem}${index}${extension}`)) index += 1;
  return `${stem}${index}${extension}`;
}

async function duplicateOwnedPart(zip, part, rewriteChart) {
  const copy = await freePartName(zip, part);
  const content = (await zipText(zip, part)) || '';
  zip.file(copy, /^xl\/charts\/chart\d+\.xml$/i.test(part) ? rewriteChart(content) : content);
  const types = (await zipText(zip, '[Content_Types].xml')) || '';
  const override = new RegExp(
    `<Override\\b[^>]*\\bPartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*\\bContentType="([^"]+)"`
  ).exec(types);
  if (override)
    zip.file(
      '[Content_Types].xml',
      types.replace('</Types>', () => `<Override PartName="/${copy}" ContentType="${override[1]}"/></Types>`)
    );
  await duplicateOwnedRelationships(zip, part, copy, rewriteChart);
  return copy;
}

// The owner's relationships written for its copy, each owned target copied under a new name and the rest shared.
async function duplicateOwnedRelationships(zip, owner, copy, rewriteChart, drop = null) {
  const relsPath = partRelationshipPath(owner);
  const rels = await zipText(zip, relsPath);
  if (!rels) return;
  let next = rels;
  for (const [relationship, attributes] of rels.matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const type = /\bType="([^"]+)"/.exec(attributes)?.[1] || '';
    if (drop?.test(type)) {
      next = next.replace(relationship, '');
      continue;
    }
    if (/\bTargetMode="External"/.test(attributes) || !OWNED_RELATIONSHIP.test(type)) continue;
    const target = relationshipTarget(relsPath, /\bTarget="([^"]+)"/.exec(attributes)?.[1] || '');
    if (!zip.file(target)) continue;
    const copied = await duplicateOwnedPart(zip, target, rewriteChart);
    const relative = posix.relative(posix.dirname(copy), copied);
    next = next.replace(relationship, () => `<Relationship${setXmlAttribute(attributes, 'Target', relative)}/>`);
  }
  zip.file(partRelationshipPath(copy), next);
}

/**
 * What a copied sheet needs beyond its cells, as Excel's copy makes it: its own drawing, charts (their series pointed
 * at the copy) and notes, and its names — each sheet-level name of the source, and each workbook name that reads the
 * source, given to the copy as a sheet-level name reading the copy.
 */
export async function copySheetParts(zip, sheets, source, copy) {
  const replacement = `${quoteSheetName(copy.name)}!`;
  const repoint = (text) => {
    try {
      return renamedFormula(text, source.name, replacement);
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      return text;
    }
  };
  const rewriteChart = (xml) =>
    xml.replace(
      /<(c|c15):f>([\s\S]*?)<\/\1:f>/g,
      (_whole, tag, text) => `<${tag}:f>${xmlEncode(repoint(xmlDecode(text)))}</${tag}:f>`
    );
  await duplicateOwnedRelationships(zip, source.path, copy.path, rewriteChart, /\/table$/);
  const workbookPath = 'xl/workbook.xml';
  const workbook = (await zipText(zip, workbookPath)) || '';
  const sourceIndex = sheets.findIndex((entry) => entry.path === source.path);
  const added = [];
  for (const [, attributes, body] of workbook.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
    const local = /\blocalSheetId="(\d+)"/.exec(attributes)?.[1];
    if (local !== undefined && Number(local) !== sourceIndex) continue;
    const text = xmlDecode(body);
    const repointed = repoint(text);
    if (local === undefined && repointed === text) continue;
    added.push(
      `<definedName${setXmlAttribute(attributes, 'localSheetId', sheets.length)}>${xmlEncode(repointed)}</definedName>`
    );
  }
  if (added.length)
    zip.file(
      workbookPath,
      workbook.replace('</definedNames>', () => `${added.join('')}</definedNames>`)
    );
}

// Excel's record of the order it last calculated formula cells in, by address. Cells that moved leave it naming
// cells that hold none, which Excel repairs with a warning on open, and a deleted sheet leaves it naming a sheet that
// is gone, which Excel will not open at all; without it Excel builds a new one.
export async function dropCalculationChain(zip) {
  if (!zip.file('xl/calcChain.xml')) return;
  zip.remove('xl/calcChain.xml');
  const relsPath = 'xl/_rels/workbook.xml.rels';
  const rels = await zipText(zip, relsPath);
  if (rels) zip.file(relsPath, rels.replace(/<Relationship\b[^>]*\bType="[^"]*\/calcChain"[^>]*\/>/g, ''));
  const types = await zipText(zip, '[Content_Types].xml');
  if (types)
    zip.file('[Content_Types].xml', types.replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
}

// The sheet's tables: a table the edit moves whole follows it, one it would cut or empty is refused.
async function moveTableParts(zip, relationships, sheet, move, writes, refused) {
  const { rows, insert } = move;
  for (const part of relationshipTargetsByType(relationships, sheet.path, 'table').values()) {
    const table = (await zipText(zip, part)) || '';
    const ref = /<table\b[^>]*?\bref="([^"]+)"/.exec(table)?.[1];
    const moved = ref && movedReference(ref, move);
    if (!ref || moved === ref) continue;
    const name = xmlDecode(/<table\b[^>]*?\bdisplayName="([^"]+)"/.exec(table)?.[1] || 'table');
    const header = referenceSpan(ref, move).start;
    if (!moved || (!rows && cutsThrough(ref, move))) {
      refused.push(`table ${name} ${ref} (its ${rows ? 'rows' : 'columns'} would change; Excel rebuilds the table)`);
      continue;
    }
    if (
      rows &&
      !insert &&
      (movedIndex(header, move) === null || referenceSpan(moved, move).start === referenceSpan(moved, move).end)
    ) {
      refused.push(`table ${name} ${ref} (the edit deletes its header or every data row)`);
      continue;
    }
    writes.set(
      part,
      table.replace(
        /(<(?:table|autoFilter)\b[^>]*?\bref=")([^"]+)"/g,
        (_whole, lead, area) => `${lead}${movedReference(area, move) || area}"`
      )
    );
  }
}

// The sheet's pivot tables, notes (with their legacy boxes) and drawings, each moved with the cells it sits on.
async function moveOwnedSheetParts(zip, relationships, sheet, move, writes, refused) {
  for (const part of relationshipTargetsByType(relationships, sheet.path, 'pivotTable').values()) {
    const pivot = (await zipText(zip, part)) || '';
    const location = /<location\b([^>]*?)\/>/.exec(pivot);
    const ref = location && /\bref="([^"]+)"/.exec(location[1])?.[1];
    const moved = ref && movedReference(ref, move);
    if (!ref || moved === ref) continue;
    if (!moved || cutsThrough(ref, move))
      refused.push(`pivot table at ${sheet.name}!${ref} (the edit cuts through it)`);
    else
      writes.set(
        part,
        pivot.replace(location[0], () => `<location${setXmlAttribute(location[1], 'ref', moved)}/>`)
      );
  }
  // A note moves with its cell and goes with it, its box following by as many rows (columns) as the cell moved.
  for (const part of relationshipTargetsByType(relationships, sheet.path, 'comments').values()) {
    const notes = (await zipText(zip, part)) || '';
    const next = notes.replace(
      /<comment\b([^>]*?)\bref="([^"]+)"([^>]*)>([\s\S]*?)<\/comment>/g,
      (whole, before, ref, after, body) => {
        const moved = movedReference(ref, move);
        if (moved === ref) return whole;
        return moved ? `<comment${before}ref="${moved}"${after}>${body}</comment>` : '';
      }
    );
    if (next !== notes) writes.set(part, next);
  }
  for (const part of relationshipTargetsByType(relationships, sheet.path, 'vmlDrawing').values()) {
    const vml = (await zipText(zip, part)) || '';
    const next = vml.replace(/<v:shape\b[\s\S]*?<\/v:shape>/g, (shape) => movedNoteShape(shape, move));
    if (next !== vml) writes.set(part, next);
  }
  for (const part of relationshipTargetsByType(relationships, sheet.path, 'drawing').values()) {
    const drawing = (await zipText(zip, part)) || '';
    const next = movedAnchors(drawing, move);
    if (next !== drawing) writes.set(part, next);
  }
}

/**
 * Inserts or deletes rows (columns) of one worksheet and moves everything in the workbook that names them.
 * @returns {Promise<number>} how many formulas, names and chart series were rewritten.
 * @throws {Error} when something naming the moved cells cannot be rewritten; nothing is changed then.
 */
export async function shiftWorksheetCells(zip, sheets, sheet, xml, { rows, from, amount, insert, op }) {
  const move = { sheet: sheet.name, rows, from, amount, insert, limit: rows ? LIMITS.rows : LIMITS.columns };
  const refused = [];
  const writes = new Map();
  let rewritten = 0;
  const rewrite = (where, text, home) => {
    try {
      const next = movedFormula(text, home, move);
      if (next !== text) rewritten += 1;
      return next;
    } catch (error) {
      if (!(error instanceof UnsupportedFormula)) throw error;
      refused.push(`${where} =${text} (${error.reason})`);
      return text;
    }
  };
  for (const other of sheets) {
    const own = other.path === sheet.path;
    const source = own ? xml : await zipText(zip, other.path);
    if (!source) continue;
    let next = movedRuleFormulas(
      movedCellFormulas(source, other.name, own, move, rewrite, refused),
      other.name,
      rewrite
    );
    if (own) next = movedSheetRanges(next, move, refused);
    if (next !== source || own) writes.set(other.path, next);
  }
  await rewriteNamesAndCharts(zip, sheets, rewrite, writes);
  for (const [part, cache, source] of await pivotSources(zip, sheet.name)) {
    const ref = /\bref="([^"]+)"/.exec(source[1])?.[1];
    const moved = ref && movedReference(ref, move);
    if (moved === null) refused.push(`pivot source ${sheet.name}!${ref} (its cells are all deleted)`);
    else if (moved !== ref)
      writes.set(
        part,
        cache.replace(source[0], () => `<worksheetSource${setXmlAttribute(source[1], 'ref', moved)}/>`)
      );
  }
  const relationships = await zipText(zip, partRelationshipPath(sheet.path));
  await moveTableParts(zip, relationships, sheet, move, writes, refused);
  await moveOwnedSheetParts(zip, relationships, sheet, move, writes, refused);
  if (refused.length) {
    const where = rows ? `row ${from}` : `column ${columnLabel(from)}`;
    throw new Error(
      `Portable ${op} at ${sheet.name} ${where} cannot rewrite ${refused.length} thing(s) that name the cells it moves: ` +
        `${refused.slice(0, 4).join('; ')}${refused.length > 4 ? '; …' : ''}. Run the edit on the Office backend ` +
        "(mode:'background'), where Excel rewrites them itself, or change those first."
    );
  }
  let moved = writes.get(sheet.path);
  const delta = insert ? amount : -amount;
  moved = rows ? shiftWorksheetRows(moved, from, delta) : shiftWorksheetColumns(moved, from, delta);
  if (insert) moved = rows ? inheritedRows(moved, from, amount) : inheritedColumns(moved, from, amount);
  if (!rows) moved = movedColumnWidths(moved, move);
  writes.set(sheet.path, moved);
  for (const [part, text] of writes) zip.file(part, text);
  await dropCalculationChain(zip);
  return rewritten;
}
