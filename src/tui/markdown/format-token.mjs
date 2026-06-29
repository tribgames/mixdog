/**
 * markdown/format-token.mjs — token → ANSI string renderer.
 *
 * Token → ANSI string renderer:
 *   - chalk is forced to truecolor (level 3) so colors render regardless of the
 *     ambient TTY detection (we control the surface).
 *   - The `permission`/code accent and blockquote bar come from our theme.mjs.
 *   - `code` (fenced) is emitted as a block-colored plain text + EOL (no
 *     syntax highlighter dependency); `codespan` (inline) gets the accent color.
 *   - `table` is NOT handled here — the React component (MarkdownTable.jsx)
 *     renders tables with proper ink Box layout (hybrid split).
 *   - Hyperlinks/issue-ref linkify are dropped (no OSC-8 dependency); link text
 *     is shown plainly with its URL.
 */
import { Chalk } from 'chalk';
import stripAnsi from 'strip-ansi';
import { theme, getThemeVersion } from '../theme.mjs';
import { BLOCKQUOTE_BAR } from '../figures.mjs';

// Force truecolor so chalk emits 24-bit SGR even when the ambient level is 0.
// ink's <Text> passes these escapes through verbatim.
const chalk = new Chalk({ level: 3 });

// Use \n unconditionally (os.EOL's \r breaks segment mapping).
const EOL = '\n';

/** Parse an `rgb(r,g,b)` theme string into a chalk colorizer. */
function rgbColor(str) {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(str || ''));
  if (!m) return (s) => s;
  return chalk.rgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

// Colorizers are derived from the active theme's md* keys. They are cached and
// rebuilt only when the theme version changes, so a `/theme` switch takes
// effect on the next render without recomputing a chalk fn per token.
let _colorizerVersion = -1;
let _colorizers = null;
function colorizers() {
  const version = getThemeVersion();
  if (_colorizers && _colorizerVersion === version) return _colorizers;
  _colorizerVersion = version;
  _colorizers = {
    accent: rgbColor(theme.mdCode), // inline codespan
    codeBlock: rgbColor(theme.mdCodeBlock), // fenced code block body
    headingAccent: rgbColor(theme.mdHeading),
    quoteBorder: rgbColor(theme.mdQuoteBorder),
    quoteText: rgbColor(theme.mdQuote),
    hrLine: rgbColor(theme.mdHr),
    listBullet: rgbColor(theme.mdListBullet),
  };
  return _colorizers;
}

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
 * marked token switch (minus table / hyperlink deps).
 */
export function formatToken(token, listBaseIndent = 0, orderedListNumber = null, parent = null) {
  const { accent, codeBlock, headingAccent, quoteBorder, quoteText, hrLine } = colorizers();
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? []).map((t) => formatToken(t)).join('');
      const bar = quoteBorder(BLOCKQUOTE_BAR);
      return inner
        .split(EOL)
        .map((line) =>
          stripAnsi(line).trim()
            ? `${bar} ${quoteText(chalk.italic(line))}`
            : line,
        )
        .join(EOL);
    }
    case 'code':
      // No syntax highlighter — emit the code text as-is.
      return codeBlock(decodeEntities(token.text ?? '')) + EOL;
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
            chalk.bold.underline(headingAccent((token.tokens ?? []).map((t) => formatToken(t)).join(''))) + EOL + EOL
          );
        default: // h2+
          return chalk.bold(headingAccent((token.tokens ?? []).map((t) => formatToken(t)).join(''))) + EOL + EOL;
      }
    case 'hr':
      return hrLine('---') + EOL;
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
          formatToken(item, listBaseIndent, token.ordered ? Number(token.start || 1) + index : null, token),
        )
        .join('');
    case 'list_item':
      return formatListItem(token, listBaseIndent, orderedListNumber, parent);
    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t)).join('') + EOL;
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text':
      if (parent?.type === 'link') return decodeEntities(token.text);
      if (token.tokens) return token.tokens.map((t) => formatToken(t, listBaseIndent, orderedListNumber, token)).join('');
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

function trimTrailingEol(value) {
  return String(value ?? '').replace(/\n+$/g, '');
}

function prefixLines(value, prefix) {
  return String(value ?? '')
    .split(EOL)
    .map((line) => `${prefix}${line}`)
    .join(EOL);
}

function prefixFirstAndRest(value, firstPrefix, restPrefix) {
  const lines = String(value ?? '').split(EOL);
  if (lines.length === 0) return '';
  return [
    `${firstPrefix}${lines[0] ?? ''}`,
    ...lines.slice(1).map((line) => `${restPrefix}${line}`),
  ].join(EOL);
}

function formatListItem(token, listBaseIndent, orderedListNumber) {
  const { listBullet } = colorizers();
  const markerPlain = orderedListNumber === null
    ? '-'
    : `${orderedListNumber}.`;
  const marker = listBullet(markerPlain);
  const markerPrefix = `${' '.repeat(listBaseIndent)}${marker} `;
  const continuationPrefix = ' '.repeat(stripAnsi(markerPrefix).length);
  const nestedListIndent = continuationPrefix.length;
  const children = token.tokens ?? [];
  let out = '';
  let firstBlock = true;

  for (const child of children) {
    if (!child) continue;

    if (child.type === 'space') {
      if (!firstBlock) {
        out += `${continuationPrefix}${EOL}`;
      }
      continue;
    }

    if (child.type === 'list') {
      if (firstBlock) {
        out += `${markerPrefix.trimEnd()}${EOL}`;
        firstBlock = false;
      }
      out += formatToken(child, nestedListIndent, null, token);
      continue;
    }

    const rendered = formatToken(child, listBaseIndent, orderedListNumber, token);
    const body = trimTrailingEol(rendered);
    if (!body) continue;

    if (firstBlock) {
      out += `${prefixFirstAndRest(body, markerPrefix, continuationPrefix)}${EOL}`;
      firstBlock = false;
    } else {
      out += `${prefixLines(body, continuationPrefix)}${EOL}`;
    }
  }

  if (firstBlock) return `${markerPrefix.trimEnd()}${EOL}`;
  return out;
}

/**
 * Pad `content` to `targetWidth` per alignment. `displayWidth` is the visible
 * width of `content` (ANSI codes excluded).
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
