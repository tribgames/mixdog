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
import { BLOCKQUOTE_BAR, HR_LINE } from '../figures.mjs';

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

/**
 * Parse an `rgb(r,g,b)` theme string into a TRUECOLOR BACKGROUND wrapper. Emits
 * `48;2;R;G;B` … `49` (bg reset) around the string so AnsiText (case 48) maps it
 * to an ink backgroundColor, giving a code line a tinted band. Returns identity
 * when the string is not a valid rgb() so a missing key never corrupts output.
 */
function rgbBg(str) {
  const m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(String(str || ''));
  if (!m) return (s) => s;
  const open = `\x1b[48;2;${+m[1]};${+m[2]};${+m[3]}m`;
  return (s) => `${open}${s}\x1b[49m`;
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
    // Truecolor background band for fenced code blocks (per-line wrap).
    codeBg: rgbBg(theme.mdCodeBlockBg ?? theme.background),
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

/** Pad a (possibly ANSI) line to `bandWidth` visible columns, then caller wraps bg. */
function padToBand(line, bandWidth) {
  const visible = stripAnsi(line).length;
  const pad = bandWidth > visible ? ' '.repeat(bandWidth - visible) : '';
  return line + pad;
}

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
  let hasStat = false;
  for (const line of lines) {
    if (/^@@ .* @@/.test(line) || /^@@ /.test(line)) hasHunk = true;
    if (/^(\+\+\+ |--- |diff --git |index [0-9a-f]+)/.test(line)) hasFileHeader = true;
    if (/^[+-](?![+-])/.test(line)) hasSign = true;
    // `git diff --stat` summary rows: `path | 4 +-` and the trailer
    // `N files changed, M insertions(+), K deletions(-)`.
    if (DIFF_STAT_FILE_RE.test(line) || DIFF_STAT_SUMMARY_RE.test(line)) hasStat = true;
  }
  return ((hasHunk || hasFileHeader) && hasSign) || hasStat;
}

// `git diff --stat` rows. FILE: `<path> | <count> <+/-/ graph>` (count may be
// `Bin`); SUMMARY: `N file(s) changed[, M insertion…][, K deletion…]`.
const DIFF_STAT_FILE_RE = /^(\s*)(.+?)(\s+\|\s+)(Bin\b.*|\d+\s*[+\-]*)\s*$/;
const DIFF_STAT_SUMMARY_RE = /^\s*\d+\s+files?\s+changed\b/;

/** Color a `git diff --stat` file row: dim path/sep, green `+`, red `-`. */
function colorizeDiffStatLine(line, c) {
  const m = DIFF_STAT_FILE_RE.exec(line);
  if (m) {
    const [, indent, path, sep, tail] = m;
    // The tail is either `Bin …` or `<count> <graph>` where graph is +/-.
    const countMatch = /^(\d+)(\s*)([+\-]*)\s*$/.exec(tail);
    let coloredTail;
    if (countMatch) {
      const [, count, gap, bars] = countMatch;
      const pluses = c.diffAdded('+'.repeat((bars.match(/\+/g) || []).length));
      const minuses = c.diffRemoved('-'.repeat((bars.match(/-/g) || []).length));
      coloredTail = `${c.diffContext(count)}${gap}${pluses}${minuses}`;
    } else {
      coloredTail = c.diffContext(tail);
    }
    return `${indent}${c.diffContext(path)}${c.diffContext(sep)}${coloredTail}`;
  }
  return c.diffContext(line);
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
  // `git diff --stat` summary trailer + per-file rows.
  if (DIFF_STAT_SUMMARY_RE.test(line)) return colorizeDiffStatTrailer(line, c);
  if (DIFF_STAT_FILE_RE.test(line)) return colorizeDiffStatLine(line, c);
  return c.diffContext(line);
}

/** Color the `N files changed, M insertions(+), K deletions(-)` trailer. */
function colorizeDiffStatTrailer(line, c) {
  return line.replace(/(\d+)(\s+insertions?\(\+\))/g, (_, n, rest) => `${c.diffAdded(n)}${c.diffContext(rest)}`)
    .replace(/(\d+)(\s+deletions?\(-\))/g, (_, n, rest) => `${c.diffRemoved(n)}${c.diffContext(rest)}`);
}

function renderDiffBody(text, c, bandWidth) {
  return String(text ?? '')
    .split(EOL)
    .map((line) => c.codeBg(padToBand(`${CODE_BLOCK_INDENT}${colorizeDiffLine(line, c)}`, bandWidth)))
    .join(EOL);
}

// ── Lightweight syntax highlighting (regex token classes, no parser) ────────
const KEYWORDS = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'default', 'async', 'await', 'yield', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'void', 'delete', 'null', 'undefined', 'true', 'false'],
  py: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue', 'lambda', 'yield', 'global', 'nonlocal', 'async', 'await', 'and', 'or', 'not', 'in', 'is', 'None', 'True', 'False', 'self'],
  sh: ['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'return', 'in', 'export', 'local', 'echo', 'cd', 'set', 'unset', 'read', 'source'],
  css: [],
  go: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'fallthrough', 'goto', 'defer', 'go', 'select', 'chan', 'map', 'struct', 'interface', 'type', 'var', 'const', 'nil', 'true', 'false', 'iota', 'string', 'int', 'int64', 'float64', 'bool', 'byte', 'rune', 'error'],
  rust: ['fn', 'let', 'mut', 'const', 'static', 'return', 'if', 'else', 'match', 'for', 'while', 'loop', 'break', 'continue', 'struct', 'enum', 'trait', 'impl', 'mod', 'use', 'pub', 'crate', 'self', 'super', 'where', 'as', 'dyn', 'move', 'ref', 'unsafe', 'async', 'await', 'type', 'true', 'false', 'Some', 'None', 'Ok', 'Err', 'Box', 'Vec', 'String', 'usize', 'isize', 'i32', 'u32', 'i64', 'u64', 'f64', 'bool'],
  java: ['public', 'private', 'protected', 'class', 'interface', 'enum', 'extends', 'implements', 'abstract', 'final', 'static', 'void', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'this', 'super', 'instanceof', 'synchronized', 'volatile', 'transient', 'native', 'int', 'long', 'short', 'byte', 'char', 'float', 'double', 'boolean', 'true', 'false', 'null'],
  c: ['auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'class', 'namespace', 'template', 'public', 'private', 'protected', 'virtual', 'new', 'delete', 'using', 'nullptr', 'true', 'false', 'bool'],
  ruby: ['def', 'end', 'class', 'module', 'if', 'elsif', 'else', 'unless', 'case', 'when', 'then', 'while', 'until', 'for', 'in', 'do', 'begin', 'rescue', 'ensure', 'raise', 'return', 'yield', 'break', 'next', 'redo', 'retry', 'self', 'nil', 'true', 'false', 'and', 'or', 'not', 'require', 'require_relative', 'attr_accessor', 'attr_reader', 'attr_writer', 'puts', 'lambda', 'proc'],
  sql: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'alter', 'drop', 'table', 'view', 'index', 'join', 'inner', 'left', 'right', 'outer', 'full', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'as', 'and', 'or', 'not', 'null', 'is', 'in', 'between', 'like', 'union', 'all', 'primary', 'key', 'foreign', 'references', 'default', 'constraint', 'unique', 'count', 'sum', 'avg', 'min', 'max'],
  yaml: [],
  toml: [],
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
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  java: 'java',
  c: 'c', cpp: 'c', 'c++': 'c', cc: 'c', h: 'c', hpp: 'c',
  ruby: 'ruby', rb: 'ruby',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
};

// Families whose comment lines / inline comments start with `#`.
const HASH_COMMENT_FAMILIES = new Set(['sh', 'py', 'yaml', 'toml']);

/** Highlight a single line for a c-like / scripting family (token scan). */
export function highlightCodeLine(line, family, c) {
  const kw = new Set(KEYWORDS[family === 'json' ? 'js' : family] ?? []);
  // Comment lines (whole-line) for the common families.
  if (family === 'js' && /^\s*\/\//.test(line)) return c.synComment(line);
  if (HASH_COMMENT_FAMILIES.has(family) && /^\s*#/.test(line)) return c.synComment(line);
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
      if (comment.startsWith('//') ? family === 'js' : HASH_COMMENT_FAMILIES.has(family)) {
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

function renderHighlightedBody(text, family, c, bandWidth) {
  return String(text ?? '')
    .split(EOL)
    .map((line) => c.codeBg(padToBand(
      `${CODE_BLOCK_INDENT}${line ? highlightCodeLine(line, family, c) : ''}`,
      bandWidth,
    )))
    .join(EOL);
}

/**
 * Render a fenced `code` token as a bordered/fenced block with an optional
 * language label, two-space body indent, and language-aware coloring.
 */
function renderCodeBlock(token, width = 0) {
  const { codeBlock } = colorizers();
  const c = extraColorizers();
  const lang = normalizeLang(token.lang);
  const text = decodeEntities(token.text ?? '');
  const bandWidth = Math.max(0, Number(width) || 80);
  // The fences sit on the same background band as the body so the whole block
  // reads as one tinted region. Each line opens+closes its own bg SGR so
  // wrapping/measurement is unaffected.
  const openFence = c.codeBg(padToBand(c.fenceBorder(`\`\`\`${lang}`), bandWidth));
  const closeFence = c.codeBg(padToBand(c.fenceBorder('```'), bandWidth));

  let body;
  if (DIFF_LANGS.has(lang) || (!lang && looksLikeUnifiedDiff(text))) {
    body = renderDiffBody(text, c, bandWidth);
  } else {
    const family = LANG_FAMILY[lang];
    // Any known family except markdown-in-markdown routes through the regex
    // highlighter (html/json/yaml/toml included). 'md' stays flat (no nested
    // markdown highlighter); unknown langs fall back to the flat body color.
    if (family && family !== 'md') {
      body = renderHighlightedBody(text, family, c, bandWidth);
    } else {
      // Unknown/plain language: flat code-block body color, still indented.
      body = text
        .split(EOL)
        .map((line) => c.codeBg(padToBand(`${CODE_BLOCK_INDENT}${codeBlock(line)}`, bandWidth)))
        .join(EOL);
    }
  }
  return `${openFence}${EOL}${body}${EOL}${closeFence}${EOL}`;
}

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
    while (n >= value) {
      result += numeral;
      n -= value;
    }
  }
  return result;
}

function getListNumber(depth, orderedListNumber) {
  switch (depth) {
    case 0:
    case 1:
      return String(orderedListNumber);
    case 2:
      return numberToLetter(orderedListNumber);
    case 3:
      return numberToRoman(orderedListNumber);
    default:
      return String(orderedListNumber);
  }
}

/**
 * Render a single marked token to an ANSI string.
 * marked token switch (minus table / hyperlink deps).
 */
export function formatToken(token, listBaseIndent = 0, orderedListNumber = null, parent = null, width = 0, depth = 0) {
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
      return renderCodeBlock(token, width);
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
            chalk.bold.italic.underline(headingAccent((token.tokens ?? []).map((t) => formatToken(t)).join(''))) + EOL + EOL
          );
        default: // h2+
          return chalk.bold(headingAccent((token.tokens ?? []).map((t) => formatToken(t)).join(''))) + EOL + EOL;
      }
    case 'hr': {
      // Span the available content width with a box-drawing rule. width is only
      // threaded from the top-level token loop; recursive calls pass 0 and fall
      // back to a sane 80-col rule.
      const w = Math.max(3, Number(width) || 80);
      return hrLine(HR_LINE.repeat(w)) + EOL;
    }
    case 'image':
      return token.href;
    case 'link': {
      if (token.href.startsWith('mailto:')) {
        return ex.linkText(token.href.replace(/^mailto:/, ''));
      }
      const linkText = (token.tokens ?? []).map((t) => formatToken(t, 0, null, token)).join('');
      const plain = stripAnsi(linkText);
      const href = token.href;
      // OSC 8 hyperlink: clickable label, URL hidden in supporting terminals
      // (Windows Terminal / iTerm); other terminals show the label text as-is.
      // AnsiText only strips `\x1b[...m` SGR, so the OSC 8 `\x1b]8;;…\x07`
      // sequences pass through untouched for the terminal to interpret.
      const OSC8_OPEN = (url) => `\x1b]8;;${url}\x07`;
      const OSC8_CLOSE = '\x1b]8;;\x07';
      if (plain && plain !== href) {
        const styledLabel = ex.linkText(chalk.underline(linkText));
        return `${OSC8_OPEN(href)}${styledLabel}${OSC8_CLOSE}`;
      }
      // No distinct label (empty or equal to href): show the URL itself as the
      // clickable, visible text.
      return `${OSC8_OPEN(href)}${ex.link(chalk.underline(href))}${OSC8_CLOSE}`;
    }
    case 'list':
      return token.items
        .map((item, index) =>
          formatToken(
            item,
            listBaseIndent,
            token.ordered ? Number(token.start || 1) + index : null,
            token,
            0,
            depth,
          ),
        )
        .join('');
    case 'list_item':
      return formatListItem(token, listBaseIndent, orderedListNumber, parent, depth);
    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t)).join('') + EOL;
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text':
      if (parent?.type === 'link') return decodeEntities(token.text);
      if (token.tokens) {
        return token.tokens.map((t) => formatToken(t, listBaseIndent, orderedListNumber, token, 0, depth)).join('');
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

function formatListItem(token, listBaseIndent, orderedListNumber, parent, depth = 0) {
  const { listBullet } = colorizers();
  const markerPlain = orderedListNumber === null
    ? '-'
    : `${getListNumber(depth, orderedListNumber)}.`;
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
      out += formatToken(child, nestedListIndent, null, token, 0, depth + 1);
      continue;
    }

    const rendered = formatToken(child, listBaseIndent, orderedListNumber, token, 0, depth);
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
