import { measureTextBlock } from './text-metrics.mjs';
import { EMU_PER_POINT } from './portable-slide-shapes.mjs';
import { paragraphTexts } from './portable-xml.mjs';

// PowerPoint's cell insets when a cell names none, in EMU.
const DEFAULT_CELL_INSETS = Object.freeze({ left: 91440, right: 91440, top: 45720, bottom: 45720 });

// The insets a cell states on its tcPr (marL/marR/marT/marB), each side PowerPoint's default where unstated: a
// table written with tight margins was measured inside the default ones and reported rows it did not overflow.
function cellInsets(cellXml) {
  const properties = /<a:tcPr\b([^>]*)/.exec(cellXml)?.[1] || '';
  const side = (name, fallback) => {
    const stated = new RegExp(`\\b${name}="(\\d+)"`).exec(properties)?.[1];
    return stated === undefined ? fallback : Number(stated);
  };
  return {
    left: side('marL', DEFAULT_CELL_INSETS.left),
    right: side('marR', DEFAULT_CELL_INSETS.right),
    top: side('marT', DEFAULT_CELL_INSETS.top),
    bottom: side('marB', DEFAULT_CELL_INSETS.bottom),
  };
}

// The height a cell's text needs against the room its row gives it, or null
// when the row or column carries no size. A merged label cell (rowSpan) owns
// the rows it spans: its room is theirs together, not one row's.
function tableCellFit(cellXml, { text, size, bold, widths, columnOrdinal, declared }) {
  const width = widths[columnOrdinal - 1];
  if (!declared || !width) return null;
  const rowSpan = Math.max(1, Number(/<a:tc\b[^>]*\browSpan="(\d+)"/.exec(cellXml)?.[1]) || 1);
  const gridSpan = Math.max(1, Number(/<a:tc\b[^>]*\bgridSpan="(\d+)"/.exec(cellXml)?.[1]) || 1);
  const spannedWidth =
    widths.slice(columnOrdinal - 1, columnOrdinal - 1 + gridSpan).reduce((sum, value) => sum + value, 0) || width;
  const insets = cellInsets(cellXml);
  const usable = (spannedWidth - insets.left - insets.right) / EMU_PER_POINT;
  const available = (declared * rowSpan - insets.top - insets.bottom) / EMU_PER_POINT;
  if (usable <= 0 || available <= 0) return null;
  return { measured: measureTextBlock([{ text, fontSize: size, bold }], { width: usable }), rowSpan, available, insets };
}

// A table row's text cells, each with its fit against the row's declared height, and the row's drawn height in
// EMU: PowerPoint grows a row to its tallest single-row cell.
export function tableRowCells(rowXml, widths) {
  const declared = Number(/<a:tr\b[^>]*\bh="(\d+)"/.exec(rowXml)?.[1]) || 0;
  let height = declared;
  const cells = [];
  let columnOrdinal = 0;
  for (const cell of rowXml.matchAll(/<a:tc(?:\s[^>]*)?>[\s\S]*?<\/a:tc>/g)) {
    columnOrdinal += 1;
    const body = /<a:txBody>[\s\S]*?<\/a:txBody>/.exec(cell[0])?.[0] || '';
    const text = paragraphTexts(body, 'a:t').join(' ').trim();
    if (!text) continue;
    const size = Number(/<a:rPr\b[^>]*\bsz="(\d+)"/.exec(body)?.[1] || 0) / 100 || 18;
    const bold = /<a:rPr\b[^>]*\bb="1"/.test(body);
    const fit = tableCellFit(cell[0], { text, size, bold, widths, columnOrdinal, declared });
    if (fit?.rowSpan === 1) {
      height = Math.max(height, fit.measured.height * EMU_PER_POINT + fit.insets.top + fit.insets.bottom);
    }
    cells.push({ xml: cell[0], body, size, bold, columnOrdinal, fit });
  }
  return { cells, height };
}

// The height a table draws to, in EMU: every row at the larger of its declared height and its tallest cell. A frame
// declared at 150 pt around ten 18 pt rows draws to twice that, over the source line under it.
export function tableDrawnHeight(tableXml) {
  const widths = [...tableXml.matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map((match) => Number(match[1]));
  if (!widths.length) return 0;
  return [...tableXml.matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)].reduce(
    (sum, row) => sum + tableRowCells(row[0], widths).height,
    0
  );
}
