import fs from "node:fs";
const p = "src/tui/components/ToolExecution.jsx";
let s = fs.readFileSync(p, "utf8");
const bad = `  let visibleDetailLines = detailLines;
  if (isSkillSurface && !showRawResult) {
    visibleDetailLines = [];
  } else if (isAgentSurfaceCard && !showRawResult) {
    if (agentSurfaceBrief) {
      visibleDetailLines = [agentSurfaceBrief];
    } else if (pending) {
      visibleDetailLines = [pendingDetailPlaceholder || 'Running'];
    } else {
      visibleDetailLines = [];
    }
  }
  } else if (isAgentSurfaceCard && !showRawResult) {
  } else if (isAgentSurfaceCard && !showRawResult) {
    const agentDetailFallback = collapsedDetail
      || (pending ? (pendingDetailPlaceholder || 'Running') : 'Finished');
    const agentDetailLine = agentSurfaceBrief
      || truncateToWidth(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
    visibleDetailLines = [agentDetailLine];
  }`;
const good = `  let visibleDetailLines = detailLines;
  if (isSkillSurface && !showRawResult) {
    visibleDetailLines = [];
  } else if (isAgentSurfaceCard && !showRawResult) {
    const agentDetailFallback = collapsedDetail
      || (pending ? (pendingDetailPlaceholder || 'Running') : 'Finished');
    const agentDetailLine = agentSurfaceBrief
      || truncateToWidth(String(agentDetailFallback), Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars));
    visibleDetailLines = [agentDetailLine];
  }`;
if (s.includes(bad)) {
  s = s.replace(bad, good);
  fs.writeFileSync(p, s);
  console.log("ToolExecution fixed");
} else if (s.includes("agentDetailFallback")) {
  console.log("ToolExecution already ok");
} else {
  throw new Error("ToolExecution pattern not found");
}
