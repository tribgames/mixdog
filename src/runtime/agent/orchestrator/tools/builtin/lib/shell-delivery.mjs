// One shape for every piece of shell output handed to an agent — a foreground
// result, a background move, task wait/read and a completion notice:
//   1. ANSI stripped, then `\r` progress frames folded to their last frame
//      (before anything is counted or cut);
//   2. a line longer than DELIVERY_LINE_MAX_CHARS is cut: `… [N chars cut]`;
//   3. DELIVERY_FULL_CHARS or less goes whole; otherwise a head of at most
//      DELIVERY_HEAD_LINES lines (≤ DELIVERY_HEAD_MAX_CHARS), the marker, and
//      the last ~DELIVERY_TAIL_CHARS;
//   4. the marker is the same everywhere and always ends with the full log:
//      `[… N lines, X KB omitted — read with offset/limit or grep, full log: <path>]`;
//   5. anything shaped like a harness/system tag is escaped.
// MIXDOG_SHELL_DELIVERY_MAX_CHARS is the one knob (the whole-delivery cap); the
// head and tail sizes are fixed. It is separate from the 50 KB
// MIXDOG_TOOL_OUTPUT_MAX_BYTES that the other tools use.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from '../../../config.mjs';
import { stripAnsi } from '../../shell-exec-output.mjs';
import { createCarriageReturnFolder } from '../shell-lossless-compact.mjs';
import { positiveEnvInt } from '../../../../../shared/tool-output-limit.mjs';
import { escapeHarnessTags } from '../../../../../shared/shell-output-summary.mjs';

export const DELIVERY_FULL_CHARS = positiveEnvInt('MIXDOG_SHELL_DELIVERY_MAX_CHARS', 6_000);
const DELIVERY_HEAD_LINES = 10;
const DELIVERY_HEAD_MAX_CHARS = 1_000;
const DELIVERY_TAIL_CHARS = 2_000;
export const DELIVERY_LINE_MAX_CHARS = 2_000;

export { createCarriageReturnFolder };

const newlines = (text) => {
  let count = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) count += 1;
  return count;
};

export function formatKb(bytes) {
  return `${(Math.max(0, bytes) / 1024).toFixed(1)} KB`;
}

/** The omission marker — identical on every delivery path, path last. */
export function omissionMarker({ lines, bytes, path }) {
  return `[… ${lines} lines, ${formatKb(bytes)} omitted — read with offset/limit or grep, full log: ${path}]`;
}

// `cut` is the number of chars removed from over-long lines.
function cutLongLines(text) {
  if (text.length <= DELIVERY_LINE_MAX_CHARS) return { text, cut: 0 };
  let cut = 0;
  const cutText = text
    .split('\n')
    .map((line) => {
      if (line.length <= DELIVERY_LINE_MAX_CHARS) return line;
      cut += line.length - DELIVERY_LINE_MAX_CHARS;
      return `${line.slice(0, DELIVERY_LINE_MAX_CHARS)} … [${line.length - DELIVERY_LINE_MAX_CHARS} chars cut]`;
    })
    .join('\n');
  return { text: cutText, cut };
}

/** Step 1 for one chunk (the cut of step 2 is made where the text is
 *  delivered, so the uncut text can be archived). `fold` carries `\r` state
 *  across chunks of the same stream; omitted, the chunk is folded on its own. */
export function prepareShellText(text, fold = createCarriageReturnFolder()) {
  return fold(stripAnsi(String(text ?? '')));
}

// `scale` is the share of the delivery budget a stream was given.
function headOf(text, scale = 1) {
  let end = 0;
  for (let line = 0; line < DELIVERY_HEAD_LINES && end < text.length; line += 1) {
    const newline = text.indexOf('\n', end);
    end = newline < 0 ? text.length : newline + 1;
  }
  return text.slice(0, Math.min(end, Math.floor(DELIVERY_HEAD_MAX_CHARS * scale)));
}

function tailOf(text, floor = 0, scale = 1) {
  const start = Math.max(floor, text.length - Math.floor(DELIVERY_TAIL_CHARS * scale));
  if (start === floor) return text.slice(start);
  // Start on a line boundary when one is near.
  const newline = text.indexOf('\n', start);
  return newline >= 0 && newline - start < 200 && newline + 1 < text.length
    ? text.slice(newline + 1)
    : text.slice(start);
}

/** head + marker + tail; `omitted` counts what lies between them. */
function joinHeadTail(head, tail, omitted) {
  const gap = head && !head.endsWith('\n') ? '\n' : '';
  return `${head}${gap}${omissionMarker(omitted)}\n${tail}`;
}

// One stream's delivery: `natural` is the length it would have whole (escaped,
// markers included; Infinity when it can only be shown at its ends) and
// `render(budget)` the text within `budget` chars. Streams share one budget.
export const EMPTY_PIECE = { natural: 0, render: () => '' };

/** Step 3 when only the two ends of a long range were read: `total` is the
 *  whole range's bytes and lines. */
export function edgesPiece(headText, tailText, { totalBytes, totalLines, path }) {
  return {
    natural: Number.POSITIVE_INFINITY,
    render: (budget) => {
      const scale = budget / DELIVERY_FULL_CHARS;
      const head = headOf(escapeHarnessTags(headText), scale);
      const tail = tailOf(escapeHarnessTags(tailText), 0, scale);
      return joinHeadTail(head, tail, {
        lines: Math.max(0, totalLines - newlines(head) - newlines(tail)),
        bytes: Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail)),
        path,
      });
    },
  };
}

export { newlines as countNewlines };

/** Steps 2, 3 and 5 on prepared text. `path` names where the whole (uncut)
 *  text can be read; it is resolved only when something is removed. */
export function textPiece(text, { path }) {
  let archive;
  const where = () => (archive ??= typeof path === 'function' ? path() : path);
  const { text: cutText, cut } = cutLongLines(text);
  const shown = escapeHarnessTags(cutText);
  // Cut long lines are removed content too: the whole text carries the marker.
  const whole = cut
    ? `${shown}${shown.endsWith('\n') ? '' : '\n'}${omissionMarker({ lines: 0, bytes: cut, path: where() })}\n`
    : shown;
  return {
    natural: whole.length,
    render: (budget) => {
      if (whole.length <= budget) return whole;
      const scale = budget / DELIVERY_FULL_CHARS;
      const head = headOf(shown, scale);
      const tail = tailOf(shown, head.length, scale);
      const middle = shown.slice(head.length, shown.length - tail.length);
      return joinHeadTail(head, tail, { lines: newlines(middle), bytes: Buffer.byteLength(middle), path: where() });
    },
  };
}

/** Max-min fair split of `budget` over the streams' natural lengths: a stream
 *  that fits its fair share is given exactly what it needs, the rest share
 *  what remains. */
function shareBudget(lengths, budget) {
  const shares = lengths.map(() => 0);
  let open = lengths.map((_, index) => index);
  let left = Math.max(0, budget);
  while (open.length) {
    const fair = left / open.length;
    const fits = open.filter((index) => lengths[index] <= fair);
    if (!fits.length) {
      for (const index of open) shares[index] = fair;
      break;
    }
    for (const index of fits) {
      shares[index] = lengths[index];
      left -= lengths[index];
    }
    open = open.filter((index) => !fits.includes(index));
  }
  return shares;
}

/** Deliver streams within one shared budget (default: the whole-delivery cap),
 *  each escaped; the caller deducts what it adds around them. */
export function fitPieces(pieces, budget = DELIVERY_FULL_CHARS) {
  const shares = shareBudget(
    pieces.map((piece) => piece.natural),
    budget
  );
  return pieces.map((piece, index) => escapeHarnessTags(piece.render(shares[index])));
}

/** Text that has no log of its own is kept where the marker can name it:
 *  the shell-output folder, swept with the spill files. */
export function persistDeliveryLog(text, label = 'output') {
  const dir = join(getPluginData(), 'shell-output');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `delivered_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}.${label}`);
  writeFileSync(file, text);
  return file;
}

/** Steps 1–5 for a whole string, as a piece. Without `path`, the original
 *  (uncut) text is saved when anything is removed, so the marker can name it. */
export function shellTextPiece(text, { path = null, label = 'output', fold } = {}) {
  const prepared = prepareShellText(text, fold);
  return textPiece(prepared, { path: path || (() => persistDeliveryLog(prepared, label)) });
}

export function deliverShellText(text, options) {
  return fitPieces([shellTextPiece(text, options)])[0];
}

/** Step 5 alone, for text the caller already capped. */
export { escapeHarnessTags };
