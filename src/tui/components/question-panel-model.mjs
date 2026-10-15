/**
 * components/question-panel-model.mjs — pure model for the ask_user
 * QuestionPanel: answer building, row layout and reserved panel height.
 */
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { truncatePanelText } from './panel-cell-text.mjs';

export const CUSTOM_LABEL = '직접 입력…';
export const RECOMMENDED_SUFFIX = ' (추천)';
export const MULTI_HINT = ' (여러 개 선택 가능)';
// border(2) + title + blank + blank-after-question; question rows added separately.
const FIXED_ROWS = 5;
// Panel interior = frame − 2 border − 2 paddingX.
const CHROME_COLUMNS = 4;

export function questionsOf(toolApproval) {
  const list = toolApproval?.args?.questions;
  return Array.isArray(list) ? list : [];
}

// One question's answer from its draft ({ selected: optionIndex[], text? }).
export function answerFor(question, draft) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const selected = [...new Set(draft?.selected || [])]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
    .sort((a, b) => a - b)
    .map((i) => options[i].label);
  const text = String(draft?.text ?? '').trim();
  if (selected.length === 0 && !text) return null;
  return text ? { selected, text } : { selected };
}

export function buildAnswers(questions, drafts) {
  return questions.map((question, i) => answerFor(question, drafts?.[i]));
}

const DETAIL_GAP = '  ';
const MIN_DETAIL_CELLS = 6;

// Geometry of one question's option rows at `columns` frame width: one line
// per option (its label, the recommended mark, then its one-sentence
// tradeoff in the cells left, cut with an ellipsis).
export function optionLayout(question, columns) {
  const options = Array.isArray(question?.options) ? question.options : [];
  const total = options.length + 1;
  const indexCells = stringWidth(`${total}. `);
  const markerCells = question?.multi_select ? 4 : 0; // "[x] "
  const prefixCells = 2 + indexCells + markerCells; // "› " + "1. " + marker
  const avail = Math.max(10, columns - CHROME_COLUMNS);
  const labelCap = Math.max(4, avail - prefixCells);
  const rows = options.map((option, i) => {
    const suffix = question?.recommended === i ? RECOMMENDED_SUFFIX : '';
    const label = truncatePanelText(String(option.label ?? ''), Math.max(1, labelCap - stringWidth(suffix)));
    const left = labelCap - stringWidth(label + suffix) - DETAIL_GAP.length;
    const text = String(option.description ?? '').trim();
    const detail = text && left >= MIN_DETAIL_CELLS ? `${DETAIL_GAP}${truncatePanelText(text, left)}` : '';
    return { label, suffix, detail };
  });
  return { rows, prefixCells, avail, indexCells };
}

export const MAX_ANSWER_CHARS = 4000;
const MIN_OPTION_ROWS = 3;

// Append `text` to `base`, never exceeding MAX_ANSWER_CHARS UTF-16 units (the
// unit the runtime checks), and never splitting a character.
export function appendCapped(base, text) {
  let out = base;
  for (const char of text) {
    if (out.length + char.length > MAX_ANSWER_CHARS) break;
    out += char;
  }
  return out;
}

export function questionLines(question, columns) {
  const shown = `${question?.question ?? ''}${question?.multi_select ? MULTI_HINT : ''}`;
  return wrapAnsi(shown, Math.max(1, columns - CHROME_COLUMNS), { trim: false, hard: true }).split('\n');
}

function ellipsize(line, width) {
  return `${truncatePanelText(line, Math.max(1, width - 1)).replace(/…$/, '')}…`;
}

// Fit the panel into `rows` (Infinity = unbudgeted). Always keeps the question
// text (capped, leaving MIN_OPTION_ROWS for options) and the highlighted
// option; the rest scroll with ↑/↓ more indicators.
export function planQuestionView(question, columns, rows, cursor) {
  const layout = optionLayout(question, columns);
  const n = layout.rows.length;
  let qLines = questionLines(question, columns);
  const optionBudget = rows - FIXED_ROWS;
  const qCap = Number.isFinite(rows) ? Math.max(1, optionBudget - MIN_OPTION_ROWS) : Infinity;
  if (qLines.length > qCap) {
    qLines = qLines.slice(0, qCap);
    qLines[qCap - 1] = ellipsize(qLines[qCap - 1], Math.max(1, columns - CHROME_COLUMNS));
  }
  const avail = Number.isFinite(rows) ? Math.max(1, rows - FIXED_ROWS - qLines.length) : Infinity;
  const full = Array(n + 1).fill(1);
  const total = n + 1;
  let heights = full;
  if (full.reduce((a, b) => a + b, 0) > avail) {
    heights = full.map((h, i) => (i === cursor ? Math.min(h, Math.max(1, avail - 2)) : 1));
  }
  let start = Math.min(cursor, total - 1);
  let end = start + 1;
  let used = heights[start];
  const fits = (s, e, sum) => sum + (s > 0 ? 1 : 0) + (e < total ? 1 : 0) <= avail;
  if (!fits(start, end, used) && avail < Infinity) {
    // highlighted option alone exceeds budget with indicators: shrink it.
    heights = heights.map((h, i) => (i === cursor ? 1 : h));
    used = 1;
  }
  for (let grew = true; grew; ) {
    grew = false;
    if (end < total && fits(start, end + 1, used + heights[end])) {
      used += heights[end++];
      grew = true;
    }
    if (start > 0 && fits(start - 1, end, used + heights[start - 1])) {
      used += heights[--start];
      grew = true;
    }
  }
  const items = [];
  for (let i = start; i < end; i++) items.push({ index: i, lines: heights[i] });
  return { qLines, items, above: start, below: total - end };
}

function questionRows(question, columns) {
  const optionRows = Array.isArray(question?.options) ? question.options.length : 0;
  return FIXED_ROWS + questionLines(question, columns).length + optionRows + 1; // +1 custom-input row
}

// Reserved floating-panel rows: the tallest question, so switching questions
// never resizes the panel.
export function questionPanelRows(questions, columns) {
  return Math.max(FIXED_ROWS + 3, ...questions.map((q) => questionRows(q, columns)));
}

export function initialCursor(question) {
  const n = Array.isArray(question?.options) ? question.options.length : 0;
  const r = question?.recommended;
  return Number.isInteger(r) && r >= 0 && r < n ? r : 0;
}

export function questionHelp({ multi, typing, last, count, questionCount = 1 }) {
  if (typing) return 'Enter Send · Esc Back to list';
  // Several questions: the title row also holds the tabs, so keep help short.
  const parts = questionCount > 1 ? [] : [`1–${count} Choose`, '↑/↓ Move'];
  if (multi) parts.push('Space Toggle');
  if (questionCount > 1) parts.push('←/→ Question');
  parts.push(last ? 'Enter Send' : 'Enter Next', 'Esc Dismiss');
  return parts.join(' · ');
}
