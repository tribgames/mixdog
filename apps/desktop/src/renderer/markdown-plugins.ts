// Shared rehype-stage helpers used by BOTH markdown pipelines (the lazy
// react-markdown chunk and the worker AST processor) so their DOM output
// stays identical. Keep this module dependency-free: it is pulled into the
// renderer bundle and the markdown worker alike.
import { isOsDocumentExtension } from '../shared/local-files';
import { isLocalMarkdownLink } from './markdown-url';

interface HastLikeNode {
  type?: string;
  value?: unknown;
  tagName?: unknown;
  properties?: Record<string, unknown>;
  children?: HastLikeNode[];
}

const adjacentStrongPunctuation =
  /(\*\*(?!\s)([^*\n]*?[^\s\p{L}\p{N}*])\*\*|__(?!\s)([^_\n]*?[^\s\p{L}\p{N}_])__)(?=[\p{L}\p{N}])/gu;

function escapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

// CommonMark does not close `**0.118%**이며` because punctuation immediately
// precedes the closing delimiter and a Korean suffix immediately follows it.
// Inline code can split that span across several text nodes. Match a projection
// with one backtick per code node, then wrap the original nodes: code content
// is never searched or re-parsed. Other node kinds form a boundary, so already
// parsed emphasis stays untouched. Both markdown pipelines share the result.
type ChildSpan = { child: HastLikeNode; start: number; end: number };

// The children projected onto one string (text verbatim, inline code as a
// backtick, anything else as a newline) with each child's span in it.
function projectChildren(
  children: HastLikeNode[],
  visit: (node: HastLikeNode) => void
): { projection: string; spans: ChildSpan[] } {
  let projection = '';
  const spans = children.map((child) => {
    visit(child);
    const start = projection.length;
    if (child.type === 'text' && typeof child.value === 'string') projection += child.value;
    else projection += child.type === 'inlineCode' ? '`' : '\n';
    return { child, start, end: projection.length };
  });
  return { projection, spans };
}

// The children covering [start, end) of the projection, text nodes cut to
// the range and other nodes kept whole.
function sliceSpans(spans: ChildSpan[], start: number, end: number): HastLikeNode[] {
  const result: HastLikeNode[] = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    if (span.child.type === 'text' && typeof span.child.value === 'string') {
      result.push({
        type: 'text',
        value: span.child.value.slice(Math.max(0, start - span.start), end - span.start),
      });
    } else {
      result.push(span.child);
    }
  }
  return result;
}

export function repairAdjacentStrongPunctuation() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      if (node.type === 'strong' || node.type === 'code' || node.type === 'inlineCode') return;
      const children = node.children;
      if (!children) return;
      const { projection, spans } = projectChildren(children, visit);
      const repaired: HastLikeNode[] = [];
      let cursor = 0;
      adjacentStrongPunctuation.lastIndex = 0;
      for (
        let match = adjacentStrongPunctuation.exec(projection);
        match;
        match = adjacentStrongPunctuation.exec(projection)
      ) {
        if (escapedAt(projection, match.index)) continue;
        const end = match.index + match[0].length;
        repaired.push(...sliceSpans(spans, cursor, match.index), {
          type: 'strong',
          children: sliceSpans(spans, match.index + 2, end - 2),
        });
        cursor = end;
      }
      if (cursor > 0) {
        repaired.push(...sliceSpans(spans, cursor, projection.length));
        node.children = repaired;
      }
    };
    visit(tree);
  };
}

// An HTML comment is authoring metadata, never reading material. Raw HTML is
// preserved as literal text on both pipelines, which made "<!-- note -->" show
// up verbatim in the transcript; drop comment nodes (and comment runs inside a
// mixed html node) before that happens.
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

export function stripHtmlComments() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      const children = node.children;
      if (!children) return;
      const kept: HastLikeNode[] = [];
      for (const child of children) {
        if (child.type === 'html' && typeof child.value === 'string') {
          HTML_COMMENT.lastIndex = 0;
          const value = child.value.replace(HTML_COMMENT, '');
          if (!value.trim()) continue;
          kept.push({ ...child, value });
          continue;
        }
        visit(child);
        kept.push(child);
      }
      node.children = kept;
    };
    visit(tree);
  };
}

// `<br>` is the only line break a GFM table cell can carry, and models reach
// for it constantly. Raw HTML stays literal on both pipelines by design, so
// that break printed the tag itself in the middle of a cell. Convert the bare
// break element — and nothing else — into an mdast `break`, leaving every
// other tag (`<b>`, `<details>`, `<script>`) literal as before.
const HTML_LINE_BREAK = /^<br\s*\/?>$/i;

export function htmlLineBreaksToBreaks() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (child.type === 'html' && typeof child.value === 'string' && HTML_LINE_BREAK.test(child.value.trim())) {
          children[index] = { type: 'break' };
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

// mdast-util-to-hast terminates every fenced block with "\n". The code
// renderer keeps the highlighted child spans instead of re-printing a
// trimmed string, so that terminator would paint an empty closing line in
// every pre-wrap code card; drop it from the final text node instead.
export function trimTrailingCodeNewline() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      for (const child of node.children ?? []) visit(child);
      if (node.type !== 'element' || node.tagName !== 'pre') return;
      const code = (node.children ?? []).find((child) => child.type === 'element' && child.tagName === 'code');
      const children = code?.children;
      const last = children?.[children.length - 1];
      if (!children || !last || last.type !== 'text' || typeof last.value !== 'string') {
        return;
      }
      last.value = last.value.replace(/\n$/, '');
      if (!last.value) children.pop();
    };
    visit(tree);
  };
}

// Chat prose names files constantly ("see src/app.ts:42", `retry-classifier.mjs
// (line 269)`, "산출물은 output/ 폴더에") without ever writing a markdown link.
// Turn those mentions into local links so MarkdownLink can open them: a path
// with folders anywhere in text, a bare file name with a known extension or
// name inside inline code, and a folder with a trailing separator. Local
// images become file links too (the renderer never displays local files
// inline). Existing links, code blocks and math stay untouched. The href
// carries `path:line[:column]` so both pipelines hand MarkdownLink the same
// target.
export const PATH_LINK_CLASS = 'markdown-path-link';
const SEGMENT = '[\\p{L}\\p{N}_.@+-]+';
const PATH_PREFIX = '(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/](?![\\\\/]))';
const EXTENSION = '\\.[A-Za-z][A-Za-z0-9]{0,11}';
const LOCATION =
  '(?::(?<line>\\d+)(?::(?<column>\\d+))?(?:-\\d+)?' +
  '|#L(?<hashLine>\\d+)(?:C(?<hashColumn>\\d+))?(?:-L?\\d+(?:C\\d+)?)?)?';
// Prose: a file needs an extension plus a folder or a ./ ../ / X:\ prefix; a
// folder needs a trailing separator and must end the word, because "입력/출력"
// is a slash in running text, not a folder.
const PROSE_PATH = new RegExp(
  `(?<![\\p{L}\\p{N}_./\\\\:@-])(?:` +
    `(?<file>(?:${PATH_PREFIX}(?:${SEGMENT}[\\\\/])*|(?:${SEGMENT}[\\\\/])+)(?:${SEGMENT})?${EXTENSION})` +
    `${LOCATION}(?![A-Za-z0-9_/\\\\])` +
    `|(?<folder>${PATH_PREFIX}?(?:${SEGMENT}[\\\\/])+)(?![\\p{L}\\p{N}_/\\\\]))`,
  'gu'
);
const CODE_LOCATION = new RegExp(`^(?<path>[\\s\\S]*?)${LOCATION}$`, 'u');
// Line references that trail a mention: `src/a.ts`:42, "(line 269, col 5)",
// "(269줄)", "269번 줄". A bare "12줄" is a line count, so the unparenthesised
// Korean form needs 번/번째.
const TRAILING_LOCATIONS = [
  /^:(?<line>\d+)(?::(?<column>\d+))?(?:-\d+)?(?![\p{L}\p{N}])/u,
  /^\s*\((?:line|ln|l)\.?\s*(?<line>\d+)(?:\s*[,:]\s*(?:col(?:umn)?\.?\s*)?(?<column>\d+))?\)/iu,
  /^\s*\(\s*(?<line>\d+)\s*(?:번째|번)?\s*(?:줄|행)\s*\)/u,
  /^\s+(?<line>\d+)\s*(?:번째|번)\s*(?:줄|행)(?![\p{L}\p{N}])/u,
];
// A bare name (no folder) is only a file when its extension or name says so;
// "node.js" in prose must not become a link, so bare names count inside
// inline code only.
const BARE_FILE_EXTENSIONS = new Set([
  'mjs',
  'cjs',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mts',
  'cts',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'md',
  'markdown',
  'mdx',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'sql',
  'txt',
  'log',
  'csv',
  'tsv',
  'env',
  'ini',
  'cfg',
  'conf',
  'lock',
  'pdf',
  'pptx',
  'docx',
  'xlsx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'mp4',
  'mp3',
]);
const BARE_FILE_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'changelog',
  'contributing',
  'codeowners',
  'procfile',
  'jenkinsfile',
  'vagrantfile',
  'gemfile',
  'rakefile',
  'brewfile',
  'justfile',
  'pipfile',
  // Dotfiles by name only: `.workspace` or `.main-panel` in chat is a CSS
  // selector far more often than a file, so a leading dot proves nothing.
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitkeep',
  '.dockerignore',
  '.npmignore',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.ruby-version',
  '.tool-versions',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.eslintignore',
  '.babelrc',
  '.env',
  '.htaccess',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.vimrc',
  '.mailmap',
]);

function pathLink(href: string, children: HastLikeNode[]): HastLikeNode {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href, className: [PATH_LINK_CLASS] },
    children,
  };
}

interface MentionLocation {
  line?: number;
  column?: number;
}

function locationHref(path: string, { line, column }: MentionLocation): string {
  if (!line) return path;
  return `${path}:${line}${column ? `:${column}` : ''}`;
}

function matchedLocation(groups: Record<string, string | undefined> | undefined): MentionLocation {
  return {
    line: Number(groups?.line || groups?.hashLine) || undefined,
    column: Number(groups?.column || groups?.hashColumn) || undefined,
  };
}

function trailingLocation(text: string): (MentionLocation & { consumed: number }) | null {
  for (const pattern of TRAILING_LOCATIONS) {
    const match = pattern.exec(text);
    if (match?.groups?.line) {
      return {
        consumed: match[0].length,
        line: Number(match.groups.line),
        column: Number(match.groups.column) || undefined,
      };
    }
  }
  return null;
}

/** Inline code that names one path: `src/a.ts:12`, `Dockerfile`, `output/`,
 *  `output/제안서 최종.pptx` (spaces only in document names). */
function codeMention(
  text: string,
  allowIncompletePath = false
): (MentionLocation & { path: string; bare: boolean }) | null {
  const match = CODE_LOCATION.exec(text.trim());
  const path = match?.groups?.path?.trim() || '';
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const body = drive ? path.slice(3) : path;
  if (
    !path ||
    !/\p{L}/u.test(path) ||
    /\s{2,}/.test(path) ||
    /^\.{1,2}$/.test(path) ||
    !/^[\p{L}\p{N}_.@+\-\\/ ]*$/u.test(body)
  ) {
    return null;
  }
  const folder = /[\\/]$/.test(path);
  const hasSeparator = drive || /[\\/]/.test(body);
  const name = folder ? '' : body.split(/[\\/]/).at(-1) || '';
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (/\s/.test(path) && !isOsDocumentExtension(extension)) return null;
  if (folder) return hasSeparator ? { path, bare: false } : null;
  // Without an extension only well-known names count (`scripts/Dockerfile`,
  // `.gitignore`, `.env.local`): `owner/repo` and `@scope/package` are not files.
  const knownName = BARE_FILE_NAMES.has(name.toLowerCase()) || /^\.env\./i.test(name);
  if (!extension && !knownName && !(allowIncompletePath && hasSeparator)) return null;
  if (!hasSeparator && !knownName && !BARE_FILE_EXTENSIONS.has(extension)) return null;
  return { path, bare: !hasSeparator, ...matchedLocation(match?.groups) };
}

/** Use the same path grammar for an unfinished explicit link's caption. */
export function localPathMentionHref(text: string): string | null {
  const mention = codeMention(text);
  if (!mention) return null;
  return locationHref(mention.bare ? `./${mention.path}` : mention.path, mention);
}

/** An unfinished qualified path may still gain its filename/extension.
 * Display-only: incomplete paths must never become link targets. */
export function isPendingLocalPathMention(text: string): boolean {
  const mention = codeMention(text, true);
  return Boolean(mention && (/[\\/]$/.test(mention.path) || !codeMention(text)));
}

function skipsPathLinks(node: HastLikeNode): boolean {
  if (node.type !== 'element') return false;
  if (['a', 'pre', 'script', 'style'].includes(String(node.tagName))) return true;
  const className = node.properties?.className;
  const names = Array.isArray(className) ? className.map(String) : [String(className || '')];
  return names.some((name) => /katex|math/.test(name));
}

function linkifyText(value: string): HastLikeNode[] | null {
  const out: HastLikeNode[] = [];
  let last = 0;
  PROSE_PATH.lastIndex = 0;
  for (let match = PROSE_PATH.exec(value); match; match = PROSE_PATH.exec(value)) {
    const path = match.groups?.file || match.groups?.folder || '';
    let end = match.index + match[0].length;
    let location = matchedLocation(match.groups);
    if (!location.line && match.groups?.file) {
      const trailing = trailingLocation(value.slice(end));
      if (trailing) {
        location = trailing;
        end += trailing.consumed;
      }
    }
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) });
    out.push(pathLink(locationHref(path, location), [{ type: 'text', value: value.slice(match.index, end) }]));
    last = end;
    PROSE_PATH.lastIndex = end;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

function inlineCodeLink(code: HastLikeNode, next: HastLikeNode | undefined): HastLikeNode | null {
  if (code.type !== 'element' || code.tagName !== 'code' || skipsPathLinks(code)) return null;
  const only = code.children?.length === 1 ? code.children[0] : null;
  if (!only || only.type !== 'text' || typeof only.value !== 'string') return null;
  const mention = codeMention(only.value);
  if (!mention) return null;
  let location: MentionLocation = mention;
  const children: HastLikeNode[] = [code];
  if (!location.line && !/[\\/]$/.test(mention.path) && next?.type === 'text' && typeof next.value === 'string') {
    const trailing = trailingLocation(next.value);
    if (trailing) {
      location = trailing;
      children.push({ type: 'text', value: next.value.slice(0, trailing.consumed) });
      next.value = next.value.slice(trailing.consumed);
    }
  }
  return pathLink(locationHref(mention.bare ? `./${mention.path}` : mention.path, location), children);
}

function localImageLink(node: HastLikeNode): HastLikeNode | null {
  if (node.type !== 'element' || node.tagName !== 'img') return null;
  const src = String(node.properties?.src || '').trim();
  return src && isLocalMarkdownLink(src) ? pathLink(src, [{ type: 'text', value: src }]) : null;
}

export function linkifyLocalPaths() {
  return (tree: HastLikeNode) => {
    const visit = (node: HastLikeNode) => {
      const children = node.children;
      if (!children || skipsPathLinks(node)) return;
      const linked: HastLikeNode[] = [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const link = inlineCodeLink(child, children[index + 1]) || localImageLink(child);
        if (link) {
          linked.push(link);
          continue;
        }
        // Inline code is a single mention or nothing: `python scripts/run.py`
        // must not sprout a link around its argument.
        if (child.type === 'element' && child.tagName === 'code') {
          linked.push(child);
          continue;
        }
        if (child.type === 'text' && typeof child.value === 'string') {
          const parts = linkifyText(child.value);
          if (parts) linked.push(...parts);
          else if (child.value) linked.push(child);
          continue;
        }
        visit(child);
        linked.push(child);
      }
      node.children = linked;
    };
    visit(tree);
  };
}
