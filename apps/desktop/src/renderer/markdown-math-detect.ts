const FENCED_MATH_RE = /(?:^|\n)[ \t]*(?:(?:>[ \t]*|(?:[-*+]|\d+[.)])[ \t]+))*(?:`{3,}|~{3,})[ \t]*math(?:\s|$)/;

/** True when `text` can produce a math node under `remark-math` (`singleDollarTextMath: false`) or `rehype-katex`. */
export function containsMarkdownMath(text: string): boolean {
  if (!text) return false;
  if (text.includes('$$')) return true;
  if (!text.includes('math')) return false;
  return FENCED_MATH_RE.test(text);
}
