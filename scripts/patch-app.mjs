import fs from "node:fs";
const p = "src/tui/App.jsx";
let s = fs.readFileSync(p, "utf8");
const old = `        // EVERY agent card is a single header row whether pending or completed —
        // ToolExecution drops the ⎿ body for all of them AND the pending-delay
        // placeholder reserves only 1 row for agent surfaces — so reserve
        // exactly 1 row regardless of pending/hasResult. Otherwise the estimate
        // (2) and the real render (1) diverge and the viewport jumps.
        if (isSkillSurface || isAgentSurface) return 1;`;
const neu = `        // Skill loads are a single header row; agent cards are header + brief.
        if (isSkillSurface) return 1;
        if (isAgentSurface) return 2;`;
if (s.includes(old)) {
  s = s.replace(old, neu);
  fs.writeFileSync(p, s);
  console.log("App ok");
} else if (s.includes("if (isAgentSurface) return 2")) {
  console.log("App already");
} else {
  throw new Error("App block not found");
}
