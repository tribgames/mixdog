/**
 * components/tool-output-format.mjs — shared post-processing for EXPANDED tool
 * result bodies (ctrl+o). Mirrors the Claude Code output pipeline so every tool
 * surface renders the same way instead of a flat run of plain lines:
 *
 *   - language inference from the read/grep path argument (file extension)
 *   - JSON auto pretty-print (precision-safe, size-capped)
 *   - URL → OSC 8 hyperlink
 *   - stray underline-ANSI removal (shell output leaks these)
 *   - oversized-output guard (never wrap/scan a 64 MB dump line-by-line)
 *   - per-line render: split the `<n>→` / `<file>:<n>:` line-number gutter into a
 *     dim column, then syntax-highlight the body with the shared markdown
 *     code-block highlighter so colors track the active theme.
 *
 * This module returns ANSI STRINGS (one per visible line). ToolExecution wraps
 * each in an ink <Text>, so the line-number gutter and the rail stay aligned.
 */
import {
  extraColorizers,
  highlightCodeLine,
  colorizeDiffLine,
  looksLikeUnifiedDiff,
  LANG_FAMILY,
} from '../markdown/format-token.mjs';

// Hard ceilings so a pathological tool result can never lock the render loop.
// CC uses ~MAX_LINES*width*4 for the collapsed fold; for the EXPANDED body we
// cap total characters processed and total lines kept, with an explicit marker.
const MAX_EXPANDED_CHARS = 256 * 1024; // 256 KB of text gets per-line processing
const MAX_EXPANDED_LINES = 4000; // keep at most this many rendered lines
const MAX_JSON_FORMAT_LENGTH = 10_000; // mirror CC's tryJsonFormatContent cap
const MAX_HIGHLIGHT_LINE_CHARS = 2000; // skip token-scan on absurdly long lines

// `<n>→<content>` (read) OR `<n>:<content>` / `<path>:<n>:<content>` (grep).
const READ_LINE_RE = /^(\s*)(\d+)(\u2192)(.*)$/;
const GREP_LINE_RE = /^(\s*)((?:[^:\n]*:)?\d+:)(\s?)(.*)$/;

// http(s) URLs not wrapped in quotes/brackets/whitespace (conservative).
const URL_RE = /https?:\/\/[^\s"'<>\\)\]]+/g;

/** Infer a highlighter family from a read/grep path arg's extension. */
export function inferLangFamily(pathArg) {
  const p = String(pathArg || '').trim().toLowerCase();
  if (!p) return null;
  const m = /\.([a-z0-9]+)$/.exec(p);
  if (!m) return null;
  return LANG_FAMILY[m[1]] || null;
}

/** Strip ONLY underline SGR (4 / 24) — other styles/colors are preserved. */
export function stripUnderlineAnsi(text) {
  return String(text ?? '').replace(
    // eslint-disable-next-line no-control-regex
    /\x1b\[(?:[0-9;]*;)?4(?:;[0-9;]*)?m|\x1b\[24m/g,
    '',
  );
}

/** Wrap bare URLs in OSC 8 hyperlinks (terminals that ignore it show the URL). */
export function linkifyUrls(text) {
  const src = String(text ?? '');
  if (src.indexOf('http') === -1) return src;
  return src.replace(URL_RE, (url) => `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`);
}

/** Precision-safe JSON pretty-print for a single line; returns input on miss. */
function tryFormatJsonLine(line) {
  const t = String(line ?? '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return line;
  try {
    const parsed = JSON.parse(t);
    if (parsed === null || typeof parsed !== 'object') return line;
    const pretty = JSON.stringify(parsed, null, 2);
    // Bail if a big-int lost precision on the round-trip.
    const a = t.replace(/\\\//g, '/').replace(/\s+/g, '');
    const b = JSON.stringify(parsed).replace(/\s+/g, '');
    return a === b ? pretty : line;
  } catch {
    return line;
  }
}

/** Auto pretty-print whole-result JSON (size-capped, per-line). */
export function tryFormatJson(text) {
  const src = String(text ?? '');
  if (src.length > MAX_JSON_FORMAT_LENGTH) return src;
  return src.split('\n').map(tryFormatJsonLine).join('\n');
}

/** True when text already carries SGR escapes (e.g. shell color output). */
function hasAnsi(text) {
  return /\x1b\[/.test(String(text ?? ''));
}

/**
 * Process an expanded tool-result body into an array of ANSI line strings.
 *
 * @param {string} text raw tool result
 * @param {object} opts
 * @param {string} [opts.pathArg] read/grep path for language inference
 * @param {boolean} [opts.isShell] shell surface (preserve existing ANSI, no highlight)
 * @returns {string[]} one ANSI string per visible line
 */
export function formatExpandedResult(text, { pathArg = '', isShell = false } = {}) {
  let src = String(text ?? '');
  if (!src) return [];

  // Oversized guard: slice before any O(n) per-line work, append a marker.
  let truncatedChars = false;
  if (src.length > MAX_EXPANDED_CHARS) {
    src = src.slice(0, MAX_EXPANDED_CHARS);
    truncatedChars = true;
  }

  const carriesAnsi = hasAnsi(src);
  // JSON pretty only when the text is not already colored (don't reflow ANSI).
  if (!carriesAnsi) src = tryFormatJson(src);

  let lines = src.split('\n');
  let truncatedLines = false;
  if (lines.length > MAX_EXPANDED_LINES) {
    lines = lines.slice(0, MAX_EXPANDED_LINES);
    truncatedLines = true;
  }

  const c = extraColorizers();
  // Diff bodies get diff coloring regardless of file family.
  const diffMode = !carriesAnsi && !isShell && looksLikeUnifiedDiff(src);
  const family = isShell || carriesAnsi ? null : inferLangFamily(pathArg);

  const out = lines.map((line) => formatLine(line, { c, family, diffMode, carriesAnsi, isShell }));

  if (truncatedChars || truncatedLines) {
    out.push(c.synComment('… [output truncated for display — re-read a narrower range]'));
  }
  return out;
}

/** Format ONE line: split line-number gutter, then highlight/linkify the body. */
function formatLine(line, { c, family, diffMode, carriesAnsi, isShell }) {
  // Shell / already-colored output: keep ANSI verbatim, only fix underline leaks
  // and linkify URLs. No gutter split (shell has no <n>→ prefix).
  if (carriesAnsi || isShell) {
    return linkifyUrls(stripUnderlineAnsi(line));
  }

  // Split a read (`<n>→`) or grep (`<file>:<n>:` / `<n>:`) gutter into a dim
  // column so the body can be highlighted independently.
  let indent = '';
  let gutter = '';
  let body = line;
  const rm = READ_LINE_RE.exec(line);
  if (rm) {
    indent = rm[1];
    gutter = `${rm[2]}${rm[3]}`;
    body = rm[4];
  } else {
    const gm = GREP_LINE_RE.exec(line);
    if (gm) {
      indent = gm[1];
      gutter = `${gm[2]}${gm[3]}`;
      body = gm[4];
    }
  }

  const coloredBody = highlightBody(body, { c, family, diffMode });
  const linked = linkifyUrls(coloredBody);
  return gutter ? `${indent}${c.synComment(gutter)}${linked}` : linked;
}

/** Color a body string per the active mode (diff / language / plain). */
function highlightBody(body, { c, family, diffMode }) {
  if (!body) return '';
  if (body.length > MAX_HIGHLIGHT_LINE_CHARS) return c.body(body);
  if (diffMode) return colorizeDiffLine(body, c);
  if (family && family !== 'md') return highlightCodeLine(body, family, c);
  return c.body(body);
}
