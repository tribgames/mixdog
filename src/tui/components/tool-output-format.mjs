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
 * This module returns ANSI STRINGS (one per logical line). ToolExecution
 * runs `wrapExpandedResultLines` so each physical terminal row maps 1:1 to the
 * left result rail before ink draws the body (no ink `wrap` on expanded rows).
 */
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import {
  extraColorizers,
  highlightCodeLine,
  highlightCodeBlockToLines,
  colorizeDiffLine,
  looksLikeUnifiedDiff,
  LANG_FAMILY,
} from '../markdown/format-token.mjs';
import { wrapText } from '../markdown/table-layout.mjs';
import { RESULT_GUTTER } from '../theme.mjs';
import { hasMarkdownSyntax, renderTokenAnsiSegments } from '../markdown/render-ansi.mjs';
import { buildTableRender } from '../markdown/table-layout.mjs';

const DEFAULT_MARKDOWN_WIDTH = 80;

// Hard ceilings so a pathological tool result can never lock the render loop.
// CC uses ~MAX_LINES*width*4 for the collapsed fold; for the EXPANDED body we
// cap total characters processed and total lines kept, with an explicit marker.
export const MAX_EXPANDED_CHARS = 256 * 1024; // 256 KB of text gets per-line processing
const MAX_EXPANDED_LINES = 4000; // logical-line safety ceiling; physical mount cap is separate
const MAX_JSON_FORMAT_LENGTH = 10_000; // mirror CC's tryJsonFormatContent cap
const MAX_HIGHLIGHT_LINE_CHARS = 2000; // skip token-scan on absurdly long lines
// Lockstep with ToolExecution collapsed fit budget (MIN_RESULT_LINE_CHARS).
const MIN_EXPANDED_BODY_COLS = 24;

// Hard cap on the number of PHYSICAL (wrapped) rows a single expanded tool /
// script body may mount. MAX_EXPANDED_LINES bounds LOGICAL lines, but a single
// very long line with no newlines (minified JSON, a 256 KB single-line blob)
// wraps into thousands of physical rows — and EACH physical row is a mounted
// Ink <Text> node that ink re-serializes every frame even while clipped off-
// screen (clipping only trims write coords, not the serialize pass). So a lone
// huge expanded item could mount thousands of nodes and stall typing/drag even
// though it is the only visible transcript item. This cap bounds the mounted
// node count regardless of line shape; the omitted tail gets a clear marker.
// It is set generously above what any viewport needs so normal multi-line
// output (already capped at MAX_EXPANDED_LINES logical lines) is byte-for-byte
// unchanged — only pathological wide/unwrapped blobs are trimmed. Env-tunable
// via MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES (0 disables); legacy
// MIXDOG_TUI_EXPANDED_MAX_ROWS is still honored when the primary var is unset.
export function resolveToolOutputMaxRenderLines() {
  const raw = process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES;
  if (raw !== undefined && String(raw).trim() !== '') {
    const v = Number(raw);
    if (Number.isFinite(v) && v <= 0) return 0;
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  const legacy = process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS;
  if (legacy !== undefined && String(legacy).trim() !== '') {
    const v = Number(legacy);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return 600;
}

function omittedPhysicalRowsMarker(omitted, isShell) {
  if (isShell) {
    const n = Math.max(1, Math.floor(Number(omitted) || 0));
    return `\u2026 [${n} line${n === 1 ? '' : 's'} omitted above \u2014 showing newest output below]`;
  }
  return '\u2026 [output truncated for display \u2014 collapse (ctrl+o) or re-read a narrower range]';
}

function shellLogicalOmittedMarker({ omittedLines = 0, omittedChars = false }, c) {
  if (omittedLines > 0) {
    return c.synComment(omittedPhysicalRowsMarker(omittedLines, true));
  }
  if (omittedChars) {
    return c.synComment('\u2026 [earlier output omitted above \u2014 showing newest output below]');
  }
  return null;
}

function finalizeShellPhysicalCap(buffer, omitted, maxRows) {
  const bodySlots = Math.max(0, maxRows - 1);
  if (omitted <= 0) {
    return buffer.length > 0 ? buffer : [' '];
  }
  const tail = bodySlots > 0 ? buffer.slice(-bodySlots) : [];
  const extraHidden = Math.max(0, buffer.length - bodySlots);
  const totalOmitted = omitted + extraHidden;
  const out = [omittedPhysicalRowsMarker(totalOmitted, true), ...tail];
  return out.length > 0 ? out.slice(0, maxRows) : [' '];
}

// `<n>→<content>` (read) OR `<n>:<content>` / `<path>:<n>:<content>` (grep).
const READ_LINE_RE = /^(\s*)(\d+)(\u2192)(.*)$/;
// Gutter ends with `:<line>:`. Windows absolute paths use `X:\...` so the drive
// colon must not terminate the path prefix (unlike the old `[^:\n]*:` rule).
const GREP_LINE_RE = /^(\s*)((?:[A-Za-z]:[\\/](?:[^\n:])*|[^\n:]*):\d+:|\d+:)(\s?)(.*)$/;

// http(s) URLs not wrapped in quotes/brackets/whitespace (conservative).
const URL_RE = /https?:\/\/[^\s"'<>\x1b\\)\]]+/g;
// CSI SGR and OSC sequences (BEL- or ST-terminated) — linkify plain text only.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;]*m|\][\s\S]*?(?:\x07|\x1b\\))/g;


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
    /\x1b\[([0-9;]*)m/g,
    (seq, params) => {
      if (!params) return seq;
      const kept = params.split(';').filter((p) => p !== '' && p !== '4' && p !== '24');
      if (kept.length === 0) return '';
      return `\x1b[${kept.join(';')}m`;
    },
  );
}

/** Wrap bare URLs in OSC 8 hyperlinks (terminals that ignore it show the URL). */
export function linkifyUrls(text) {
  const src = String(text ?? '');
  if (!/https?:\/\//.test(src)) return src;
  const chunks = [];
  let last = 0;
  for (const match of src.matchAll(ANSI_ESCAPE_RE)) {
    if (match.index > last) chunks.push(src.slice(last, match.index));
    chunks.push(match[0]);
    last = match.index + match[0].length;
  }
  if (last < src.length) chunks.push(src.slice(last));
  return chunks
    .map((part) => (part.startsWith('\x1b')
      ? part
      : part.replace(URL_RE, (url) => `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`)))
    .join('');
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

/** True when the whole body is a JSON object/array (not markdown prose). */
function isJsonDocument(text) {
  const t = String(text ?? '').trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
  try {
    const parsed = JSON.parse(t);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/** True when text already carries SGR escapes (e.g. shell color output). */
function hasAnsi(text) {
  return /\x1b\[/.test(String(text ?? ''));
}

/** True when a line carries a read/grep tool line-number gutter. */
function lineHasToolGutter(line) {
  return READ_LINE_RE.test(line) || GREP_LINE_RE.test(line);
}

/** Read/grep bodies are source lines — never whole-document markdown. */
function contentHasToolGutters(lines) {
  for (const line of lines) {
    if (lineHasToolGutter(line)) return true;
  }
  return false;
}

/**
 * Whole-result markdown render for prose-y tool output (headings, emphasis,
 * fences). Skipped for shell/ANSI/diff, read/grep gutters, and non-md path
 * language inference (those stay per-line syntax highlight).
 */
function shouldRenderExpandedMarkdown({ src, lines, carriesAnsi, isShell, diffMode, family }) {
  if (carriesAnsi || isShell || diffMode) return false;
  if (isJsonDocument(src)) return false;
  if (contentHasToolGutters(lines)) return false;
  if (family && family !== 'md') return false;
  if (family === 'md') return true;
  return hasMarkdownSyntax(src);
}

/** Markdown lexer → one ANSI string per terminal row (tables via table-layout). */
function formatExpandedMarkdownLines(src, { width = DEFAULT_MARKDOWN_WIDTH } = {}) {
  const segments = renderTokenAnsiSegments(src, { width });
  const out = [];
  for (const seg of segments) {
    if (seg.type === 'table') {
      const { lines } = buildTableRender(seg.token, width);
      for (const line of lines) out.push(linkifyUrls(line));
      continue;
    }
    if (seg.type !== 'ansi' || !seg.ansi) continue;
    for (const line of String(seg.ansi).split('\n')) {
      out.push(linkifyUrls(line));
    }
  }
  return out;
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
  let shellOmittedLines = 0;
  let shellOmittedChars = false;
  if (src.length > MAX_EXPANDED_CHARS) {
    src = isShell ? src.slice(-MAX_EXPANDED_CHARS) : src.slice(0, MAX_EXPANDED_CHARS);
    if (isShell) shellOmittedChars = true;
    else truncatedChars = true;
  }

  const carriesAnsi = hasAnsi(src);
  // JSON pretty only when the text is not already colored (don't reflow ANSI).
  if (!carriesAnsi) src = tryFormatJson(src);

  let lines = src.split('\n');
  let truncatedLines = false;
  if (lines.length > MAX_EXPANDED_LINES) {
    if (isShell) shellOmittedLines = lines.length - MAX_EXPANDED_LINES;
    lines = isShell ? lines.slice(-MAX_EXPANDED_LINES) : lines.slice(0, MAX_EXPANDED_LINES);
    if (!isShell) truncatedLines = true;
  }

  const c = extraColorizers();
  // Diff bodies get diff coloring regardless of file family.
  const diffMode = !carriesAnsi && !isShell && looksLikeUnifiedDiff(src);
  const family = isShell || carriesAnsi ? null : inferLangFamily(pathArg);

  let out;
  if (shouldRenderExpandedMarkdown({ src, lines, carriesAnsi, isShell, diffMode, family })) {
    out = formatExpandedMarkdownLines(src);
    if (out.length > MAX_EXPANDED_LINES) {
      if (isShell) shellOmittedLines += out.length - MAX_EXPANDED_LINES;
      out = isShell ? out.slice(-MAX_EXPANDED_LINES) : out.slice(0, MAX_EXPANDED_LINES);
      if (!isShell) truncatedLines = true;
    }
  } else {
    if (family && family !== 'md' && !diffMode && !carriesAnsi && !isShell) {
      out = formatSyntaxBlock(lines, { c, family });
    } else {
      out = lines.map((line) => formatLine(line, { c, family, diffMode, carriesAnsi, isShell }));
    }
  }

  if (isShell) {
    const marker = shellLogicalOmittedMarker({ omittedLines: shellOmittedLines, omittedChars: shellOmittedChars }, c);
    if (marker) return [marker, ...out];
    return out;
  }
  if (truncatedChars || truncatedLines) {
    out.push(c.synComment('… [output truncated for display — re-read a narrower range]'));
  }
  return out;
}

/** Split read/grep line-number gutter from body (shared by per-line and block highlight). */
function splitGutter(line) {
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
  return { indent, gutter, body };
}

/** Block syntax highlight for non-diff code bodies (multi-line tokens color correctly). */
function formatSyntaxBlock(lines, { c, family }) {
  const parts = lines.map(splitGutter);
  const bodies = parts.map((p) =>
    p.body.length > MAX_HIGHLIGHT_LINE_CHARS ? '' : p.body,
  );
  const highlighted = highlightCodeBlockToLines(bodies.join('\n'), family, c);
  return parts.map((p, i) => {
    const rawBody = p.body;
    const bodyOut = rawBody.length > MAX_HIGHLIGHT_LINE_CHARS
      ? c.body(rawBody)
      : (highlighted[i] ?? '');
    const linked = linkifyUrls(bodyOut);
    return p.gutter ? `${p.indent}${c.synComment(p.gutter)}${linked}` : linked;
  });
}

/** Format ONE line: split line-number gutter, then highlight/linkify the body. */
function formatLine(line, { c, family, diffMode, carriesAnsi, isShell }) {
  // Shell / already-colored output: keep ANSI verbatim, only fix underline leaks
  // and linkify URLs. No gutter split (shell has no <n>→ prefix).
  if (carriesAnsi || isShell) {
    return linkifyUrls(stripUnderlineAnsi(line));
  }

  const { indent, gutter, body } = splitGutter(line);

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

/** Body text width for expanded tool results (terminal cols minus the ⎿ rail). */
export function expandedResultBodyWidth(columns = 80) {
  const cols = Math.max(1, Number(columns) || 80);
  const budget = cols - stringWidth(RESULT_GUTTER);
  return Math.max(MIN_EXPANDED_BODY_COLS, budget);
}

function padDisplaySpaces(width) {
  const w = Math.max(0, Math.floor(Number(width) || 0));
  return w ? ' '.repeat(w) : '';
}

/** Split an ANSI string after `plainTarget` display columns of visible text. */
function splitAnsiByPlainWidth(text, plainTarget) {
  const src = String(text ?? '');
  const target = Math.max(0, Math.floor(Number(plainTarget) || 0));
  if (!src) return ['', ''];
  if (target <= 0) return ['', src];
  let i = 0;
  let plain = 0;
  while (i < src.length) {
    if (plain >= target) break;
    if (src[i] === '\x1b') {
      const rest = src.slice(i);
      const sgr = rest.match(/^\x1b\[[0-9;]*m/);
      if (sgr) {
        i += sgr[0].length;
        continue;
      }
      const osc = rest.match(/^\x1b\]8;;[^\x07]*\x07/);
      if (osc) {
        i += osc[0].length;
        continue;
      }
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    plain += stringWidth(ch);
    i += cp > 0xffff ? 2 : 1;
  }
  return [src.slice(0, i), src.slice(i)];
}

function leadingPrefixPlainWidth(plainLine) {
  const rm = READ_LINE_RE.exec(plainLine);
  if (rm) return stringWidth(rm[1] + rm[2] + rm[3]);
  const gm = GREP_LINE_RE.exec(plainLine);
  if (gm) return stringWidth(gm[1] + gm[2] + gm[3]);
  return 0;
}

function wrapOneExpandedLogicalLine(line, maxWidth) {
  const src = String(line ?? '');
  if (!src) return [' '];
  if (stringWidth(src) <= maxWidth) return [src];

  const prefixPlainW = leadingPrefixPlainWidth(stripAnsi(src));
  const [prefix, body] = prefixPlainW > 0
    ? splitAnsiByPlainWidth(src, prefixPlainW)
    : ['', src];
  const prefixW = stringWidth(prefix);
  const bodyBudget = Math.max(1, maxWidth - prefixW);
  const bodyPieces = wrapText(body, bodyBudget, { hard: true });
  if (bodyPieces.length <= 1) return [src];

  const out = [];
  for (let i = 0; i < bodyPieces.length; i++) {
    if (i === 0) out.push(`${prefix}${bodyPieces[i]}`);
    else out.push(`${padDisplaySpaces(prefixW)}${bodyPieces[i]}`);
  }
  return out;
}

/**
 * Turn logical expanded lines into physical rows that fit the body column.
 * One output row per left-rail row in ToolExecution (lockstep with App row est.).
 */
export function wrapExpandedResultLines(logicalLines, columns = 80, { isShell = false } = {}) {
  const maxRows = resolveToolOutputMaxRenderLines();
  const capOn = maxRows > 0;
  const maxWidth = expandedResultBodyWidth(columns);
  const lines = Array.isArray(logicalLines) ? logicalLines : [];
  const out = [];

  if (!capOn) {
    for (const line of lines) {
      for (const row of wrapOneExpandedLogicalLine(line, maxWidth)) out.push(row);
    }
    return out.length > 0 ? out : [' '];
  }

  if (isShell) {
    let omitted = 0;
    for (const line of lines) {
      for (const row of wrapOneExpandedLogicalLine(line, maxWidth)) {
        out.push(row);
        if (out.length > maxRows) {
          out.shift();
          omitted += 1;
        }
      }
    }
    return finalizeShellPhysicalCap(out, omitted, maxRows);
  }

  // Non-shell surfaces keep the head of the expanded body (read/grep/json).
  let truncated = false;
  outer: for (const line of lines) {
    for (const row of wrapOneExpandedLogicalLine(line, maxWidth)) {
      if (out.length < maxRows) {
        out.push(row);
      } else {
        truncated = true;
        break outer;
      }
    }
  }
  if (truncated) {
    const bodySlots = Math.max(0, maxRows - 1);
    if (out.length > bodySlots) out.length = bodySlots;
    if (maxRows > 0) out.push(omittedPhysicalRowsMarker(1, false));
    return out.length > 0 ? out.slice(0, maxRows) : [' '];
  }
  return out.length > 0 ? out : [' '];
}
