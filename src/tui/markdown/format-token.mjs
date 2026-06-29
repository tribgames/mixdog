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

// Extended colorizers (fence border, link, emphasis, diff + syntax classes).
// Cached on the same theme-version key so a /theme switch rebuilds both maps.
let _extraVersion = -1;
let _extra = null;
export function extraColorizers() {
  const version = getThemeVersion();
  if (_extra && _extraVersion === version) return _extra;
  _extraVersion = version;
  const fallbackBody = rgbColor(theme.mdCodeBlock);
  _extra = {
    fenceBorder: rgbColor(theme.mdCodeBlockBorder ?? theme.mdHr),
    link: rgbColor(theme.mdLink ?? theme.code),
    linkText: rgbColor(theme.mdLinkText ?? theme.mdCode),
    strong: rgbColor(theme.mdStrong ?? theme.mdHeading),
    emph: rgbColor(theme.mdEmph ?? theme.mdHeading),
    // diff/patch
    diffAdded: rgbColor(theme.mdDiffAdded ?? theme.success),
    diffRemoved: rgbColor(theme.mdDiffRemoved ?? theme.error),
    diffHunk: rgbColor(theme.mdDiffHunk ?? theme.code),
    diffHeader: rgbColor(theme.mdDiffHeader ?? theme.mdHeading),
    diffContext: rgbColor(theme.mdDiffContext ?? theme.subtle),
    // syntax classes (fall back to plain code-block body when key missing)
    synComment: rgbColor(theme.syntaxComment ?? theme.subtle),
    synKeyword: rgbColor(theme.syntaxKeyword ?? theme.mdCodeBlock),
    synFunction: rgbColor(theme.syntaxFunction ?? theme.mdCodeBlock),
    synVariable: rgbColor(theme.syntaxVariable ?? theme.mdCodeBlock),
    synString: rgbColor(theme.syntaxString ?? theme.mdCodeBlock),
    synNumber: rgbColor(theme.syntaxNumber ?? theme.mdCodeBlock),
    synType: rgbColor(theme.syntaxType ?? theme.mdCodeBlock),
    synOperator: rgbColor(theme.syntaxOperator ?? theme.mdCodeBlock),
    synPunct: rgbColor(theme.syntaxPunctuation ?? theme.mdCodeBlock),
    body: fallbackBody,
  };
  return _extra;
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

// ── Fenced code block rendering ─────────────────────────────────────────────
// Pi-style: a `codeBlockBorder`-colored fence line with the optional language
// label, a two-space-indented body, and a closing fence. Diff/patch languages
// (and code text that clearly looks like a unified diff) get colored +/-/@@
// lines; other known languages get a conservative regex highlighter; unknown
// languages fall back to the flat `mdCodeBlock` body color.
const CODE_BLOCK_INDENT = '  ';
const DIFF_LANGS = new Set(['diff', 'patch', 'udiff', 'git-diff', 'gitdiff']);

/** Normalize a fenced info-string to a bare lowercase language token. */
function normalizeLang(lang) {
  return String(lang || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
}

/**
 * Heuristic: does this code body look like a unified diff/patch? Requires at
 * least one +/- body line AND a hunk header or file header, so ordinary code
 * with leading +/- (rare) is not misclassified.
 */
export function looksLikeUnifiedDiff(text) {
  const lines = String(text ?? '').split(EOL);
  let hasHunk = false;
  let hasFileHeader = false;
  let hasSign = false;
  for (const line of lines) {
    if (/^@@ .* @@/.test(line) || /^@@ /.test(line)) hasHunk = true;
    if (/^(\+\+\+ |--- |diff --git |index [0-9a-f]+)/.test(line)) hasFileHeader = true;
    if (/^[+-](?![+-])/.test(line)) hasSign = true;
  }
  return (hasHunk || hasFileHeader) && hasSign;
}

/** Classify and color a single unified-diff line. */
export function colorizeDiffLine(line, c) {
  // File/section headers first so +++/--- are never treated as add/remove.
  if (/^(\+\+\+|---)(\s|$)/.test(line)) return c.diffHeader(line);
  if (/^(diff --git |index [0-9a-f]|new file|deleted file|rename |similarity |old mode|new mode)/.test(line)) {
    return c.diffHeader(line);
  }
  if (/^@@/.test(line)) return c.diffHunk(line);
  if (/^\+/.test(line)) return c.diffAdded(line);
  if (/^-/.test(line)) return c.diffRemoved(line);
  if (/^\\ No newline/.test(line)) return c.diffContext(line);
  return c.diffContext(line);
}

function renderDiffBody(text, c) {
  return String(text ?? '')
    .split(EOL)
    .map((line) => `${CODE_BLOCK_INDENT}${colorizeDiffLine(line, c)}`)
    .join(EOL);
}

// ── Lightweight syntax highlighting (regex token classes, no parser) ────────
const KEYWORDS = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'null', 'undefined', 'true', 'false'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue', 'lambda', 'yield', 'global', 'nonlocal', 'async', 'await', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'self'],
  sh: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'in', 'export', 'local', 'echo', 'cd', 'set', 'unset', 'read', 'source'],
  css: [],
};

export const LANG_FAMILY = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js',
  ts: 'js', typescript: 'js', jsx: 'js', tsx: 'js',
  json: 'json', json5: 'json',
  bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh',
  python: 'py', py: 'py',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html',
  md: 'md', markdown: 'md',
};

/** Highlight a single line for a c-like / scripting family (token scan). */
export function highlightCodeLine(line, family, c) {
  const kw = new Set(KEYWORDS[family === 'json' ? 'js' : family] || []);
  // Comment lines (whole-line) for the common families.
  if (family === 'js' && /^\s*\/\//.test(line)) return c.synComment(line);
  if ((family === 'sh' || family === 'py') && /^\s*#/.test(line)) return c.synComment(line);
  if (family === 'html' && /^\s*<!--/.test(line)) return c.synComment(line);

  // Token regex: strings, numbers, comments, identifiers, punctuation.
  const TOKEN_RE = /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/\/[^\n]*|#[^\n]*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][A-Za-z0-9_$]*)|([{}()[\].,;:=+\-*/%<>!&|^~?]+)/g;
  let out = '';
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) out += c.body(line.slice(last, m.index));
    const [, str, comment, num, ident, punct] = m;
    if (str !== undefined) {
      out += c.synString(str);
    } else if (comment !== undefined) {
      // `#` is only a comment for sh/py; for js treat as body.
      if (comment.startsWith('//') ? family === 'js' : (family === 'sh' || family === 'py')) {
        out += c.synComment(comment);
      } else {
        out += c.body(comment);
      }
    } else if (num !== undefined) {
      out += c.synNumber(num);
    } else if (ident !== undefined) {
      if (kw.has(ident)) out += c.synKeyword(ident);
      else if (line[TOKEN_RE.lastIndex] === '(') out += c.synFunction(ident);
      else out += c.body(ident);
    } else if (punct !== undefined) {
      out += c.synOperator(punct);
    }
    last = TOKEN_RE.lastIndex;
  }
  if (last < line.length) out += c.body(line.slice(last));
  return out;
}

function renderHighlightedBody(text, family, c) {
  return String(text ?? '')
    .split(EOL)
    .map((line) => `${CODE_BLOCK_INDENT}${line ? highlightCodeLine(line, family, c) : ''}`)
    .join(EOL);
}

/**
 * Render a fenced `code` token as a bordered/fenced block with an optional
 * language label, two-space body indent, and language-aware coloring.
 */
function renderCodeBlock(token) {
  const { codeBlock } = colorizers();
  const c = extraColorizers();
  const lang = normalizeLang(token.lang);
  const text = decodeEntities(token.text ?? '');
  const openFence = c.fenceBorder(`\`\`\`${lang}`);
  const closeFence = c.fenceBorder('```');

  let body;
  if (DIFF_LANGS.has(lang) || (!lang && looksLikeUnifiedDiff(text))) {
    body = renderDiffBody(text, c);
  } else {
    const family = LANG_FAMILY[lang];
    if (family && family !== 'md' && family !== 'html' && family !== 'json') {
      body = renderHighlightedBody(text, family, c);
    } else if (family === 'json' || family === 'html') {
      body = renderHighlightedBody(text, family === 'json' ? 'json' : 'html', c);
    } else {
      // Unknown/plain language: flat code-block body color, still indented.
      body = text
        .split(EOL)
        .map((line) => `${CODE_BLOCK_INDENT}${codeBlock(line)}`)
        .join(EOL);
    }
  }
  return `${openFence}${EOL}${body}${EOL}${closeFence}${EOL}`;
}

/**
 * Render a single marked token to an ANSI string.
 * marked token switch (minus table / hyperlink deps).
 */
export function formatToken(token, listBaseIndent = 0, orderedListNumber = null, parent = null) {
  const { accent, codeBlock, headingAccent, quoteBorder, quoteText, hrLine } = colorizers();
  const ex = extraColorizers();
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
      // Fenced block: bordered fence + lang label + indented, colored body.
      return renderCodeBlock(token);
    case 'codespan':
      // inline code
      return accent(decodeEntities(token.text));
    case 'em':
      return ex.emph(chalk.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join('')));
    case 'strong':
      return ex.strong(chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join('')));
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
        return ex.linkText(token.href.replace(/^mailto:/, ''));
      }
      const linkText = (token.tokens ?? []).map((t) => formatToken(t, 0, null, token)).join('');
      const plain = stripAnsi(linkText);
      const styledLabel = ex.linkText(chalk.underline(linkText));
      if (plain && plain !== token.href) {
        return `${styledLabel} ${ex.link(`(${token.href})`)}`;
      }
      return ex.link(token.href);
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
