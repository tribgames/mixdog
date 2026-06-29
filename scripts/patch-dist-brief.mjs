import fs from "node:fs";
const p = "src/tui/dist/index.mjs";
let s = fs.readFileSync(p, "utf8");

const helpers = `const AGENT_SURFACE_BRIEF_MAX = 40;
function truncateAgentSurfaceBrief(value, max = AGENT_SURFACE_BRIEF_MAX) {
  const text = String(value ?? "").replace(/\\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return \`\${text.slice(0, Math.max(1, max - 1))}…\`;
}
function summarizeAgentSurfaceBrief(name, args, resultText, { isError = false, isResponse = false } = {}) {
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

if (!s.includes("function summarizeAgentSurfaceBrief")) {
  const needle = `function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed
  };
}
function pluralize`;
  if (!s.includes(needle)) throw new Error("formatToolSurface needle missing");
  s = s.replace(needle, `function formatToolSurface(name, args, opts = {}) {
  const parsed = parseToolArgs(args);
  return {
    label: displayToolName(name, parsed),
    summary: summarizeToolArgs(name, parsed, opts),
    normalizedName: normalizeToolName(name),
    args: parsed
  };
}
` + helpers + `function pluralize`);
}

const oldVisible = `  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const visibleDetailLines = (isAgentSurfaceCard || isSkillSurface) && !showRawResult ? [] : detailLines;`;
const newVisible = `  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const agentSurfaceBriefRaw = isAgentSurfaceCard && !showRawResult
    ? summarizeAgentSurfaceBrief(name, parsedArgs, displayedResultText || "", { isError, isResponse: isAgentResponse })
    : "";
  const agentSurfaceBrief = agentSurfaceBriefRaw
    ? truncateToWidth(agentSurfaceBriefRaw, Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars))
    : "";
  let visibleDetailLines = detailLines;
  if (isSkillSurface && !showRawResult) {
    visibleDetailLines = [];
  } else if (isAgentSurfaceCard && !showRawResult) {
    const agentDetailFallback = collapsedDetail
      || (pending ? (pendingDetailPlaceholder || "Running") : "Finished");
    const agentDetailLine = agentSurfaceBrief
      || truncateToWidth(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
    visibleDetailLines = [agentDetailLine];
  }`;
if (s.includes(oldVisible)) s = s.replace(oldVisible, newVisible);
else if (!s.includes("agentSurfaceBriefRaw")) throw new Error("visibleDetailLines block missing");

s = s.replace(
  "const placeholderSingleRow = !aggregate && (SKILL_SURFACE_NAMES.has(placeholderNormalizedName) || isAgentTool(placeholderNormalizedName));",
  "const placeholderSingleRow = !aggregate && SKILL_SURFACE_NAMES.has(placeholderNormalizedName);"
);

s = s.replace(
  "        if (isSkillSurface || isAgentSurface) return 1;",
  "        if (isSkillSurface) return 1;\n        if (isAgentSurface) return 2;"
);

fs.writeFileSync(p, s);
console.log("dist patched");
