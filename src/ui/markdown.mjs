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
  cyan,
  gray,
  yellow,
  green,
  underline,
  strike as strikeStyle,
  brightWhite,
  colorEnabled,
  visibleWidth,
} from './ansi.mjs';

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);

    if (fenceMatch && !inFence) {
      inFence = true;
      fenceLang = fenceMatch[3].trim();
      fenceBuf = [];
      continue;
    }
    if (inFence) {
      // A line of only backticks/tildes closes the fence.
      if (/^(\s*)(`{3,}|~{3,})\s*$/.test(line)) {
        out.push(renderCodeBlock(fenceBuf, fenceLang, width));
        inFence = false;
        fenceLang = '';
        fenceBuf = [];
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
    return dim('─'.repeat(Math.min(width, 60)));
  }

  // ATX heading.
  const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) {
    const level = h[1].length;
    const text = renderInline(h[2]);
    if (level === 1) return '\n' + bold(brightWhite('▌ ' + text));
    if (level === 2) return '\n' + bold(cyan(text));
    if (level === 3) return bold(text);
    return bold(dim(text));
  }

  // Blockquote (possibly nested).
  const q = /^(\s*>+)\s?(.*)$/.exec(line);
  if (q) {
    return dim('│ ') + dim(renderInline(q[2]));
  }

  // Bullet list.
  const b = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (b) {
    const indent = b[1].replace(/\t/g, '  ');
    return indent + yellow('•') + ' ' + renderInline(b[3]);
  }

  // Numbered list.
  const n = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (n) {
    const indent = n[1].replace(/\t/g, '  ');
    return indent + yellow(n[2] + '.') + ' ' + renderInline(n[4]);
  }

  // Plain paragraph line.
  return renderInline(line);
}

function renderCodeBlock(bufLines, lang, width) {
  const inner = bufLines.length ? bufLines : [''];
  const contentWidth = Math.max(
    20,
    Math.min(width, inner.reduce((m, l) => Math.max(m, l.length), 0) + 2),
  );
  const label = lang ? ` ${lang} ` : '';
  const top = dim('┌' + (label ? gray(label) : '') + '─'.repeat(Math.max(0, contentWidth - visibleWidth(label) - 1)) + '┐');
  const bottom = dim('└' + '─'.repeat(contentWidth) + '┘');
  const body = inner.map((l) => {
    const text = colorEnabled() ? green(l) : l;
    return dim('│ ') + text;
  });
  return [top, ...body, bottom].join('\n');
}

// --- Inline ------------------------------------------------------------------

/**
 * Render inline markdown spans. Order matters: we extract code spans first
 * (their contents are literal), then apply emphasis/link transforms to the rest.
 */
function renderInline(text) {
  let s = String(text ?? '');

  // Protect inline code spans from further formatting.
  const codeSpans = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    const token = `\u0000C${codeSpans.length}\u0000`;
    codeSpans.push(code);
    return token;
  });

  // Links: [text](url) -> text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, url) => {
    return underline(label) + ' ' + dim('(' + url + ')');
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
    const code = codeSpans[Number(idx)] ?? '';
    return colorEnabled() ? cyan(code) : '`' + code + '`';
  });

  return s;
}
