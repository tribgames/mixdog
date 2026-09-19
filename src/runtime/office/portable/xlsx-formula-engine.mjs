// Excel formulas evaluated in this process, so a workbook can carry cached
// values on a machine without LibreOffice. The function bodies come from a
// library that implements Excel's own semantics; the tokenizer, the precedence,
// the reference resolution and the coercions are ours. A formula this engine
// cannot read is refused, never guessed: a wrong number inside a model is worse
// than a cell the reader can see was never calculated.
import * as functions from '@formulajs/formulajs';
import { columnLabel, columnNumber, parseCellRef } from './portable-cells.mjs';

const MAX_RANGE_CELLS = 200_000;
const ERROR_VALUE = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|GETTING_DATA)$/;
// Excel's own epoch: day 1 is 1900-01-01 and the calendar keeps its 1900 leap-day bug,
// which puts the zero point at 1899-12-30.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** A formula the engine refuses to evaluate, with the reason the caller reports. */
export class UnsupportedFormula extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'UnsupportedFormula';
    this.reason = reason;
  }
}

export const isFormulaError = (value) => typeof value === 'string' && ERROR_VALUE.test(value);

// A function that answers for an error argument instead of inheriting it: IF
// and its family choose a branch, and the IS tests report on the error itself.
const ERROR_TOLERANT = new Set([
  'IF',
  'IFS',
  'IFERROR',
  'IFNA',
  'ISERROR',
  'ISERR',
  'ISNA',
  'ERROR.TYPE',
  'CHOOSE',
  'SWITCH',
  'NA',
]);

const SCANNERS = [
  ['space', /\s+/y],
  ['string', /"(?:[^"]|"")*"/y],
  ['error', /#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/y],
  // A name followed by "(" is a call, which keeps LOG10( from reading as a cell.
  ['call', /[A-Za-z_][A-Za-z0-9_.]*(?=\s*\()/y],
  // A cell or cell range first, then the whole-column (A:A) and whole-row (1:1)
  // forms — the cell form is tried first so A1:A2 never reads as a column pair.
  [
    'reference',
    /(?:(?:'[^']+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(?:\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d{1,7}:\$?\d{1,7})/y,
  ],
  ['number', /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+/y],
  ['name', /[A-Za-z_][A-Za-z0-9_.]*/y],
  ['operator', /<>|<=|>=|[-+*/^&=<>%]/y],
  ['open', /\(/y],
  ['close', /\)/y],
  ['comma', /,/y],
];

function tokenize(formula) {
  const tokens = [];
  let index = 0;
  while (index < formula.length) {
    let taken = false;
    for (const [type, pattern] of SCANNERS) {
      pattern.lastIndex = index;
      const match = pattern.exec(formula);
      if (!match) continue;
      index = pattern.lastIndex;
      taken = true;
      if (type !== 'space') tokens.push({ type, text: match[0] });
      break;
    }
    if (!taken) throw new UnsupportedFormula(`unreadable character "${formula[index]}"`);
  }
  return tokens;
}

// Excel stores every function it gained after 2007 with an _xlfn. prefix, and a
// worksheet-only one with _xlws. on top of that: the file holds _xlfn.TEXTJOIN
// where the author typed TEXTJOIN. The library implements the name they typed.
const functionName = (text) =>
  text
    .toUpperCase()
    .replace(/^_XLFN\./, '')
    .replace(/^_XLWS\./, '');

// The library groups a dotted family under one owner, so RANK.EQ lives at
// RANK.EQ rather than under the whole name as a key.
const resolveLibraryPath = (name) => name.split('.').reduce((owner, part) => owner?.[part], functions);

// Excel kept every pre-2010 name beside the family it grew into and documents
// the pair as the same calculation — STDEV is STDEV.S, PERCENTILE is
// PERCENTILE.INC. The library ships only the family member, so the older name,
// which is what a workbook of that age still holds, resolves through here.
const LEGACY_FUNCTION_NAMES = new Map([
  ['STDEV', 'STDEV.S'],
  ['VAR', 'VAR.S'],
  ['PERCENTILE', 'PERCENTILE.INC'],
  ['QUARTILE', 'QUARTILE.INC'],
  ['MODE', 'MODE.SNGL'],
  ['RANK', 'RANK.EQ'],
]);

const libraryFunction = (name) => {
  const direct = resolveLibraryPath(name);
  if (typeof direct === 'function') return direct;
  const legacy = LEGACY_FUNCTION_NAMES.get(name);
  return legacy ? resolveLibraryPath(legacy) : direct;
};

class TokenCursor {
  constructor(tokens) {
    this.tokens = tokens;
    this.at = 0;
  }
  peek() {
    return this.tokens[this.at];
  }
  take() {
    return this.tokens[this.at++];
  }
}

const binaryLevel = (operators, next) => (cursor) => {
  let node = next(cursor);
  for (;;) {
    const token = cursor.peek();
    if (token?.type !== 'operator' || !operators.includes(token.text)) return node;
    cursor.take();
    node = { kind: 'binary', operator: token.text, left: node, right: next(cursor) };
  }
};

function parseCallArgs(cursor) {
  cursor.take(); // the "(" the name looked ahead to
  const args = [];
  if (cursor.peek()?.type === 'close') {
    cursor.take();
    return args;
  }
  for (;;) {
    args.push(parseExpression(cursor));
    const next = cursor.take();
    if (!next) throw new UnsupportedFormula('the call is never closed');
    if (next.type === 'close') return args;
    if (next.type !== 'comma') throw new UnsupportedFormula(`unexpected "${next.text}" in a call`);
  }
}

function parsePrimary(cursor) {
  const token = cursor.take();
  if (!token) throw new UnsupportedFormula('the formula ends early');
  if (token.type === 'number') return { kind: 'literal', value: Number(token.text) };
  if (token.type === 'string') return { kind: 'literal', value: token.text.slice(1, -1).replaceAll('""', '"') };
  if (token.type === 'error') return { kind: 'literal', value: token.text };
  if (token.type === 'reference') return { kind: 'reference', text: token.text };
  if (token.type === 'name') {
    const upper = token.text.toUpperCase();
    if (upper === 'TRUE') return { kind: 'literal', value: true };
    if (upper === 'FALSE') return { kind: 'literal', value: false };
    return { kind: 'name', text: token.text };
  }
  if (token.type === 'call') return { kind: 'call', name: functionName(token.text), args: parseCallArgs(cursor) };
  if (token.type === 'open') {
    const expression = parseExpression(cursor);
    const closing = cursor.take();
    if (closing?.type !== 'close') throw new UnsupportedFormula('a group is never closed');
    return expression;
  }
  throw new UnsupportedFormula(`unexpected "${token.text}"`);
}

function parsePostfix(cursor) {
  let node = parsePrimary(cursor);
  while (cursor.peek()?.type === 'operator' && cursor.peek().text === '%') {
    cursor.take();
    node = { kind: 'percent', operand: node };
  }
  return node;
}

function parseUnary(cursor) {
  const token = cursor.peek();
  if (token?.type === 'operator' && (token.text === '-' || token.text === '+')) {
    cursor.take();
    return { kind: 'unary', operator: token.text, operand: parseUnary(cursor) };
  }
  return parsePostfix(cursor);
}

const parsePower = binaryLevel(['^'], parseUnary);
const parseProduct = binaryLevel(['*', '/'], parsePower);
const parseSum = binaryLevel(['+', '-'], parseProduct);
const parseConcat = binaryLevel(['&'], parseSum);
const parseComparison = binaryLevel(['=', '<>', '<', '>', '<=', '>='], parseConcat);
const parseExpression = (cursor) => parseComparison(cursor);

function parse(tokens) {
  const cursor = new TokenCursor(tokens);
  const tree = parseExpression(cursor);
  if (cursor.at < tokens.length) throw new UnsupportedFormula(`unexpected "${tokens[cursor.at].text}"`);
  return tree;
}

const REFERENCE_CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;
const REFERENCE_COLUMN = /^(\$?)([A-Za-z]{1,3})$/;
const REFERENCE_ROW = /^(\$?)(\d{1,7})$/;

function shiftReferencePart(part, rowDelta, columnDelta) {
  const cell = REFERENCE_CELL.exec(part);
  if (cell) {
    const [, columnLock, column, rowLock, row] = cell;
    const movedColumn = columnLock ? column : columnNumber(column.toUpperCase()) + columnDelta;
    const movedRow = rowLock ? Number(row) : Number(row) + rowDelta;
    if ((!columnLock && movedColumn < 1) || (!rowLock && movedRow < 1)) {
      throw new UnsupportedFormula('a shared formula that moves off the sheet');
    }
    return `${columnLock}${columnLock ? column : columnLabel(movedColumn)}${rowLock}${movedRow}`;
  }
  const column = REFERENCE_COLUMN.exec(part);
  if (column) {
    if (column[1]) return part;
    const moved = columnNumber(column[2].toUpperCase()) + columnDelta;
    if (moved < 1) throw new UnsupportedFormula('a shared formula that moves off the sheet');
    return columnLabel(moved);
  }
  const row = REFERENCE_ROW.exec(part);
  if (row) {
    if (row[1]) return part;
    const moved = Number(row[2]) + rowDelta;
    if (moved < 1) throw new UnsupportedFormula('a shared formula that moves off the sheet');
    return String(moved);
  }
  return part;
}

function shiftReference(text, rowDelta, columnDelta) {
  const bang = text.lastIndexOf('!');
  const sheet = bang < 0 ? '' : text.slice(0, bang + 1);
  return (
    sheet +
    text
      .slice(bang + 1)
      .split(':')
      .map((part) => shiftReferencePart(part, rowDelta, columnDelta))
      .join(':')
  );
}

/**
 * The same formula as the cell it was shared from, seen from `rowDelta` rows and
 * `columnDelta` columns away: every relative reference moves with the cell and
 * every one pinned with $ stays where it is.
 * @throws {UnsupportedFormula} when the move would leave the sheet, or the
 * formula is outside what this engine reads.
 */
export function translateSharedFormula(formula, rowDelta, columnDelta) {
  const text = String(formula).replace(/^=/, '');
  if (!rowDelta && !columnDelta) return text;
  return tokenize(text)
    .map((token) => (token.type === 'reference' ? shiftReference(token.text, rowDelta, columnDelta) : token.text))
    .join('');
}

function splitReference(text) {
  const bang = text.lastIndexOf('!');
  const sheet = bang < 0 ? '' : text.slice(0, bang).replace(/^'|'$/g, '').replaceAll("''", "'");
  const body = text
    .slice(bang + 1)
    .replaceAll('$', '')
    .toUpperCase();
  const [from, to] = body.split(':');
  return { sheet, from, to: to || '' };
}

const COLUMN_ONLY = /^[A-Z]{1,3}$/;
const ROW_ONLY = /^\d{1,7}$/;

// A:A names a column of a million rows, of which the sheet uses a few. Excel
// answers from its used range, so this engine asks the workbook for that
// extent and refuses when nothing can tell it — a million empty cells is not
// an answer worth writing into a model.
function rangeCorners(sheet, from, to, context) {
  if (COLUMN_ONLY.test(from) && COLUMN_ONLY.test(to)) {
    const extent = context.extent?.(sheet);
    if (!extent) throw new UnsupportedFormula('a whole-column reference without a known used range');
    return {
      firstColumn: Math.min(columnNumber(from), columnNumber(to)),
      lastColumn: Math.max(columnNumber(from), columnNumber(to)),
      firstRow: 1,
      lastRow: Math.max(1, extent.rows),
    };
  }
  if (ROW_ONLY.test(from) && ROW_ONLY.test(to)) {
    const extent = context.extent?.(sheet);
    if (!extent) throw new UnsupportedFormula('a whole-row reference without a known used range');
    return {
      firstColumn: 1,
      lastColumn: Math.max(1, extent.columns),
      firstRow: Math.min(Number(from), Number(to)),
      lastRow: Math.max(Number(from), Number(to)),
    };
  }
  const start = parseCellRef(from);
  const end = parseCellRef(to);
  return {
    firstColumn: Math.min(columnNumber(start.col), columnNumber(end.col)),
    lastColumn: Math.max(columnNumber(start.col), columnNumber(end.col)),
    firstRow: Math.min(start.row, end.row),
    lastRow: Math.max(start.row, end.row),
  };
}

function rangeValues(sheet, from, to, context) {
  const { firstColumn, lastColumn, firstRow, lastRow } = rangeCorners(sheet, from, to, context);
  if ((lastColumn - firstColumn + 1) * (lastRow - firstRow + 1) > MAX_RANGE_CELLS) {
    throw new UnsupportedFormula('the range is larger than this engine evaluates');
  }
  const rows = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const line = [];
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      line.push(context.value(sheet, `${columnLabel(column)}${row}`));
    }
    rows.push(line);
  }
  return rows;
}

function single(value) {
  // Excel would take the implicit intersection here; this engine does not
  // guess which cell the author meant.
  if (Array.isArray(value)) throw new UnsupportedFormula('a range used where one value is expected');
  return value;
}

/** An empty cell or empty text: what Excel reads as blank. */
export const isBlank = (value) => value == null || value === '';

function toNumber(value) {
  if (isBlank(value)) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (isFormulaError(value)) return value;
  const numeric = Number(String(value).trim());
  return Number.isFinite(numeric) ? numeric : '#VALUE!';
}

function toText(value) {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function ordering(x, y) {
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function arithmetic(operator, left, right) {
  const a = toNumber(single(left));
  if (isFormulaError(a)) return a;
  const b = toNumber(single(right));
  if (isFormulaError(b)) return b;
  if (operator === '+') return a + b;
  if (operator === '-') return a - b;
  if (operator === '*') return a * b;
  if (operator === '/') return b === 0 ? '#DIV/0!' : a / b;
  const power = a ** b;
  return Number.isFinite(power) ? power : '#NUM!';
}

function compare(operator, left, right) {
  const a = single(left);
  const b = single(right);
  let order = null;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = isBlank(a) ? 0 : toNumber(a);
    const y = isBlank(b) ? 0 : toNumber(b);
    if (!isFormulaError(x) && !isFormulaError(y)) order = ordering(x, y);
  }
  if (order === null) order = ordering(toText(a).toUpperCase(), toText(b).toUpperCase());
  if (operator === '=') return order === 0;
  if (operator === '<>') return order !== 0;
  if (operator === '<') return order < 0;
  if (operator === '>') return order > 0;
  if (operator === '<=') return order <= 0;
  return order >= 0;
}

// The library recognises an error by identity — ISERROR compares against its own
// error objects — so an error travelling into IFERROR or ISERROR must be the
// library's own instance, not a copy carrying the same text.
const LIBRARY_ERRORS = new Map(
  Object.values(functions.utils?.errors || {})
    .filter((entry) => entry instanceof Error)
    .map((entry) => [entry.message, entry])
);

function asLibraryError(value) {
  if (Array.isArray(value)) return value.map((entry) => asLibraryError(entry));
  return isFormulaError(value) ? (LIBRARY_ERRORS.get(value) ?? value) : value;
}

// A serial counts calendar days, and the library builds its dates at local
// midnight: reading the UTC instant instead of the wall-clock parts stores 31
// January as 30 January plus fifteen hours on a machine east of UTC, and every
// function that reads the serial back then answers for the wrong day.
function excelSerial(value, parsedFromText = false) {
  if (Number.isNaN(value.getTime())) return '#VALUE!';
  // A date the library read out of text sits at UTC midnight rather than local
  // midnight, and reading it by its wall clock would move it into the next day.
  if (parsedFromText) return (value.getTime() - EXCEL_EPOCH_MS) / DAY_MS;
  const wallClock = Date.UTC(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
    value.getMilliseconds()
  );
  return (wallClock - EXCEL_EPOCH_MS) / DAY_MS;
}

// A library result speaks JavaScript; a worksheet stores Excel's own shapes.
function normalize(value, parsedFromText = false) {
  if (value instanceof Date) return excelSerial(value, parsedFromText);
  if (value instanceof Error) return isFormulaError(value.message) ? value.message : '#VALUE!';
  if (value === undefined) return '';
  if (typeof value === 'number' && !Number.isFinite(value)) return '#NUM!';
  if (Array.isArray(value)) throw new UnsupportedFormula('a function that answers with an array');
  return value;
}

// The library reads a serial as a plain number and renders a date as the day
// before it in this time zone, so a date format code has no answer here worth
// writing into a cell. A number format has one, and keeps working.
// Excel matches "가*" against the cells of a range; the library compares the
// criterion as written and quietly counts nothing. A count of nothing looks
// like an answer, so these are refused instead.
const CRITERIA_FUNCTIONS = new Set([
  'COUNTIF',
  'COUNTIFS',
  'SUMIF',
  'SUMIFS',
  'AVERAGEIF',
  'AVERAGEIFS',
  'MAXIFS',
  'MINIFS',
]);
const WILDCARD_CRITERION = /(?:^|[^~])[*?]/;

// These answer about where a reference sits. This engine hands a function the
// value of a cell rather than the cell itself, so their answer would describe
// something else entirely.
const NEEDS_REFERENCE = new Set(['ROW', 'COLUMN', 'OFFSET', 'INDIRECT', 'ADDRESS', 'CELL', 'AREAS', 'FORMULATEXT']);

// Every date the library builds stands at local midnight — except the one it
// reads out of text, which stands at UTC midnight instead.
const TEXT_PARSED_DATE = new Set(['DATEVALUE']);
const DATE_FORMAT_TOKEN = /[ymdhs]/i;
const unquotedFormat = (text) =>
  String(text)
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '');

function evaluateNode(node, context) {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'reference') {
    const { sheet, from, to } = splitReference(node.text);
    const target = sheet || context.sheet;
    return to ? rangeValues(target, from, to, context) : context.value(target, from);
  }
  // A name the workbook defines as a cell, a range or a constant is that value
  // under another word, and it is read exactly as the definition is written.
  // A name defined as anything else — including one scoped to a single sheet —
  // has no reading here and is refused.
  if (node.kind === 'name') {
    const target = context.definedName?.(node.text);
    if (!target) throw new UnsupportedFormula(`defined name ${node.text}`);
    return evaluateNode(parse(tokenize(String(target).replace(/^=/, ''))), context);
  }
  if (node.kind === 'percent') {
    const value = toNumber(single(evaluateNode(node.operand, context)));
    return isFormulaError(value) ? value : value / 100;
  }
  if (node.kind === 'unary') {
    const value = toNumber(single(evaluateNode(node.operand, context)));
    if (isFormulaError(value)) return value;
    return node.operator === '-' ? -value : value;
  }
  if (node.kind === 'binary') {
    const left = evaluateNode(node.left, context);
    if (isFormulaError(left)) return left;
    const right = evaluateNode(node.right, context);
    if (isFormulaError(right)) return right;
    if (node.operator === '&') return `${toText(single(left))}${toText(single(right))}`;
    if (['=', '<>', '<', '>', '<=', '>='].includes(node.operator)) return compare(node.operator, left, right);
    return arithmetic(node.operator, left, right);
  }
  return evaluateCall(node, context);
}

function evaluateCall(node, context) {
  // An empty cell arrives here as empty text, so ISBLANK would call a blank
  // cell filled. Excel's answer is TRUE, and guessing FALSE is worse than
  // leaving the cell for LibreOffice.
  if (node.name === 'ISBLANK') {
    throw new UnsupportedFormula('ISBLANK, which cannot tell an empty cell from empty text here');
  }
  if (NEEDS_REFERENCE.has(node.name)) {
    throw new UnsupportedFormula(`${node.name}, which answers about a cell this engine reads as a value`);
  }
  const implementation = libraryFunction(node.name);
  if (typeof implementation !== 'function') throw new UnsupportedFormula(`${node.name} is not implemented`);
  const args = node.args.map((argument) => evaluateNode(argument, context));
  if (node.name === 'TEXT' && DATE_FORMAT_TOKEN.test(unquotedFormat(args[1]))) {
    throw new UnsupportedFormula('TEXT with a date format, which this engine cannot render');
  }
  if (
    CRITERIA_FUNCTIONS.has(node.name) &&
    args.some((value) => typeof value === 'string' && WILDCARD_CRITERION.test(value))
  ) {
    throw new UnsupportedFormula(`${node.name} with a wildcard criterion, which this engine does not match`);
  }
  if (!ERROR_TOLERANT.has(node.name)) {
    const failed = args.find((value) => isFormulaError(value));
    if (failed) return failed;
  }
  return normalize(implementation(...args.map((value) => asLibraryError(value))), TEXT_PARSED_DATE.has(node.name));
}

/**
 * The value of one formula, read in the context of its own sheet.
 * `context.value(sheet, ref)` answers with a cell's value and may recurse.
 * @throws {UnsupportedFormula} when the formula is outside what this engine reads.
 */
export function evaluateFormula(formula, context) {
  const text = String(formula || '').replace(/^=/, '');
  if (!text.trim()) throw new UnsupportedFormula('the formula is empty');
  if (/\[[^\]]*\]/.test(text)) throw new UnsupportedFormula('a workbook or table reference');
  return normalize(evaluateNode(parse(tokenize(text)), context));
}
