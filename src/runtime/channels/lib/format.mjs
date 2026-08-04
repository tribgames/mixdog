function getDisplayWidth(str) {
  let width = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 4352 && code <= 4447 || code >= 11904 && code <= 12350 || code >= 12352 && code <= 13247 || code >= 13312 && code <= 19903 || code >= 19968 && code <= 40959 || code >= 44032 && code <= 55215 || code >= 63744 && code <= 64255 || code >= 65072 && code <= 65103 || code >= 65280 && code <= 65376 || code >= 65504 && code <= 65510 || code >= 131072 && code <= 195103 || code >= 127744 && code <= 129535) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}
function replaceEmojiInCodeBlock(text) {
  return text.replace(/✅/g, "[O]").replace(/❌/g, "[X]").replace(/⭕/g, "[O]").replace(/🔴/g, "[X]");
}
function parseTableCells(line) {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
// Render a parsed table as a monospace ASCII block wrapped in a code fence.
// allRows[0] is the header row; the rest are data rows.
function renderTableAsCode(allRows) {
  const colCount = allRows[0].length;
  const widths = [];
  for (let c = 0; c < colCount; c++) {
    let max = 2;
    for (const row of allRows) {
      const cellLen = row[c] ? getDisplayWidth(row[c]) : 0;
      if (cellLen > max) max = cellLen;
    }
    widths.push(max);
  }
  const padCell = (str, w) => {
    const visLen = getDisplayWidth(str || "");
    return (str || "") + " ".repeat(Math.max(0, w - visLen));
  };
  const outLines = [];
  outLines.push(allRows[0].map((c, ci) => padCell(c, widths[ci])).join("  "));
  outLines.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (let r = 1; r < allRows.length; r++) {
    outLines.push(allRows[r].map((c, ci) => padCell(c, widths[ci])).join("  "));
  }
  const tableText = replaceEmojiInCodeBlock(outLines.join("\n"));
  return "```\n" + tableText + "\n```";
}
// Render a parsed table as a bullet list (mobile-safe, never wraps/breaks).
// Multi-column tables use the first cell as a bold row label and emit
// `• Header: Value` bullets for the remaining columns; empty values are
// skipped. Single-column tables fall back to a flat bullet list.
function renderTableAsBullets(allRows) {
  const headers = allRows[0] ?? [];
  const dataRows = allRows.slice(1);
  if (headers.length === 0 && dataRows.length === 0) return "";
  const useFirstColAsLabel = headers.length > 1 && dataRows.length > 0;
  const out = [];
  if (useFirstColAsLabel) {
    for (const row of dataRows) {
      if (row.length === 0) continue;
      const rowLabel = row[0];
      if (rowLabel) out.push("**" + rowLabel + "**");
      for (let i = 1; i < row.length; i++) {
        const value = row[i];
        if (!value) continue;
        const header = headers[i];
        out.push(header ? "• " + header + ": " + value : "• Column " + i + ": " + value);
      }
      out.push("");
    }
  } else {
    for (const row of dataRows) {
      for (let i = 0; i < row.length; i++) {
        const value = row[i];
        if (!value) continue;
        const header = headers[i];
        if (header) out.push("• " + header + ": " + value);
      }
      out.push("");
    }
  }
  return out.join("\n").replace(/\n+$/, "");
}
// Convert GitHub-flavored Markdown tables for Discord delivery.
// mode: "bullets" (default, mobile-safe) | "code" (monospace block) | "off".
function isTableSeparator(line) {
  return /^\|[\s-:]+(\|[\s-:]+)*\|?\s*$/.test(line);
}
function convertMarkdownTables(text, mode = "bullets") {
  if (!text || mode === "off") return text;
  const lines = text.split("\n");
  const result = [];
  let i = 0;
  while (i < lines.length) {
    // A separator row turns the previously pushed header line into a table.
    // We pop that header off `result` and push the rendered block in its place,
    // so collapsing a multi-line table never desyncs array indices across
    // subsequent tables.
    if (i > 0 && isTableSeparator(lines[i]) && result.length > 0 && /\|/.test(lines[i - 1])) {
      const headerLine = lines[i - 1];
      const tableLines = [headerLine];
      let j = i + 1;
      while (j < lines.length && /^\|/.test(lines[j]) && !isTableSeparator(lines[j])) {
        tableLines.push(lines[j]);
        j++;
      }
      const allRows = tableLines.map(parseTableCells);
      result.pop();
      result.push(mode === "code" ? renderTableAsCode(allRows) : renderTableAsBullets(allRows));
      i = j;
      continue;
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n");
}
function escapeNestedCodeBlocks(text) {
  let fenceLen = 0;
  const lines = text.split("\n");
  return lines.map((line) => {
    const match = line.match(/^(`{3,})/);
    if (match) {
      if (fenceLen === 0) {
        fenceLen = match[1].length;
      } else if (match[1].length >= fenceLen) {
        fenceLen = 0;
      }
      return line;
    }
    if (fenceLen > 0 && line.includes("```")) {
      return line.replace(/```/g, "`​``");
    }
    return line;
  }).join("\n");
}
// opts.tables selects the table rendering mode: "bullets" | "code" | "off".
function formatForDiscord(text, opts = {}) {
  const mode = opts.tables ?? "bullets";
  return escapeNestedCodeBlocks(convertMarkdownTables(text, mode));
}
function safeCodeBlock(content, lang = "") {
  const escaped = content.replace(/```/g, "`​``");
  return "```" + lang + "\n" + escaped + "\n```";
}
const MAX_DISCORD_MESSAGE = 2000;
function chunk(text, limit = MAX_DISCORD_MESSAGE) {
  if (text.length <= limit) return [text];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    const cbEnd1 = rest.lastIndexOf("\n```\n", limit);
    const cbEnd2 = rest.lastIndexOf("\n```", limit);
    if (cbEnd1 > limit / 2) {
      cut = cbEnd1 + 4;
    } else if (cbEnd2 > limit / 2) {
      cut = cbEnd2 + 4;
    }
    if (cut <= 0 || cut > limit) {
      const para = rest.lastIndexOf("\n\n", limit);
      const line = rest.lastIndexOf("\n", limit);
      const space = rest.lastIndexOf(" ", limit);
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    let part = rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n+/, "");
    const backtickCount = (part.match(/```/g) || []).length;
    if (backtickCount % 2 === 1) {
      const langMatch = part.match(/```(\w+)/);
      const lang = langMatch ? langMatch[1] : "";
      const closing = "\n```";
      if (part.length + closing.length > limit) {
        const overflow = part.length + closing.length - limit;
        const moved = part.slice(part.length - overflow);
        part = part.slice(0, part.length - overflow) + closing;
        rest = "```" + lang + "\n" + moved + rest;
      } else {
        part += closing;
        rest = "```" + lang + "\n" + rest;
      }
    }
    out.push(part);
  }
  if (rest) out.push(rest);
  return out;
}
export {
  chunk,
  formatForDiscord,
  safeCodeBlock,
  MAX_DISCORD_MESSAGE
};
