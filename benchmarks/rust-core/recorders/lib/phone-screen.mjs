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

const SHOWN_ON_BLANK = new Set(['isInverse', 'isUnderline', 'isStrikethrough', 'isOverline']);
const FLAGS = ['isBold', 'isItalic', 'isDim', 'isUnderline', 'isBlink', 'isInverse', 'isInvisible', 'isStrikethrough', 'isOverline'];

/** One row: its text, and a run `[from, length, fg, bg, flags, underline style, underline colour, link]` for each stretch of cells that is not in the default style. */
function row(line, cols, cell, links) {
  const runs = [];
  for (let x = 0; x < cols; x += 1) {
    line.getCell(x, cell);
    // The underline's style (straight, double, curly, dotted, dashed) and colour show only on an underlined cell; a link is its target.
    const underline = cell.isUnderline() ? [cell.getUnderlineStyle(), cell.getUnderlineColorMode(), cell.getUnderlineColor(), cell.getUnderlineVariantOffset()] : [0, 0, 0, 0];
    const link = cell.extended.urlId ? (links.getLinkData(cell.extended.urlId)?.uri ?? '') : '';
    // An empty or blank cell shows its background, an underline, a strike or an overline, and (inverse) its foreground as a background;
    // its foreground colour, bold, italic, dim, blink and invisible do not show. Two Node recordings of the same script differ only
    // there: PSReadLine's colouring of the typed command reached 4 blank cells past its end in one and not in the other.
    const blank = cell.getChars().trim() === '';
    const shown = blank ? FLAGS.filter((flag) => cell[flag]() && SHOWN_ON_BLANK.has(flag)) : FLAGS.filter((flag) => cell[flag]());
    const foreground = blank && !cell.isInverse() ? [0, 0] : [cell.getFgColorMode(), cell.getFgColor()];
    const style = [...foreground, cell.getBgColorMode(), cell.getBgColor(), shown.join('+'), underline.join(':'), link];
    if (style[0] === 0 && style[2] === 0 && style[4] === '' && style[6] === '') continue;
    const last = runs.at(-1);
    if (last && last[0] + last[1] === x && last.slice(2).join() === style.join()) last[1] += 1;
    else runs.push([x, 1, ...style]);
  }
  // Blanks at the end of a row are not seen unless they carry what a blank shows (the runs keep those); whether a shell wrote the space after
  // its prompt or left the cell empty is not a difference on screen (two Node recordings differ in just that).
  const text = line.translateToString(true).trimEnd();
  return runs.length ? { text, runs } : { text };
}

/** The screen the text draws: the rows of the buffer (scrollback included, trailing blank rows dropped), the cursor (place, whether it shows,
 *  its shape and whether it blinks), which buffer is showing, the size. */
export function screenOf(text) {
  const term = played(text);
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const rows = [];
  const links = term._core._oscLinkService;
  for (let y = 0; y < buffer.length; y += 1) rows.push(row(buffer.getLine(y), term.cols, cell, links));
  while (rows.length && rows.at(-1).text === '' && !rows.at(-1).runs) rows.pop();
  const cursor = {
    at: [buffer.cursorX, buffer.baseY + buffer.cursorY],
    visible: !term._core.coreService.isCursorHidden,
    style: term.options.cursorStyle,
    blink: term.options.cursorBlink,
  };
  const screen = { size: [term.cols, term.rows], buffer: buffer.type, cursor, rows };
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
