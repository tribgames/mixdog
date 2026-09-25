// Figures are compared down the column, so they are set against the right
// edge and the header sits over them; every column of figures used to start
// at the left edge, which is where a reader looks for words. A currency sign
// may lead the figure (₩2,400,000, $120): an invoice's amounts are figures too,
// and so is a Korean amount whose unit is spaced from its multiplier (2.6억 원).
const NUMERIC_CELL = /^[(\-+−]?[₩$€£¥]?\s?[\d,.\s]+(?:%|(?:\s?[A-Za-z가-힣원$€£¥]{1,3}){0,2})\)?$/;
// A first column of 1호, 2호 is a row label with a digit in it, not a
// figure to compare down the column: it stays left unless every entry
// is a bare number.
const BARE_NUMBER_CELL = /^[(\-+]?[\d,.\s]+%?\)?$/;

// The text alignment of each column of a table given as rows of strings: a declared alignment is kept, a column of
// figures sets right, everything else left. The PDF writer and a Word table that declares none read their columns
// the same way.
export function figureColumnAlignments(rows, columns, declared = [], header = true) {
  const numeric = (text) => /\d/.test(text) && NUMERIC_CELL.test(text.trim());
  const bareNumber = (text) => /\d/.test(text) && BARE_NUMBER_CELL.test(text.trim());
  return Array.from({ length: columns }, (_, column) => {
    const stated = Array.isArray(declared) ? declared[column] : '';
    if (stated) return String(stated).toLowerCase();
    const body = rows
      .slice(header ? 1 : 0)
      .map((row) => String(row[column] ?? '').trim())
      .filter(Boolean);
    if (!body.length) return 'left';
    if (column === 0) return body.every(bareNumber) ? 'right' : 'left';
    return body.filter(numeric).length / body.length >= 0.6 ? 'right' : 'left';
  });
}
