// Column widths for a table the caller gave no widths, across `available` (the unit `measure` answers in):
// equal columns while every cell fits its column on one line (a stat strip, a table of short figures), otherwise
// the automatic table layout — each column gets its longest line when all of them fit, the extra shared evenly;
// when they do not, each column keeps its longest word, a column whose whole line costs no more than an even share
// of what is left takes it (cheapest first), and the rest of the width goes where the text is longest. Equal columns
// used to wrap a description beside a two-word label column, and broke "6개월" between the figure and its unit; a
// share by length alone broke the header "처리량 (건)" over two lines beside a description that wraps anyway.
// `measure(text, rowIndex, column)` is one line's printed width in the table's own face, padding included.
export function naturalColumnWidths(rows, measure, available) {
  const table = Array.isArray(rows) ? rows : [];
  const columns = Math.max(0, ...table.map((row) => (Array.isArray(row) ? row.length : 0)));
  if (!columns || !(available > 0)) return null;
  const longest = Array(columns).fill(0);
  const widestWord = Array(columns).fill(0);
  table.forEach((row, rowIndex) => {
    (Array.isArray(row) ? row : []).forEach((value, column) => {
      for (const line of String(value ?? '').split(/\r?\n/)) {
        longest[column] = Math.max(longest[column], measure(line, rowIndex, column));
        for (const word of line.split(/\s+/).filter(Boolean)) {
          widestWord[column] = Math.max(widestWord[column], measure(word, rowIndex, column));
        }
      }
    });
  });
  if (longest.every((width) => width <= available / columns)) return longest.map(() => available / columns);
  const total = (list) => list.reduce((sum, width) => sum + width, 0);
  if (total(longest) <= available) {
    const extra = (available - total(longest)) / columns;
    return longest.map((width) => width + extra);
  }
  if (total(widestWord) >= available) return widestWord.map((width) => (width * available) / total(widestWord));
  const widths = [...widestWord];
  const open = new Set(widths.keys());
  let room = available - total(widestWord);
  const need = (column) => longest[column] - widestWord[column];
  for (const column of [...open].sort((a, b) => need(a) - need(b))) {
    if (need(column) > room / open.size) break;
    widths[column] = longest[column];
    room -= need(column);
    open.delete(column);
  }
  const flexible = [...open].reduce((sum, column) => sum + need(column), 0);
  for (const column of open) widths[column] += flexible > 0 ? (room * need(column)) / flexible : room / open.size;
  return widths;
}
