// Telegram MarkdownV2 conversion — a faithful JS port of hermes-agent's
// gateway/platforms/telegram.py (functions: _MDV2_ESCAPE_RE, _escape_mdv2,
// _strip_mdv2, _TABLE_SEPARATOR_RE, _is_table_row, _split_markdown_table_row,
// _render_table_block_for_telegram, _wrap_markdown_tables, and the 12-step
// format_message pipeline). The Python behaviour is battle-tested; this port
// keeps the same step order and the same table/header/blockquote decisions so
// output matches the reference.
//
// Exported:
//   toMarkdownV2(text)  — the main converter (port of format_message)
//   stripMdV2(text)     — plain-text fallback (port of _strip_mdv2)
//   escapeMdV2(text)    — raw escape helper (port of _escape_mdv2)
//   isParseEntitiesError(err) — detect a MarkdownV2 400 parse failure

// Matches every character MarkdownV2 requires to be backslash-escaped outside a
// code span / fenced block. Port of _MDV2_ESCAPE_RE:
//   Python: r'([_*\[\]()~`>#\+\-=|{}.!\\])'
const MDV2_ESCAPE_RE = /([_*[\]()~`>#+\-=|{}.!\\])/g;

/** Port of _escape_mdv2: backslash-escape all MarkdownV2 specials. */
export function escapeMdV2(text) {
  return String(text).replace(MDV2_ESCAPE_RE, "\\$1");
}

/**
 * Port of _strip_mdv2: remove MarkdownV2 escape backslashes AND the entity
 * markers format_message introduced, producing clean plain text for the
 * parse-error fallback.
 */
export function stripMdV2(text) {
  let cleaned = String(text);
  // Remove escape backslashes before special characters.
  cleaned = cleaned.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
  // Remove bold markers (*text* → text).
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
  // Remove italic markers (_text_ → text). Word-boundary guards keep
  // snake_case identifiers intact (mirrors the Python lookbehind/lookahead).
  cleaned = cleaned.replace(/(^|\W)_([^_]+)_(?!\w)/g, "$1$2");
  // Remove strikethrough markers (~text~ → text).
  cleaned = cleaned.replace(/~([^~]+)~/g, "$1");
  // Remove spoiler markers (||text|| → text).
  cleaned = cleaned.replace(/\|\|([^|]+)\|\|/g, "$1");
  return cleaned;
}

// ── Markdown table → Telegram-friendly row groups ──────────────────────────
// Port of _TABLE_SEPARATOR_RE / _is_table_row / _split_markdown_table_row /
// _render_table_block_for_telegram / _wrap_markdown_tables.

// Python: r'^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$'
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*){1,}\|?\s*$/;

function isTableRow(line) {
  const stripped = line.trim();
  return !!stripped && stripped.includes("|");
}

function splitMarkdownTableRow(line) {
  let stripped = line.trim();
  if (stripped.startsWith("|")) stripped = stripped.slice(1);
  if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
  return stripped.split("|").map((cell) => cell.trim());
}

function renderTableBlockForTelegram(tableBlock) {
  if (tableBlock.length < 3) return tableBlock.join("\n");

  const headers = splitMarkdownTableRow(tableBlock[0]);
  if (headers.length < 2) return tableBlock.join("\n");

  // Row-label column present when data rows carry one more cell than headers.
  const firstDataRow = tableBlock.length > 2 ? splitMarkdownTableRow(tableBlock[2]) : [];
  const hasRowLabelCol = firstDataRow.length === headers.length + 1;

  const renderedGroups = [];
  for (let idx = 0; idx < tableBlock.length - 2; idx++) {
    const row = tableBlock[idx + 2];
    const cells = splitMarkdownTableRow(row);
    let heading;
    let dataCells;
    if (hasRowLabelCol) {
      heading = cells.length && cells[0] ? cells[0] : `Row ${idx + 1}`;
      dataCells = cells.slice(1);
    } else {
      heading = cells.find((c) => c) ?? `Row ${idx + 1}`;
      dataCells = cells.slice();
    }
    // Pad / trim dataCells to headers length.
    if (dataCells.length < headers.length) {
      dataCells = dataCells.concat(Array(headers.length - dataCells.length).fill(""));
    } else if (dataCells.length > headers.length) {
      dataCells = dataCells.slice(0, headers.length);
    }
    const bullets = [];
    for (let c = 0; c < headers.length; c++) {
      const value = dataCells[c];
      // Skip a bullet that just duplicates the heading (no row-label column).
      if (!hasRowLabelCol && value === heading) continue;
      bullets.push(`• ${headers[c]}: ${value}`);
    }
    // The heading is emitted as `**heading**` markdown so step 5 (bold) of the
    // main pipeline converts it — matches the Python ordering intentionally.
    const groupLines = [`**${heading}**`, ...bullets];
    renderedGroups.push(groupLines.join("\n"));
  }
  return renderedGroups.join("\n\n");
}

function wrapMarkdownTables(text) {
  if (!text.includes("|") || !text.includes("-")) return text;
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.replace(/^\s+/, "");
    // Track existing fenced code blocks — never touch content inside.
    if (stripped.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    // Header row (contains '|') immediately followed by a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      const tableBlock = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        tableBlock.push(lines[j]);
        j++;
      }
      out.push(renderTableBlockForTelegram(tableBlock));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

// ── Main converter — port of format_message (12-step placeholder pipeline) ──

/**
 * Convert standard/assistant markdown into Telegram MarkdownV2.
 *
 * Protected regions (fenced code, inline code, links) are stashed behind
 * `\x00PH{n}\x00` placeholders BEFORE escaping so their interiors survive; the
 * remaining text is converted to MarkdownV2 entities then fully escaped, and
 * placeholders are restored in reverse insertion order.
 */
export function toMarkdownV2(content) {
  if (!content) return content;

  const placeholders = new Map();
  let counter = 0;
  const ph = (value) => {
    const key = `\x00PH${counter}\x00`;
    counter += 1;
    placeholders.set(key, value);
    return key;
  };

  let text = String(content);

  // 0) Rewrite GFM pipe tables into Telegram-friendly row groups first.
  text = wrapMarkdownTables(text);

  // 1) Protect fenced code blocks (``` ... ```). Inside pre/code only \ and `
  //    must be escaped per the MarkdownV2 spec.
  text = text.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, (raw) => {
    // Split off the opening ``` (+ optional language line) and closing ```.
    const openEnd = raw.slice(3).includes("\n") ? raw.indexOf("\n") + 1 : 3;
    const opening = raw.slice(0, openEnd);
    const bodyAndClose = raw.slice(openEnd);
    let body = bodyAndClose.slice(0, -3);
    body = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
    return ph(opening + body + "```");
  });

  // 2) Protect inline code (`...`). Escape \ inside per spec.
  text = text.replace(/(`[^`]+`)/g, (m) => ph(m.replace(/\\/g, "\\\\")));

  // 3) Convert markdown links — escape display text; inside the URL only ')'
  //    and '\' need escaping.
  text = text.replace(/\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_m, display, url) => {
    const d = escapeMdV2(display);
    const u = url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
    return ph(`[${d}](${u})`);
  });

  // 4) Headers (## Title) → bold *Title* (MarkdownV2 has no headers).
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_m, inner) => {
    const stripped = inner.trim().replace(/\*\*(.+?)\*\*/g, "$1");
    return ph(`*${escapeMdV2(stripped)}*`);
  });

  // 5) Bold: **text** → *text*.
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, inner) => ph(`*${escapeMdV2(inner)}*`));

  // 6) Italic: *text* (single asterisk) → _text_. [^*\n]+ avoids matching
  //    across newlines (which would corrupt * bullet lists / multi-line text).
  text = text.replace(/\*([^*\n]+)\*/g, (_m, inner) => ph(`_${escapeMdV2(inner)}_`));

  // 7) Strikethrough: ~~text~~ → ~text~.
  text = text.replace(/~~(.+?)~~/g, (_m, inner) => ph(`~${escapeMdV2(inner)}~`));

  // 8) Spoiler: ||text|| → ||text|| (protect from | escaping).
  text = text.replace(/\|\|(.+?)\|\|/g, (_m, inner) => ph(`||${escapeMdV2(inner)}||`));

  // 9) Blockquotes: line-leading >, >>, >>>, **>, **>> etc. Preserve the
  //    prefix from escaping; an expandable quote (**> … ||) keeps a trailing ||.
  text = text.replace(/^((?:\*\*)?>{1,3}) (.+)$/gm, (_m, prefix, quoteContent) => {
    if (prefix.startsWith("**") && quoteContent.endsWith("||")) {
      return ph(`${prefix} ${escapeMdV2(quoteContent.slice(0, -2))}||`);
    }
    return ph(`${prefix} ${escapeMdV2(quoteContent)}`);
  });

  // 10) Escape all remaining special characters in the plain text.
  text = escapeMdV2(text);

  // 11) Restore placeholders in REVERSE insertion order so a placeholder
  //     nested inside another resolves correctly.
  const keys = [...placeholders.keys()].reverse();
  for (const key of keys) {
    text = text.split(key).join(placeholders.get(key));
  }

  // 12) Safety net: escape bare ( ) { } that slipped past placeholder
  //     processing, WITHOUT touching content inside code spans/blocks.
  const codeSplit = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  const safeParts = [];
  for (let idx = 0; idx < codeSplit.length; idx++) {
    const seg = codeSplit[idx];
    if (idx % 2 === 1) {
      // Inside a code span/block — leave untouched.
      safeParts.push(seg);
      continue;
    }
    safeParts.push(seg.replace(/[(){}]/g, (ch, s) => {
      // Already escaped.
      if (s > 0 && seg[s - 1] === "\\") return ch;
      // '(' that opens a MarkdownV2 link [text](url).
      if (ch === "(" && s > 0 && seg[s - 1] === "]") return ch;
      // ')' that closes a link URL.
      if (ch === ")") {
        const before = seg.slice(0, s);
        if (before.includes("](http") || before.includes("](")) {
          let depth = 0;
          for (let j = s - 1; j >= Math.max(s - 2000, 0); j--) {
            if (seg[j] === "(") {
              depth -= 1;
              if (depth < 0) {
                if (j > 0 && seg[j - 1] === "]") return ch;
                break;
              }
            } else if (seg[j] === ")") {
              depth += 1;
            }
          }
        }
      }
      return "\\" + ch;
    }));
  }
  text = safeParts.join("");

  return text;
}

/** True when a Bot API error looks like a MarkdownV2 parse failure. */
export function isParseEntitiesError(err) {
  const status = err?.status;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return status === 400 && /can't parse entities|entities/i.test(msg);
}
