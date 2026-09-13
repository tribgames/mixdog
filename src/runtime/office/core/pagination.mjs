const DEFAULT_LIMITS = Object.freeze({
  docx: 200,
  xlsx: 2_000,
  pptx: 20,
  csv: 2_000,
  tsv: 2_000,
  pdf: 20,
});

const MAX_LIMITS = Object.freeze({
  docx: 2_000,
  xlsx: 10_000,
  pptx: 100,
  csv: 10_000,
  tsv: 10_000,
  pdf: 100,
});

function normalizedPages(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((page) => Number.isInteger(page) && page > 0))];
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    if (!decoded || decoded.version !== 1) throw new Error('unsupported cursor version');
    return decoded;
  } catch {
    throw new Error('Invalid Office snapshot cursor');
  }
}

function selectorFromArgs(args = {}) {
  return {
    sheet: String(args.sheet || ''),
    range: String(args.range || ''),
    target: String(args.target || ''),
    pages: normalizedPages(args.pages),
    includeStyles: args.includeStyles === true,
    includeSelection: args.includeSelection === true,
  };
}

function sameSelector(left, right) {
  return left.sheet === right.sheet
    && left.range === right.range
    && left.target === right.target
    && left.includeStyles === right.includeStyles
    && left.includeSelection === right.includeSelection
    && JSON.stringify(left.pages) === JSON.stringify(right.pages);
}

export function createOfficeSnapshotRequest(session, args = {}, { full = false } = {}) {
  if (full) return { full: true };
  const format = String(session?.format || '');
  const defaultLimit = DEFAULT_LIMITS[format] || 200;
  const formatMaximum = MAX_LIMITS[format] || 2_000;
  let selector = selectorFromArgs(args);
  let offset = 0;
  let sheetOffset = 0;
  let limit = Math.max(1, Number(args.limit) || defaultLimit);
  if (args.cursor) {
    const cursor = decodeCursor(args.cursor);
    if (cursor.session !== session.id || cursor.format !== format) {
      throw new Error('Office snapshot cursor belongs to a different document session');
    }
    if (Number(cursor.revision) !== Number(session.snapshotVersion || 0)) {
      throw new Error('Office snapshot cursor is stale because the document changed');
    }
    const suppliedSelector = selectorFromArgs(args);
    const cursorSelector = cursor.selector || selectorFromArgs();
    const hasSuppliedSelector = suppliedSelector.sheet
      || suppliedSelector.range
      || suppliedSelector.target
      || suppliedSelector.pages.length
      || suppliedSelector.includeStyles
      || suppliedSelector.includeSelection;
    if (hasSuppliedSelector && !sameSelector(suppliedSelector, cursorSelector)) {
      throw new Error('Office snapshot cursor selector does not match this request');
    }
    selector = cursorSelector;
    offset = Number(cursor.offset) || 0;
    sheetOffset = Math.max(0, Number(cursor.sheetOffset) || 0);
    limit = Math.max(1, Number(args.limit) || Number(cursor.limit) || defaultLimit);
  }
  const maximum = format === 'xlsx' && selector.includeStyles ? 500 : formatMaximum;
  limit = Math.min(maximum, limit);
  return {
    paged: true,
    offset,
    // Which worksheet the walk is on when the caller named none: a workbook is
    // read sheet by sheet, and the next page continues into the next sheet.
    sheetOffset,
    limit,
    ...selector,
  };
}

export function finalizeOfficeSnapshotPage(document, session, request) {
  const pagination = document?.pagination;
  if (!pagination || request.full) return document;
  // A workbook's next page may be the next sheet: the cells of this one are
  // done, but the caller has not seen the workbook yet.
  const nextSheetOffset = Number.isInteger(pagination.nextSheetOffset) ? pagination.nextSheetOffset : null;
  const nextOffset = Number(pagination.nextOffset);
  const hasMore = (pagination.nextOffset !== null
    && pagination.nextOffset !== undefined
    && Number.isInteger(nextOffset)
    && nextOffset >= 0)
    || nextSheetOffset !== null;
  const cursorFor = (offset, sheetOffset) => encodeCursor({
    version: 1,
    session: session.id,
    format: session.format,
    revision: Number(session.snapshotVersion || 0),
    offset,
    ...(sheetOffset ? { sheetOffset } : {}),
    limit: request.limit,
    selector: selectorFromArgs(request),
  });
  pagination.cursor = request.offset > 0 || request.sheetOffset > 0
    ? cursorFor(request.offset, request.sheetOffset || 0)
    : null;
  pagination.nextCursor = hasMore
    ? (nextSheetOffset !== null
      ? cursorFor(0, nextSheetOffset)
      : cursorFor(nextOffset, request.sheetOffset || 0))
    : null;
  pagination.hasMore = hasMore;
  delete pagination.nextOffset;
  delete pagination.nextSheetOffset;
  return document;
}
