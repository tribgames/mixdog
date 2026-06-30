/**
 * markdown/format-token.mjs — token → ANSI string renderer.
 *
 * Token → ANSI string renderer:
 *   - chalk is forced to truecolor (level 3) so colors render regardless of the
 *     ambient TTY detection (we control the surface).
 *   - The `permission`/code accent and blockquote bar come from our theme.mjs.
 *   - `code` (fenced) uses cli-highlight + theme syntax palette; `codespan`
 *     (inline) gets the accent color.
 *   - `table` is NOT handled here — the React component (MarkdownTable.jsx)
 *     renders tables with proper ink Box layout (hybrid split).
 *   - Hyperlinks/issue-ref linkify are dropped (no OSC-8 dependency); link text
 *     is shown plainly with its URL.
 */
import { Chalk } from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import stripAnsi from 'strip-ansi';
import wrapAnsi from 'wrap-ansi';
import { theme, getThemeVersion } from '../theme.mjs';
import { BLOCKQUOTE_BAR, HR_LINE } from '../figures.mjs';
import { displayWidth } from '../display-width.mjs';

// Force truecolor so chalk emits 24-bit SGR even when the ambient level is 0.
// ink's <Text> passes these escapes through verbatim.
const chalk = new Chalk({ level: 3 });

// Use \n unconditionally (os.EOL's \r breaks segment mapping).
const EOL = '\n';

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
// Gutter-indented, syntax-highlighted body with NO background band and no ```
// fences (codex/claude-code convention). Diff/patch languages (and bodies that
// look like unified diffs) keep the diff highlighter; other languages use
// cli-highlight (highlight.js) themed from our syntax* palette; unknown
// languages fall back to flat `mdCodeBlock` body color.
const DIFF_LANGS = new Set(['diff', 'patch', 'udiff', 'git-diff', 'gitdiff']);

/** Wrap text to width, ANSI-aware (lockstep with table-layout hard wrap). */
function wrapTextToWidth(text, width, options) {
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

/** Hard-wrap so every line satisfies stringWidth(line) <= width. */
function hardWrapAnsiLines(text, width) {
  const max = Math.max(1, Math.floor(Number(width) || 1));
  const input = String(text ?? '');
  if (!input) return [''];
  const out = [];
  for (const softLine of wrapTextToWidth(input, max, { hard: true })) {
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

/** Wrap one logical code line (ANSI content) to max visible width. */
function wrapCodeLine(ansiContent, maxLineWidth) {
  const contentMax = Math.max(1, maxLineWidth);
  return hardWrapAnsiLines(ansiContent, contentMax);
}

/** Reduce render width by a visible prefix (list marker, blockquote bar, etc.). */
function contentWidthAfterPrefix(width, prefix) {
  const base = Number(width) || 0;
  if (base <= 0) return 0;
  return Math.max(8, base - displayWidth(String(prefix ?? '')));
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

function collectDiffBodyLines(text, c, bandWidth) {
  const lines = [];
  for (const line of String(text ?? '').split(EOL)) {
    const colored = colorizeDiffLine(line, c);
    lines.push(...wrapCodeLine(colored, bandWidth));
  }
  return lines;
}

// ── cli-highlight (highlight.js) ────────────────────────────────────────────
/** Internal family → highlight.js language id (when alias alone is insufficient). */
const FAMILY_TO_HLJS = {
  js: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  json: 'json',
  sh: 'bash',
  py: 'python',
  css: 'css',
  html: 'xml',
  go: 'go',
  rust: 'rust',
  java: 'java',
  c: 'cpp',
  ruby: 'ruby',
  sql: 'sql',
  yaml: 'yaml',
  toml: 'ini',
  kotlin: 'kotlin',
  swift: 'swift',
  php: 'php',
  csharp: 'csharp',
  dockerfile: 'dockerfile',
  protobuf: 'protobuf',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  perl: 'perl',
  r: 'r',
  objc: 'objectivec',
  powershell: 'powershell',
  makefile: 'makefile',
  nginx: 'nginx',
  ini: 'ini',
  vim: 'vim',
  haskell: 'haskell',
  elixir: 'elixir',
  clojure: 'clojure',
};

export const LANG_FAMILY = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js',
  ts: 'ts', typescript: 'ts', jsx: 'jsx', tsx: 'tsx',
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
  kotlin: 'kotlin', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  php: 'php',
  csharp: 'csharp', cs: 'csharp', 'c#': 'csharp',
  dockerfile: 'dockerfile', docker: 'dockerfile',
  graphql: 'graphql', gql: 'graphql',
  protobuf: 'protobuf', proto: 'protobuf',
  scala: 'scala',
  dart: 'dart',
  lua: 'lua',
  perl: 'perl', pl: 'perl',
  r: 'r', rl: 'r',
  objc: 'objc', 'objective-c': 'objc', 'obj-c': 'objc',
  powershell: 'powershell', ps1: 'powershell', ps: 'powershell', pwsh: 'powershell',
  makefile: 'makefile', make: 'makefile',
  nginx: 'nginx',
  ini: 'ini',
  vim: 'vim',
  haskell: 'haskell', hs: 'haskell',
  elixir: 'elixir', ex: 'elixir', exs: 'elixir',
  clojure: 'clojure', clj: 'clojure',
};

const HIGHLIGHT_CACHE_MAX = 300;
const highlightCache = new Map();

/** @internal Test-only introspection for highlight LRU cache. */
export function _highlightCacheSizeForTests() {
  return highlightCache.size;
}

let _hljsThemeVersion = -1;
let _hljsTheme = null;

/** Map highlight.js token classes to chalk truecolor fns from the active theme. */
function buildCliHighlightTheme(c) {
  const plain = (s) => c.body(s);
  return {
    default: plain,
    keyword: c.synKeyword,
    built_in: c.synType,
    type: c.synType,
    literal: c.synKeyword,
    number: c.synNumber,
    regexp: c.synString,
    string: c.synString,
    subst: plain,
    symbol: plain,
    class: c.synType,
    function: c.synFunction,
    title: c.synFunction,
    params: c.synVariable,
    comment: c.synComment,
    doctag: c.synComment,
    meta: c.synComment,
    section: c.synType,
    tag: c.synPunct,
    name: c.synFunction,
    builtin: c.synType,
    attr: c.synType,
    attribute: c.synType,
    variable: c.synVariable,
    selector: c.synKeyword,
    template: c.synVariable,
    bullet: plain,
    code: plain,
    emphasis: plain,
    strong: plain,
    formula: plain,
    link: plain,
    quote: plain,
    addition: c.synString,
    deletion: c.synString,
  };
}

function getCliHighlightTheme() {
  const version = getThemeVersion();
  if (_hljsTheme && _hljsThemeVersion === version) return _hljsTheme;
  _hljsThemeVersion = version;
  _hljsTheme = buildCliHighlightTheme(extraColorizers());
  return _hljsTheme;
}

function hljsLanguageFromFamily(family) {
  if (!family || family === 'md') return null;
  const mapped = FAMILY_TO_HLJS[family];
  if (mapped && supportsLanguage(mapped)) return mapped;
  if (supportsLanguage(family)) return family;
  return null;
}

/** Resolve a fenced info-string to a highlight.js language id. */
function resolveHljsLanguage(lang) {
  const normalized = normalizeLang(lang);
  if (!normalized) return null;
  const viaFamily = hljsLanguageFromFamily(LANG_FAMILY[normalized]);
  if (viaFamily) return viaFamily;
  return supportsLanguage(normalized) ? normalized : null;
}

/**
 * Highlight source with cli-highlight; returns null when language is unsupported
 * or highlighting fails (caller falls back to flat body color).
 */
function highlightCodeText(text, hljsLang) {
  if (!hljsLang || !supportsLanguage(hljsLang)) return null;
  const src = String(text ?? '');
  if (!src.trim()) return null;
  if (!/[A-Za-z0-9]/.test(src)) return null;
  const cacheKey = `${hljsLang}|${getThemeVersion()}|${src}`;
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) {
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const out = highlight(src, {
      language: hljsLang,
      theme: getCliHighlightTheme(),
      ignoreIllegals: true,
    });
    if (highlightCache.size >= HIGHLIGHT_CACHE_MAX) {
      const first = highlightCache.keys().next().value;
      if (first !== undefined) highlightCache.delete(first);
    }
    highlightCache.set(cacheKey, out);
    return out;
  } catch {
    return null;
  }
}

/** Highlight a single line (tool expanded output); uses the same theme map. */
export function highlightCodeLine(line, family, c) {
  const hljsLang = hljsLanguageFromFamily(family);
  const highlighted = highlightCodeText(line, hljsLang);
  if (highlighted != null) return highlighted;
  return line ? c.body(line) : '';
}

/**
 * Highlight a multi-line block in one cli-highlight call; returns one ANSI string per line.
 * On miss, each line is flat-colored with `c.body`.
 */
export function highlightCodeBlockToLines(text, family, c) {
  const hljsLang = hljsLanguageFromFamily(family);
  const raw = String(text ?? '');
  const highlighted = hljsLang ? highlightCodeText(raw, hljsLang) : null;
  if (highlighted != null) {
    return highlighted.split(EOL);
  }
  return raw.split(EOL).map((line) => (line ? c.body(line) : ''));
}

function collectFlatBodyLines(text, codeBlock, bandWidth) {
  const lines = [];
  for (const line of String(text ?? '').split(EOL)) {
    const colored = codeBlock(line);
    lines.push(...wrapCodeLine(colored, bandWidth));
  }
  return lines;
}

function collectHighlightedBodyLines(text, hljsLang, bandWidth) {
  const highlighted = highlightCodeText(text, hljsLang);
  const { codeBlock } = colorizers();
  const source = highlighted != null
    ? highlighted
    : String(text ?? '').split(EOL).map(codeBlock).join(EOL);
  const lines = [];
  for (const line of source.split(EOL)) {
    lines.push(...wrapCodeLine(line, bandWidth));
  }
  return lines;
}

/** Left gutter that keeps code visually distinct from prose (no bg band). */
const CODE_GUTTER = '  ';

/**
 * Render a fenced `code` token (codex/claude-code convention): an optional
 * subtle language label row, then the wrapped, syntax/diff/flat-highlighted
 * body. Every row is left-indented by a 2-col gutter. NO background band, no
 * full-width padding, and no visible ``` fence lines.
 */
function renderCodeBlock(token, width = 0) {
  const { codeBlock } = colorizers();
  const c = extraColorizers();
  const lang = normalizeLang(token.lang);
  const text = decodeEntities(token.text ?? '');
  const renderWidth = Math.max(8, Number(width) || 80);
  // Wrap content to the render width minus the left gutter so `gutter + content`
  // never overruns the available width.
  const contentWidth = Math.max(1, renderWidth - CODE_GUTTER.length);

  let bodyLines;
  if (DIFF_LANGS.has(lang) || (!lang && looksLikeUnifiedDiff(text))) {
    bodyLines = collectDiffBodyLines(text, c, contentWidth);
  } else {
    const hljsLang = resolveHljsLanguage(lang);
    const family = LANG_FAMILY[lang];
    if (hljsLang && family !== 'md') {
      bodyLines = collectHighlightedBodyLines(text, hljsLang, contentWidth);
    } else {
      bodyLines = collectFlatBodyLines(text, codeBlock, contentWidth);
    }
  }
  // Indent every body row by the gutter (no bg band).
  const indentedBody = bodyLines.map((line) => `${CODE_GUTTER}${line ?? ''}`);
  // Language label: a subtle (syntax-comment colored) metadata row above the
  // body. Its trimmed visible text is exactly the bare lang token, so consumers
  // can detect the label by trimmed equality.
  const langLine = lang ? `${CODE_GUTTER}${c.synComment(lang)}` : null;
  const rows = [...(langLine ? [langLine] : []), ...indentedBody].join(EOL);
  return `${rows}${rows ? EOL : ''}`;
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
      const bar = quoteBorder(BLOCKQUOTE_BAR);
      const quotePrefix = `${BLOCKQUOTE_BAR} `;
      const innerWidth = contentWidthAfterPrefix(width, quotePrefix);
      const inner = (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, innerWidth)).join('');
      return inner
        .split(EOL)
        .map((line) => {
          // Padded fenced-code blank rows are space-only; trim() would drop the quote bar.
          if (displayWidth(stripAnsi(line)) === 0) return line;
          return `${bar} ${quoteText(chalk.italic(line))}`;
        })
        .join(EOL);
    }
    case 'code':
      // Fenced block: flush-left wrapped body with syntax highlighting.
      return renderCodeBlock(token, width);
    case 'codespan':
      // inline code — accent color only (no background tint; a bg box behind
      // inline spans reads as awkward against body text, matches claude-code's
      // codespan = color-only treatment).
      return accent(decodeEntities(token.text));
    case 'em':
      // Italic only — no color tint (matches codex/claude-code; a colored em
      // clashes per-theme and reads loud against body prose).
      return chalk.italic((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''));
    case 'strong':
      // Bold only — no color tint (stays body-colored, just heavier weight).
      return chalk.bold((token.tokens ?? []).map((t) => formatToken(t, 0, null, parent)).join(''));
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
            width,
            depth,
          ),
        )
        .join('');
    case 'list_item':
      return formatListItem(token, listBaseIndent, orderedListNumber, parent, depth, width);
    case 'paragraph':
      return (token.tokens ?? []).map((t) => formatToken(t, 0, null, null, width)).join('') + EOL;
    case 'space':
      return EOL;
    case 'br':
      return EOL;
    case 'text':
      if (parent?.type === 'link') return decodeEntities(token.text);
      if (token.tokens) {
        return token.tokens.map((t) => formatToken(t, listBaseIndent, orderedListNumber, token, width, depth)).join('');
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

function formatListItem(token, listBaseIndent, orderedListNumber, parent, depth = 0, width = 0) {
  const { listBullet } = colorizers();
  const markerPlain = orderedListNumber === null
    ? '-'
    : `${getListNumber(depth, orderedListNumber)}.`;
  const marker = listBullet(markerPlain);
  const markerPrefix = `${' '.repeat(listBaseIndent)}${marker} `;
  const continuationPrefix = ' '.repeat(stripAnsi(markerPrefix).length);
  const nestedListIndent = continuationPrefix.length;
  const childWidth = contentWidthAfterPrefix(width, continuationPrefix);
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
      // Pass outer `width` so the nested list subtracts only its own marker prefix once.
      out += formatToken(child, nestedListIndent, null, token, width, depth + 1);
      continue;
    }

    const rendered = formatToken(child, listBaseIndent, orderedListNumber, token, childWidth, depth);
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
