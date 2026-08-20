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
  stripAnsi,
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

const FOOTNOTE_DEF_RE = /^ {0,3}\[\^([^\]]+)\]:\s*(.*)$/;
const LINK_DEF_RE = /^ {0,3}\[([^\]^][^\]]*)\]:\s*(\S+)(?:\s+["'(].*)?\s*$/;
const SETEXT_H1_RE = /^ {0,3}={2,}\s*$/;
const SETEXT_H2_RE = /^ {0,3}-{2,}\s*$/;
const TABLE_DELIM_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

/**
 * First pass: pull link-reference and footnote definitions out of the body so
 * inline rendering can resolve `[text][tag]` and the footnote texts survive.
 * Fenced blocks are skipped — a definition-shaped line inside code is code.
 */
function extractDefinitions(rawLines) {
  const links = new Map();
  const footnotes = [];
  const lines = [];
  let fenceMarker = '';
  let fenceMarkerLen = 0;
  for (const line of rawLines) {
    const fence = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[2][0];
      if (!fenceMarker) {
        fenceMarker = marker;
        fenceMarkerLen = fence[2].length;
      } else if (marker === fenceMarker && fence[2].length >= fenceMarkerLen) {
        fenceMarker = '';
        fenceMarkerLen = 0;
      }
      lines.push(line);
      continue;
    }
    if (!fenceMarker) {
      const footnote = FOOTNOTE_DEF_RE.exec(line);
      if (footnote) {
        footnotes.push({ tag: footnote[1], text: footnote[2] });
        continue;
      }
      const def = LINK_DEF_RE.exec(line);
      if (def) {
        links.set(def[1].trim().toLowerCase(), def[2]);
        continue;
      }
    }
    lines.push(line);
  }
  return { lines, links, footnotes };
}

function renderUnsafe(src, opts) {
  const width = clampWidth(opts.width);
  const { lines, links, footnotes } = extractDefinitions(src.replace(/\r\n?/g, '\n').split('\n'));
  const defs = { links, footnotes };
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

    // GFM table: a pipe row immediately followed by an alignment row.
    if (line.includes('|') && TABLE_DELIM_RE.test(lines[i + 1] ?? '')) {
      const rows = [line];
      let cursor = i + 2;
      while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim()) {
        rows.push(lines[cursor]);
        cursor += 1;
      }
      out.push(renderTable(rows, lines[i + 1], width, defs));
      i = cursor - 1;
      continue;
    }

    // Setext heading: the underline belongs to the line above it, so the pair
    // is rewritten into the ATX form the line renderer already handles.
    const next = lines[i + 1] ?? '';
    const setext = SETEXT_H1_RE.test(next) ? '#' : SETEXT_H2_RE.test(next) ? '##' : '';
    if (setext && line.trim() && !/^ {0,3}(#|>|[-*+] |\d+[.)] )/.test(line)) {
      out.push(renderLine(`${setext} ${line.trim()}`, width, defs));
      i += 1;
      continue;
    }

    out.push(renderLine(line, width, defs));
  }

  // Unterminated fence — render whatever we collected so nothing is lost.
  if (inFence) out.push(renderCodeBlock(fenceBuf, fenceLang, width));

  // Pulling definition lines out of the body leaves their blank neighbours
  // behind; the block must still end where the prose does.
  while (out.length && !stripAnsi(out[out.length - 1]).trim()) out.pop();

  // Footnote texts are body prose: dropping the definitions with the reference
  // plumbing deleted content the author wrote.
  if (footnotes.length) {
    out.push('');
    for (const footnote of footnotes) {
      out.push(`${dim(`[${footnote.tag}]`)} ${renderInline(footnote.text, undefined, defs)}`);
    }
  }

  return out.join('\n');
}

/** Split one GFM table row into raw cell sources. */
function tableCells(row) {
  return String(row ?? '')
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function tableAlignments(delimiterRow) {
  return tableCells(delimiterRow).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
}

function padCell(text, target, align) {
  const padding = Math.max(0, target - visibleWidth(text));
  if (align === 'right') return ' '.repeat(padding) + text;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return ' '.repeat(left) + text + ' '.repeat(padding - left);
  }
  return text + ' '.repeat(padding);
}

/** Render a GFM table as an aligned, dim-ruled block (header row in bold). */
function renderTable(rows, delimiterRow, width, defs) {
  const align = tableAlignments(delimiterRow);
  const body = rows.map((row, rowIndex) => tableCells(row).map((cell) => {
    const rendered = renderInline(cell, undefined, defs);
    return rowIndex === 0 ? bold(rendered) : rendered;
  }));
  const columns = body.reduce((max, cells) => Math.max(max, cells.length), 0);
  const widths = [];
  for (let column = 0; column < columns; column++) {
    widths.push(body.reduce((max, cells) => Math.max(max, visibleWidth(cells[column] ?? '')), 0));
  }
  const total = widths.reduce((sum, value) => sum + value + 3, 0);
  if (total > width) {
    // Too wide to align: fall back to one "header: value" block per row.
    const headers = body[0] ?? [];
    return body.slice(1).map((cells) => cells
      .map((cell, column) => `${dim(`${stripCellLabel(headers[column])}:`)} ${cell}`)
      .join('\n')).join('\n\n');
  }
  const line = (cells) => cells
    .map((cell, column) => padCell(cell ?? '', widths[column], align[column] ?? 'left'))
    .join(dim(' \u2502 '));
  const rule = dim(widths.map((value) => '\u2500'.repeat(value)).join('\u2500\u253c\u2500'));
  return [line(body[0] ?? []), rule, ...body.slice(1).map(line)].join('\n');
}

function stripCellLabel(cell) {
  return String(cell ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim() || '-';
}

function clampWidth(w) {
  const n = Number(w);
  if (Number.isFinite(n) && n >= 20) return Math.min(Math.floor(n), 120);
  return 80;
}

// --- Block-level -------------------------------------------------------------

function renderLine(line, width, defs) {
  // Horizontal rule.
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return dim(rgb(128, 128, 128)('─'.repeat(Math.min(width, 60))));
  }

  // ATX heading.
  const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (h) {
    const level = h[1].length;
    const text = renderInline(h[2], undefined, defs);
    if (level === 1) return '\n' + compose(bold, PALETTE.heading1)('▌ ' + text);
    if (level === 2) return '\n' + compose(bold, PALETTE.heading)(text);
    if (level === 3) return compose(bold, PALETTE.heading)(text);
    return compose(bold, dim)(text);
  }

  // Blockquote (possibly nested).
  const q = /^(\s*>+)\s?(.*)$/.exec(line);
  if (q) {
    return dim('│ ') + italic(renderInline(q[2], undefined, defs));
  }

  // Bullet list.
  const b = /^(\s*)([-*+])\s+(.*)$/.exec(line);
  if (b) {
    const indent = b[1].replace(/\t/g, '  ');
    // GFM task item: the box state is the item's meaning, so it replaces the
    // bullet instead of being rendered as literal "[ ]" prose.
    const task = /^\[([ xX])\]\s+(.*)$/.exec(b[3]);
    if (task) {
      return `${indent}${PALETTE.listBullet(task[1] === ' ' ? '[ ]' : '[x]')} ${renderInline(task[2], undefined, defs)}`;
    }
    return indent + PALETTE.listBullet('•') + ' ' + renderInline(b[3], undefined, defs);
  }

  // Numbered list.
  const n = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line);
  if (n) {
    const indent = n[1].replace(/\t/g, '  ');
    return indent + PALETTE.listBullet(n[2] + '.') + ' ' + renderInline(n[4], undefined, defs);
  }

  // Plain paragraph line.
  return renderInline(line, undefined, defs);
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
function renderInline(text, state, defs) {
  const st = state ?? { codeSpans: [], escapes: [] };
  st.escapes ??= [];
  let s = String(text ?? '');

  // A backslash escape is a literal character, not markup. Park it before any
  // emphasis pass: without this, `a\*x\*b` lost BOTH the backslash and the
  // star it was protecting.
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, (_m, ch) => {
    const token = `\u0000E${st.escapes.length}\u0000`;
    st.escapes.push(ch);
    return token;
  });

  // Protect inline code spans from further formatting.
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    const token = `\u0000C${st.codeSpans.length}\u0000`;
    st.codeSpans.push(code);
    return token;
  });

  // Images: ![alt](url) -> alt (url). Runs BEFORE links, otherwise the leading
  // "!" survived as literal prose in front of the label.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, alt, url) => {
    const label = alt.trim()
      ? compose(underline, PALETTE.link)(renderInline(alt, st, defs))
      : '';
    return label ? `${label} ${dim('(' + url + ')')}` : dim(url);
  });

  // Links: [text](url) -> text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label, url) => {
    const linkLabel = compose(underline, PALETTE.link)(renderInline(label, st, defs));
    return linkLabel + ' ' + dim('(' + url + ')');
  });

  // Footnote reference: the definition text is printed as an apparatus block.
  s = s.replace(/\[\^([^\]]+)\]/g, (_m, tag) => dim(`[${tag}]`));

  // Reference links: [text][tag], [tag][] and the shortcut [tag].
  const links = defs?.links;
  if (links && links.size) {
    const reference = (label, tag) => {
      const url = links.get(String(tag || label).trim().toLowerCase());
      if (!url) return null;
      return `${compose(underline, PALETTE.link)(renderInline(label, st, defs))} ${dim('(' + url + ')')}`;
    };
    s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, label, tag) => reference(label, tag) ?? match);
    s = s.replace(/\[([^\]]+)\]/g, (match, label) => reference(label, label) ?? match);
  }

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

  // Restore escaped characters as their literal selves.
  s = s.replace(/\u0000E(\d+)\u0000/g, (_m, idx) => st.escapes[Number(idx)] ?? '');

  return s;
}
