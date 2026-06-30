/**
 * src/ui/markdown.mjs — minimal terminal markdown renderer (zero deps).
 *
 * POST-RENDER (not streaming): given a full markdown string, returns a styled
 * terminal string. The REPL streams raw tokens live for "it feels alive" feel,
 * then on turn-end clears the streamed block and re-prints this rendered form
 * (approach (a) from the brief). Because we always have the complete text by
 * the time we render, a simple line-oriented parser is enough — no need for an
 * incremental/streaming markdown state machine.
 *
 * Supported: ATX headings (#..######), fenced ``` code blocks (with optional
 * language label), inline `code`, **bold**, *italic* / _italic_, ~~strike~~,
 * bullet lists (-, *, +), numbered lists, blockquotes (>), horizontal rules,
 * and [text](url) links rendered as `text (url)`.
 *
 * Robustness: this MUST never throw on partial/garbage markdown — the whole
 * body is wrapped so any internal error falls back to the raw text.
 */
import {
  bold,
  italic,
  dim,
  underline,
  strike as strikeStyle,
  colorEnabled,
  visibleWidth,
  rgb,
  compose,
} from './ansi.mjs';

// Default Mixdog dark markdown semantics (mirrors src/tui/theme.mjs mixdogPalette md* keys).
const PALETTE = {
  heading1: rgb(215, 119, 87),
  heading: rgb(240, 198, 116),
  inlineCode: rgb(138, 190, 183),
  link: rgb(47, 127, 255),
  codeBlock: rgb(181, 189, 104),
  fenceLabel: rgb(138, 190, 183),
  listBullet: rgb(138, 190, 183),
  quoteText: rgb(128, 128, 128),
  diffAdd: rgb(0, 170, 75),
  diffDel: rgb(220, 70, 88),
  diffHunk: rgb(204, 157, 44),
};

/**
 * Render a markdown string to a terminal-styled string.
 * @param {string} src
 * @param {{ width?: number }} [opts]
 * @returns {string}
 */
export function renderMarkdown(src, opts = {}) {
  try {
    return renderUnsafe(String(src ?? ''), opts);
  } catch {
    // Never blow up the REPL over malformed markdown — show it raw.
    return String(src ?? '');
  }
}

function renderUnsafe(src, opts) {
  const width = clampWidth(opts.width);
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];

  let inFence = false;
  let fenceLang = '';
  let fenceBuf = [];
  let fenceMarker = '';
  let fenceMarkerLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);

    if (fenceMatch && !inFence) {
      inFence = true;
      fenceLang = fenceMatch[3].trim();
      fenceMarker = fenceMatch[2][0];
      fenceMarkerLen = fenceMatch[2].length;
      fenceBuf = [];
      continue;
    }
    if (inFence) {
      const closeMatch = /^(\s*)([`~]+)\s*$/.exec(line);
      const markerRun = closeMatch?.[2] ?? '';
      const closes =
        markerRun.length >= fenceMarkerLen &&
        [...markerRun].every((ch) => ch === fenceMarker);
      if (closes) {
        out.push(renderCodeBlock(fenceBuf, fenceLang, width));
        inFence = false;
        fenceLang = '';
        fenceBuf = [];
        fenceMarker = '';
        fenceMarkerLen = 0;
      } else {
        fenceBuf.push(line);
      }
      continue;
    }

    out.push(renderLine(line, width));
  }

  // Unterminated fence — render whatever we collected so nothing is lost.
  if (inFence) out.push(renderCodeBlock(fenceBuf, fenceLang, width));

  return out.join('\n');
}

function clampWidth(w) {
  const n = Number(w);
  if (Number.isFinite(n) && n >= 20) return Math.min(Math.floor(n), 120);
  return 80;
}

// --- Block-level -------------------------------------------------------------

function renderLine(line, width) {
  // Horizontal rule.
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return dim(rgb(128, 128, 128)('─'.repeat(Math.min(width, 60))));
  }

  // ATX heading.
  const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) {
    const level = h[1].length;
    const text = renderInline(h[2]);
    if (level === 1) return '\n' + bold('▌ ' + text);
    if (level === 2) return '\n' + bold(text);
    if (level === 3) return bold(text);
    return compose(bold, dim)(text);
  }

  // Blockquote (possibly nested).
  const q = /^(\s*>+)\s?(.*)$/.exec(line);
  if (q) {
    return dim('│ ') + italic(renderInline(q[2]));
  }

  // Bullet list.
  const b = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (b) {
    const indent = b[1].replace(/\t/g, '  ');
    return indent + PALETTE.listBullet('•') + ' ' + renderInline(b[3]);
  }

  // Numbered list.
  const n = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (n) {
    const indent = n[1].replace(/\t/g, '  ');
    return indent + PALETTE.listBullet(n[2] + '.') + ' ' + renderInline(n[4]);
  }

  // Plain paragraph line.
  return renderInline(line);
}

function renderCodeBlock(bufLines, lang, width) {
  const inner = bufLines.length ? bufLines : [''];
  const isDiff = isDiffFence(lang, inner);
  const contentWidth = Math.max(
    20,
    Math.min(width, inner.reduce((m, l) => Math.max(m, l.length), 0) + 2),
  );
  const labelPlain = lang ? ` ${lang} ` : '';
  const labelStyled = labelPlain ? PALETTE.fenceLabel(labelPlain) : '';
  const ruleLen = Math.max(0, contentWidth - visibleWidth(labelPlain));
  const top = dim('┌') + labelStyled + dim('─'.repeat(ruleLen) + '┐');
  const bottom = dim('└' + '─'.repeat(contentWidth) + '┘');
  const body = inner.map((l) => {
    const text = colorFenceLine(l, isDiff);
    const padTarget = Math.max(0, contentWidth - 1);
    const padded = padVisible(text, padTarget);
    return dim('│ ') + padded + dim('│');
  });
  return [top, ...body, bottom].join('\n');
}

function padVisible(text, targetWidth) {
  const w = visibleWidth(text);
  if (w >= targetWidth) return text;
  return String(text ?? '') + ' '.repeat(targetWidth - w);
}

function isDiffFence(lang, lines) {
  const tag = String(lang ?? '').trim().toLowerCase();
  if (/^(diff|patch|udiff)$/.test(tag)) return true;
  let hunk = false;
  let delta = false;
  for (const line of lines) {
    const s = String(line ?? '');
    if (/^@@/.test(s)) hunk = true;
    if (/^\+/.test(s) && !/^\+\+\+/.test(s)) delta = true;
    if (/^-/.test(s) && !/^---/.test(s)) delta = true;
  }
  return hunk && delta;
}

function colorFenceLine(line, isDiff) {
  const s = String(line ?? '');
  if (!colorEnabled()) return s;
  if (!isDiff) return PALETTE.codeBlock(s);
  if (/^@@/.test(s)) return PALETTE.diffHunk(s);
  if (/^(\+\+\+|---)/.test(s)) return PALETTE.diffHunk(s);
  if (/^\+/.test(s)) return PALETTE.diffAdd(s);
  if (/^-/.test(s)) return PALETTE.diffDel(s);
  return PALETTE.codeBlock(s);
}

// --- Inline ------------------------------------------------------------------

/**
 * Render inline markdown spans. Order matters: we extract code spans first
 * (their contents are literal), then apply emphasis/link transforms to the rest.
 */
function renderInline(text, state) {
  const st = state ?? { codeSpans: [] };
  let s = String(text ?? '');

  // Protect inline code spans from further formatting.
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    const token = `\u0000C${st.codeSpans.length}\u0000`;
    st.codeSpans.push(code);
    return token;
  });

  // Links: [text](url) -> text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, url) => {
    const linkLabel = compose(underline, PALETTE.link)(renderInline(label, st));
    return linkLabel + ' ' + dim('(' + url + ')');
  });

  // Bold: **x** or __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, x) => bold(x));
  s = s.replace(/__([^_]+)__/g, (_m, x) => bold(x));

  // Strikethrough: ~~x~~
  s = s.replace(/~~([^~]+)~~/g, (_m, x) => strikeStyle(x));

  // Italic: *x* or _x_ (avoid matching list bullets / already-consumed bold).
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, (_m, pre, x) => pre + italic(x));
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!_)/g, (_m, pre, x) => pre + italic(x));

  // Restore code spans, styled.
  s = s.replace(/\u0000C(\d+)\u0000/g, (_m, idx) => {
    const code = st.codeSpans[Number(idx)] ?? '';
    return colorEnabled() ? PALETTE.inlineCode(code) : '`' + code + '`';
  });

  return s;
}
