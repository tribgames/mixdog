/**
 * markdown/format-token.mjs — token → ANSI string renderer.
 *
 * Ported from Claude Code (refs/claude-code/src/utils/markdown.ts: formatToken
 * + helpers), adapted for this CLI:
 *   - chalk is forced to truecolor (level 3) so colors render regardless of the
 *     ambient TTY detection (we control the surface).
 *   - The `permission`/code accent and blockquote bar come from our theme.mjs.
 *   - `code` (fenced) is emitted as plain text + EOL (no syntax highlighter
 *     dependency); `codespan` (inline) gets the accent color, like CC.
 *   - `table` is NOT handled here — the React component (MarkdownTable.jsx)
 *     renders tables with proper ink Box layout, mirroring CC's hybrid split.
 *   - Hyperlinks/issue-ref linkify are dropped (no OSC-8 dependency); link text
 *     is shown plainly with its URL.
 */
import { Chalk } from 'chalk';
import stripAnsi from 'strip-ansi';
import { theme } from '../theme.mjs';

// Force truecolor so chalk emits 24-bit SGR even when the ambient level is 0.
// ink's <Text> passes these escapes through verbatim.
const chalk = new Chalk({ level: 3 });

// Use \n unconditionally (CC note: os.EOL's \r breaks segment mapping).
const EOL = '\n';

// ▎ left one-quarter block — CC's BLOCKQUOTE_BAR (constants/figures.ts).
const BLOCKQUOTE_BAR = '▎';

/** Parse an `rgb(r,g,b)` theme string into a chalk colorizer. */
function rgbColor(str) {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(str || ''));
  if (!m) return (s) => s;
  return chalk.rgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

const accent = rgbColor(theme.code); // inline code / codespan accent (light blue-purple)
const dim = (s) => chalk.dim(s);

// marked 14 HTML-encodes token.text / codespan.text (`"` → `&quot;`, `&` →
// `&amp;`, `<`→`&lt;`, `>`→`&gt;`, `'`→`&#39;`), but we render to a terminal,
// not HTML — so the entities must be decoded back to literals or they leak as
// `&quot;` on screen. Decode the named set marked emits plus numeric refs;
// `&amp;` is unwound LAST so `&amp;lt;` → `&lt;` → `<` can't double-decode.
function decodeEntities(s) {
  if (typeof s !== 'string' || s.indexOf('&') === -1) return s;
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Render a single marked token to an ANSI string.
 * Mirrors CC's formatToken switch verbatim (minus table / hyperlink deps).
 */
export function formatToken(token, listDepth = 0, orderedListNumber = null, parent = null) {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? []).map((t) => formatToken(t)).join('');
      const bar = dim(BLOCKQUOTE_BAR);
      return inner
        .split(EOL)
        .map((line) => (stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line))
        .join(EOL);
    }
    case 'code':
      // No syntax highlighter — emit the code text as-is.
      return token.text + EOL;
    case 'codespan':
      // inline code
      return accent(decodeEntities(token.text));
    case 'em':
      return chalk.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''));
    case 'strong':
      return chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''));
    case 'heading':
      switch (token.depth) {
        case 1:
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? []).map((t) => formatToken(t)).join(''),
            ) + EOL + EOL
          );
        default: // h2+
          return chalk.bold((token.tokens ?? []).map((t) => formatToken(t)).join('')) + EOL + EOL;
      }
    case 'hr':
      return '---';
    case 'image':
      return token.href;
    case 'link': {
      if (token.href.startsWith('mailto:')) {
        return token.href.replace(/^mailto:/, '');
      }
      const linkText = (token.tokens ?? []).map((t) => formatToken(t, 0, null, token)).join('');
      const plain = stripAnsi(linkText);
      if (plain && plain !== token.href) {
        return `${linkText} (${token.href})`;
      }
      return token.href;
    }
    case 'list':
      return token.items
        .map((item, index) =>
          formatToken(item, listDepth, token.ordered ? token.start + index : null, token),
        )
        .join('');
    case 'list_item':
      return (token.tokens ?? [])
        .map((t) => `${'  '.repeat(listDepth)}${formatToken(t, listDepth + 1, orderedListNumber, token)}`)
        .join('');
    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t)).join('') + EOL;
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text':
      if (parent?.type === 'link') return decodeEntities(token.text);
      if (parent?.type === 'list_item') {
        const marker = orderedListNumber === null ? '-' : `${getListNumber(listDepth, orderedListNumber)}.`;
        const body = token.tokens
          ? token.tokens.map((t) => formatToken(t, listDepth, orderedListNumber, token)).join('')
          : decodeEntities(token.text);
        return `${marker} ${body}${EOL}`;
      }
      return decodeEntities(token.text);
    case 'escape':
      return decodeEntities(token.text);
    case 'def':
    case 'del':
    case 'html':
      return '';
    default:
      return '';
  }
}

/* --- ordered-list numbering (CC: numberToLetter / numberToRoman) ---------- */

function numberToLetter(n) {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(97 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

const ROMAN_VALUES = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

function numberToRoman(n) {
  let result = '';
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) { result += numeral; n -= value; }
  }
  return result;
}

function getListNumber(listDepth, orderedListNumber) {
  switch (listDepth) {
    case 0:
    case 1: return String(orderedListNumber);
    case 2: return numberToLetter(orderedListNumber);
    case 3: return numberToRoman(orderedListNumber);
    default: return String(orderedListNumber);
  }
}

/**
 * Pad `content` to `targetWidth` per alignment. `displayWidth` is the visible
 * width of `content` (ANSI codes excluded). Ported verbatim from CC padAligned.
 */
export function padAligned(content, displayWidth, targetWidth, align) {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad);
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content;
  }
  return content + ' '.repeat(padding);
}

export { chalk };
