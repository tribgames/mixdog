// What a user sees of a terminal: the text a shell wrote, played into the terminal emulator the app renders with (xterm.js, the build
// in apps/desktop/node_modules, run un-opened), then read back as the screen: every row's text and attributes and the cursor.
// Two byte streams that draw the same screen (a redraw per keystroke or in one frame, a re-render after a resize) give the same screen.
// ConPTY reports each size change in its stream as `ESC[8;<rows>;<cols>t`; the emulator follows it, as the page follows the owner's size.
import { createRequire } from 'node:module';

const { Terminal } = createRequire(new URL('../../../../apps/desktop/package.json', import.meta.url))('@xterm/xterm');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESIZE_REPORT = /(\x1b\[8;\d+;\d+t)/;

function played(text) {
  const term = new Terminal({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: 5000, allowProposedApi: true });
  // Synchronous: the emulator's async write is timer-driven, and the recording holds Node's timers on a virtual clock.
  for (const part of String(text).split(RESIZE_REPORT)) {
    const size = /^\x1b\[8;(\d+);(\d+)t$/.exec(part);
    if (size) term.resize(Number(size[2]), Number(size[1]));
    else if (part) term._core.writeSync(part);
  }
  return term;
}

const FLAGS = ['isBold', 'isItalic', 'isDim', 'isUnderline', 'isBlink', 'isInverse', 'isInvisible', 'isStrikethrough'];

/** One row: its text, and a run `[from, length, fg, bg, flags]` for each stretch of cells that is not in the default style. */
function row(line, cols, cell) {
  const runs = [];
  for (let x = 0; x < cols; x += 1) {
    line.getCell(x, cell);
    const style = [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), FLAGS.filter((flag) => cell[flag]()).join('+')];
    if (style[0] === 0 && style[2] === 0 && style[4] === '') continue;
    const last = runs.at(-1);
    if (last && last[0] + last[1] === x && last.slice(2).join() === style.join()) last[1] += 1;
    else runs.push([x, 1, ...style]);
  }
  // Blanks at the end of a row are not seen unless they carry a colour (the runs keep those); whether a shell wrote the space after its
  // prompt or left the cell empty is not a difference on screen (two Node recordings differ in just that).
  const text = line.translateToString(true).trimEnd();
  return runs.length ? { text, runs } : { text };
}

/** The screen the text draws: the rows of the buffer (scrollback included, trailing blank rows dropped), the cursor, the size. */
export function screenOf(text) {
  const term = played(text);
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const rows = [];
  for (let y = 0; y < buffer.length; y += 1) rows.push(row(buffer.getLine(y), term.cols, cell));
  while (rows.length && rows.at(-1).text === '' && !rows.at(-1).runs) rows.pop();
  const screen = { size: [term.cols, term.rows], cursor: [buffer.cursorX, buffer.baseY + buffer.cursorY], rows };
  term.dispose();
  return screen;
}

/** The lines of the screen as typed, not as the width cut them: a row the terminal wrapped is joined to the one before it. */
export function linesOf(text) {
  const term = played(text);
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    const piece = line.translateToString(!buffer.getLine(y + 1)?.isWrapped);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += piece;
    else lines.push(piece);
  }
  term.dispose();
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
}
