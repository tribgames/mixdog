import fs from "node:fs";
const p = "src/runtime/shared/tool-surface.mjs";
let s = fs.readFileSync(p, "utf8");
if (s.includes("summarizeAgentSurfaceBrief")) { console.log("skip"); process.exit(0); }
const insert = `/** Collapsed agent/worker surface card: one-line brief under the header (30-40 chars). */
export const AGENT_SURFACE_BRIEF_MAX = 40;

export function summarizeAgentSurfaceBrief(name, args, resultText, { isError = false, isResponse = false } = {}) {
  const a = parseToolArgs(args);
  const action = String(a?.type || a?.action || "").toLowerCase();
  const text = String(resultText ?? "").trim();

  if (isResponse && text) {
    const fromResult = summarizeToolResult(name, args, text, isError);
    if (fromResult) return truncateSingleLine(stripInlineMarkdown(fromResult), AGENT_SURFACE_BRIEF_MAX);
    const line = firstAgentResultLine(text);
    if (line) return truncateSingleLine(stripInlineMarkdown(line), AGENT_SURFACE_BRIEF_MAX);
  }

  const outbound = firstText(a?.prompt, a?.message);
  if (outbound && (action === "spawn" || action === "send" || !action)) {
    return truncateSingleLine(outbound, AGENT_SURFACE_BRIEF_MAX);
  }

  if ((action === "spawn" || action === "send") && text && !isResponse) {
    const fromResult = summarizeToolResult(name, args, text, isError);
    if (fromResult) return truncateSingleLine(stripInlineMarkdown(fromResult), AGENT_SURFACE_BRIEF_MAX);
  }

  return "";
}

`;
const needle = `export function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed,
  };
}

function pluralize`;
if (!s.includes(needle)) throw new Error("needle not found");
s = s.replace(needle, insert + "function pluralize");
fs.writeFileSync(p, s);
console.log("tool-surface ok");
