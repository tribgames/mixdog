import wrapAnsi from 'wrap-ansi';
import { displayWidth } from '../display-width.mjs';

/** Wrap text to width, ANSI-aware, returning nonempty lines or one empty line. */
export function wrapText(text, width, options) {
  if (width <= 0) return [text];
  const trimmedText = String(text).trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  });
  const lines = wrapped.split('\n').filter((line) => line.length > 0);
  return lines.length > 0 ? lines : [''];
}

/** Apply the display-width fallback after wrap-ansi's hard wrapping. */
export function hardWrapAnsiLines(text, width) {
  const max = Math.max(1, Math.floor(Number(width) || 1));
  const input = String(text ?? '');
  if (!input) return [''];
  const out = [];
  for (const softLine of wrapText(input, max, { hard: true })) {
    let rest = softLine;
    while (rest.length > 0 && displayWidth(rest) > max) {
      let take = 1;
      for (let i = 1; i <= rest.length; i++) {
        if (displayWidth(rest.slice(0, i)) <= max) take = i;
        else break;
      }
      out.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    if (rest.length > 0) out.push(rest);
  }
  return out.length > 0 ? out : [''];
}
