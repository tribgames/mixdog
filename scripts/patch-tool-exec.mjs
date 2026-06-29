import fs from "node:fs";
const p = "src/tui/components/ToolExecution.jsx";
let s = fs.readFileSync(p, "utf8");
if (!s.includes("summarizeAgentSurfaceBrief,")) {
  s = s.replace(
    "  displayModelName,\n} from '../../runtime/shared/tool-surface.mjs';",
    "  displayModelName,\n  summarizeAgentSurfaceBrief,\n  AGENT_SURFACE_BRIEF_MAX,\n} from '../../runtime/shared/tool-surface.mjs';",
  );
}
s = s.replace(
  `    // Skill surfaces AND agent surfaces both collapse to a single header row in
    // estimateTranscriptItemRows (agent cards drop their ⎿ body entirely), so
    // the pending-delay placeholder must reserve exactly 1 row for them too —
    // otherwise the card paints 2 blank rows for ~1s then snaps to 1 ("튐").
    const placeholderSingleRow = !aggregate
      && (SKILL_SURFACE_NAMES.has(placeholderNormalizedName) || isAgentTool(placeholderNormalizedName));`,
  `    // Skill surfaces collapse to a single header row; agent surfaces reserve
    // header + one brief detail row (see estimateTranscriptItemRows).
    const placeholderSingleRow = !aggregate && SKILL_SURFACE_NAMES.has(placeholderNormalizedName);`,
);
const oldBlock = `  // Every agent card is a single header row when collapsed: spawn/send/response/
  // status/list/cancel/close/cleanup all fold their context into the header
  // label, so the ⎿ detail body (response summary, "agents: N …" worker list,
  // status metadata) is dropped unless the user expands with ctrl+o.
  const isAgentSurfaceCard = isAgentTool(normalizedName);
  // Skill loads carry the skill name in the header already
  // ("Loaded 1 skill (name)"); the collapsed detail row just repeats it, so
  // drop it and keep the card a single line. Expanding (ctrl+o) still shows the
  // full skill body via the raw-result path.
  // Agent responses now identify the responder in the header itself
  // ("Heavy Worker (Opus 4.8)"); the collapsed body just echoed the response
  // summary ("All green. Done."), so drop it and keep the card a single line.
  // ctrl+o expand (showRawResult) still surfaces the full response body.
  // Suppression is COLLAPSED-ONLY: agent/skill cards hide their ⎿ body when
  // collapsed, but once the user expands (showRawResult) the raw body — the
  // response, the "agents: N …" worker list, the status metadata — must render.
  const visibleDetailLines = ((isAgentSurfaceCard || isSkillSurface) && !showRawResult)
    ? []
    : detailLines;`;
const newBlock = `  const isAgentSurfaceCard = isAgentTool(normalizedName);
  const agentSurfaceBriefRaw = isAgentSurfaceCard && !showRawResult
    ? summarizeAgentSurfaceBrief(name, parsedArgs, displayedResultText || '', { isError, isResponse: isAgentResponse })
    : '';
  const agentSurfaceBrief = agentSurfaceBriefRaw
    ? truncateToWidth(agentSurfaceBriefRaw, Math.min(AGENT_SURFACE_BRIEF_MAX, maxResultChars))
    : '';
  // Skill loads carry the skill name in the header already
  // ("Loaded 1 skill (name)"); the collapsed detail row just repeats it, so
  // drop it and keep the card a single line. Expanding (ctrl+o) still shows the
  // full skill body via the raw-result path.
  // Agent spawn/send/response cards show a tight brief under the ⎿ gutter when
  // collapsed; ctrl+o expand still surfaces the full body.
  let visibleDetailLines = detailLines;
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
  }`;
if (!s.includes("agentSurfaceBriefRaw")) {
  if (!s.includes(oldBlock)) throw new Error("ToolExecution block not found");
  s = s.replace(oldBlock, newBlock);
}
fs.writeFileSync(p, s);
console.log("ToolExecution ok");
