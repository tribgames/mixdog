/**
 * `text` without its trailing U+FFFD characters: what a byte cut through a
 * multi-byte sequence leaves behind. A loop, not `/\uFFFD+$/`, which is
 * quadratic on a long run of them.
 */
export function stripTrailingReplacementChars(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\uFFFD') end -= 1;
  return end === text.length ? text : text.slice(0, end);
}
