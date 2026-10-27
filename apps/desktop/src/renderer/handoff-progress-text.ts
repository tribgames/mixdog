/** Longest progress text a hand-off line shows (graphemes): the line is one
 *  faint row, and the target's name beside it must stay readable. */
export const HANDOFF_PROGRESS_MAX = 80;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// A delimiter acts as emphasis only at a word edge: opened after a start,
// space or bracket, closed before an end, space or closing punctuation.
// Inside a word or a path (`__init__.py`, `snake_case`, `a*b`, `C:\x\__y__\`)
// it is text.
const OPENS = String.raw`(^|[\s(\[])`;
const CLOSES = String.raw`(?=[).,;:!?\]]*(?:$|\s))`;
const emphasis = (delimiter: string, inner: string) =>
  new RegExp(`${OPENS}${delimiter}(?=${inner})(.+?)(?<=${inner})${delimiter}${CLOSES}`, 'g');
const STRONG = [
  emphasis(String.raw`\*\*`, String.raw`\S`),
  emphasis('__', String.raw`\S`),
  emphasis('~~', String.raw`\S`),
];
const SLANTED = [emphasis(String.raw`\*`, String.raw`[^\s*]`), emphasis('_', String.raw`[^\s_]`)];

/** Markdown reduced to its plain words: code spans keep their text verbatim,
 *  emphasis delimiters go only where they act as delimiters, and a cut-off
 *  delimiter dangling at the end goes too. */
function plainText(markdown: string): string {
  const code: string[] = [];
  let text = markdown.replace(
    /(`+)([^`]+?)\1(?!`)/g,
    (_, _ticks, body: string) => `\uE000${code.push(body) - 1}\uE000`
  );
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '');
  for (const pattern of [...STRONG, ...SLANTED]) text = text.replace(pattern, '$1$2');
  return text
    .replace(/\s*(?:\*\*|__|~~|`)$/, '')
    .replace(/\uE000(\d+)\uE000/g, (_, at: string) => code[Number(at)])
    .replace(/\s+/g, ' ')
    .trim();
}

/** A progress update as the plain, bounded text of a hand-off line: markdown
 *  stripped, then cut at a word (else a grapheme) boundary with an ellipsis. */
export function handoffProgressText(markdown: string, max = HANDOFF_PROGRESS_MAX): string {
  const text = plainText(markdown);
  const parts = Array.from(graphemes.segment(text), (part) => part.segment);
  if (parts.length <= max) return text;
  const head = parts.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space > head.length / 2 ? head.slice(0, space) : head;
  return `${cut.trimEnd()}…`;
}
