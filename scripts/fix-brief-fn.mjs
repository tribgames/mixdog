import fs from "node:fs";
const p = "src/runtime/shared/tool-surface.mjs";
let s = fs.readFileSync(p, "utf8");
const start = s.indexOf("export function summarizeAgentSurfaceBrief");
const end = s.indexOf("function pluralize", start);
if (start < 0 || end < 0) throw new Error("markers");
const clean = `export function summarizeAgentSurfaceBrief(name, args, resultText, { isError = false, isResponse = false } = {}) {
  const a = parseToolArgs(args);
  const action = String(a?.type || a?.action || "").toLowerCase();
  const text = String(resultText ?? "").trim();

  if (isResponse && text) {
    const fromResult = summarizeToolResult(name, args, text, isError);
    if (fromResult) return truncateAgentSurfaceBrief(stripInlineMarkdown(fromResult));
    const line = firstAgentResultLine(text);
    if (line) return truncateAgentSurfaceBrief(stripInlineMarkdown(line));
  }

  const outbound = firstText(a?.prompt, a?.message);
  if (outbound && (action === "spawn" || action === "send" || !action)) {
    return truncateAgentSurfaceBrief(outbound);
  }

  if ((action === "spawn" || action === "send") && text && !isResponse) {
    const fromResult = summarizeToolResult(name, args, text, isError);
    if (fromResult) return truncateAgentSurfaceBrief(stripInlineMarkdown(fromResult));
  }

  return "";
}

`;
s = s.slice(0, start) + clean + s.slice(end);
fs.writeFileSync(p, s);
console.log("summarizeAgentSurfaceBrief cleaned");
